// brand-network-overlay test suite (node --test).
//
// Coverage:
//   - lib/host-match.js     host matching semantics (wildcard subdomain-only,
//                           allow wins, non-http(s) never blocked);
//   - lib/site-config.js    YAML subset parsing + config priority chain
//                           (env > file > baked) + dirty host normalization;
//   - lib/statsig.js        numeric payload contract (initialize full shape,
//                           evaluation has_updates:false, deltas checksum,
//                           overlay response_mode, telemetry "{}");
//   - webview runtimes      executed in a vm sandbox with a minimal fake DOM
//                           and a FakeXHR that replicates the read-only IDL
//                           properties of a real XMLHttpRequest (plain
//                           assignment is silently ignored, only
//                           Object.defineProperty on the instance works);
//   - patch.js              apply-once semantics, idempotency, non-target
//                           bundle untouched, anchor drift fail-soft.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const vm = require("node:vm");

const FEATURE_DIR = __dirname;
const { hostMatchesPattern, isBlockedUrl } = require("./lib/host-match.js");
const siteConfig = require("./lib/site-config.js");
const statsig = require("./lib/statsig.js");
const patch = require("./patch.js");
const { buildWebviewRuntimes } = require("./runtime/webview-runtime.js");

const MANIFEST = {
  brandNetworkOverlay: {
    brand: { name: "wdev" },
    network: { block: ["chatgpt.com", "*.chatgpt.com", "*.openai.com", "*.example.com"], allow: ["ok.example.com"] },
    statsig: { initializeDelayMs: 400 },
  },
};

// ---------------------------------------------------------------------------
// lib/host-match.js
// ---------------------------------------------------------------------------

test("hostMatchesPattern: wildcard matches subdomains only, not the bare domain", () => {
  assert.equal(hostMatchesPattern("ab.chatgpt.com", "*.chatgpt.com"), true);
  assert.equal(hostMatchesPattern("a.b.chatgpt.com", "*.chatgpt.com"), true);
  assert.equal(hostMatchesPattern("chatgpt.com", "*.chatgpt.com"), false);
  assert.equal(hostMatchesPattern("AB.ChatGPT.com", "*.chatgpt.com"), true);
});

test("hostMatchesPattern: exact rules are case-insensitive exact equality", () => {
  assert.equal(hostMatchesPattern("statsigapi.net", "statsigapi.net"), true);
  assert.equal(hostMatchesPattern("StatsigAPI.NET", "statsigapi.net"), true);
  assert.equal(hostMatchesPattern("evilchatgpt.com", "chatgpt.com"), false);
  assert.equal(hostMatchesPattern("", "chatgpt.com"), false);
  assert.equal(hostMatchesPattern("x.com", ""), false);
});

test("isBlockedUrl: allow wins over block; only http(s); junk never blocked", () => {
  const network = { blockedHosts: ["*.example.com", "chatgpt.com"], allowedHosts: ["ok.example.com"] };
  assert.equal(isBlockedUrl("https://cdn.example.com/a.js", network), true);
  assert.equal(isBlockedUrl("https://chatgpt.com/x", network), true);
  assert.equal(isBlockedUrl("https://ok.example.com/x", network), false);
  assert.equal(isBlockedUrl("https://example.com/", network), false); // bare domain, wildcard only
  assert.equal(isBlockedUrl("https://api.github.com/x", network), false);
  assert.equal(isBlockedUrl("sentry-ipc://local", network), false);
  assert.equal(isBlockedUrl("file:///etc/passwd", network), false);
  assert.equal(isBlockedUrl("/relative/path", network), false);
  assert.equal(isBlockedUrl("not a url at all", network), false);
  assert.equal(isBlockedUrl("", network), false);
  assert.equal(isBlockedUrl("https://cdn.example.com/", { blockedHosts: [], allowedHosts: [] }), false);
});

// ---------------------------------------------------------------------------
// lib/site-config.js
// ---------------------------------------------------------------------------

test("site-config: parses the brand/network YAML subset (comments, inline + block lists)", () => {
  const yaml = [
    "auth:",
    "  password: secret123", // must not leak into brand
    "brand:",
    '  name: "wdev" # trailing comment',
    "network:",
    "  block:",
    '    - "*.chatgpt.com"',
    '    - https://statsigapi.net:443/pasted-url',
    '  allow: [ok.chatgpt.com, "ok2.chatgpt.com"]',
  ].join("\n");
  const config = siteConfig.loadSiteConfig({ readText: () => yaml, env: {} });
  assert.equal(config.brand.name, "wdev");
  assert.equal(config.brand.source, "config");
  assert.equal(config.brand.configured, true);
  assert.deepEqual(config.network.blockedHosts, ["*.chatgpt.com", "statsigapi.net"]);
  assert.deepEqual(config.network.allowedHosts, ["ok.chatgpt.com", "ok2.chatgpt.com"]);
  assert.equal(config.network.configured, true);
});

test("site-config: env brand wins over file; baked defaults fill gaps; junk host entries dropped", () => {
  const yaml = [
    "brand:",
    "  name: filebrand",
    "network:",
    "  block:",
    "    - not a host",
    "    - ..broken..",
    "    - GOOD.Example.COM",
  ].join("\n");
  const config = siteConfig.loadSiteConfig({
    readText: () => yaml,
    env: { [siteConfig.BRAND_NAME_ENV]: "envbrand" },
  });
  assert.equal(config.brand.name, "envbrand");
  assert.equal(config.brand.source, "env");
  assert.deepEqual(config.network.blockedHosts, ["good.example.com"]);

  const baked = siteConfig.loadSiteConfig({
    readText: () => "",
    env: {},
    bakedBrandName: "wdev",
    bakedBlockedHosts: ["*.statsig.com"],
  });
  assert.equal(baked.brand.name, "wdev");
  assert.equal(baked.brand.source, "default");
  assert.deepEqual(baked.network.blockedHosts, ["*.statsig.com"]);
});

test("site-config: malformed config never throws and falls back to defaults", () => {
  const config = siteConfig.loadSiteConfig({ readText: () => ": : [ \\n broken\t\tyaml {{", env: {} });
  assert.equal(config.brand.name, "OpenCodex");
  assert.equal(config.brand.configured, false);
  assert.deepEqual(config.network.blockedHosts, []);
  assert.equal(siteConfig.loadSiteConfig({ readText: () => { throw new Error("disk"); }, env: {} }).brand.name, "OpenCodex");
});

test("site-config: brand name length cap and control-char stripping", () => {
  const { normalizeBrandName } = siteConfig.__test;
  assert.equal(normalizeBrandName("  wdev  "), "wdev");
  assert.equal(normalizeBrandName("w\u0000dev"), "wdev");
  assert.equal(normalizeBrandName("x".repeat(65)), "");
  assert.equal(normalizeBrandName("").length, 0);
});

// ---------------------------------------------------------------------------
// lib/statsig.js numeric contract
// ---------------------------------------------------------------------------

test("statsig: initialize payload has the full legal shape and the official gate values", () => {
  const body = statsig.buildStatsigInitializeResponse();
  assert.equal(body.has_updates, true);
  assert.equal(typeof body.time, "number");
  assert.equal(body.hash_used, "djb2");
  // feature gates: 3903742690 / 505458 / artifacts all true.
  assert.equal(body.feature_gates["3903742690"].value, true);
  assert.equal(body.feature_gates["505458"].value, true);
  assert.equal(body.feature_gates["artifacts"].value, true);
  for (const name of Object.keys(body.feature_gates)) {
    assert.equal(body.feature_gates[name].rule_id, "gateway_override");
    assert.deepEqual(body.feature_gates[name].secondary_exposures, []);
  }
  const dyn = body.dynamic_configs["statsig_default_enable_features"].value;
  assert.deepEqual(dyn, { "3903742690": true, "505458": true, artifacts: true });
  // i18n layer 72216192.
  assert.deepEqual(body.layer_configs["72216192"].value, { enable_i18n: true, locale_source: "IDE" });
  assert.deepEqual(body.param_stores, {});
  assert.deepEqual(body.exposures, {});
  assert.deepEqual(body.sdk_flags, {});
});

test("statsig: evaluation payload is has_updates:false with deltas/overlay extras", () => {
  const plain = statsig.buildStatsigEvaluationResponse("/v1/eval");
  assert.equal(plain.has_updates, false);
  assert.equal(plain.checksum, undefined);
  assert.equal(plain.response_mode, undefined);
  const deltas = statsig.buildStatsigEvaluationResponse("/v1/deltas/123/");
  assert.equal(deltas.has_updates, false);
  assert.equal(deltas.checksum, "0");
  const overlay = statsig.buildStatsigEvaluationResponse("/v1/overlay/live");
  assert.equal(overlay.response_mode, "full");
});

test("statsig: URL classifiers are exact-hostname and path based", () => {
  assert.equal(statsig.isStatsigInitializeUrl("https://ab.chatgpt.com/v1/initialize"), true);
  assert.equal(statsig.isStatsigInitializeUrl("https://ab.chatgpt.com/v1/initialize/"), true);
  assert.equal(statsig.isStatsigInitializeUrl("https://ab.chatgpt.com.evil.com/v1/initialize"), false);
  assert.equal(statsig.isStatsigEvaluationUrl("https://ab.chatgpt.com/v1/download_config_specs"), true);
  assert.equal(statsig.isStatsigEvaluationUrl("https://ab.chatgpt.com/v2/whatever"), false);
  assert.equal(statsig.isStatsigTelemetryUrl("https://chatgpt.com/ces/v1/rgstr"), true);
  assert.equal(statsig.isStatsigTelemetryUrl("https://chatgpt.com/ces/v1/log_event"), true);
  assert.equal(statsig.isStatsigTelemetryUrl("https://chatgpt.com.evil.example/ces/v1/rgstr"), false);
  assert.equal(statsig.statsigLocalBodyForUrl("https://example.com/x"), null);
  assert.equal(statsig.statsigLocalBodyForUrl("https://ab.chatgpt.com/v1/initialize").kind, "initialize");
  assert.equal(statsig.statsigLocalBodyForUrl("https://chatgpt.com/ces/v1/rgstr").body, "{}");
  assert.equal(statsig.normalizeInitializeDelayMs(undefined), 400);
  assert.equal(statsig.normalizeInitializeDelayMs("150"), 150);
  assert.equal(statsig.normalizeInitializeDelayMs(-5), 0);
});

// ---------------------------------------------------------------------------
// vm sandbox harness: minimal fake DOM + FakeXHR with read-only IDL props
// ---------------------------------------------------------------------------

function createFakeDom() {
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;
  const FILTER_ACCEPT = 1;
  const FILTER_REJECT = 2;
  const SHOW_ELEMENT = 2;
  const SHOW_TEXT = 4;

  const mutations = [];

  function makeElement(tagName, attrs = {}) {
    const element = {
      nodeType: ELEMENT_NODE,
      tagName: String(tagName).toUpperCase(),
      childNodes: [],
      children: [],
      parentElement: null,
      parentNode: null,
      hidden: false,
      disabled: false,
      dataset: {},
      _attrs: { ...attrs },
      style: {
        setProperty(name, value, priority) {
          this[name] = priority ? `${value}; ${priority}` : value;
        },
      },
      addEventListener() {},
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
      },
      setAttribute(name, value) {
        this._attrs[name] = String(value);
      },
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this._attrs, name);
      },
      appendChild(child) {
        child.parentElement = this;
        child.parentNode = this;
        if (child.nodeType === ELEMENT_NODE) {
          this.children.push(child);
        }
        this.childNodes.push(child);
        return child;
      },
      querySelectorAll(selector) {
        return queryAll(this, selector);
      },
    };
    Object.defineProperty(element, "className", {
      get() { return this._attrs.class || ""; },
      set(value) { this._attrs.class = value; },
      configurable: true,
    });
    // closest supports tag, [attr], [attr="value"] terms (comma separated).
    element.closest = function (selector) {
      const terms = String(selector || "").split(",").map((term) => term.trim()).filter(Boolean);
      let current = this;
      while (current && current.nodeType === ELEMENT_NODE) {
        for (const term of terms) {
          const attrMatch = term.match(/^\[([a-zA-Z-]+)(?:=\"([^\"]*)\")?\]$/);
          if (attrMatch) {
            const value = current.getAttribute(attrMatch[1]);
            if (value !== null && (attrMatch[2] === undefined || value === attrMatch[2])) return current;
          } else if (current.tagName === term.toUpperCase()) {
            return current;
          }
        }
        current = current.parentElement;
      }
      return null;
    };
    return element;
  }

  function makeText(value) {
    return {
      nodeType: TEXT_NODE,
      nodeValue: String(value),
      parentElement: null,
      parentNode: null,
    };
  }

  function matchTerm(node, term) {
    if (term === "*") return node.nodeType === ELEMENT_NODE;
    const attrMatch = term.match(/^\[([a-zA-Z-]+)(?:=\"?([^\"\]]*)\"?)?\]$/);
    if (attrMatch) {
      if (node.nodeType !== ELEMENT_NODE) return false;
      const value = node.getAttribute(attrMatch[1]);
      return value !== null && (attrMatch[2] === undefined || value === attrMatch[2]);
    }
    return node.nodeType === ELEMENT_NODE && node.tagName === term.toUpperCase();
  }

  function queryAll(root, selector) {
    const terms = String(selector || "").split(",").map((term) => term.trim()).filter(Boolean);
    const found = [];
    (function walk(node) {
      for (const child of node.children || []) {
        if (terms.some((term) => matchTerm(child, term))) found.push(child);
        walk(child);
      }
    })(root);
    return found;
  }

  const documentElement = makeElement("html");
  const body = makeElement("body");
  documentElement.appendChild(body);

  const document = {
    readyState: "complete",
    documentElement,
    body,
    _title: "",
    get title() { return this._title; },
    set title(value) { this._title = String(value); },
    addEventListener() {},
    querySelectorAll(selector) {
      return queryAll(documentElement, selector);
    },
    createTreeWalker(root, whatToShow, filter) {
      const queue = [];
      (function collect(node) {
        for (const child of node.childNodes || []) {
          if (child.nodeType === TEXT_NODE) {
            if (whatToShow & SHOW_TEXT) queue.push(child);
            continue;
          }
          const accept = filter && typeof filter.acceptNode === "function" ? filter.acceptNode(child) : FILTER_ACCEPT;
          if (accept === FILTER_REJECT) continue;
          if (whatToShow & SHOW_ELEMENT) queue.push(child);
          collect(child);
        }
      })(root);
      return { nextNode: () => queue.shift() || null };
    },
  };

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observations = 0;
      mutations.push(this);
    }
    observe() {
      this.observations += 1;
    }
    fire(records) {
      this.callback(records);
    }
  }

  const Node = { ELEMENT_NODE, TEXT_NODE };
  const NodeFilter = { SHOW_ELEMENT, SHOW_TEXT, FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP: 3 };

  return { document, Node, NodeFilter, FakeMutationObserver, mutations, makeElement, makeText, body };
}

function createFakeXhrEnvironment() {
  const nativeFetchCalls = [];
  const nativeXhrSendCalls = [];
  const nativeBeaconCalls = [];

  class FakeXHR {
    constructor() {
      this._listeners = {};
      this._events = [];
    }
    addEventListener(type, listener) {
      (this._listeners[type] = this._listeners[type] || []).push(listener);
    }
    removeEventListener() {}
    dispatchEvent(event) {
      this._events.push(event.type);
      for (const listener of this._listeners[event.type] || []) listener.call(this, event);
      return true;
    }
    open(method, url) {
      this._url = typeof url === "string" ? url : "";
      return undefined;
    }
    send(body) {
      nativeXhrSendCalls.push(this._url);
      return undefined;
    }
  }
  // Replicate the read-only IDL properties of a real XMLHttpRequest: the
  // prototype accessor has NO setter, so in sloppy mode plain assignment is
  // silently ignored; only Object.defineProperty on the instance (configurable
  // shadowing) can change the observed value.
  const readonlyGetters = {
    status: () => 0,
    statusText: () => "",
    response: () => null,
    responseText: () => "",
    readyState: () => 0,
  };
  for (const [name, getter] of Object.entries(readonlyGetters)) {
    Object.defineProperty(FakeXHR.prototype, name, { configurable: true, enumerable: true, get: getter });
  }

  return { FakeXHR, nativeFetchCalls, nativeXhrSendCalls, nativeBeaconCalls };
}

function runWebviewRuntimesInSandbox(options = {}) {
  const dom = createFakeDom();
  const xhrEnv = createFakeXhrEnvironment();
  const timers = [];

  function nativeFetchUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  // The sandbox object itself plays `window`: the vm global proxy is built
  // from it, so the runtimes patch the exact properties the tests call.
  const sandbox = {
    console: {
      warn() {},
      error() {},
      // The network guard emits "[bnov-audit]" console.info lines for the
      // main-process capture hook; collect them when the caller asks.
      info: (m) => {
        if (Array.isArray(options.auditLines)) options.auditLines.push(String(m));
      },
    },
    URL,
    Event: class Event {
      constructor(type) { this.type = type; }
    },
    Response: class MinimalResponse {
      constructor(body, init = {}) {
        this._body = String(body == null ? "" : body);
        this.status = init.status ?? 200;
        this.statusText = init.statusText ?? "OK";
        this.headers = new Map(Object.entries(init.headers || {}));
      }
      text() {
        return Promise.resolve(this._body);
      }
      json() {
        return Promise.resolve(JSON.parse(this._body));
      }
    },
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    fetch(input, init) {
      const url = nativeFetchUrl(input);
      if (url) xhrEnv.nativeFetchCalls.push(url);
      return Promise.resolve({ status: 200, native: true });
    },
    XMLHttpRequest: xhrEnv.FakeXHR,
    navigator: {
      sendBeacon(url) {
        xhrEnv.nativeBeaconCalls.push(String(url || ""));
        return true;
      },
    },
    location: { href: "https://chatgpt.com/workspace" },
    __timers: timers,
  };
  sandbox.window = sandbox;
  sandbox.document = dom.document;
  sandbox.Node = dom.Node;
  sandbox.NodeFilter = dom.NodeFilter;
  sandbox.MutationObserver = dom.FakeMutationObserver;

  const runtimes = buildWebviewRuntimes({
    manifest: options.manifest || MANIFEST,
    settings: options.settings || {},
  });
  for (const [name, source] of Object.entries(runtimes)) {
    vm.runInNewContext(source, sandbox, { filename: `wv-${name}.js` });
  }

  function flushTimers() {
    const pending = timers.splice(0);
    for (const timer of pending) timer.callback();
  }

  return { sandbox, dom, xhrEnv, timers, flushTimers };
}

// ---------------------------------------------------------------------------
// webview runtime: network guard + statsig local responses
// ---------------------------------------------------------------------------

test("webview: FakeXHR replicates read-only IDL (plain assignment is silently ignored)", () => {
  const { FakeXHR } = createFakeXhrEnvironment();
  // Real browser page scripts run in sloppy mode, where assignment to a
  // setter-less prototype accessor is silently ignored. node --test files are
  // strict modules, so replicate the browser with an explicit non-strict scope.
  const sloppySet = new Function("xhr", "xhr.status = 999;");
  const xhr = new FakeXHR();
  sloppySet(xhr);
  assert.equal(xhr.status, 0);
  assert.equal(xhr.readyState, 0);
  // But a configurable instance defineProperty DOES change the observed value
  // (this is exactly what the injected runtime does).
  Object.defineProperty(xhr, "status", { configurable: true, get: () => 200 });
  assert.equal(xhr.status, 200);
});

test("webview: blocked fetch returns local 200 JSON; passthrough reaches native", async () => {
  const env = runWebviewRuntimesInSandbox();
  const blocked = await env.sandbox.fetch("https://cdn.example.com/a.js");
  assert.equal(blocked.status, 200);
  assert.equal(await blocked.text(), "{}");
  assert.equal(blocked.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(env.xhrEnv.nativeFetchCalls.length, 0);

  const bare = await env.sandbox.fetch("https://example.com/"); // wildcard: subdomains only
  assert.equal(bare.native, true);
  const allowed = await env.sandbox.fetch("https://ok.example.com/x");
  assert.equal(allowed.native, true);
  const outside = await env.sandbox.fetch("https://api.github.com/x");
  assert.equal(outside.native, true);
  assert.deepEqual(env.xhrEnv.nativeFetchCalls, ["https://example.com/", "https://ok.example.com/x", "https://api.github.com/x"]);
});

test("webview: Statsig initialize/evaluation/telemetry get legal payloads (fetch channel)", async () => {
  const env = runWebviewRuntimesInSandbox();
  const init = await env.sandbox.fetch("https://ab.chatgpt.com/v1/initialize");
  const initBody = JSON.parse(await init.text());
  assert.equal(init.status, 200);
  assert.equal(initBody.has_updates, true);
  assert.equal(initBody.feature_gates["505458"].value, true);
  assert.equal(initBody.layer_configs["72216192"].value.enable_i18n, true);
  assert.equal(env.xhrEnv.nativeFetchCalls.length, 0);

  const evalResp = await env.sandbox.fetch("https://ab.chatgpt.com/v1/deltas/42");
  const evalBody = JSON.parse(await evalResp.text());
  assert.equal(evalBody.has_updates, false);
  assert.equal(evalBody.checksum, "0");

  const telemetry = await env.sandbox.fetch("https://chatgpt.com/ces/v1/rgstr");
  assert.equal(await telemetry.text(), "{}");
});

test("webview: blocked XHR simulates async 200 via defineProperty (read-only IDL)", () => {
  const env = runWebviewRuntimesInSandbox();
  const xhr = new env.sandbox.XMLHttpRequest();
  xhr.open("GET", "https://cdn.example.com/a.js");
  xhr.addEventListener("load", function () { this._sawLoad = true; });
  xhr.send();
  // loadstart is synchronous; the rest is deferred (the SDK registers load after send returns).
  assert.deepEqual(xhr._events, ["loadstart"]);
  assert.equal(env.xhrEnv.nativeXhrSendCalls.length, 0);
  assert.equal(xhr.status, 0);
  assert.equal(xhr.readyState, 0);
  env.flushTimers();
  assert.equal(xhr.status, 200);
  assert.equal(xhr.statusText, "OK");
  assert.equal(xhr.readyState, 4);
  assert.equal(xhr.responseText, "{}");
  assert.equal(xhr.response, "{}");
  assert.deepEqual(xhr._events, ["loadstart", "readystatechange", "load", "loadend"]);
  assert.equal(xhr._sawLoad, true);
  // A fresh instance must not see any prototype pollution.
  const fresh = new env.sandbox.XMLHttpRequest();
  assert.equal(fresh.status, 0);
  assert.equal(fresh.readyState, 0);
});

test("webview: XHR Statsig initialize gets the full payload, not bare {}", () => {
  const env = runWebviewRuntimesInSandbox();
  const xhr = new env.sandbox.XMLHttpRequest();
  xhr.open("POST", "https://ab.chatgpt.com/v1/initialize");
  xhr.send();
  env.flushTimers();
  const body = JSON.parse(xhr.responseText);
  assert.equal(body.has_updates, true);
  assert.equal(body.feature_gates["3903742690"].value, true);
  assert.ok(typeof body.time === "number");
  assert.equal(env.xhrEnv.nativeXhrSendCalls.length, 0);

  // telemetry XHR (statsig runtime, inner layer) also answered locally.
  const telemetry = new env.sandbox.XMLHttpRequest();
  telemetry.open("POST", "https://chatgpt.com/ces/v1/log_event");
  telemetry.send();
  env.flushTimers();
  assert.equal(telemetry.status, 200);
  assert.equal(telemetry.responseText, "{}");
});

test("webview: sendBeacon blocked returns true; unblocked passes through", () => {
  const env = runWebviewRuntimesInSandbox();
  assert.equal(env.sandbox.navigator.sendBeacon("https://cdn.example.com/track"), true);
  assert.equal(env.sandbox.navigator.sendBeacon("https://api.github.com/track"), true);
  assert.deepEqual(env.xhrEnv.nativeBeaconCalls, ["https://api.github.com/track"]);
});

// ---------------------------------------------------------------------------
// webview runtime: brand text replacement
// ---------------------------------------------------------------------------

test("webview: brand replaces title, text nodes and visible attrs; boundaries respected", () => {
  const env = runWebviewRuntimesInSandbox();
  const dom = env.dom;
  dom.document.title = "ChatGPT - My Session";
  const h1 = dom.body.appendChild(dom.makeText("Welcome to ChatGPT by OpenAI (openai)"));
  // Dynamic elements arrive as a container; the observer pass rewrites the
  // container's descendants, including user-visible attributes.
  const container = dom.makeElement("div");
  const icon = dom.makeElement("img");
  icon.setAttribute("alt", "ChatGPT logo");
  icon.setAttribute("title", "OpenAI assistant");
  icon.setAttribute("aria-label", "Codex menu");
  container.appendChild(icon);
  const shellText = dom.makeText("Switch to ChatGPT Plus");
  dom.body.appendChild(shellText);
  // The IIFE scans once at install (before these nodes existed); dynamic
  // content arrives through the observer. Fire childList records for every
  // added node, then let the throttled pass run.
  const brandObserver = env.dom.mutations.find((mo) => mo && mo.observations > 0);
  assert.ok(brandObserver, "brand runtime installed a MutationObserver");
  brandObserver.fire([
    { type: "childList", addedNodes: [h1, container, shellText] },
  ]);
  env.flushTimers();
  assert.equal(dom.document.title, "wdev - My Session");
  assert.equal(h1.nodeValue, "Welcome to wdev by wdev (wdev)");
  assert.equal(icon.getAttribute("alt"), "wdev logo");
  assert.equal(icon.getAttribute("title"), "wdev assistant");
  assert.equal(icon.getAttribute("aria-label"), "wdev menu");
  assert.equal(shellText.nodeValue, "Switch to wdev Plus");
});

test("webview: brand leaves lowercase codex, CSS vars, protocols and camelCase untouched", () => {
  const env = runWebviewRuntimesInSandbox();
  const dom = env.dom;
  const el = dom.makeElement("div");
  const label = dom.makeText("restart the codex and codex app; --codex-var; codex-sandbox://x; CodexApp2");
  el.appendChild(label);
  dom.body.appendChild(el);
  const brandObserver = env.dom.mutations.find((mo) => mo && mo.observations > 0);
  brandObserver.fire([{ type: "childList", addedNodes: [el] }]);
  env.flushTimers();
  assert.equal(label.nodeValue, "restart the codex and codex app; --codex-var; codex-sandbox://x; CodexApp2");
});

test("webview: brand never touches conversation/code containers (whole subtree)", () => {
  const env = runWebviewRuntimesInSandbox();
  const dom = env.dom;
  const bubble = dom.makeElement("div");
  bubble.setAttribute("data-user-message-bubble", "");
  const innerText = dom.makeText("user wrote ChatGPT here");
  bubble.appendChild(innerText);
  const pre = dom.makeElement("pre");
  const code = dom.makeElement("code");
  const codeText = dom.makeText("const ChatGPT = 1;");
  code.appendChild(codeText);
  pre.appendChild(code);
  const editable = dom.makeElement("div");
  editable.setAttribute("contenteditable", "true");
  const editableText = dom.makeText("editing ChatGPT");
  editable.appendChild(editableText);
  dom.body.appendChild(bubble);
  dom.body.appendChild(pre);
  dom.body.appendChild(editable);
  const shellText = dom.makeText("shell: ChatGPT settings");
  dom.body.appendChild(shellText);
  const brandObserver = env.dom.mutations.find((mo) => mo && mo.observations > 0);
  brandObserver.fire([{ type: "childList", addedNodes: [bubble, pre, editable, shellText] }]);
  env.flushTimers();
  assert.equal(innerText.nodeValue, "user wrote ChatGPT here");
  assert.equal(codeText.nodeValue, "const ChatGPT = 1;");
  assert.equal(editableText.nodeValue, "editing ChatGPT");
  assert.equal(shellText.nodeValue, "shell: wdev settings");
});

// ---------------------------------------------------------------------------
// webview runtime: menu hiding
// ---------------------------------------------------------------------------

function makeMenuButton(label) {
  const dom = createFakeDom();
  const menu = dom.makeElement("div");
  menu.setAttribute("role", "menu");
  const button = dom.makeElement("button");
  button.appendChild(dom.makeText(label));
  menu.appendChild(button);
  dom.body.appendChild(menu);
  return { dom, menu, button };
}

test("webview: official menu items are hidden (all a11y effects), others untouched", () => {
  const env = runWebviewRuntimesInSandbox();
  const dom = env.dom;
  const items = {};
  const menu = dom.makeElement("div");
  menu.setAttribute("role", "menu");
  for (const label of ["What's new", "Help", "显示宠物", "Hide pet", "Keyboard shortcuts", "Help center"]) {
    const button = dom.makeElement("button");
    button.appendChild(dom.makeText(label));
    menu.appendChild(button);
    items[label] = button;
  }
  dom.body.appendChild(menu);
  const menuObserver = env.dom.mutations.find((mo) => mo && mo.observations > 0 && mo.__bnovMenuObserver === true);
  assert.ok(menuObserver, "menu runtime installed a MutationObserver");
  menuObserver.fire([{ type: "childList", addedNodes: [menu] }]);
  env.flushTimers();

  for (const label of ["What's new", "Help", "显示宠物", "Hide pet"]) {
    const el = items[label];
    assert.equal(el.hidden, true, `${label} hidden`);
    assert.equal(el.getAttribute("aria-hidden"), "true");
    assert.equal(el.getAttribute("tabindex"), "-1");
    assert.ok(String(el.style.display).includes("none"), `${label} display none`);
    assert.equal(el.dataset.bnovMenuItemHidden, "true");
  }
  for (const label of ["Keyboard shortcuts", "Help center"]) {
    assert.equal(items[label].hidden, false, `${label} untouched`);
  }
});

test("webview: identical text outside a menu context is untouched", () => {
  const env = runWebviewRuntimesInSandbox();
  const dom = env.dom;
  const button = dom.makeElement("button");
  button.appendChild(dom.makeText("Help"));
  dom.body.appendChild(button);
  const menuObserver = env.dom.mutations.find((mo) => mo && mo.observations > 0 && mo.__bnovMenuObserver === true);
  menuObserver.fire([{ type: "childList", addedNodes: [button] }]);
  env.flushTimers();
  assert.equal(button.hidden, false);
});

test("webview: split label + shortcut text nodes still match (per-node equality)", () => {
  const env = runWebviewRuntimesInSandbox();
  const dom = env.dom;
  const menu = dom.makeElement("div");
  menu.setAttribute("role", "menubar");
  const button = dom.makeElement("button");
  button.appendChild(dom.makeText("Show pet"));
  button.appendChild(dom.makeText("Alt+Super+P"));
  menu.appendChild(button);
  dom.body.appendChild(menu);
  const menuObserver = env.dom.mutations.find((mo) => mo && mo.observations > 0 && mo.__bnovMenuObserver === true);
  menuObserver.fire([{ type: "childList", addedNodes: [menu] }]);
  env.flushTimers();
  assert.equal(button.hidden, true);
});

// ---------------------------------------------------------------------------
// webview runtime: pets surface hiding
// ---------------------------------------------------------------------------

function makePetsDom(env) {
  const dom = env.dom;
  const nav = dom.makeElement("nav");
  nav.setAttribute("aria-label", "Settings");
  nav._attrs.class = "sidebar-navigation flex min-h-0 flex-1 flex-col";
  const scroll = dom.makeElement("div");
  scroll._attrs.class = "min-h-0 flex-1 overflow-y-auto";
  const list = dom.makeElement("div");
  scroll.appendChild(list);
  nav.appendChild(scroll);
  dom.body.appendChild(nav);
  const items = {};
  for (const label of ["General", "Pets", "Keyboard shortcuts", "Pet care", "Account"]) {
    const button = dom.makeElement("button");
    button._attrs.class = "sidebar-item relative";
    if (label !== "Pet care") button.setAttribute("aria-label", label);
    button.appendChild(dom.makeText(label));
    list.appendChild(button);
    items[label] = button;
  }
  return { dom, nav, list, items };
}

function firePetsObserver(env, addedNodes) {
  const petsObserver = env.dom.mutations.find((mo) => mo && mo.observations > 0 && mo.__bnovPetsObserver === true);
  assert.ok(petsObserver, "pets runtime installed a MutationObserver");
  petsObserver.fire([{ type: "childList", addedNodes }]);
  env.flushTimers();
}

test("webview: settings sidebar Pets tab is hidden; ordinary items untouched", () => {
  const env = runWebviewRuntimesInSandbox();
  const { items } = makePetsDom(env);
  firePetsObserver(env, [env.dom.body]);
  const pets = items["Pets"];
  assert.equal(pets.hidden, true, "Pets tab hidden attr");
  assert.equal(pets.getAttribute("aria-hidden"), "true");
  assert.equal(pets.getAttribute("tabindex"), "-1");
  assert.ok(String(pets.style.display).includes("none"), "Pets tab display none");
  assert.equal(pets.disabled, true);
  assert.equal(pets.dataset.bnovPetsHidden, "true");
  for (const label of ["General", "Keyboard shortcuts", "Pet care", "Account"]) {
    assert.equal(items[label].hidden, false, `${label} untouched`);
    assert.equal(items[label].getAttribute("aria-hidden"), null);
  }
});

test("webview: Pets settings panel (heading + content container) is hidden", () => {
  const env = runWebviewRuntimesInSandbox();
  const dom = env.dom;
  // Replicates the real panel: a scroll container holding the panel root
  // (mx-auto flex w-full flex-col max-w-3xl) with the H1 "Pets" heading and
  // the pet-size slider inside.
  const scroll = dom.makeElement("div");
  scroll._attrs.class = "flex-1 scrollbar-stable overflow-y-auto p-panel";
  const panel = dom.makeElement("div");
  panel._attrs.class = "mx-auto flex w-full flex-col max-w-3xl";
  const heading = dom.makeElement("h1");
  heading.appendChild(dom.makeText("Pets"));
  const slider = dom.makeElement("input");
  slider.setAttribute("id", "pet-size");
  panel.appendChild(heading);
  panel.appendChild(slider);
  scroll.appendChild(panel);
  dom.body.appendChild(scroll);
  firePetsObserver(env, [scroll]);
  assert.equal(heading.getAttribute("aria-hidden"), "true");
  assert.ok(String(heading.style.display).includes("none"));
  assert.equal(panel.getAttribute("aria-hidden"), "true", "panel container hidden");
  assert.ok(String(panel.style.display).includes("none"), "panel container display none");
  // The slider stays in the DOM (hidden with its container) - never removed.
  assert.equal(slider.parentNode, panel);
});

test("webview: pet avatar elements (data-codex-pet-id) are hidden wherever mounted", () => {
  const env = runWebviewRuntimesInSandbox();
  const dom = env.dom;
  const pet = dom.makeElement("div");
  pet._attrs.class = "_Root_1hrnv_1 scale-75";
  pet.setAttribute("data-codex-pet-id", "codex");
  pet.setAttribute("data-codex-pet-state", "idle");
  const wrap = dom.makeElement("div");
  wrap.appendChild(pet);
  dom.body.appendChild(wrap);
  firePetsObserver(env, [wrap]);
  assert.equal(pet.getAttribute("aria-hidden"), "true");
  assert.equal(pet.getAttribute("tabindex"), "-1");
  assert.ok(String(pet.style.display).includes("none"));
  assert.equal(pet.dataset.bnovPetsHidden, "true");
  // The wrapper is NOT touched (hide the sprite itself, not its layout slot).
  assert.equal(wrap.getAttribute("aria-hidden"), null);
});

test("webview: non-exact pet text outside the settings sidebar is untouched", () => {
  const env = runWebviewRuntimesInSandbox();
  const dom = env.dom;
  // A bare span "Pets" in a normal (non-sidebar) context and a longer
  // heading must both be left alone (exact per-text-node equality).
  const wrapper = dom.makeElement("div");
  const span = dom.makeElement("span");
  span.appendChild(dom.makeText("Pets"));
  wrapper.appendChild(span);
  const otherHeading = dom.makeElement("h2");
  otherHeading.appendChild(dom.makeText("Pet care tracker"));
  wrapper.appendChild(otherHeading);
  dom.body.appendChild(wrapper);
  firePetsObserver(env, [wrapper]);
  assert.equal(span.getAttribute("aria-hidden"), null);
  assert.equal(otherHeading.getAttribute("aria-hidden"), null);
});

test("webview: pets runtime is idempotent (second install is a no-op)", () => {
  const env = runWebviewRuntimesInSandbox();
  const { items } = makePetsDom(env);
  firePetsObserver(env, [env.dom.body]);
  assert.equal(items["Pets"].hidden, true);
  // Re-run the compiled pets runtime: the window marker must short-circuit
  // without throwing.
  const source = buildWebviewRuntimes({ manifest: MANIFEST, settings: {} }).pets;
  vm.runInNewContext(source, env.sandbox, { filename: "wv-pets-second.js" });
  assert.equal(env.sandbox.__bnovPetsInstalled, true);
  assert.equal(items["Pets"].dataset.bnovPetsHidden, "true");
});

test("webview: added node that IS the pet element gets hidden (self + descendants)", () => {
  const env = runWebviewRuntimesInSandbox();
  const dom = env.dom;
  // React commits the H1 itself and the sprite div as their own addedNodes
  // (not wrapped in a fresh parent) - scanRoot must check the node itself.
  const heading = dom.makeElement("h1");
  heading.appendChild(dom.makeText("Pets"));
  const sprite = dom.makeElement("div");
  sprite.setAttribute("data-codex-pet-id", "dewey");
  sprite.setAttribute("data-codex-pet-state", "idle");
  const sibling = dom.makeElement("span");
  sibling.appendChild(dom.makeText("unrelated"));
  sprite.appendChild(sibling);
  firePetsObserver(env, [heading, sprite]);
  assert.equal(heading.getAttribute("aria-hidden"), "true");
  assert.ok(String(heading.style.display).includes("none"));
  assert.equal(sprite.getAttribute("aria-hidden"), "true");
  assert.ok(String(sprite.style.display).includes("none"));
  // a non-pet descendant of the sprite stays untouched
  assert.equal(sibling.getAttribute("aria-hidden"), null);
});

test("webview: records arriving while a scan is queued are accumulated, not dropped", () => {
  const env = runWebviewRuntimesInSandbox();
  const dom = env.dom;
  const petsObserver = env.dom.mutations.find((mo) => mo && mo.observations > 0 && mo.__bnovPetsObserver === true);
  assert.ok(petsObserver);
  const a = dom.makeElement("div");
  a.setAttribute("data-codex-pet-id", "a");
  const b = dom.makeElement("div");
  b.setAttribute("data-codex-pet-id", "b");
  dom.body.appendChild(a);
  dom.body.appendChild(b);
  // Two batches: the first queues a scan, the second arrives while pending.
  petsObserver.fire([{ type: "childList", addedNodes: [a] }]);
  petsObserver.fire([{ type: "childList", addedNodes: [b] }]);
  env.flushTimers();
  assert.equal(a.getAttribute("aria-hidden"), "true");
  assert.equal(b.getAttribute("aria-hidden"), "true");
});

// ---------------------------------------------------------------------------
// patch.js: descriptor behavior
// ---------------------------------------------------------------------------

function sampleSources() {
  const mainSrc = "// official main bundle\nexports.runMainAppStartup = () => {};\n";
  const webviewSrc = "// official webview bundle (marker subset)\nconst a = \"ab.chatgpt.com\"; const b = \"/ces/v1/rgstr\"; const sidebarProjectRow = \"x\";\n";
  return { mainSrc, webviewSrc };
}

function patchContext() {
  return { feature: { manifest: MANIFEST, settings: {} } };
}

test("patch: main bundle patch appends the runtime once (idempotent) and fails soft on drift", () => {
  const { mainSrc } = sampleSources();
  const once = patch.applyMainBundlePatch(mainSrc, patchContext());
  assert.notEqual(once, mainSrc);
  assert.ok(once.includes(patch.MAIN_IDEMPOTENT_MARKER));
  assert.equal(patch.applyMainBundlePatch(once, patchContext()), once);
  // Drift: no anchor -> untouched, no throw.
  const drifted = patch.applyMainBundlePatch("no anchor here", patchContext());
  assert.equal(drifted, "no anchor here");
});

test("patch: webview descriptors append each runtime exactly once; non-target untouched", () => {
  const { webviewSrc } = sampleSources();
  const idToMarker = {
    "statsig-local-responder": patch.WEBVIEW_IDEMPOTENT_MARKERS.statsig,
    "network-block-guard": patch.WEBVIEW_IDEMPOTENT_MARKERS.network,
    "brand-text-overlay": patch.WEBVIEW_IDEMPOTENT_MARKERS.brand,
    "menu-item-hider": patch.WEBVIEW_IDEMPOTENT_MARKERS.menu,
    "pets-surface-hider": patch.WEBVIEW_IDEMPOTENT_MARKERS.pets,
  };
  let source = webviewSrc;
  for (const descriptor of patch.descriptors.filter((d) => d.phase === "webview-asset")) {
    const next = descriptor.apply(source, patchContext());
    assert.notEqual(next, source, `${descriptor.id} applied`);
    assert.ok(next.includes(idToMarker[descriptor.id]), descriptor.id);
    // second application is a no-op
    assert.equal(descriptor.apply(next, patchContext()), next, `${descriptor.id} idempotent`);
    source = next;
  }
  const nonTarget = "console.log(1)";
  const menuDescriptor = patch.descriptors.find((d) => d.id === "menu-item-hider");
  assert.equal(menuDescriptor.apply(nonTarget, patchContext()), nonTarget);
  assert.equal(menuDescriptor.assetMatch("console.log(1)"), false);
  assert.equal(menuDescriptor.assetMatch(webviewSrc), true);
});

test("patch: all six descriptors exist with distinct ids and expected phases/orders", () => {
  assert.equal(patch.descriptors.length, 6);
  const ids = patch.descriptors.map((d) => d.id);
  assert.deepEqual(new Set(ids).size, ids.length);
  assert.deepEqual(
    patch.descriptors.map((d) => d.phase),
    ["main-bundle", "webview-asset", "webview-asset", "webview-asset", "webview-asset", "webview-asset"],
  );
  assert.deepEqual(patch.descriptors.map((d) => d.id).at(-1), "pets-surface-hider");
  assert.equal(patch.descriptors.at(-1).order, 20855);
  const orders = patch.descriptors.map((d) => d.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  assert.ok(patch.descriptors.every((d) => d.ciPolicy === "optional"));
});

// ---------------------------------------------------------------------------
// main-bundle runtime: must install cleanly in a Node/Electron-like sandbox.
// Regression: a missing inlined constant (BRAND_NAME_MAX_LENGTH) previously made
// the whole main runtime throw a ReferenceError at install time, silently
// disabling main-process net.fetch blocking.
// ---------------------------------------------------------------------------

test("main runtime: installs in a sandbox and blocks net.fetch per config", async () => {
  const { buildMainRuntime } = require("./runtime/main-runtime.js");
  const source = buildMainRuntime({ manifest: MANIFEST, settings: {} });

  const warns = [];
  const electronStub = {
    net: { fetch: async () => ({ ok: true, status: 200, marker: "native" }) },
    session: {},
    app: { on() {}, getAllWindows() { return []; } },
  };
  const sandbox = {
    console: { warn: (m) => warns.push(String(m)), log() {}, error() {} },
    process: { env: { CODEX_DESKTOP_CONFIG: "/nonexistent/config.yaml" } },
    Buffer,
    setTimeout,
    clearTimeout,
    // URL is not part of a bare vm context; the runtime and isBlockedUrl rely on
    // the global URL parser, so the sandbox must expose it like a real realm.
    URL,
    require: (name) => {
      if (name === "electron") return electronStub;
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      if (name === "node:url") return require("node:url");
      throw new Error("unexpected require: " + name);
    },
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(source, sandbox, { filename: "bnov-main-runtime.js" });

  const failed = warns.filter((m) => m.includes("install failed"));
  assert.deepEqual(failed, [], "main runtime must not fail to install");
  assert.equal(sandbox.__bnovMainRuntimeInstalled, true);
  assert.ok(
    warns.some((m) => m.includes("main runtime installed")),
    "main runtime should log the installed marker",
  );

  // The wrap installs the hooked fetch onto the electron net object; the
  // blocked host must return a local 200 JSON body instead of the native fetch.
  const blocked = await electronStub.net.fetch("https://chatgpt.com/ces/v1/rgstr");
  assert.equal(blocked.status, 200);
  assert.equal(await blocked.text(), "{}");

  const open = await electronStub.net.fetch("https://example.org/");
  assert.equal(open.marker, "native");
});

// Regression: the Statsig control plane must be answered BEFORE the generic
// block list. The default block list contains *.chatgpt.com, so
// ab.chatgpt.com/v1/initialize also matches the block list; if the block check
// ran first it would answer a bare "{}", the official Statsig SDK would fail to
// parse it, the i18n layer (72216192 enable_i18n) would fall back to false, and
// the whole UI would stay in English even though the locale resolves to zh-CN.
test("main runtime: Statsig initialize is served its legal payload even when the host is in the block list", async () => {
  const { buildMainRuntime } = require("./runtime/main-runtime.js");
  const manifest = {
    brandNetworkOverlay: {
      brand: { name: "wdev" },
      // *.chatgpt.com is the shipping default, so ab.chatgpt.com is blocked.
      network: { block: ["chatgpt.com", "*.chatgpt.com", "*.openai.com"], allow: [] },
      statsig: { initializeDelayMs: 0 },
    },
  };
  const source = buildMainRuntime({ manifest, settings: {} });

  const warns = [];
  const electronStub = {
    net: { fetch: async () => ({ ok: true, status: 200, marker: "native" }) },
    session: {},
    app: { on() {}, getAllWindows() { return []; } },
  };
  const req = (n) => {
    if (n === "electron") return electronStub;
    if (n === "node:fs") return fs;
    if (n === "node:path") return path;
    if (n === "node:url") return require("node:url");
    throw new Error("unexpected require: " + n);
  };
  const sandbox = {
    console: { warn: (m) => warns.push(String(m)), log() {}, error() {} },
    process: { env: { CODEX_DESKTOP_CONFIG: "/nonexistent/config.yaml" } },
    Buffer,
    setTimeout,
    clearTimeout,
    URL,
    require: req,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "bnov-main-runtime.js" });

  // ab.chatgpt.com matches *.chatgpt.com (blocked) yet must get the gate payload.
  const init = await electronStub.net.fetch("https://ab.chatgpt.com/v1/initialize");
  assert.equal(init.status, 200);
  const initBody = JSON.parse(await init.text());
  assert.equal(initBody.has_updates, true);
  assert.equal(initBody.layer_configs["72216192"].value.enable_i18n, true, "i18n layer must stay enabled");
  assert.equal(initBody.feature_gates["505458"].value, true);
  assert.notEqual(JSON.stringify(initBody), "{}", "initialize must never be answered with a bare {}");

  // A plain blocked host still gets the bare "{}" short-circuit.
  const blocked = await electronStub.net.fetch("https://chatgpt.com/ces/v1/rgstr");
  assert.equal(blocked.status, 200);
  assert.equal(await blocked.text(), "{}");
});

test("patch: real upstream bundles (26.908.40834) accept all five descriptors", (t, done) => {
  const asarDir = "/data/tmp/overlay-inspect/asar";
  if (!fs.existsSync(asarDir)) {
    t.skip("upstream asar extract not present");
    done();
    return;
  }
  try {
    const { applyMainBundlePatch } = patch;
    const mainFile = fs.readdirSync(path.join(asarDir, ".vite", "build")).find((n) => /^main(?:-[^.]+)?\.js$/.test(n));
    const mainSrc = fs.readFileSync(path.join(asarDir, ".vite", "build", mainFile), "utf8");
    const patchedMain = applyMainBundlePatch(mainSrc, patchContext());
    assert.notEqual(patchedMain, mainSrc);
    assert.equal(patch.applyMainBundlePatch(patchedMain, patchContext()), patchedMain);

    const assetDir = path.join(asarDir, "webview", "assets");
    const targetName = fs.readdirSync(assetDir).find((n) => {
      if (!/^app-initial-[^.]+\.js$/.test(n)) return false;
      const source = fs.readFileSync(path.join(assetDir, n), "utf8");
      return patch.WEBVIEW_BUNDLE_MARKERS.every((marker) => source.includes(marker));
    });
    assert.ok(targetName, "webview target bundle found in the upstream asar");
    const webviewSrc = fs.readFileSync(path.join(assetDir, targetName), "utf8");
    let source = webviewSrc;
    for (const descriptor of patch.descriptors.filter((d) => d.phase === "webview-asset")) {
      source = descriptor.apply(source, patchContext());
      assert.notEqual(source, webviewSrc);
    }
    done();
  } catch (error) {
    done(error);
  }
});

// ---------------------------------------------------------------------------
// allowPaths (URL-level temporary allow) + structured audit log
//---------------------------------------------------------------------------

test("host-match: parseAllowPathRule splits at the first slash, drops invalid, dedupes", () => {
  const m = require("./lib/host-match.js");
  assert.deepEqual(m.parseAllowPathRule("ab.chatgpt.com/v1/initialize"), { host: "ab.chatgpt.com", path: "v1/initialize" });
  // host-only entry (no "/") == allow entry
  assert.deepEqual(m.parseAllowPathRule("ok.host"), { host: "ok.host", path: null });
  // a full pasted URL in the host part is NOT a legal rule (host would be "https:") -> dropped; the host itself still tolerates port/query junk via normalizeHostPattern
  assert.equal(m.parseAllowPathRule("https://a.b.com:443/x/y"), null);
  assert.deepEqual(m.parseAllowPathRule("a.b.com:443/x/y"), { host: "a.b.com", path: "x/y" });
  // path keeps case; a stray query/fragment in the config is stripped
  assert.deepEqual(m.parseAllowPathRule("c.com/API/Path?x=1"), { host: "c.com", path: "API/Path" });
  // invalid entries drop
  assert.equal(m.parseAllowPathRule("bad host!/x"), null);
  assert.equal(m.parseAllowPathRule("x/"), null);
  assert.equal(m.parseAllowPathRule("x/?q=1"), null);
  assert.equal(m.parseAllowPathRule(""), null);
  // normalize: drop + dedupe (case-insensitive host) + keep order
  const rules = m.normalizeAllowPathList(["a.com/x", "A.com/x", "bad!", "b.com", "a.com/y"]);
  assert.equal(rules.length, 3);
  assert.deepEqual(rules[0], { host: "a.com", path: "x" });
  assert.deepEqual(rules[1], { host: "b.com", path: null });
  assert.deepEqual(rules[2], { host: "a.com", path: "y" });
});

test("host-match: pathMatchesGlob is case-sensitive, * crosses /, leading slash ignored", () => {
  const { pathMatchesGlob } = require("./lib/host-match.js");
  assert.equal(pathMatchesGlob("v1/initialize", "v1/initialize"), true); // exact
  assert.equal(pathMatchesGlob("v1/initialize2", "v1/initialize"), false);
  assert.equal(pathMatchesGlob("backend-api/a/b", "backend-api/*"), true); // * crosses /
  assert.equal(pathMatchesGlob("backend-api2/x", "backend-api/*"), false); // . stays literal
  assert.equal(pathMatchesGlob("Backend-api/x", "backend-api/*"), false); // case-sensitive
  assert.equal(pathMatchesGlob("backend-api/x", "/backend-api/*"), true); // leading slash equivalent
  assert.equal(pathMatchesGlob("x", ""), false);
  assert.equal(pathMatchesGlob("a.b", "a.b"), true);
  assert.equal(pathMatchesGlob("axb", "a.b"), false);
});

test("host-match: isBlockedUrl allowPaths outrank block; urlPolicy audit decisions", () => {
  const m = require("./lib/host-match.js");
  const allowedPaths = m.normalizeAllowPathList([
    "ab.chatgpt.com/v1/initialize",
    "chatgpt.com/backend-api/*",
    "loose.host",
  ]);
  const network = {
    blockedHosts: ["chatgpt.com", "*.chatgpt.com"],
    allowedHosts: ["ok.chatgpt.com"],
    allowedPaths: allowedPaths,
  };
  // allowPaths hit on a blocked host family -> not blocked (real request goes out)
  assert.equal(m.isBlockedUrl("https://ab.chatgpt.com/v1/initialize", network), false);
  assert.equal(m.isBlockedUrl("https://chatgpt.com/backend-api/wham/usage?x=1", network), false); // query ignored
  assert.equal(m.isBlockedUrl("https://loose.host/whatever", network), false); // host-only rule
  // same host, non-matching path -> still blocked
  assert.equal(m.isBlockedUrl("https://chatgpt.com/ces/v1/other", network), true);
  // allow(host) still passes without allowPaths involvement
  assert.equal(m.isBlockedUrl("https://ok.chatgpt.com/x", network), false);
  // allowPaths without any block -> trivially not blocked
  assert.equal(m.isBlockedUrl("https://ab.chatgpt.com/v1/initialize", { blockedHosts: [], allowedPaths }), false);
  // non-http(s) / junk never blocked
  assert.equal(m.isBlockedUrl("sentry-ipc://local", network), false);
  assert.equal(m.isBlockedUrl("/relative", network), false);
  // urlPolicy is the audit-oriented view of the same decision
  assert.equal(m.urlPolicy("https://chatgpt.com/backend-api/x", network), "allow-path");
  assert.equal(m.urlPolicy("https://chatgpt.com/ces/v1/other", network), "block");
  assert.equal(m.urlPolicy("https://api.github.com/x", network), "passthrough");
  assert.equal(m.urlPolicy("not a url", network), "passthrough");
  assert.equal(m.urlPolicy("file:///x", network), "passthrough");
  // urlMatchesAllowPath standalone
  assert.equal(m.urlMatchesAllowPath("https://chatgpt.com/backend-api/x?y=1", allowedPaths), true);
  assert.equal(m.urlMatchesAllowPath("https://chatgpt.com/other", allowedPaths), false);
  assert.equal(m.urlMatchesAllowPath("https://loose.host/deep/path", allowedPaths), true);
  assert.equal(m.urlMatchesAllowPath("file:///x", allowedPaths), false);
});

test("site-config: parses network.allowPaths (block list, junk dropped, deduped); configured with only allowPaths", () => {
  const yaml = [
    "network:",
    "  block:",
    '    - "*.chatgpt.com"',
    "  allow: []",
    "  allowPaths:",
    '    - "ab.chatgpt.com/v1/initialize"',
    '    - "chatgpt.com/backend-api/*"',
    "    - loose.host",
    '    - "bad! host"',
    '    - "x/"',
    '    - "ab.chatgpt.com/v1/initialize"',
  ].join("\n");
  const config = siteConfig.loadSiteConfig({ readText: () => yaml, env: {} });
  assert.deepEqual(config.network.allowedPaths, [
    { host: "ab.chatgpt.com", path: "v1/initialize" },
    { host: "chatgpt.com", path: "backend-api/*" },
    { host: "loose.host", path: null },
  ]);
  assert.equal(config.network.configured, true);

  const only = siteConfig.loadSiteConfig({ readText: () => "network:\n  allowPaths:\n    - a.com/x", env: {} });
  assert.equal(only.network.configured, true, "configured must be true when only allowPaths is set");
  assert.deepEqual(only.network.blockedHosts, []);
  assert.deepEqual(only.network.allowedPaths, [{ host: "a.com", path: "x" }]);

  const none = siteConfig.loadSiteConfig({ readText: () => "", env: {} });
  assert.deepEqual(none.network.allowedPaths, []);
  assert.equal(none.network.configured, false);
});

test("main runtime: allowPaths opens the hole (no local {}) + audit file fields, no query", async () => {
  const { buildMainRuntime } = require("./runtime/main-runtime.js");
  const manifest = {
    brandNetworkOverlay: {
      brand: { name: "wdev" },
      network: { block: ["chatgpt.com", "*.chatgpt.com"], allow: [], allowPaths: ["chatgpt.com/backend-api/*"] },
      statsig: { initializeDelayMs: 0 },
    },
  };
  const source = buildMainRuntime({ manifest, settings: {} });
  const auditFile = fs.mkdtempSync(path.join(os.tmpdir(), "bnov-audit-")) + "/audit.jsonl";
  const warns = [];
  const electronStub = {
    net: { fetch: async () => ({ ok: true, status: 200, marker: "native" }) },
    session: {},
    app: { on() {}, getAllWindows() { return []; }, getVersion() { return "9.9.9-test"; } },
  };
  const req = (n) => {
    if (n === "electron") return electronStub;
    if (n === "node:fs") return fs;
    if (n === "node:path") return path;
    if (n === "node:url") return require("node:url");
    throw new Error("unexpected require: " + n);
  };
  const sandbox = {
    console: { warn: (m) => warns.push(String(m)), log() {}, info() {}, error() {} },
    process: { env: { CODEX_DESKTOP_CONFIG: "/nonexistent/config.yaml", CODEX_DESKTOP_NETWORK_AUDIT_LOG: auditFile } },
    Buffer,
    setTimeout,
    clearTimeout,
    URL,
    require: req,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "bnov-main-runtime-allowpath.js" });
  assert.equal(sandbox.__bnovMainRuntimeInstalled, true);

  // allowPaths hit inside the blocked family -> native fetch, NOT the local {}
  const allowed = await electronStub.net.fetch("https://chatgpt.com/backend-api/wham/usage?token=SECRET", { method: "post" });
  assert.equal(allowed.marker, "native", "allowPaths hit must pass through to the native fetch");
  // same family, non-matching path -> local {} short-circuit
  const blocked = await electronStub.net.fetch("https://assets.chatgpt.com/app.js", { method: "GET" });
  assert.equal(blocked.status, 200);
  assert.equal(await blocked.text(), "{}");

  const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  // startup config line: policy snapshot with version + counts + lists
  const configLine = lines.find((l) => l.event === "config");
  assert.ok(configLine, "a config line must be written on install");
  assert.equal(configLine.layer, "desktop-net-fetch");
  assert.equal(configLine.version, "9.9.9-test");
  assert.equal(configLine.blockedCount, 2);
  assert.equal(configLine.allowedCount, 0);
  assert.equal(configLine.allowedPathsCount, 1);
  assert.deepEqual(configLine.blockedHosts, ["chatgpt.com", "*.chatgpt.com"]);
  assert.deepEqual(configLine.allowedPathRules, ["chatgpt.com/backend-api/*"]);
  // allow-path + block lines: host + pathname only, method upper-cased, NO query
  const allowLine = lines.find((l) => l.event === "allow-path");
  assert.ok(allowLine, "allow-path line present");
  assert.equal(allowLine.host, "chatgpt.com");
  assert.equal(allowLine.path, "/backend-api/wham/usage");
  assert.equal(allowLine.method, "POST");
  const blockLine = lines.find((l) => l.event === "block");
  assert.ok(blockLine, "block line present");
  assert.equal(blockLine.layer, "desktop-net-fetch");
  assert.equal(blockLine.host, "assets.chatgpt.com");
  assert.equal(blockLine.path, "/app.js");
  assert.ok(!JSON.stringify(lines).includes("token=SECRET"), "query must never be written");
  // every line has the fixed field set and a valid ts
  for (const l of lines) {
    assert.ok(typeof l.ts === "string" && !Number.isNaN(Date.parse(l.ts)), "ts is ISO8601");
    assert.ok(["block", "allow-path", "statsig-local", "config"].includes(l.event));
    assert.ok(["desktop-net-fetch", "desktop-webrequest", "desktop-webview"].includes(l.layer));
  }
});

test("main runtime: CODEX_DESKTOP_NETWORK_AUDIT_LOG 0/off/none disable the file (case-insensitive)", async () => {
  const { buildMainRuntime } = require("./runtime/main-runtime.js");
  const manifest = {
    brandNetworkOverlay: {
      brand: { name: "wdev" },
      network: { block: ["*.example.com"], allow: [], allowPaths: [] },
      statsig: { initializeDelayMs: 0 },
    },
  };
  const source = buildMainRuntime({ manifest, settings: {} });
  for (const offValue of ["off", "OFF", "0", "none"]) {
    const auditFile = fs.mkdtempSync(path.join(os.tmpdir(), "bnov-audit-off-")) + "/audit.jsonl";
    const warns = [];
    const electronStub = {
      net: { fetch: async () => ({ ok: true, status: 200, marker: "native" }) },
      session: {},
      app: { on() {}, getAllWindows() { return []; } },
    };
    const req = (n) => {
      if (n === "electron") return electronStub;
      if (n === "node:fs") return fs;
      if (n === "node:path") return path;
      if (n === "node:url") return require("node:url");
      throw new Error("unexpected require: " + n);
    };
    const sandbox = {
      console: { warn: (m) => warns.push(String(m)), log() {}, info() {}, error() {} },
      process: { env: { CODEX_DESKTOP_CONFIG: "/nonexistent/config.yaml", CODEX_DESKTOP_NETWORK_AUDIT_LOG: offValue } },
      Buffer,
      setTimeout,
      clearTimeout,
      URL,
      require: req,
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(source, sandbox, { filename: "bnov-main-runtime-audit-off.js" });
    assert.equal(sandbox.__bnovMainRuntimeInstalled, true);
    // trigger one block so a disabled writer would have written the file
    const blocked = await electronStub.net.fetch("https://cdn.example.com/a.js");
    assert.equal(await blocked.text(), "{}");
    assert.ok(!fs.existsSync(auditFile), "no file may be created for value: " + offValue);
    assert.deepEqual(
      warns.filter((m) => m.includes("audit write failed")),
      [],
      "a disabled audit log must not fall back to console warnings",
    );
  }
});

test("main runtime: [bnov-audit] console-message lines persist as desktop-webview records", async () => {
  const { buildMainRuntime } = require("./runtime/main-runtime.js");
  const manifest = {
    brandNetworkOverlay: {
      brand: { name: "wdev" },
      network: { block: ["*.example.com"], allow: [], allowPaths: [] },
      statsig: { initializeDelayMs: 0 },
    },
  };
  const source = buildMainRuntime({ manifest, settings: {} });
  const auditFile = fs.mkdtempSync(path.join(os.tmpdir(), "bnov-audit-wv-")) + "/audit.jsonl";
  const handlers = {};
  const win = {
    webContents: {
      on(name, fn) {
        (handlers[name] = handlers[name] || []).push(fn);
      },
      executeJavaScript: () => Promise.resolve(),
    },
  };
  const electronStub = {
    net: { fetch: async () => ({ ok: true, status: 200, marker: "native" }) },
    session: {},
    app: { on() {}, getAllWindows() { return [win]; } },
  };
  const req = (n) => {
    if (n === "electron") return electronStub;
    if (n === "node:fs") return fs;
    if (n === "node:path") return path;
    if (n === "node:url") return require("node:url");
    throw new Error("unexpected require: " + n);
  };
  const sandbox = {
    console: { warn() {}, log() {}, info() {}, error() {} },
    process: { env: { CODEX_DESKTOP_CONFIG: "/nonexistent/config.yaml", CODEX_DESKTOP_NETWORK_AUDIT_LOG: auditFile } },
    Buffer,
    setTimeout,
    clearTimeout,
    URL,
    require: req,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "bnov-main-runtime-wv.js" });

  const cm = handlers["console-message"];
  assert.ok(cm && cm.length, "console-message handler must be installed");
  cm[0]({}, 1, '[bnov-audit] {"event":"block","host":"cdn.example.com","path":"/a.js?secret=1","method":"get"}');
  cm[0]({}, 1, '[bnov-audit] {"event":"allow-path","host":"cdn.example.com","path":"/api/v2"}');
  // noise must be ignored without throwing
  cm[0]({}, 1, "unrelated console noise");
  cm[0]({}, 1, "[bnov-audit] {not json");
  cm[0]({}, 1, '[bnov-audit] {"event":"weird","host":"x.com","path":"/"}');

  const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const webviewLines = lines.filter((l) => l.layer === "desktop-webview");
  assert.equal(webviewLines.length, 2, "only the two valid renderer lines are persisted");
  assert.equal(webviewLines[0].event, "block");
  assert.equal(webviewLines[0].host, "cdn.example.com");
  assert.equal(webviewLines[0].path, "/a.js"); // query stripped on persist
  assert.equal(webviewLines[0].method, "GET");
  assert.equal(webviewLines[1].event, "allow-path");
  assert.equal(webviewLines[1].method, "");
});

test("webview: allowPaths passes through at the renderer and emits [bnov-audit] lines", async () => {
  const auditLines = [];
  const env = runWebviewRuntimesInSandbox({
    auditLines,
    manifest: {
      brandNetworkOverlay: {
        brand: { name: "wdev" },
        network: { block: ["*.example.com", "chatgpt.com"], allow: [], allowPaths: ["*.example.com/api/*"] },
        statsig: { initializeDelayMs: 0 },
      },
    },
  });
  // allowPaths hit inside the blocked family -> native fetch (the hole opened)
  const allowed = await env.sandbox.fetch("https://cdn.example.com/api/v2?token=SECRET");
  assert.equal(allowed.native, true, "renderer allowPaths hit must reach the native fetch");
  // same family, non-matching path -> local 200
  const blocked = await env.sandbox.fetch("https://cdn.example.com/assets/app.js");
  assert.equal(await blocked.text(), "{}");

  // audit lines: compact JSON behind the fixed prefix, no query, host+path only
  const audit = auditLines
    .filter((l) => l.startsWith("[bnov-audit] "))
    .map((l) => JSON.parse(l.slice("[bnov-audit] ".length)));
  assert.deepEqual(audit.map((l) => l.event), ["allow-path", "block"]);
  assert.equal(audit[0].host, "cdn.example.com");
  assert.equal(audit[0].path, "/api/v2");
  assert.equal(audit[1].host, "cdn.example.com");
  assert.equal(audit[1].path, "/assets/app.js");
  assert.ok(!auditLines.join("\n").includes("SECRET"), "query must never reach the audit line");
});

test("generated runtime sources: main + all five webview IIFEs parse (syntax self-check)", () => {
  const { buildMainRuntime } = require("./runtime/main-runtime.js");
  const { buildWebviewRuntimes } = require("./runtime/webview-runtime.js");
  const manifest = {
    brandNetworkOverlay: {
      brand: { name: "wdev" },
      network: { block: ["*.example.com"], allow: [], allowPaths: ["*.example.com/api/*"] },
      statsig: { initializeDelayMs: 400 },
    },
  };
  const main = buildMainRuntime({ manifest, settings: {} });
  new Function(main); // throws on syntax error
  for (const [name, source] of Object.entries(buildWebviewRuntimes({ manifest, settings: {} }))) {
    new Function(source);
  }
});
