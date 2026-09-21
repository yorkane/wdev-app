// Site configuration reader for the brand-network-overlay feature.
//
// Runtime configuration source, ported from the OpenCodex site-config module
// (gateway/runtime/core/site-config.cjs, branch codex/brand-network-overlay):
// a hand-rolled YAML subset parser that only understands
//   top-level key -> one nested map level -> scalar / inline list / block list
// Anything outside that subset is ignored so a broken config file can never
// break the app. Parse failures and read errors fall back to defaults.
//
// Resolution order for the brand name:
//   env CODEX_DESKTOP_BRAND_NAME > config.yaml brand.name > baked-in default.
// network.block / network.allow come from config.yaml only (no env override).
//
// The config path is env CODEX_DESKTOP_CONFIG, defaulting to
// /etc/codex-desktop/config.yaml. The same file the OpenCodex gateway reads
// (brand:/network: blocks), so a deployment can keep one config for both the
// gateway and the desktop overlay. The baked-in defaults come from the feature
// manifest (feature.json "brandNetworkOverlay" block, overridable per build
// through features.json settings). The parsed config.yaml wins over the baked
// defaults when it defines the same keys.

"use strict";

const { hostMatchesPattern, isBlockedUrl } = require("./host-match.js");

const DEFAULT_BRAND_NAME = "OpenCodex";
const BRAND_NAME_ENV = "CODEX_DESKTOP_BRAND_NAME";
const BRAND_NAME_MAX_LENGTH = 64;
const CONFIG_PATH_ENV = "CODEX_DESKTOP_CONFIG";
const DEFAULT_CONFIG_PATH = "/etc/codex-desktop/config.yaml";
const EXPECTED_BLOCKS = ["brand", "network"];

function stripYamlComment(value) {
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    // Double-quoted strings: a backslash escapes the next character.
    if (quote === "\"") {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === "\"") quote = "";
      continue;
    }
    // Single-quoted strings use two single quotes for a literal quote.
    if (quote === "'") {
      if (char === "'" && value[i + 1] === "'") {
        i += 1;
        continue;
      }
      if (char === "'") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    // Only a # preceded by whitespace (or at line start) starts a comment.
    if (char === "#" && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i);
  }
  return value;
}

function leadingIndent(line) {
  const match = String(line || "").match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function parseScalar(rawValue) {
  const value = stripYamlComment(String(rawValue || "")).trim();
  if (!value || value === "null" || value === "~") return "";
  if (value.startsWith("\"")) {
    if (!value.endsWith("\"") || value.length < 2) return "";
    try {
      return JSON.parse(value);
    } catch {
      return "";
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) return "";
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseInlineList(rawValue) {
  const value = stripYamlComment(String(rawValue || "")).trim();
  if (!value.startsWith("[") || !value.endsWith("]")) return null;
  const inner = value.slice(1, -1);
  if (!inner.trim()) return [];
  const items = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  items.push(current);
  return items.map((item) => parseScalar(item)).filter((item) => item !== "");
}

/**
 * Parse the tiny subset: { topKey: { childKey: string | string[] } } for the
 * blocks listed in expectedKeys. Structural anomalies are ignored, never thrown.
 */
function parseBlockSubset(rawConfig, expectedKeys) {
  const result = {};
  const lines = String(rawConfig || "").split(/\r?\n/);
  let currentBlock = "";
  let currentChildIndent = null;
  let currentListKey = "";
  let currentListIndent = null;

  const resetBlock = () => {
    currentBlock = "";
    currentChildIndent = null;
    currentListKey = "";
    currentListIndent = null;
  };

  for (const line of lines) {
    const logicalLine = stripYamlComment(line);
    if (!logicalLine.trim()) continue;
    const indent = leadingIndent(line);

    // Top-level block header: indent 0, "key:", no inline value.
    if (indent === 0) {
      const topMatch = logicalLine.trim().match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
      if (topMatch && expectedKeys.includes(topMatch[1]) && !topMatch[2].trim()) {
        currentBlock = topMatch[1];
        currentChildIndent = null;
        currentListKey = "";
        currentListIndent = null;
        if (!result[currentBlock] || typeof result[currentBlock] !== "object") result[currentBlock] = {};
        continue;
      }
      resetBlock();
      continue;
    }

    if (!currentBlock) continue;

    const listItemMatch = logicalLine.trim().match(/^-(\s+(.*))?$/);
    if (listItemMatch) {
      if (!currentListKey) continue;
      if (currentListIndent != null && indent < currentListIndent) {
        currentListKey = "";
        currentListIndent = null;
        continue;
      }
      const item = parseScalar(listItemMatch[2] == null ? "" : listItemMatch[2]);
      if (item) result[currentBlock][currentListKey].push(item);
      continue;
    }

    const childMatch = logicalLine.trim().match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!childMatch) continue;
    if (currentChildIndent == null) currentChildIndent = indent;
    if (currentChildIndent !== indent) continue;
    const childKey = childMatch[1];
    const rawChildValue = childMatch[2];
    currentListKey = "";
    currentListIndent = null;
    const inlineList = parseInlineList(rawChildValue);
    if (inlineList) {
      result[currentBlock][childKey] = inlineList;
      continue;
    }
    const scalar = parseScalar(rawChildValue);
    if (scalar !== "") {
      result[currentBlock][childKey] = scalar;
      continue;
    }
    // Empty value may start a block list; reserve the key and fill from "- item".
    if (!rawChildValue.trim()) {
      result[currentBlock][childKey] = [];
      currentListKey = childKey;
      currentListIndent = indent;
    }
  }

  return result;
}

function normalizeBrandName(value) {
  const name = String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!name) return "";
  if (name.length > BRAND_NAME_MAX_LENGTH) return "";
  return name;
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

function normalizeHostList(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const host = normalizeHostPattern(item);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    result.push(host);
  }
  return result;
}

function configPathFromEnv(env) {
  const value = String((env && env[CONFIG_PATH_ENV]) || "").trim();
  return value || DEFAULT_CONFIG_PATH;
}

/**
 * Read the raw config text. Any read error yields "" (defaults apply).
 * Kept injectable for tests (readText).
 */
function loadSiteConfig(options = {}) {
  const env = options.env || process.env;
  const readText = typeof options.readText === "function" ? options.readText : null;
  const configPath = options.configPath || configPathFromEnv(env);
  let rawConfig = "";
  try {
    if (readText) {
      rawConfig = readText(configPath);
    } else {
      const fs = require("node:fs");
      if (fs.existsSync(configPath)) rawConfig = fs.readFileSync(configPath, "utf8");
    }
  } catch {
    rawConfig = "";
  }
  const parsed = parseBlockSubset(rawConfig, EXPECTED_BLOCKS);

  const envBrandName = normalizeBrandName(env[BRAND_NAME_ENV] || "");
  const fileBrandName = normalizeBrandName(parsed.brand && parsed.brand.name);
  const bakedBrandName = normalizeBrandName(options.bakedBrandName || "");
  const brandName = envBrandName || fileBrandName || bakedBrandName || DEFAULT_BRAND_NAME;

  const fileBlocked = normalizeHostList(parsed.network && parsed.network.block);
  const fileAllowed = normalizeHostList(parsed.network && parsed.network.allow);
  // config.yaml wins over the baked-in feature defaults for network lists.
  const blockedHosts = fileBlocked.length ? fileBlocked : normalizeHostList(options.bakedBlockedHosts || []);
  const allowedHosts = fileAllowed.length ? fileAllowed : normalizeHostList(options.bakedAllowedHosts || []);

  return Object.freeze({
    configPath,
    brand: Object.freeze({
      name: brandName,
      // Where the brand name came from: env > config file > baked feature default.
      source: envBrandName ? "env" : fileBrandName ? "config" : bakedBrandName ? "default" : "builtin",
      configured: Boolean(envBrandName || fileBrandName || bakedBrandName),
    }),
    network: Object.freeze({
      blockedHosts: Object.freeze(blockedHosts),
      allowedHosts: Object.freeze(allowedHosts),
      configured: blockedHosts.length > 0 || allowedHosts.length > 0,
    }),
  });
}

module.exports = {
  BRAND_NAME_ENV,
  CONFIG_PATH_ENV,
  DEFAULT_BRAND_NAME,
  DEFAULT_CONFIG_PATH,
  configPathFromEnv,
  hostMatchesPattern,
  isBlockedUrl,
  loadSiteConfig,
  __test: {
    normalizeBrandName,
    normalizeHostList,
    normalizeHostPattern,
    parseBlockSubset,
    parseInlineList,
    parseScalar,
    stripYamlComment,
  },
};
