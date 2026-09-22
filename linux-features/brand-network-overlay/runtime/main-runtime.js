// Builds the main-process runtime source (appended to .vite/build/main*.js).
//
// The official main bundle is a CJS module, so the injected IIFE can require
// node builtins and "electron" (which resolves to the real Electron APIs from
// inside the asar). Responsibilities, ported from the OpenCodex gateway
// (official-net-fetch-statsig-hook.cjs + site-config.cjs + official-runtime IPC
// handlers):
//
//   1. read the runtime config (env CODEX_DESKTOP_CONFIG path, default
//      /etc/codex-desktop/config.yaml) with the same YAML subset parser as the
//      webview side, merged over the baked feature defaults;
//   2. wrap electron net.fetch: blocked hosts -> local 200 "{}", Statsig
//      control plane -> legal synthetic payloads, initialize paced by
//      CODEX_DESKTOP_STATSIG_INITIALIZE_DELAY_MS (default 400ms) to keep the
//      official authed-route init race from firing "n is not a function";
//   3. register session.defaultSession.webRequest.onBeforeRequest so any
//      renderer/main load that still reaches a blocked host is cancelled and
//      answered locally (main process has no cross-process channel to reply
//      through webRequest, so cancel + console marker is the documented
//      behavior; the renderer-side guards are what actually serve the 200);
//   4. for each BrowserWindow loading the local webview index, inject
//      window.__bnovConfig at document_start (executeJavaScript is exempt from
//      the page CSP, unlike inline <script>), so the webview runtime sees the
//      live config; falls back to the baked config when the file is missing
//      or unparsable.
//   5. append structured audit lines (block / allow-path / statsig-local /
//      config) to $CODEX_DESKTOP_NETWORK_AUDIT_LOG (default
//      /var/log/codex-desktop/network-audit.jsonl; 0/off/none disables the
//      file, read at write time, never baked) and capture the renderer
//      guard's "[bnov-audit]" console lines as layer "desktop-webview".
//      Best-effort: a write failure never touches the interception path.
//
// Everything is wrapped in try/catch: this feature must never crash the app
// startup. A console.warn marker line is emitted once per category so the
// behavior is auditable from the terminal/log.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { extractDeclaration } = require("./webview-runtime.js");

const FEATURE_DIR = path.join(__dirname, "..");

function cjsSource(file) {
  return fs.readFileSync(path.join(FEATURE_DIR, file), "utf8");
}

function buildMainRuntime({ manifest = {}, settings = {} } = {}) {
  const hostMatchSource = cjsSource("lib/host-match.js");
  const statsigSource = cjsSource("lib/statsig.js");
  const siteConfigSource = cjsSource("lib/site-config.js");

  // host-match.js is the single source of the matching semantics: it also
  // holds normalizeHostPattern (moved there from site-config.js because
  // parseAllowPathRule depends on it) and the allowPaths rule functions.
  // Keep this list in sync with inlinedHostMatch() in webview-runtime.js:
  // a missing entry is a ReferenceError at install time (the
  // BRAND_NAME_MAX_LENGTH regression - see test.js).
  const hostMatch = [
    "hostMatchesPattern",
    "normalizeHostPattern",
    "isBlockedUrl",
    "parseAllowPathRule",
    "normalizeAllowPathList",
    "UNSAFE_GLOB_CHARS",
    "escapeGlobChar",
    "pathMatchesGlob",
    "hostPathMatchesAllowPath",
    "urlMatchesAllowPath",
    "urlPolicy",
  ]
    .map((name) => extractDeclaration(hostMatchSource, name))
    .join("\n\n");
  const statsig = [
    "STATSIG_DEFAULT_FEATURES_CONFIG",
    "STATSIG_I18N_LAYER_CONFIG",
    "STATSIG_I18N_LAYER_VALUES",
    "STATSIG_DEFAULT_FEATURE_OVERRIDES",
    "DEFAULT_INITIALIZE_DELAY_MS",
    "INITIALIZE_DELAY_ENV",
    "normalizeInitializeDelayMs",
    "buildStatsigInitializeResponse",
    "buildStatsigEvaluationResponse",
    "parseStatsigUrl",
    "isStatsigInitializeUrl",
    "isStatsigEvaluationUrl",
    "isStatsigTelemetryUrl",
  ].map((name) => extractDeclaration(statsigSource, name)).join("\n\n");

  // site-config internals needed by the config reader (no node:fs require:
  // the injected code provides readText itself). normalizeHostPattern is
  // inlined from host-match.js above, not here anymore.
  const siteConfigParts = [
    "stripYamlComment",
    "leadingIndent",
    "parseScalar",
    "parseInlineList",
    "parseBlockSubset",
    "normalizeBrandName",
    "normalizeHostList",
    "configPathFromEnv",
  ].map((name) => extractDeclaration(siteConfigSource, name)).join("\n\n");

  const bakedDefaults = (manifest && manifest.brandNetworkOverlay) || {};

  const source = `;(function () {
  "use strict";
  const w = globalThis;
  if (w.__bnovMainRuntimeInstalled === true) return;
  w.__bnovMainRuntimeInstalled = true;

  const BAKED_DEFAULTS = ${JSON.stringify(bakedDefaults)};

  ${hostMatch}

  ${statsig}

  ${siteConfigParts}

  const EXPECTED_BLOCKS = ["brand", "network"];
  const CONFIG_PATH_ENV = "CODEX_DESKTOP_CONFIG";
  const DEFAULT_CONFIG_PATH = "/etc/codex-desktop/config.yaml";
  const BRAND_NAME_ENV = "CODEX_DESKTOP_BRAND_NAME";
  const BRAND_NAME_MAX_LENGTH = 64;
  const DEFAULT_BRAND_NAME = "OpenCodex";

  /** Read the live config; every failure falls back to the baked defaults. */
  function readRuntimeConfig() {
    const fs = require("node:fs");
    const configPath = configPathFromEnv(process.env) || DEFAULT_CONFIG_PATH;
    let rawConfig = "";
    try {
      if (fs.existsSync(configPath)) rawConfig = fs.readFileSync(configPath, "utf8");
    } catch (err) {
      rawConfig = "";
    }
    const parsed = parseBlockSubset(rawConfig, EXPECTED_BLOCKS);

    const envBrandName = normalizeBrandName(process.env[BRAND_NAME_ENV] || "");
    const fileBrandName = normalizeBrandName(parsed.brand && parsed.brand.name);
    const bakedBrandName = normalizeBrandName(
      (BAKED_DEFAULTS.brand && BAKED_DEFAULTS.brand.name) || "",
    );
    const brandName = envBrandName || fileBrandName || bakedBrandName || "OpenCodex";

    const fileBlocked = normalizeHostList(parsed.network && parsed.network.block);
    const fileAllowed = normalizeHostList(parsed.network && parsed.network.allow);
    const bakedBlocked = normalizeHostList(BAKED_DEFAULTS.network && BAKED_DEFAULTS.network.block);
    const bakedAllowed = normalizeHostList(BAKED_DEFAULTS.network && BAKED_DEFAULTS.network.allow);
    const blockedHosts = fileBlocked.length ? fileBlocked : bakedBlocked;
    const allowedHosts = fileAllowed.length ? fileAllowed : bakedAllowed;
    // URL-level temporary allows: config.yaml network.allowPaths wins over
    // the baked list; entries are normalized rules {host, path|null}
    // (invalid dropped, deduped, order kept).
    const fileAllowedPaths = normalizeAllowPathList(parsed.network && parsed.network.allowPaths);
    const bakedAllowedPaths = normalizeAllowPathList(BAKED_DEFAULTS.network && BAKED_DEFAULTS.network.allowPaths);
    const allowedPaths = fileAllowedPaths.length ? fileAllowedPaths : bakedAllowedPaths;

    const delayRaw =
      process.env[INITIALIZE_DELAY_ENV] !== undefined
        ? process.env[INITIALIZE_DELAY_ENV]
        : BAKED_DEFAULTS.statsig && BAKED_DEFAULTS.statsig.initializeDelayMs !== undefined
          ? BAKED_DEFAULTS.statsig.initializeDelayMs
          : DEFAULT_INITIALIZE_DELAY_MS;

    return {
      configPath: configPath,
      brand: { name: brandName },
      network: {
        blockedHosts: blockedHosts,
        allowedHosts: allowedHosts,
        allowedPaths: allowedPaths,
        // configured must stay true when only allowPaths is set: the
        // interception gate keys off the policy lists and the webview
        // runtime keys off this flag.
        configured: blockedHosts.length > 0 || allowedHosts.length > 0 || allowedPaths.length > 0,
      },
      statsig: { initializeDelayMs: normalizeInitializeDelayMs(delayRaw) },
    };
  }

  // ---- Structured audit log (JSONL, best-effort) --------------------------
  // One line per interception / allow / Statsig local answer / startup:
  //   {"ts","event":"block|allow-path|statsig-local|config","layer",
  //    "host","path","method"}
  // Never query/cookie/header/body: fields are sanitized down to host +
  // pathname + method, structurally. The log path is read at WRITE time
  // (never baked) from $CODEX_DESKTOP_NETWORK_AUDIT_LOG; 0/off/none
  // (case-insensitive) disables the file. Append-only: rotation is the
  // gateway's job. Write failures fall back to a deduped console.warn and
  // never touch the interception path.
  const AUDIT_LOG_ENV = "CODEX_DESKTOP_NETWORK_AUDIT_LOG";
  const DEFAULT_AUDIT_LOG = "/var/log/codex-desktop/network-audit.jsonl";
  const AUDIT_FALLBACK_WARNED = new Set();

  function auditLogPathNow() {
    const raw = String(process.env[AUDIT_LOG_ENV] == null ? "" : process.env[AUDIT_LOG_ENV]).trim();
    if (!raw) return DEFAULT_AUDIT_LOG;
    const lower = raw.toLowerCase();
    if (lower === "0" || lower === "off" || lower === "none") return null;
    return raw;
  }

  function sanitizeAuditFields(host, path, method) {
    const h = String(host == null ? "" : host).toLowerCase().replace(/[?#].*$/, "");
    const p = String(path == null ? "" : path).replace(/[?#].*$/, "");
    const m = String(method == null ? "" : method).trim().toUpperCase();
    return {
      host: /^[a-z0-9.*-]{0,255}$/.test(h) ? h : "",
      path: p.slice(0, 2048),
      method: /^[A-Z]{0,16}$/.test(m) ? m : "",
    };
  }

  function auditFields(rawUrl, method) {
    let host = "";
    let path = "";
    try {
      const parsed = new URL(String(rawUrl == null ? "" : rawUrl));
      host = parsed.hostname;
      path = parsed.pathname;
    } catch (err) {}
    return sanitizeAuditFields(host, path, method);
  }

  function fetchMethodFromArgs(args) {
    const init = args && args.length > 1 ? args[1] : null;
    return init && typeof init === "object" && typeof init.method === "string" ? init.method : "";
  }

  function appendAuditLine(event, layer, details) {
    let filePath = null;
    try {
      filePath = auditLogPathNow();
    } catch (err) {
      filePath = null;
    }
    if (!filePath) return;
    const fields = sanitizeAuditFields(details.host, details.path, details.method);
    const record = {
      ts: new Date().toISOString(),
      event: event,
      layer: layer,
      host: fields.host,
      path: fields.path,
      method: fields.method,
    };
    if (event === "config") {
      // Startup snapshot: the policy in effect at this (re)start, so every
      // upgrade leaves one timestamped record of what was active.
      const toRules = (list) =>
        (Array.isArray(list) ? list : []).map((item) =>
          item && typeof item === "object"
            ? String(item.host || "") + (item.path ? "/" + String(item.path) : "")
            : String(item == null ? "" : item)
        );
      record.version = String(details.version == null ? "" : details.version);
      record.blockedCount = Array.isArray(details.blocked) ? details.blocked.length : 0;
      record.allowedCount = Array.isArray(details.allowed) ? details.allowed.length : 0;
      record.allowedPathsCount = Array.isArray(details.allowedPaths) ? details.allowedPaths.length : 0;
      record.blockedHosts = toRules(details.blocked);
      record.allowedHosts = toRules(details.allowed);
      record.allowedPathRules = toRules(details.allowedPaths);
    }
    let line = "";
    try {
      line = JSON.stringify(record);
    } catch (err) {
      return;
    }
    try {
      require("node:fs").appendFileSync(filePath, line + "\\n", "utf-8");
    } catch (err) {
      // Best-effort: dedupe the fallback warning per combo so a broken log
      // path never spams the console.
      const key = event + "|" + layer + "|" + fields.host + "|" + fields.path;
      if (!AUDIT_FALLBACK_WARNED.has(key)) {
        AUDIT_FALLBACK_WARNED.add(key);
        console.warn("[brand-network-overlay] audit write failed (layer=" + layer + "); same combo not repeated this session: " + line);
      }
    }
  }

  function localStatsigBodyForUrl(rawUrl) {
    if (isStatsigInitializeUrl(rawUrl)) {
      return { delay: true, body: JSON.stringify(buildStatsigInitializeResponse()) };
    }
    if (isStatsigEvaluationUrl(rawUrl)) {
      const parsed = parseStatsigUrl(rawUrl);
      return { delay: false, body: JSON.stringify(buildStatsigEvaluationResponse(parsed && parsed.pathname)) };
    }
    if (isStatsigTelemetryUrl(rawUrl)) return { delay: false, body: "{}" };
    return null;
  }

  function buildLocalResponse(bodyJson, url, ResponseCtor) {
    if (typeof ResponseCtor === "function") {
      return new ResponseCtor(bodyJson, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    const buffer = Buffer.from(bodyJson, "utf-8");
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      url: url,
      headers: { get: function (name) { return String(name).toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null; } },
      json: async function () { return JSON.parse(bodyJson); },
      text: async function () { return bodyJson; },
      arrayBuffer: async function () {
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      },
    };
  }

  function urlFromFetchArgs(args) {
    const first = args && args[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") {
      if (typeof first.url === "string") return first.url;
      if (typeof first.href === "string") return first.href;
      try {
        return first.toString();
      } catch (err) {
        return "";
      }
    }
    return "";
  }

  try {
    const config = readRuntimeConfig();
    // The net.fetch wrap is unconditional: Statsig local answers are part of the
    // same contract even when no block list is configured (renderer parity with
    // the OpenCodex gateway).

    // ---- Channel A: electron net.fetch (main process + net-based loads) ----
    const electron = require("electron");
    const nativeNet = electron && electron.net;
    if (nativeNet && typeof nativeNet.fetch === "function" && nativeNet.__bnovWrapped !== true) {
      const nativeFetch = nativeNet.fetch.bind(nativeNet);
      const ResponseCtor = typeof Response === "function" ? Response : null;
      const initializeDelayMs = config.statsig.initializeDelayMs;
      const hookedNet = Object.assign(Object.create(Object.getPrototypeOf(nativeNet)), nativeNet, {
        __bnovWrapped: true,
        fetch: function (input, init) {
          const args = Array.prototype.slice.call(arguments);
          const url = urlFromFetchArgs(args);
          // Order matters: the Statsig control plane must be answered with its
          // legal payload BEFORE the generic block list. The default block list
          // contains *.chatgpt.com, and ab.chatgpt.com/v1/initialize matches it;
          // answering that with a bare {} makes the official Statsig SDK fail to
          // parse the response, which drops the i18n layer (72216192
          // enable_i18n) to NoValues and leaves the whole UI in English even
          // though the locale resolves to zh-CN. Statsig-first mirrors the
          // gateway's IPC relay and browser guard ordering.
          const statsigBody = localStatsigBodyForUrl(url);
          if (statsigBody) {
            const deliver = function () {
              return buildLocalResponse(statsigBody.body, url, ResponseCtor);
            };
            // Audit: the Statsig control plane is answered locally. The
            // doctor's upgrade self-check keys on "initialize must be
            // statsig-local, never block".
            try {
              appendAuditLine("statsig-local", "desktop-net-fetch", auditFields(url, fetchMethodFromArgs(args)));
            } catch (err) {}
            // Pace only the initialize response to replay a real network
            // round-trip and keep the official authed-route module init from
            // racing the side-effect export registration.
            if (statsigBody.delay && initializeDelayMs > 0) {
              return new Promise(function (resolve) {
                setTimeout(function () { resolve(deliver()); }, initializeDelayMs);
              });
            }
            return Promise.resolve(deliver());
          }
          const policyDecision = urlPolicy(url, config.network);
          if (policyDecision === "allow-path") {
            // Temporary allowPaths hit on an otherwise blocked host family:
            // pass through to the real fetch and audit so the operator can
            // see the temporary allow actually took effect.
            try {
              appendAuditLine("allow-path", "desktop-net-fetch", auditFields(url, fetchMethodFromArgs(args)));
            } catch (err) {}
            return nativeFetch.apply(null, args);
          }
          if (policyDecision === "block") {
            console.warn("[brand-network-overlay] net.fetch blocked by config: " + String(url).split("?")[0]);
            try {
              appendAuditLine("block", "desktop-net-fetch", auditFields(url, fetchMethodFromArgs(args)));
            } catch (err) {}
            return Promise.resolve(buildLocalResponse("{}", url, ResponseCtor));
          }
          return nativeFetch.apply(null, args);
        },
      });
      // electron's net is a plain property on the module object; the official
      // bundle reads it lazily through the same require("electron") instance.
      try {
        nativeNet.fetch = hookedNet.fetch.bind(hookedNet);
      } catch (err) {
        // Read-only module property: fall back to patching the instance the
        // official code actually calls (the bound fetch on net itself was
        // already captured above; nothing else to do).
      }
    }

    // ---- Channel B: session.defaultSession.webRequest.onBeforeRequest ----
    // The renderer-side webview guards (injected into the bundle) are the
    // primary interceptors; this is the safety net for anything that bypasses
    // them (e.g. loads initiated by main). Cancel + auditable marker; we
    // cannot fabricate a 200 body through webRequest from the main process,
    // and the primary channel has already served it for the known paths.
    if (electron && electron.session && electron.session.defaultSession) {
      const session = electron.session.defaultSession;
      if (typeof session.webRequest.onBeforeRequest === "function" && !session.__bnovWebRequestHooked) {
        session.__bnovWebRequestHooked = true;
        session.webRequest.onBeforeRequest(function (details, callback) {
          const decision = urlPolicy(details.url, config.network);
          if (decision === "block") {
            console.warn("[brand-network-overlay] webRequest blocked by config: " + String(details.url).split("?")[0]);
            try {
              appendAuditLine("block", "desktop-webrequest", auditFields(details.url, details.method || ""));
            } catch (err) {}
            return callback({ cancel: true });
          }
          callback({});
        });
      }
    }

    // ---- Channel C: document_start config injection for the webview ----
    // executeJavaScript runs outside the page CSP; it installs
    // window.__bnovConfig which the appended webview runtime reads at startup.
    const webviewIndexUrl = (() => {
      try {
        const app = require("electron").app;
        if (app && typeof app.getAppPath === "function") {
          return require("node:path").join(app.getAppPath(), "webview", "index.html");
        }
      } catch (err) {}
      return null;
    })();
    const configJson = JSON.stringify({
      brand: config.brand,
      network: {
        blockedHosts: config.network.blockedHosts,
        allowedHosts: config.network.allowedHosts,
        allowedPaths: config.network.allowedPaths,
        configured: config.network.configured,
      },
      statsig: config.statsig,
    });
    const installWindowHook = function (win) {
      try {
        if (!win || win.__bnovHooked) return;
        win.__bnovHooked = true;
        const webContents = win.webContents;
        if (!webContents) return;
        const injection = "window.__bnovConfig = " + configJson + ";";
        const maybeInject = function (url) {
          try {
            if (webviewIndexUrl && url === webviewIndexUrl) return true;
            if (webviewIndexUrl) {
              const path = require("node:path").posix;
              const fileUrl = require("node:url").pathToFileURL(webviewIndexUrl).href;
              if (url === fileUrl) return true;
            }
            return false;
          } catch (err) {
            return false;
          }
        };
        webContents.on("did-start-navigation", function (_event, url, isInPlace, isMainFrame) {
          if (!isMainFrame) return;
          if (!maybeInject(url)) return;
          webContents.executeJavaScript(injection, true).catch(function () {});
        });
        // The renderer-side webview guard cannot write files; it logs its
        // block / allow-path decisions as compact JSON lines prefixed with
        // "[bnov-audit]". Capture those lines here and persist them as
        // layer "desktop-webview" audit records. Best-effort: a parse or
        // write failure must never affect the page (and the guard's own
        // console line stays in gateway.log as the fallback trail).
        try {
          webContents.on("console-message", function (_event, _level, message) {
            try {
              const raw = String(message == null ? "" : message);
              const prefix = "[bnov-audit]";
              if (!raw.startsWith(prefix)) return;
              const payload = JSON.parse(raw.slice(prefix.length).trim());
              const record = {
                event: String(payload.event == null ? "" : payload.event),
                host: String(payload.host == null ? "" : payload.host),
                path: String(payload.path == null ? "" : payload.path),
                method: String(payload.method == null ? "" : payload.method),
              };
              if (record.event !== "block" && record.event !== "allow-path") return;
              appendAuditLine(record.event, "desktop-webview", record);
            } catch (err) {}
          });
        } catch (err) {}
      } catch (err) {}
    };
    try {
      const app = require("electron").app;
      app.on("browser-window-created", function (_event, win) {
        installWindowHook(win);
      });
      // Hook windows created before this line (app is normally ready by the
      // time this IIFE runs at module load, but be defensive).
      for (const win of app.getAllWindows()) installWindowHook(win);
    } catch (err) {}

    // Startup audit: record the policy in effect at this (re)start so every
    // upgrade leaves one timestamped "config" line the doctor can inspect.
    try {
      let version = "";
      try {
        version = require("electron").app.getVersion ? require("electron").app.getVersion() : "";
      } catch (err) {}
      appendAuditLine("config", "desktop-net-fetch", {
        version: version,
        blocked: config.network.blockedHosts,
        allowed: config.network.allowedHosts,
        allowedPaths: config.network.allowedPaths,
      });
    } catch (err) {}

    console.warn("[brand-network-overlay] main runtime installed (config: " + config.configPath + ", brand: " + config.brand.name + ", blocked hosts: " + config.network.blockedHosts.length + ")");
  } catch (err) {
    console.warn("[brand-network-overlay] main runtime install failed: " + (err && err.message ? err.message : String(err)));
  }
})();
`;
  return source;
}

module.exports = { buildMainRuntime };

if (require.main === module) {
  process.stdout.write(buildMainRuntime({}));
}
