// Statsig local-response contract for the brand-network-overlay feature.
//
// Ported from two OpenCodex sources (branch codex/brand-network-overlay),
// which must stay numerically in sync with each other:
//   - web-shell/internal/providers/codex-bridge-polyfill.js
//     (buildStatsigInitializeResponse / buildStatsigEvaluationResponse)
//   - gateway/runtime/electron/official-net-fetch-statsig-hook.cjs
//     (net.fetch hook + OPENCODEX_STATSIG_INITIALIZE_DELAY_MS pacing)
//
// Numeric contract (do not change without updating both call sites):
//   - feature gates: 3903742690, 505458, artifacts -> all true;
//     505458 is the official "new worktree" entry gate.
//   - i18n layer "72216192": { enable_i18n: true, locale_source: "IDE" }.
//   - initialize responses: has_updates true with the full field set
//     (feature_gates / dynamic_configs / layer_configs / param_stores /
//     exposures / sdk_flags); a bare "{}" makes the SDK log
//     "[Statsig] Failed to parse Response".
//   - other /v1/* evaluation endpoints: has_updates false; deltas paths add
//     checksum "0", overlay paths add response_mode "full".
//   - the initialize response is paced (default 400ms, override via the
//     feature setting statsig.initializeDelayMs or the env
//     CODEX_DESKTOP_STATSIG_INITIALIZE_DELAY_MS in the main process): a 0ms
//     reply races the official authed-route module init and probabilistically
//     triggers "n is not a function".

"use strict";

const STATSIG_DEFAULT_FEATURES_CONFIG = "statsig_default_enable_features";
const STATSIG_I18N_LAYER_CONFIG = "72216192";
const STATSIG_I18N_LAYER_VALUES = { enable_i18n: true, locale_source: "IDE" };
const STATSIG_DEFAULT_FEATURE_OVERRIDES = {
  "3903742690": true,
  "505458": true,
  artifacts: true,
};
const DEFAULT_INITIALIZE_DELAY_MS = 400;
const INITIALIZE_DELAY_ENV = "CODEX_DESKTOP_STATSIG_INITIALIZE_DELAY_MS";

function normalizeInitializeDelayMs(value) {
  const n = Number(value == null ? DEFAULT_INITIALIZE_DELAY_MS : value);
  if (!Number.isFinite(n)) return DEFAULT_INITIALIZE_DELAY_MS;
  return Math.max(0, Math.floor(n));
}

/** Full local payload for ab.chatgpt.com/v1/initialize. */
function buildStatsigInitializeResponse() {
  const feature_gates = {};
  const dynamic_configs = {
    [STATSIG_DEFAULT_FEATURES_CONFIG]: {
      name: STATSIG_DEFAULT_FEATURES_CONFIG,
      value: { ...STATSIG_DEFAULT_FEATURE_OVERRIDES },
      rule_id: "gateway_override",
      secondary_exposures: [],
    },
  };
  for (const [name, value] of Object.entries(STATSIG_DEFAULT_FEATURE_OVERRIDES)) {
    feature_gates[name] = { name, value, rule_id: "gateway_override", secondary_exposures: [] };
  }
  return {
    has_updates: true,
    time: Date.now(),
    hash_used: "djb2",
    feature_gates,
    dynamic_configs,
    layer_configs: {
      [STATSIG_I18N_LAYER_CONFIG]: {
        name: STATSIG_I18N_LAYER_CONFIG,
        value: { ...STATSIG_I18N_LAYER_VALUES },
        rule_id: "gateway_override",
        secondary_exposures: [],
      },
    },
    param_stores: {},
    exposures: {},
    sdk_flags: {},
  };
}

/** Minimal legal payload for the other ab.chatgpt.com/v1/* evaluation endpoints. */
function buildStatsigEvaluationResponse(pathname) {
  const path = String(pathname || "").replace(/\/+$/, "");
  const body = {
    has_updates: false,
    time: Date.now(),
    hash_used: "djb2",
    feature_gates: {},
    dynamic_configs: {},
    layer_configs: {},
    param_stores: {},
    exposures: {},
    sdk_flags: {},
  };
  if (path.includes("deltas") || path.includes("delta")) {
    body.checksum = "0";
  }
  if (path.includes("overlay")) {
    body.response_mode = "full";
  }
  return body;
}

/**
 * URL classifiers. All three share one rule set (same as the OpenCodex
 * providers): exact hostname match, trailing slashes ignored.
 * baseUrl is optional (renderer: location.href; main: omit - absolute only).
 */
function parseStatsigUrl(raw, baseUrl) {
  try {
    const parsed = new URL(String(raw == null ? "" : raw), baseUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return { hostname: parsed.hostname, pathname };
  } catch {
    return null;
  }
}

function isStatsigInitializeUrl(raw, baseUrl) {
  const parsed = parseStatsigUrl(raw, baseUrl);
  return Boolean(parsed && parsed.hostname === "ab.chatgpt.com" && parsed.pathname === "/v1/initialize");
}

// Loose match covering /v1/download_config_specs, /v1/eval, /v1/deltas and the
// live overlay variants; all of them pass the SDK's typed-JSON validation.
function isStatsigEvaluationUrl(raw, baseUrl) {
  const parsed = parseStatsigUrl(raw, baseUrl);
  return Boolean(parsed && parsed.hostname === "ab.chatgpt.com" && parsed.pathname.startsWith("/v1/"));
}

// Official telemetry reporting endpoints (XHR/Beacon channels in the SDK):
// only HTTP 200 matters, the body is never parsed, so "{}" is enough.
function isStatsigTelemetryUrl(raw, baseUrl) {
  const parsed = parseStatsigUrl(raw, baseUrl);
  return Boolean(
    parsed &&
      parsed.hostname === "chatgpt.com" &&
      (parsed.pathname === "/ces/v1/rgstr" || parsed.pathname === "/ces/v1/log_event"),
  );
}

/**
 * Decide the local JSON body for a Statsig control-plane URL, or null when the
 * URL is not one we answer locally (must pass through to the native fetch).
 * kind: "initialize" | "evaluation" | "telemetry".
 */
function statsigLocalBodyForUrl(raw, baseUrl) {
  if (isStatsigInitializeUrl(raw, baseUrl)) {
    return { kind: "initialize", body: JSON.stringify(buildStatsigInitializeResponse()) };
  }
  if (isStatsigEvaluationUrl(raw, baseUrl)) {
    const parsed = parseStatsigUrl(raw, baseUrl);
    return { kind: "evaluation", body: JSON.stringify(buildStatsigEvaluationResponse(parsed && parsed.pathname)) };
  }
  if (isStatsigTelemetryUrl(raw, baseUrl)) {
    return { kind: "telemetry", body: "{}" };
  }
  return null;
}

module.exports = {
  STATSIG_DEFAULT_FEATURES_CONFIG,
  STATSIG_DEFAULT_FEATURE_OVERRIDES,
  STATSIG_I18N_LAYER_CONFIG,
  STATSIG_I18N_LAYER_VALUES,
  DEFAULT_INITIALIZE_DELAY_MS,
  INITIALIZE_DELAY_ENV,
  buildStatsigEvaluationResponse,
  buildStatsigInitializeResponse,
  isStatsigEvaluationUrl,
  isStatsigInitializeUrl,
  isStatsigTelemetryUrl,
  normalizeInitializeDelayMs,
  statsigLocalBodyForUrl,
};
