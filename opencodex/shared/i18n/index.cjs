const ZH_CN = "zh-CN";
const EN_US = "en-US";
const DEFAULT_LOCALE = ZH_CN;
const PREFERRED_LANGUAGES_ENV = "OPENCODEX_PREFERRED_LANGUAGES";

const MESSAGES = {
  // 文案表是资源数据，不放在逻辑源码里；这里仅按 locale 装载对应 JSON。
  [ZH_CN]: require("./locales/zh-CN.json"),
  [EN_US]: require("./locales/en-US.json"),
};

const RUNTIME_COMPATIBILITY_MESSAGES = {
  // 107 个修改点的调试文案只在调试页注入，避免增加认证页和正式 Renderer 的启动配置。
  [ZH_CN]: require("./locales/runtime-compatibility-zh-CN.json"),
  [EN_US]: require("./locales/runtime-compatibility-en-US.json"),
};

function normalizeLocale(value, fallback = DEFAULT_LOCALE) {
  const raw = String(value || "").trim().replace(/_/g, "-").toLowerCase();
  if (!raw) return fallback;
  if (raw === "c" || raw === "posix" || raw === "c.utf-8") return fallback;
  if (raw === "zh" || raw.startsWith("zh-")) return ZH_CN;
  if (raw === "en" || raw.startsWith("en-")) return EN_US;
  return fallback;
}

function messagesForLocale(locale) {
  return MESSAGES[normalizeLocale(locale)] || MESSAGES[DEFAULT_LOCALE];
}

function runtimeCompatibilityMessagesForLocale(locale) {
  return RUNTIME_COMPATIBILITY_MESSAGES[normalizeLocale(locale)] || RUNTIME_COMPATIBILITY_MESSAGES[DEFAULT_LOCALE];
}

function formatMessage(messages, key, values) {
  const template = (messages && messages[key]) || MESSAGES[DEFAULT_LOCALE][key] || key;
  if (!values || typeof values !== "object") return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  );
}

function t(locale, key, values) {
  return formatMessage(messagesForLocale(locale), key, values);
}

// 历史文案里用 OpenCodex 作为产品名；品牌可配置后统一按这个字面量做替换。
const DEFAULT_BRAND_NAME = "OpenCodex";

/**
 * 把文案值里的产品名换成配置品牌名。
 * - 未配置（或就是默认名）时原样返回同一份对象，保证默认行为与字节完全不变。
 * - 只替换默认产品名这个字面量，不动 i18n key 与占位符，避免破坏既有语义。
 */
function withBrandName(messages, brandName) {
  const name = String(brandName == null ? "" : brandName).trim();
  if (!name || name === DEFAULT_BRAND_NAME) return messages;
  if (!messages || typeof messages !== "object") return messages;
  const result = {};
  for (const [key, value] of Object.entries(messages)) {
    result[key] = typeof value === "string" ? value.split(DEFAULT_BRAND_NAME).join(name) : value;
  }
  return result;
}

function flattenLanguageCandidates(value) {
  if (Array.isArray(value)) return value.flatMap(flattenLanguageCandidates);
  if (value == null) return [];
  const raw = String(value).trim();
  if (!raw) return [];
  return raw
    .split(/[,:;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function preferredLanguagesFromEnv(env = process.env) {
  const raw = env && env[PREFERRED_LANGUAGES_ENV];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    // 启动器传入 JSON 数组；手动调试时也兼容 JSON 字符串。
    return flattenLanguageCandidates(parsed);
  } catch {
    return flattenLanguageCandidates(raw);
  }
}

function systemLocaleCandidates(extraCandidates) {
  const candidates = preferredLanguagesFromEnv();
  if (Array.isArray(extraCandidates)) candidates.push(...extraCandidates);
  return candidates.filter(Boolean);
}

function resolveOpenCodexLocale(options = {}) {
  // OpenCodex 自有文案只跟随启动器传入的系统首选语言列表；缺省时默认中文。
  const candidates = systemLocaleCandidates(options.systemLocales);
  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate, "");
    if (locale) return { locale, source: "preferred-env" };
  }
  return { locale: DEFAULT_LOCALE, source: "default" };
}

function resolveOpenCodexI18n(options = {}) {
  const resolved = resolveOpenCodexLocale(options);
  return {
    ...resolved,
    messages: messagesForLocale(resolved.locale),
  };
}

module.exports = {
  DEFAULT_BRAND_NAME,
  DEFAULT_LOCALE,
  EN_US,
  MESSAGES,
  PREFERRED_LANGUAGES_ENV,
  RUNTIME_COMPATIBILITY_MESSAGES,
  ZH_CN,
  formatMessage,
  messagesForLocale,
  normalizeLocale,
  preferredLanguagesFromEnv,
  resolveOpenCodexI18n,
  resolveOpenCodexLocale,
  runtimeCompatibilityMessagesForLocale,
  t,
  withBrandName,
};
