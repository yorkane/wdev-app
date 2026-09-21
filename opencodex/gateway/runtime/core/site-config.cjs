const { AUTH_CONFIG_PATH, exists, readText } = require("./config.cjs");

/**
 * site-config 负责读取 config.yaml 里的「站点外观」和「出站域名策略」两个块。
 *
 * 设计约束：本仓库不引入 YAML 依赖（auth.cjs 已经手写了所需的最小子集），
 * 因此这里也只实现这两个块需要的语法：
 *   顶层 key -> 嵌套 map（一层）-> 标量 / 行内列表 / 块状列表
 * 出现任何超出该子集的结构都不猜测语义，直接忽略，保证「配置写坏不影响服务启动」。
 */

// 品牌名兜底值必须与历史默认一致：未配置时不能改变现有行为。
const DEFAULT_BRAND_NAME = "OpenCodex";
// 环境变量优先级高于 config.yaml，便于 launcher 或无配置文件部署临时覆盖。
const BRAND_NAME_ENV = "OPENCODEX_BRAND_NAME";
const BRAND_NAME_MAX_LENGTH = 64;

function stripYamlComment(value) {
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    // 双引号里的反斜杠是转义起点，跳过下一个字符，避免把转义引号当成收尾引号。
    if (quote === "\"") {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === "\"") quote = "";
      continue;
    }
    // YAML 单引号内用两个单引号表示字面单引号。
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
    // 只有前面是空白（或行首）的 # 才是注释，避免截断值里的 # 字符。
    if (char === "#" && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i);
  }
  return value;
}

function leadingIndent(line) {
  const match = String(line || "").match(/^(\s*)/);
  return match ? match[1].length : 0;
}

/** 解析单个标量；只支持裸值、单引号、双引号三种写法，其余视为空。 */
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

/** 解析行内列表 [a, b]；不是行内列表时返回 null，让调用方走标量分支。 */
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
 * 解析顶层块形如 { key: { childKey: string | string[] } } 的极小子集。
 * 只保留 expectedKeys 声明的顶层块，避免把无关配置误读成站点配置。
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

    // 顶层块：缩进归零且形如 key:，不允许行内值，避免把嵌套 map 写在一行。
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

    // 列表项 - value：必须紧跟在一个已识别列表键之下。
    const listItemMatch = logicalLine.trim().match(/^-\s+(.*)$/);
    if (listItemMatch) {
      if (!currentListKey) continue;
      if (currentListIndent != null && indent < currentListIndent) {
        currentListKey = "";
        currentListIndent = null;
        continue;
      }
      const item = parseScalar(listItemMatch[1]);
      if (item) result[currentBlock][currentListKey].push(item);
      continue;
    }

    // 子键 child: value。
    const childMatch = logicalLine.trim().match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!childMatch) continue;
    if (currentChildIndent == null) currentChildIndent = indent;
    // 同一块内子键缩进必须一致，否则视为结构异常、不再消费该行。
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
    // 空值可能是块状列表的头部：先占位成数组，由后续 - item 填充。
    if (!rawChildValue.trim()) {
      result[currentBlock][childKey] = [];
      currentListKey = childKey;
      currentListIndent = indent;
    }
  }

  return result;
}

/** 品牌名清洗：去掉控制字符与首尾空白；过长视为配置错误并丢弃。 */
function normalizeBrandName(value) {
  const name = String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!name) return "";
  if (name.length > BRAND_NAME_MAX_LENGTH) return "";
  return name;
}

/** 域名清洗：接受主机名，也容忍直接粘贴 URL；非法项返回空串。 */
function normalizeHostPattern(value) {
  let host = String(value == null ? "" : value).trim().toLowerCase();
  if (!host) return "";
  // 允许直接粘贴完整 URL：剥掉 scheme 与之后的路径、查询、端口。
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.replace(/[/?#].*$/, "");
  host = host.replace(/:\d+$/, "");
  const wildcard = host.startsWith("*.") ? "*." : "";
  if (wildcard) host = host.slice(2);
  if (!host) return "";
  // 主机名只允许字母数字、点、连字符；其余一律判为非法配置。
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

const EXPECTED_BLOCKS = ["brand", "network"];
// 进程内缓存：config.yaml 只在启动时读一次，热路径（每个出站请求）不能反复读盘。
let cachedSiteConfig = null;

/** 进程级单例读取；测试可用 clearSiteConfigCache() 重置。 */
function getSiteConfig() {
  if (!cachedSiteConfig) cachedSiteConfig = loadSiteConfig();
  return cachedSiteConfig;
}

function clearSiteConfigCache() {
  cachedSiteConfig = null;
}

/**
 * 读取并归一化站点配置。返回值始终是完整结构，调用方不需要判空。
 * 任何读取/解析异常都回落到默认值，保证 gateway 能起得来。
 */
function loadSiteConfig(options = {}) {
  const configPath = options.configPath || AUTH_CONFIG_PATH;
  let rawConfig = "";
  try {
    if (exists(configPath)) rawConfig = readText(configPath);
  } catch {
    rawConfig = "";
  }
  const parsed = parseBlockSubset(rawConfig, EXPECTED_BLOCKS);

  const envBrandName = normalizeBrandName(process.env[BRAND_NAME_ENV] || "");
  const fileBrandName = normalizeBrandName(parsed.brand && parsed.brand.name);
  const brandName = envBrandName || fileBrandName || DEFAULT_BRAND_NAME;

  const blockedHosts = normalizeHostList(parsed.network && parsed.network.block);
  const allowedHosts = normalizeHostList(parsed.network && parsed.network.allow);

  return Object.freeze({
    brand: Object.freeze({
      name: brandName,
      // 记录来源，便于诊断页与日志解释为什么品牌名是这个值。
      source: envBrandName ? "env" : fileBrandName ? "config" : "default",
      configured: Boolean(envBrandName || fileBrandName),
    }),
    network: Object.freeze({
      blockedHosts: Object.freeze(blockedHosts),
      // allow 用于在被 block 的域族里开洞，例如拦截某个域族时放行其中一条子域。
      allowedHosts: Object.freeze(allowedHosts),
      configured: blockedHosts.length > 0 || allowedHosts.length > 0,
    }),
  });
}

/**
 * 判断 hostname 是否命中某条清单规则。
 * 通配规则 *.example.com 只匹配子域，不匹配 example.com 本身，与常见 glob 语义一致。
 */
function hostMatchesPattern(hostname, pattern) {
  const host = String(hostname || "").trim().toLowerCase();
  const rule = String(pattern || "").trim().toLowerCase();
  if (!host || !rule) return false;
  if (rule.startsWith("*.")) return host.endsWith("." + rule.slice(2));
  return host === rule;
}

/**
 * 是否应拦截该出站 URL。语义：命中 allow 直接放行，否则命中 block 即拦截。
 * 解析不出 hostname 的输入（相对路径、私有协议、非 http(s)）一律不拦，交给原实现处理。
 */
function isBlockedUrl(rawUrl, network) {
  const policy = network && typeof network === "object" ? network : {};
  const blocked = Array.isArray(policy.blockedHosts) ? policy.blockedHosts : [];
  const allowed = Array.isArray(policy.allowedHosts) ? policy.allowedHosts : [];
  if (!blocked.length) return false;
  let host = "";
  try {
    const parsed = new URL(String(rawUrl || ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  if (allowed.some((pattern) => hostMatchesPattern(host, pattern))) return false;
  return blocked.some((pattern) => hostMatchesPattern(host, pattern));
}

module.exports = {
  BRAND_NAME_ENV,
  DEFAULT_BRAND_NAME,
  clearSiteConfigCache,
  getSiteConfig,
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
