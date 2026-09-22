+// Host-pattern matching core for the brand-network-overlay feature.
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
// URL-level temporary allow rules (network.allowPaths) follow the same spec
// as the gateway (must stay word-for-word identical):
//   - a rule is <hostPattern>/<pathGlob> split at the FIRST "/"; an entry
//     without "/" is host-only (equivalent to an allow entry);
//   - hostPattern keeps the host matching semantics above (case-insensitive,
//     "*.x.com" subdomains only);
//   - pathGlob matches the URL pathname only (query ignored), case-sensitive,
//     "*" matches any run of characters including "/", other characters are
//     literal (implemented as an escaped regex);
//   - evaluation order: allowPaths hit -> pass; else allow(host) hit -> pass;
//     else block(host) hit -> block.
//
// This module is used directly by test.js, and the same functions are also
// inlined into the injected main-process and webview runtimes (see
// main-runtime.js / webview-runtime.js) so both sides of the app boundary
// share identical matching semantics. normalizeHostPattern lives HERE (not
// in site-config.js) because parseAllowPathRule depends on it and the
// inlining mechanism extracts declarations from a single source file.

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

// Host normalization tolerates pasted URLs: scheme, path, query and port are
// stripped; the "*." wildcard prefix is kept; anything else is rejected.
function normalizeHostPattern(value) {
  let host = String(value == null ? "" : value).trim().toLowerCase();
  if (!host) return "";
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.replace(/[/?#].*$/, "");
  host = host.replace(/:\d+$/, "");
  const wildcard = host.startsWith("*.") ? "*." : "";
  if (wildcard) host = host.slice(2);
  if (!host) return "";
  if (!/^[a-z0-9.-]+$/.test(host)) return "";
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return "";
  return wildcard + host;
}

/**
 * Should the outbound URL be blocked?
 *
 * Semantics: an allowPaths (URL-level) hit passes through immediately;
 * otherwise an allow(host) hit passes through; otherwise a block(host) hit
 * blocks. Inputs that do not parse as an http(s) URL are never blocked and
 * are left to the native implementation.
 */
function isBlockedUrl(rawUrl, network) {
  const policy = network && typeof network === "object" ? network : {};
  const blocked = Array.isArray(policy.blockedHosts) ? policy.blockedHosts : [];
  const allowed = Array.isArray(policy.allowedHosts) ? policy.allowedHosts : [];
  const allowedPaths = Array.isArray(policy.allowedPaths) ? policy.allowedPaths : [];
  if (!blocked.length) return false;
  let host = "";
  let pathname = "";
  try {
    const parsed = new URL(String(rawUrl == null ? "" : rawUrl));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    host = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  } catch {
    return false;
  }
  if (!host) return false;
  // allowPaths outrank block: a temporary allow is a hole for a newly
  // required endpoint inside an otherwise blocked host family.
  if (hostPathMatchesAllowPath(host, pathname, allowedPaths)) return false;
  if (allowed.some((pattern) => hostMatchesPattern(host, pattern))) return false;
  return blocked.some((pattern) => hostMatchesPattern(host, pattern));
}

/**
 * Parse one allowPaths rule. Spec: a rule is <hostPattern>/<pathGlob>, split
 * at the FIRST "/"; an entry without "/" is host-only (equivalent to an
 * allow entry, path is null). The host reuses normalizeHostPattern (scheme/
 * port/path stripped, lower-cased, "*." wildcard kept); a path that is still
 * empty after stripping a stray query/fragment drops the whole rule (returns
 * null) so a broken config can never break the app.
 */
function parseAllowPathRule(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  const slashIndex = raw.indexOf("/");
  const hostPart = slashIndex === -1 ? raw : raw.slice(0, slashIndex);
  const pathPart = slashIndex === -1 ? "" : raw.slice(slashIndex + 1);
  const host = normalizeHostPattern(hostPart);
  if (!host) return null;
  // path only matches the URL pathname: strip a stray query/fragment.
  const path = pathPart.replace(/[?#].*$/, "").trim();
  if (slashIndex !== -1 && !path) return null;
  return Object.freeze({ host, path: path || null });
}

/** Normalize an allowPaths list: parse each entry, drop invalid ones, dedupe by host|path, keep order. */
function normalizeAllowPathList(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const rule = parseAllowPathRule(item);
    if (!rule) continue;
    const key = rule.host + "|" + (rule.path || "");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(rule);
  }
  return result;
}

// These characters appear in a glob and would become regex metacharacters if
// not escaped. (A plain string, not a Set, on purpose: the extractDeclaration
// inliner truncates a const initializer at its first unbalanced bracket, so
// "new Set([ ... ])" would produce broken injected source.)
const UNSAFE_GLOB_CHARS = ".*+?^${}()|[]";

function escapeGlobChar(char) {
  return UNSAFE_GLOB_CHARS.indexOf(char) !== -1 ? "\\" + char : char;
}

/**
 * Match a pathGlob against a URL pathname: case-sensitive, pathname only
 * (query is naturally ignored). "*" matches any run of characters including
 * "/"; every other character is literal (escaped then compiled to a regex).
 * A leading "/" is stripped on both sides, so "backend-api/*" and
 * "/backend-api/*" are equivalent.
 */
function pathMatchesGlob(pathname, pathGlob) {
  const path = String(pathname == null ? "" : pathname).replace(/^\//, "");
  const glob = String(pathGlob == null ? "" : pathGlob).replace(/^\//, "");
  if (!glob) return false;
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    source += glob[i] === "*" ? ".*" : escapeGlobChar(glob[i]);
  }
  try {
    return new RegExp("^" + source + "$").test(path);
  } catch {
    return false;
  }
}

/** Does host + pathname hit any allowPaths rule; host match is case-insensitive, path match is case-sensitive. */
function hostPathMatchesAllowPath(host, pathname, allowedPaths) {
  const rules = Array.isArray(allowedPaths) ? allowedPaths : [];
  const value = String(host || "").toLowerCase();
  if (!value) return false;
  // URL pathnames carry a leading "/" (e.g. /backend-api/x) while config
  // globs usually do not (backend-api/*); compare with the leading slash
  // stripped so both shapes match.
  const barePath = String(pathname || "").replace(/^\//, "");
  return rules.some(
    (rule) =>
      rule &&
      hostMatchesPattern(value, rule.host) &&
      (!rule.path || pathMatchesGlob(barePath, rule.path))
  );
}

/** Does the URL hit the allowPaths list; anything that is not an http(s) URL returns false. */
function urlMatchesAllowPath(rawUrl, allowedPaths) {
  if (!Array.isArray(allowedPaths) || !allowedPaths.length) return false;
  let parsed;
  try {
    parsed = new URL(String(rawUrl == null ? "" : rawUrl));
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return hostPathMatchesAllowPath(parsed.hostname, parsed.pathname, allowedPaths);
}

/**
 * Outbound URL policy decision (for interception points that also write the
 * audit log). Word-for-word identical to the gateway site-config.cjs:
 *   - "allow-path"    hit allowPaths, pass through (caller logs allow-path);
 *   - "block"         hit block and not allowed, block (caller logs block);
 *   - "passthrough"   unrelated to policy (non-http(s), parse failure, no hit),
 *                     pass through untouched.
 * isBlockedUrl is equivalent to urlPolicy(url) === "block".
 */
function urlPolicy(rawUrl, network) {
  const policy = network && typeof network === "object" ? network : {};
  const blocked = Array.isArray(policy.blockedHosts) ? policy.blockedHosts : [];
  const allowed = Array.isArray(policy.allowedHosts) ? policy.allowedHosts : [];
  const allowedPaths = Array.isArray(policy.allowedPaths) ? policy.allowedPaths : [];
  let parsed;
  try {
    parsed = new URL(String(rawUrl == null ? "" : rawUrl));
  } catch {
    return "passthrough";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "passthrough";
  const host = parsed.hostname.toLowerCase();
  if (!host) return "passthrough";
  if (hostPathMatchesAllowPath(host, parsed.pathname, allowedPaths)) return "allow-path";
  if (allowed.some((pattern) => hostMatchesPattern(host, pattern))) return "passthrough";
  if (blocked.length && blocked.some((pattern) => hostMatchesPattern(host, pattern))) return "block";
  return "passthrough";
}

module.exports = {
  hostMatchesPattern,
  isBlockedUrl,
  parseAllowPathRule,
  pathMatchesGlob,
  hostPathMatchesAllowPath,
  normalizeAllowPathList,
  urlMatchesAllowPath,
  urlPolicy,
  __test: {
    normalizeHostPattern,
  },
};
