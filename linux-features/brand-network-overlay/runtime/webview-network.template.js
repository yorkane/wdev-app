/*
 * brand-network-overlay webview runtime: outbound network guard.
 * Ported from OpenCodex codex-network-guard.js. Takes over window.fetch,
 * XMLHttpRequest and navigator.sendBeacon for hosts matched by the site
 * block list (allow wins over block; only http(s); *.x.com = subdomains
 * only; URL-level allowPaths outrank block). Blocked requests never leave
 * the machine: fetch gets a local 200 JSON response, XHR gets a simulated
 * async 200 (read-only IDL properties overwritten via Object.defineProperty,
 * events dispatched after send() returns because the caller registers load
 * then), sendBeacon returns true.
 * Statsig control-plane URLs are answered with the legal payload shapes via
 * the __bnovStatsig* globals exposed by the statsig runtime (installed
 * first), falling back to local builders.
 * Installed when a block or allowPaths list is configured.
 *
 * Audit: the renderer cannot write files. Every block / allow-path decision
 * is also emitted as a compact JSON console.info line prefixed with
 * "[bnov-audit]"; the main runtime listens on
 * webContents "console-message" and persists those lines as
 * layer "desktop-webview" audit records. If that capture chain is not
 * active, the same line remains grep-able in the app log (best effort).
 */
;(function () {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const w = window;
  if (w.__bnovNetworkInstalled === true) return;

  const BAKED_CONFIG = __BAKED_CONFIG_JSON__;
  const RT_CONFIG = typeof w.__bnovConfig === "object" && w.__bnovConfig !== null ? w.__bnovConfig : null;
  const rtNetwork = RT_CONFIG && RT_CONFIG.network && typeof RT_CONFIG.network === "object" ? RT_CONFIG.network : null;

  let blockedHosts = [];
  let allowedHosts = [];
  let allowedPaths = [];
  if (rtNetwork && (Array.isArray(rtNetwork.blockedHosts) || Array.isArray(rtNetwork.allowedHosts))) {
    blockedHosts = Array.isArray(rtNetwork.blockedHosts) ? rtNetwork.blockedHosts : [];
    allowedHosts = Array.isArray(rtNetwork.allowedHosts) ? rtNetwork.allowedHosts : [];
    // Injected config carries the normalized rule objects {host, path|null};
    // the baked config carries raw strings and is normalized here.
    allowedPaths = Array.isArray(rtNetwork.allowedPaths) ? rtNetwork.allowedPaths : [];
  } else {
    blockedHosts = BAKED_CONFIG.network && Array.isArray(BAKED_CONFIG.network.block) ? BAKED_CONFIG.network.block : [];
    allowedHosts = BAKED_CONFIG.network && Array.isArray(BAKED_CONFIG.network.allow) ? BAKED_CONFIG.network.allow : [];
    try {
      allowedPaths = normalizeAllowPathList(
        BAKED_CONFIG.network && Array.isArray(BAKED_CONFIG.network.allowPaths) ? BAKED_CONFIG.network.allowPaths : []
      );
    } catch (err) {
      allowedPaths = [];
    }
  }
  if (!blockedHosts.length && !allowedPaths.length) return;

  w.__bnovNetworkInstalled = true;

  __HOST_MATCH_FUNCTIONS__

  function parseRequestUrl(raw) {
    try {
      let value = raw;
      if (value && typeof value === "object" && typeof value.url === "string") value = value.url;
      else if (typeof value !== "string") value = value == null ? "" : String(value);
      if (!value) return null;
      return new URL(value, location.href);
    } catch (err) {
      return null;
    }
  }

  // "block" | "allow-path" | "passthrough" - identical semantics to the
  // gateway urlPolicy / main runtime, so all interception layers agree.
  function policyParsed(parsed) {
    if (!parsed) return false;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = String(parsed.hostname || "").toLowerCase();
    if (!host) return false;
    if (hostPathMatchesAllowPath(host, parsed.pathname, allowedPaths)) return "allow-path";
    if (allowedHosts.some((pattern) => hostMatchesPattern(host, pattern))) return false;
    if (blockedHosts.some((pattern) => hostMatchesPattern(host, pattern))) return "block";
    return false;
  }

  // Best-effort audit line for the main-process capture hook. Never throws:
  // a broken audit path must not change interception behavior.
  function auditLine(event, parsed) {
    try {
      const host = String((parsed && parsed.hostname) || "").toLowerCase();
      const path = String((parsed && parsed.pathname) || "").replace(/[?#].*$/, "");
      console.info(
        "[bnov-audit] " +
          JSON.stringify({ event: event, host: host, path: path.slice(0, 2048) })
      );
    } catch (err) {}
  }

  function statsigBodyFor(rawUrl, parsed) {
    // Reuse the statsig runtime globals when present (identical shapes);
    // fall back to local builders so a missing inner layer degrades to a
    // legal body instead of "{}".
    const initFn = typeof w.__bnovStatsigInitialize === "function" ? w.__bnovStatsigInitialize : null;
    const evalFn = typeof w.__bnovStatsigEvaluation === "function" ? w.__bnovStatsigEvaluation : null;
    try {
      const url = new URL(String(rawUrl || ""), location.href);
      const pathname = url.pathname.replace(/\/+$/, "");
      if (url.hostname === "ab.chatgpt.com" && pathname === "/v1/initialize") {
        return initFn ? JSON.stringify(initFn()) : "{}";
      }
      if (url.hostname === "ab.chatgpt.com" && pathname.startsWith("/v1/")) {
        return evalFn
          ? JSON.stringify(evalFn(pathname))
          : JSON.stringify({ has_updates: false, time: Date.now(), feature_gates: {}, dynamic_configs: {}, layer_configs: {} });
      }
    } catch (err) {}
    return "{}";
  }

  function jsonResponse(body) {
    return new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  }

  // Channel 1: fetch.
  if (typeof w.fetch === "function") {
    const originalFetch = w.fetch.bind(w);
    w.fetch = function (input, init) {
      const parsed = parseRequestUrl(input);
      const decision = policyParsed(parsed);
      if (decision === "allow-path") {
        // Temporary allowPaths hit: pass through to the real fetch (the
        // whole point of the hole) and tell the operator it took effect.
        auditLine("allow-path", parsed);
        return originalFetch(input, init);
      }
      if (decision !== "block") return originalFetch(input, init);
      auditLine("block", parsed);
      const raw = parsed.toString();
      return Promise.resolve(jsonResponse(statsigBodyFor(raw, parsed)));
    };
  }

  // Channel 2: XMLHttpRequest.
  if (typeof w.XMLHttpRequest === "function") {
    const xhrPrototype = w.XMLHttpRequest.prototype;
    const originalOpen = xhrPrototype.open;
    const originalSend = xhrPrototype.send;

    xhrPrototype.open = function (method, url, rest) {
      this.__bnovUrl = typeof url === "string" ? url : "";
      return originalOpen.apply(this, arguments);
    };

    xhrPrototype.send = function (body) {
      const raw = String(this.__bnovUrl || "");
      const parsed = parseRequestUrl(raw);
      const decision = policyParsed(parsed);
      if (decision === "allow-path") {
        auditLine("allow-path", parsed);
        return originalSend.call(this, body);
      }
      if (decision !== "block") return originalSend.call(this, body);
      auditLine("block", parsed);
      const xhr = this;
      const responseBody = statsigBodyFor(raw, parsed);
      function defineReadOnly(target, name, value) {
        try {
          Object.defineProperty(target, name, { configurable: true, enumerable: true, get: function () { return value; } });
        } catch (err) {}
      }
      function dispatch(type) {
        try {
          xhr.dispatchEvent(new Event(type));
        } catch (err) {}
      }
      dispatch("loadstart");
      setTimeout(function () {
        defineReadOnly(xhr, "status", 200);
        defineReadOnly(xhr, "statusText", "OK");
        defineReadOnly(xhr, "response", responseBody);
        defineReadOnly(xhr, "responseText", responseBody);
        defineReadOnly(xhr, "readyState", 4);
        dispatch("readystatechange");
        dispatch("load");
        dispatch("loadend");
      }, 0);
      return undefined;
    };
  }

  // Channel 3: sendBeacon.
  if (w.navigator && typeof w.navigator.sendBeacon === "function") {
    const originalSendBeacon = w.navigator.sendBeacon.bind(w.navigator);
    w.navigator.sendBeacon = function (url, data) {
      const parsed = parseRequestUrl(url);
      const decision = policyParsed(parsed);
      if (decision === "allow-path") {
        auditLine("allow-path", parsed);
        return originalSendBeacon.apply(w.navigator, arguments);
      }
      if (decision !== "block") return originalSendBeacon.apply(w.navigator, arguments);
      auditLine("block", parsed);
      return true;
    };
  }
})();
