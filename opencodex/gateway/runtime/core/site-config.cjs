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
// CODEX_DESKTOP_BRAND_NAME 与桌面端覆盖层（linux-features/brand-network-overlay）使用同名变量，
// 保证「桌面 + 网关」同一份 brand 来源；OPENCODEX_BRAND_NAME 作为兼容别名保留。
const BRAND_NAME_ENV = "CODEX_DESKTOP_BRAND_NAME";
const BRAND_NAME_ENV_ALIAS = "OPENCODEX_BRAND_NAME";
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

/**
 * 解析一条 allowPaths 规则。
 * 规范：一条规则 = <hostPattern>/<pathGlob>，按**第一个** / 切分；
 * 没有 / 的条目视为 host-only（等价 allow，path 为 null）。
 * host 复用 normalizeHostPattern 的归一化（剥 scheme/端口/路径、小写）；
 * path 剥掉 query/fragment 后仍为空则整条规则丢弃（返回 null），配置写坏不影响启动。
 */
function parseAllowPathRule(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  const slashIndex = raw.indexOf("/");
  const hostPart = slashIndex === -1 ? raw : raw.slice(0, slashIndex);
  const pathPart = slashIndex === -1 ? "" : raw.slice(slashIndex + 1);
  const host = normalizeHostPattern(hostPart);
  if (!host) return null;
  // path 只匹配 URL 的 pathname：配置里误带的 query/fragment 直接剥掉。
  const path = pathPart.replace(/[?#].*$/, "").trim();
  if (slashIndex !== -1 && !path) return null;
  return Object.freeze({ host, path: path || null });
}

/** 归一化 allowPaths 列表：逐条解析、非法丢弃、按 host|path 去重保序。 */
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

// 这些字符出现在 glob 里必须转义，否则会被 RegExp 当成元字符。
const UNSAFE_GLOB_CHARS = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

function escapeGlobChar(char) {
  return UNSAFE_GLOB_CHARS.has(char) ? "\\" + char : char;
}

/**
 * pathGlob 匹配 URL pathname：大小写敏感、只看 pathname（天然忽略 query）。
 * * 匹配任意长度字符（含 /），其余按字面量；实现是「逐字符转义后拼正则」。
 */
function pathMatchesGlob(pathname, pathGlob) {
  // URL pathname 带前导 /（如 /backend-api/x），配置 glob 可能带也可能不带（backend-api/* 与
  // /backend-api/* 等价）；两边统一剥掉前导 / 再比较，避免同一规则因写法不同行为分叉。
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

/** host+pathname 是否命中某条 allowPaths 规则；host 匹配大小写不敏感，path 匹配大小写敏感。 */
function hostPathMatchesAllowPath(host, pathname, allowedPaths) {
  const rules = Array.isArray(allowedPaths) ? allowedPaths : [];
  const value = String(host || "").toLowerCase();
  if (!value) return false;
  // URL pathname 带前导 /（如 /backend-api/x），而配置 glob 通常不带（backend-api/*）；
  // 匹配前剥掉前导 /，两者在同一形状下比较。
  const barePath = String(pathname || "").replace(/^\//, "");
  return rules.some(
    (rule) =>
      rule &&
      hostMatchesPattern(value, rule.host) &&
      (!rule.path || pathMatchesGlob(barePath, rule.path))
  );
}

/** URL 是否命中 allowPaths 清单；解析不出 http(s) URL 的输入一律 false。 */
function urlMatchesAllowPath(rawUrl, allowedPaths) {
  if (!Array.isArray(allowedPaths) || !allowedPaths.length) return false;
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return hostPathMatchesAllowPath(parsed.hostname, parsed.pathname, allowedPaths);
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

  const envBrandName = normalizeBrandName(process.env[BRAND_NAME_ENV] || process.env[BRAND_NAME_ENV_ALIAS] || "");
  const fileBrandName = normalizeBrandName(parsed.brand && parsed.brand.name);
  const brandName = envBrandName || fileBrandName || DEFAULT_BRAND_NAME;

  const blockedHosts = normalizeHostList(parsed.network && parsed.network.block);
  const allowedHosts = normalizeHostList(parsed.network && parsed.network.allow);
  // allowPaths 是 URL 级临时放行清单：升级后新端点被误伤时在 config.yaml 里开洞，命中即放行。
  const allowedPaths = normalizeAllowPathList(parsed.network && parsed.network.allowPaths);

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
      // allowedPaths 是 URL 级放行（hostPattern/pathGlob）；只有 allowPaths 时 configured 也必须是
      // true，否则 IPC 链路（official-runtime.cjs 以 configured 为闸门）会跳过清单判定。
      allowedPaths: Object.freeze(allowedPaths),
      configured: blockedHosts.length > 0 || allowedHosts.length > 0 || allowedPaths.length > 0,
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
 * 是否应拦截该出站 URL。语义：命中 allowPaths（URL 级）直接放行，其次命中 allow（host 级）
 * 直接放行，否则命中 block 即拦截。
 * 解析不出 hostname 的输入（相对路径、私有协议、非 http(s)）一律不拦，交给原实现处理。
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
    const parsed = new URL(String(rawUrl || ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    host = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  } catch {
    return false;
  }
  if (!host) return false;
  // allowPaths 优先于 block：升级后临时放行就是给被误伤的 URL 开洞，不能被同域族的 block 顶回去。
  if (hostPathMatchesAllowPath(host, pathname, allowedPaths)) return false;
  if (allowed.some((pattern) => hostMatchesPattern(host, pattern))) return false;
  return blocked.some((pattern) => hostMatchesPattern(host, pattern));
}

/**
 * 出站 URL 策略判定（供拦截点写审计日志使用）：
 *  - "allow-path"  命中 allowPaths，按放行处理（调用方应记 allow-path 审计事件）；
 *  - "block"       命中 block 且未放行，应拦截（调用方应记 block 审计事件）；
 *  - "passthrough" 与策略无关（非 http(s)、解析失败、未命中任何清单），原样透传。
 * 语义与 isBlockedUrl 完全一致，isBlockedUrl 等价于 urlPolicy(url) === "block"。
 */
function urlPolicy(rawUrl, network) {
  const policy = network && typeof network === "object" ? network : {};
  const blocked = Array.isArray(policy.blockedHosts) ? policy.blockedHosts : [];
  const allowed = Array.isArray(policy.allowedHosts) ? policy.allowedHosts : [];
  const allowedPaths = Array.isArray(policy.allowedPaths) ? policy.allowedPaths : [];
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
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
  BRAND_NAME_ENV,
  BRAND_NAME_ENV_ALIAS,
  DEFAULT_BRAND_NAME,
  clearSiteConfigCache,
  getSiteConfig,
  hostMatchesPattern,
  isBlockedUrl,
  loadSiteConfig,
  parseAllowPathRule,
  pathMatchesGlob,
  urlPolicy,
  urlMatchesAllowPath,
  __test: {
    normalizeBrandName,
    normalizeHostList,
    normalizeHostPattern,
    normalizeAllowPathList,
    hostPathMatchesAllowPath,
    parseBlockSubset,
    parseInlineList,
    parseScalar,
    stripYamlComment,
  },
};
