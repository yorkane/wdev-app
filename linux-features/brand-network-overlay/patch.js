// brand-network-overlay ASAR patch descriptors.
//
// Five descriptors, mirroring the OpenCodex codex/brand-network-overlay
// branch (see doc/ in this directory for the mapping):
//
//   main-bundle  net-fetch-overlay      wraps electron net.fetch (local 200
//                                       for blocked hosts + Statsig control
//                                       plane with the 400ms initialize pace)
//                                       and registers a session webRequest
//                                       onBeforeRequest safety net; also
//                                       injects window.__bnovConfig at
//                                       document_start for the webview.
//   webview-asset statsig-local-responder (appended IIFE, installed first):
//                                       fetch/XHR/sendBeacon Statsig control
//                                       plane + telemetry local answers.
//   webview-asset network-block-guard      (appended IIFE): block-list guard
//                                       over fetch/XHR/sendBeacon.
//   webview-asset brand-text-overlay       (appended IIFE): word-boundary
//                                       brand replacement with the official
//                                       exclusion list + throttled observer.
//   webview-asset menu-item-hider          (appended IIFE): multilingual
//                                       official menu hiding (hide, not
//                                       remove).
//
// All webview descriptors target the same unique bundle: the one referenced
// by webview/index.html (the app-initial entry chunk, which contains the
// Statsig SDK strings "ab.chatgpt.com" + "/ces/v1/rgstr" and the sidebar
// markers). Each IIFE is idempotent (window marker) so a second pass over an
// already-patched bundle is a no-op.

"use strict";

const { buildWebviewRuntimes } = require("./runtime/webview-runtime.js");
const { buildMainRuntime } = require("./runtime/main-runtime.js");

const MAIN_BUNDLE_ANCHOR = "exports.runMainAppStartup";

// Unique-content markers that must ALL be present in the webview target
// bundle: the Statsig SDK hosts (ab.chatgpt.com control plane + chatgpt.com
// telemetry), plus the sidebar bundle marker shared by the other
// webview-asset features. This is the same bundle webview/index.html loads.
const WEBVIEW_BUNDLE_MARKERS = ["ab.chatgpt.com", "/ces/v1/rgstr", "sidebarProjectRow"];

const WEBVIEW_IDEMPOTENT_MARKERS = {
  statsig: "__bnovStatsigInstalled",
  network: "__bnovNetworkInstalled",
  brand: "__bnovBrandInstalled",
  menu: "__bnovMenuInstalled",
};

const MAIN_IDEMPOTENT_MARKER = "__bnovMainRuntimeInstalled";

function mergedContextFeature(context = {}) {
  return context && context.feature ? context.feature : {};
}

function applyMainBundlePatch(source, context = {}) {
  if (typeof source !== "string") return source;
  if (source.includes(MAIN_IDEMPOTENT_MARKER)) return source;
  if (!source.includes(MAIN_BUNDLE_ANCHOR)) {
    console.warn("WARN: brand-network-overlay main bundle anchor missing (exports.runMainAppStartup) - skipping main-bundle overlay");
    return source;
  }
  const feature = mergedContextFeature(context);
  const mainRuntime = buildMainRuntime({
    manifest: feature.manifest || {},
    settings: feature.settings || {},
  });
  return source + "\n" + mainRuntime;
}

function webviewApplyFactory(runtimeName) {
  return function apply(source, context = {}) {
    if (typeof source !== "string") return source;
    if (source.includes(WEBVIEW_IDEMPOTENT_MARKERS[runtimeName])) return source;
    const markersPresent = WEBVIEW_BUNDLE_MARKERS.filter((marker) => source.includes(marker));
    if (markersPresent.length !== WEBVIEW_BUNDLE_MARKERS.length) {
      if (markersPresent.length > 0) {
        console.warn(`WARN: brand-network-overlay webview bundle markers incomplete (${markersPresent.length}/${WEBVIEW_BUNDLE_MARKERS.length}) - skipping ${runtimeName}`);
      }
      return source;
    }
    const feature = mergedContextFeature(context);
    const runtimes = buildWebviewRuntimes({
      manifest: feature.manifest || {},
      settings: feature.settings || {},
    });
    return source + "\n" + runtimes[runtimeName];
  };
}

// assetMatch guards each descriptor against non-target bundles (the engine
// then requires exactly one match via patchUniqueAssetFile).
function webviewAssetMatch(source) {
  if (typeof source !== "string") return false;
  return WEBVIEW_BUNDLE_MARKERS.every((marker) => source.includes(marker));
}

const descriptors = [
  {
    id: "net-fetch-overlay",
    phase: "main-bundle",
    order: 20850,
    ciPolicy: "optional",
    missingDescription: "main bundle (exports.runMainAppStartup anchor)",
    skipDescription: "brand-network-overlay main-bundle overlay",
    apply: applyMainBundlePatch,
  },
  {
    id: "statsig-local-responder",
    phase: "webview-asset",
    order: 20851,
    ciPolicy: "optional",
    pattern: /^app-initial-[^.]+\.js$/,
    assetMatch: webviewAssetMatch,
    missingDescription: "webview app-initial entry bundle",
    skipDescription: "brand-network-overlay statsig local responder",
    apply: webviewApplyFactory("statsig"),
  },
  {
    id: "network-block-guard",
    phase: "webview-asset",
    order: 20852,
    ciPolicy: "optional",
    pattern: /^app-initial-[^.]+\.js$/,
    assetMatch: webviewAssetMatch,
    missingDescription: "webview app-initial entry bundle",
    skipDescription: "brand-network-overlay network block guard",
    apply: webviewApplyFactory("network"),
  },
  {
    id: "brand-text-overlay",
    phase: "webview-asset",
    order: 20853,
    ciPolicy: "optional",
    pattern: /^app-initial-[^.]+\.js$/,
    assetMatch: webviewAssetMatch,
    missingDescription: "webview app-initial entry bundle",
    skipDescription: "brand-network-overlay brand text overlay",
    apply: webviewApplyFactory("brand"),
  },
  {
    id: "menu-item-hider",
    phase: "webview-asset",
    order: 20854,
    ciPolicy: "optional",
    pattern: /^app-initial-[^.]+\.js$/,
    assetMatch: webviewAssetMatch,
    missingDescription: "webview app-initial entry bundle",
    skipDescription: "brand-network-overlay menu item hider",
    apply: webviewApplyFactory("menu"),
  },
];

module.exports = {
  descriptors,
  applyMainBundlePatch,
  buildMainRuntime,
  buildWebviewRuntimes,
  WEBVIEW_BUNDLE_MARKERS,
  WEBVIEW_IDEMPOTENT_MARKERS,
  MAIN_IDEMPOTENT_MARKER,
  MAIN_BUNDLE_ANCHOR,
};
