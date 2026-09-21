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

  const hostMatch = ["hostMatchesPattern", "isBlockedUrl"]
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
  // the injected code provides readText itself).
  const siteConfigParts = [
    "stripYamlComment",
    "leadingIndent",
    "parseScalar",
    "parseInlineList",
    "parseBlockSubset",
    "normalizeBrandName",
    "normalizeHostPattern",
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
        configured: blockedHosts.length > 0 || allowedHosts.length > 0,
      },
      statsig: { initializeDelayMs: normalizeInitializeDelayMs(delayRaw) },
    };
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
          if (config.network.blockedHosts.length && isBlockedUrl(url, config.network)) {
            console.warn("[brand-network-overlay] net.fetch blocked by config: " + String(url).split("?")[0]);
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
          if (config.network.blockedHosts.length && isBlockedUrl(details.url, config.network)) {
            console.warn("[brand-network-overlay] webRequest blocked by config: " + String(details.url).split("?")[0]);
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
      network: { blockedHosts: config.network.blockedHosts, allowedHosts: config.network.allowedHosts, configured: config.network.configured },
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
