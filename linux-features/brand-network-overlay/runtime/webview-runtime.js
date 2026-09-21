// Builds the four appended webview runtime sources (each an IIFE, each
// appended to the main webview bundle once). They follow the OpenCodex
// provider install order, which matters for the XHR/fetch wrapping chain:
//   1. statsig   (webview-statsig.template.js)  - innermost fetch wrapper,
//     exposes __bnovStatsig* payload builders;
//   2. network   (webview-network.template.js)  - block-list guard over the
//     three channels; reuses __bnovStatsig* when present;
//   3. brand     (webview-brand.template.js)    - DOM brand text rewrite;
//   4. menu      (webview-menu.template.js)     - official menu hiding.
//
// Placeholders are filled from the shared lib modules (so test.js and the
// injected code run the same functions) plus the baked config JSON and the
// multilingual menu label set.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FEATURE_DIR = path.join(__dirname, "..");

function cjsSource(file) {
  return fs.readFileSync(path.join(FEATURE_DIR, file), "utf8");
}

/**
 * Extract a top-level `const NAME = ...;` or `function NAME(...)` declaration
 * from CJS source (depth-balanced, string/comment aware).
 */
function extractDeclaration(source, name) {
  const constStart = source.indexOf("const " + name + " = ");
  const fnStart = source.indexOf("function " + name + "(");
  const isFunction = fnStart !== -1 && (constStart === -1 || fnStart < constStart);
  const start = isFunction ? fnStart : constStart;
  if (start === -1) throw new Error(`declaration not found: ${name}`);
  let depth = 0;
  let seenOpen = false;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") { inBlockComment = false; i += 1; }
      continue;
    }
    if (inString) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "/" && next === "/") { inLineComment = true; i += 1; continue; }
    if (ch === "/" && next === "*") { inBlockComment = true; i += 1; continue; }
    if (ch === "'" || ch === "\"" || ch === "`") { inString = ch; continue; }
    if (ch === "{" || ch === "[") {
      depth += 1;
      seenOpen = true;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth -= 1;
      if (seenOpen && depth === 0) return source.slice(start, i + 1);
      continue;
    }
    if (!isFunction && seenOpen === false && ch === ";") return source.slice(start, i + 1);
  }
  throw new Error(`unterminated declaration for: ${name}`);
}

const STATSIG_CONSTANTS = [
  "STATSIG_DEFAULT_FEATURES_CONFIG",
  "STATSIG_I18N_LAYER_CONFIG",
  "STATSIG_I18N_LAYER_VALUES",
  "STATSIG_DEFAULT_FEATURE_OVERRIDES",
  "DEFAULT_INITIALIZE_DELAY_MS",
];
const STATSIG_FUNCTIONS = [
  "normalizeInitializeDelayMs",
  "buildStatsigInitializeResponse",
  "buildStatsigEvaluationResponse",
  "parseStatsigUrl",
  "isStatsigInitializeUrl",
  "isStatsigEvaluationUrl",
  "isStatsigTelemetryUrl",
];

function inlinedStatsig() {
  const source = cjsSource("lib/statsig.js");
  const parts = [...STATSIG_CONSTANTS, ...STATSIG_FUNCTIONS].map((name) => extractDeclaration(source, name));
  return parts.join("\n\n");
}

function inlinedHostMatch() {
  const source = cjsSource("lib/host-match.js");
  return ["hostMatchesPattern", "isBlockedUrl"].map((name) => extractDeclaration(source, name)).join("\n\n");
}

function normalizeConfig(manifestDefaults, settings) {
  function block(value) {
    if (value != null && typeof value === "object" && !Array.isArray(value)) return value;
    return null;
  }
  const def = block(manifestDefaults) || {};
  const set = block(settings) || {};
  return {
    brand: { ...block(def.brand), ...block(set.brand) },
    network: { ...block(def.network), ...block(set.network) },
    statsig: { ...block(def.statsig), ...block(set.statsig) },
  };
}

function fillTemplate(name, replacements) {
  let out = cjsSource(path.join("runtime", name));
  for (const [key, value] of Object.entries(replacements)) {
    if (!out.includes(key)) throw new Error(`template ${name}: placeholder missing: ${key}`);
    out = out.split(key).join(value);
  }
  return out;
}

/**
 * Build all four runtime sources. Returns an object keyed by runtime name,
 * each value a complete IIFE string safe to append to the webview bundle.
 */
function buildWebviewRuntimes({ manifest = {}, settings = {}, menuLabels = null } = {}) {
  const baked = normalizeConfig(manifest.brandNetworkOverlay, settings);
  const bakedJson = JSON.stringify(baked);
  const labels = Array.isArray(menuLabels) && menuLabels.length ? menuLabels : defaultMenuLabels();
  return {
    statsig: fillTemplate("webview-statsig.template.js", {
      "__STATSIG_FUNCTIONS__": inlinedStatsig(),
    }),
    network: fillTemplate("webview-network.template.js", {
      "__HOST_MATCH_FUNCTIONS__": inlinedHostMatch(),
      "__BAKED_CONFIG_JSON__": bakedJson,
    }),
    brand: fillTemplate("webview-brand.template.js", {
      "__BAKED_CONFIG_JSON__": bakedJson,
    }),
    menu: fillTemplate("webview-menu.template.js", {
      "__HIDDEN_MENU_LABELS_JSON__": JSON.stringify(labels),
    }),
  };
}

/** Backwards-compatible single-source builder (concatenated, order preserved). */
function buildWebviewRuntime(options) {
  const runtimes = buildWebviewRuntimes(options);
  return [runtimes.statsig, runtimes.network, runtimes.brand, runtimes.menu].join("\n");
}

function defaultMenuLabels() {
  // Same 109-entry multilingual set as OpenCodex codex-menu-item-guard.js.
  return [
    "Afficher la mascotte",
    "Afișează mascota",
    "Aide",
    "Aiuto",
    "Ajuda",
    "Ajutor",
    "Ascunde mascota",
    "Ayuda",
    "Bantuan",
    "Co je nového",
    "Co nowego",
    "Có gì mới",
    "Dölj husdjur",
    "Help",
    "Hide pet",
    "Hilfe",
    "Hiển thị thú cưng",
    "Hjelp",
    "Hjälp",
    "Hjælp",
    "Huisdier tonen",
    "Huisdier verbergen",
    "Hva er nytt",
    "Kisállat elrejtése",
    "Kisállat megjelenítése",
    "Maskotu gizle",
    "Maskotu göster",
    "Masquer la mascotte",
    "Mostra mascotte",
    "Mostrar mascota",
    "Mostrar mascote",
    "Nascondi mascotte",
    "Neuigkeiten",
    "Noutăți",
    "Novedades",
    "Novidades",
    "Novità",
    "Nyheder",
    "Nyheter",
    "Näytä lemmikki",
    "Ocultar mascota",
    "Ocultar mascote",
    "Ohje",
    "Pet anzeigen",
    "Pet ausblenden",
    "Piilota lemmikki",
    "Pokaż zwierzaka",
    "Pomoc",
    "Quoi de neuf",
    "Sembunyikan pet",
    "Show pet",
    "Skjul kjæledyret",
    "Skjul kæledyr",
    "Skrýt domácího mazlíčka",
    "Súgó",
    "Tampilkan pet",
    "Trợ giúp",
    "Ukryj zwierzaka",
    "Uutta",
    "Vis kjæledyret",
    "Vis kæledyr",
    "Visa husdjur",
    "Wat is er nieuw",
    "What's new",
    "Yang baru",
    "Yardım",
    "Yenilikler",
    "Zobrazit domácího mazlíčka",
    "Újdonságok",
    "Απόκρυψη κατοικιδίου",
    "Βοήθεια",
    "Εμφάνιση κατοικιδίου",
    "Τι νέο υπάρχει",
    "Довідка",
    "Показати улюбленця",
    "Показать питомца",
    "Приховати улюбленця",
    "Скрыть питомца",
    "Справка",
    "Что нового",
    "Що нового",
    "नया क्या है",
    "पेट छिपाएँ",
    "पेट दिखाएँ",
    "हेल्प",
    "ซ่อนสัตวเลี้ยง",
    "มีอะไรใหม",
    "วิธี่ใช้",
    "แสดงสัตวเลี้ยง",
    "Ẩn thú cưng",
    "ヘルプ",
    "ペットを表示",
    "ペットを非表示",
    "帮助",
    "新功能",
    "新着情報",
    "显示宠物",
    "最新消息",
    "說明",
    "隐藏宠物",
    "隱藏寵物",
    "隱藏智能拍檔",
    "顯示寵物",
    "顯示智能拍檔",
    "도움말",
    "새로운 기능",
    "펫 보이기",
    "펫 숨기기",
  ];
}

module.exports = {
  buildWebviewRuntime,
  buildWebviewRuntimes,
  defaultMenuLabels,
  extractDeclaration,
};

if (require.main === module) {
  const runtimes = buildWebviewRuntimes({});
  for (const [name, source] of Object.entries(runtimes)) {
    fs.writeFileSync(path.join(__dirname, "..", "..", "..", "..", "..", "data", "tmp", "overlay-inspect", `built-${name}.js`), source);
    process.stdout.write(`${name}: ${source.length} bytes\n`);
  }
}
