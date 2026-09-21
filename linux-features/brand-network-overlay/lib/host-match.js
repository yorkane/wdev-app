// Host-pattern matching core for the brand-network-overlay feature.
//
// Pure functions, zero dependencies. Semantics are ported verbatim from the
// OpenCodex site-config module (gateway/runtime/core/site-config.cjs, branch
// codex/brand-network-overlay):
//   - "*.example.com" matches subdomains only, never the bare domain itself;
//   - every other rule is an exact host equality comparison;
//   - both sides are trimmed and lower-cased;
//   - an allow rule wins over a block rule;
//   - anything that is not an http(s) URL with a parseable hostname is never
//     blocked (relative paths, private protocols, junk strings pass through).
//
// This module is used directly by test.js, and the same functions are also
// inlined into the injected main-process and webview runtimes (see
// main-runtime.js / webview-runtime.js) so both sides of the app boundary
// share identical matching semantics.

"use strict";

/**
 * Decide whether a hostname matches one policy rule.
 * Wildcard rules ("*.example.com") match subdomains only, not the bare domain.
 */
function hostMatchesPattern(hostname, pattern) {
  const host = String(hostname == null ? "" : hostname).trim().toLowerCase();
  const rule = String(pattern == null ? "" : pattern).trim().toLowerCase();
  if (!host || !rule) return false;
  if (rule.startsWith("*.")) return host.endsWith("." + rule.slice(2));
  return host === rule;
}

/**
 * Should the outbound URL be blocked?
 *
 * Semantics: an allow hit passes through immediately; otherwise a block hit
 * blocks. Inputs that do not parse as an http(s) URL are never blocked and
 * are left to the native implementation.
 */
function isBlockedUrl(rawUrl, network) {
  const policy = network && typeof network === "object" ? network : {};
  const blocked = Array.isArray(policy.blockedHosts) ? policy.blockedHosts : [];
  const allowed = Array.isArray(policy.allowedHosts) ? policy.allowedHosts : [];
  if (!blocked.length) return false;
  let host = "";
  try {
    const parsed = new URL(String(rawUrl == null ? "" : rawUrl));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  if (allowed.some((pattern) => hostMatchesPattern(host, pattern))) return false;
  return blocked.some((pattern) => hostMatchesPattern(host, pattern));
}

module.exports = { hostMatchesPattern, isBlockedUrl };
