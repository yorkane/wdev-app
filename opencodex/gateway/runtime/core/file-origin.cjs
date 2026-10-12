const { hostHeaderParts } = require("./loopback-host.cjs");

/**
 * file-origin 把「浏览器实际访问的 codex 域」映射成 authz 侧的文件直取域：
 *   codex-235.ws.gatepro.cn:99 -> https://file-235.ws.gatepro.cn:99
 * 纯函数、无 IO（配置项除外）：Host / Origin / Referer 全部由调用方（server.cjs、
 * official-runtime.cjs）显式传入，便于单测。
 *
 * 派生优先级（resolveFileOrigin）：
 *   1. configured      —— CODEX_WEB_FILE_ORIGIN 显式覆盖，运维钉死域名时用（唯一豁免可信域校验的一级）
 *   2. clientOrigin    —— 前端自报的 location.origin，唯一不受任何反代改写影响的来源
 *   3. origin          —— Origin 请求头
 *   4. referer         —— Referer 的 host 段
 *   5. forwardedHost   —— X-Forwarded-Host
 *   6. host            —— Host 请求头
 *   7. 兜底 http://127.0.0.1:<port>/file-open —— 本地直连退化到 gateway 自己的预览入口
 *
 * 除 configured 以外每一级都必须过 hostnameInTrustedZones：Host / Origin / Referer /
 * X-Forwarded-Host / clientOrigin 全部是客户端或链路上可被伪造的输入，只要有一级不过白名单，
 * 已认证页面就能把本机绝对路径拼到攻击者域名（file-x.evil.com）上，形成路径外泄 + 诱导点击。
 *
 * 为什么需要这么多级：生产链路里
 *   - 企业边缘 APISIX 把 *.ws.gatepro.cn 的 Host 通配改写成内网 ai-t 域；
 *   - authz 的 codex->3737 绑定开了 simulate_local，把 Host / X-Forwarded-Host / Origin
 *     全部改写成 127.0.0.1:3737（实测抓包确认，见 doc 报告）。
 * 所以单看 Host 或 Origin 都会得到浏览器打不开的地址，必须逐级回退到还能用的信号。
 */

// 首个 label 的节点前缀：codex / codex-<节点> <-> file / file-<节点>；其余 label、端口、协议原样保留。
const CODEX_LABEL_PREFIX = "codex";
const FILE_LABEL_PREFIX = "file";
// 本地退化兜底：不依赖 authz 文件域名的 gateway 同源预览入口。
const FILE_OPEN_FALLBACK_PATH = "/file-open";

// authz 转发时写入的身份断言头。只要其中之一非空，就说明这次请求经过了 authz（客户端是浏览器页面），
// 而不是本机直连 3737 的桌面端；在 simulate_local 改写 Host 之后，这是唯一的浏览器证据。
const AUTHZ_ASSERTION_HEADERS = Object.freeze(["x-authz-user", "x-authz-source", "x-authz-identity"]);

// 派生结果必须落在可信父域里。clientOrigin / Origin / Referer 都是客户端可影响的输入，
// 若不校验，被攻破的页面就能把「本机文件绝对路径」拼到攻击者域名的链接上（路径外泄 + 诱导点击）。
// 默认只放行本机 fleet 的两个父域，可用 CODEX_WEB_FILE_ORIGIN_ZONES 覆盖（逗号分隔）。
const DEFAULT_FILE_ORIGIN_ZONES = Object.freeze(["ai-t.wtvdev.com", "ws.gatepro.cn"]);

function pickHeaderSingle(value) {
  return Array.isArray(value) ? value[0] : value;
}

/** Node 原始请求头可能是数组；统一取第一个值并把空串归一成 null，方便进入下一级派生。 */
function firstHeader(value) {
  const single = Array.isArray(value) ? value[0] : value;
  const text = String(single == null ? "" : single).trim();
  return text || null;
}

/** 请求是否经过 authz 转发（即客户端是浏览器，而不是直连 gateway 的桌面端）。 */
function isViaAuthzGateway(headers) {
  if (!headers || typeof headers !== "object") return false;
  for (const name of AUTHZ_ASSERTION_HEADERS) {
    const value = pickHeaderSingle(headers[name]);
    if (typeof value === "string" && value.trim()) return true;
  }
  return false;
}

/** 生效的可信父域清单。 */
function fileOriginZones() {
  const raw = String(process.env.CODEX_WEB_FILE_ORIGIN_ZONES || "").trim();
  if (!raw) return DEFAULT_FILE_ORIGIN_ZONES;
  const zones = raw
    .split(",")
    .map((zone) => zone.trim().toLowerCase().replace(/^\.+/, ""))
    .filter((zone) => zone.includes(".") && !/[/\\\s@]/.test(zone));
  return zones.length > 0 ? Object.freeze(zones) : DEFAULT_FILE_ORIGIN_ZONES;
}

function hostnameInTrustedZones(hostname, zones) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  return (zones || fileOriginZones()).some((zone) => host === zone || host.endsWith("." + zone));
}

/** 从 Referer 取 origin 作为次级信号（反代改写 Host/Origin 时它常还留着浏览器地址栏的域）。 */
function originFromReferer(value) {
  const raw = String(pickHeaderSingle(value) || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * 把一个「Host 值或完整 origin URL」映射成 file 域 base。
 * 输入既可以是 Host header（host[:port]），也可以是 Origin header（scheme://host[:port]）。
 * 首个 label 不是 codex / codex-* 时返回 null，交给调用方走下一优先级。
 * options.requireTrustedZone=true 时，派生域名的父域还必须在可信清单内，否则返回 null；
 * 客户端可影响的输入（clientOrigin / Referer / Origin）必须开这一位。
 */
function deriveFileOriginFromAuthority(value, options = {}) {
  const raw = String(pickHeaderSingle(value) || "").trim().toLowerCase();
  if (!raw) return null;
  let scheme = options.defaultScheme || "https";
  let authority = raw;
  const schemeIndex = raw.indexOf("://");
  if (schemeIndex > 0) {
    // Origin 自带 scheme 时以 Origin 为准；非 http(s) 一律视为无效，绝不外推到 file 域。
    const protocol = raw.slice(0, schemeIndex);
    if (protocol !== "http" && protocol !== "https") return null;
    scheme = protocol;
    authority = raw.slice(schemeIndex + 3);
  } else if (raw.includes("/")) {
    // 不带 scheme 却带斜杠的输入不是合法 Host/Origin，交给下一优先级。
    return null;
  }
  // Origin/Host 允许携带 path/query 的畸形变体；只取 authority 段。
  authority = authority.replace(/[/?#].*$/, "");
  if (!authority) return null;
  const parts = hostHeaderParts(authority);
  if (!parts || !parts.hostname) return null;
  if (options.requireTrustedZone && !hostnameInTrustedZones(parts.hostname, options.zones)) return null;
  const firstLabel = parts.hostname.split(".")[0];
  if (!firstLabel) return null;
  let fileFirstLabel = "";
  if (firstLabel === CODEX_LABEL_PREFIX) fileFirstLabel = FILE_LABEL_PREFIX;
  else if (firstLabel.startsWith(CODEX_LABEL_PREFIX + "-")) {
    fileFirstLabel = FILE_LABEL_PREFIX + firstLabel.slice(CODEX_LABEL_PREFIX.length);
  } else {
    return null;
  }
  const host = fileFirstLabel + parts.hostname.slice(firstLabel.length);
  const port = parts.port ? ":" + parts.port : "";
  return scheme + "://" + host + port;
}

/** 校验并归一化 CODEX_WEB_FILE_ORIGIN 显式覆盖值；非法输入一律视为未配置。 */
function normalizeConfiguredOrigin(value) {
  const raw = String(pickHeaderSingle(value) || "").trim();
  if (!raw) return "";
  if (/[\u0000-\u0020\u007f-\u009f]/.test(raw)) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  if (!parsed.hostname) return "";
  // 保留 scheme://host[:port][/path]：配置项可以指向带路径的反代入口。
  const port = parsed.port ? ":" + parsed.port : "";
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return parsed.protocol.replace(/:$/, "") + "://" + parsed.hostname.toLowerCase() + port + path;
}

function fallbackFileOrigin(fallbackPort) {
  const port = Number(fallbackPort);
  const safePort = Number.isFinite(port) && port > 0 ? Math.floor(port) : 3737;
  return "http://127.0.0.1:" + safePort + FILE_OPEN_FALLBACK_PATH;
}

/**
 * 按优先级 configured -> clientOrigin -> origin -> referer -> forwardedHost -> host -> 兜底
 * 求 file 域 base，并报告命中的是哪一级。
 *
 * source 是调用方必须消费的字段：只有 configured/clientOrigin/origin/referer/forwarded-host/host
 * 得到的域名对浏览器才可用；"fallback" 是 gateway 本机回环地址，远端浏览器打不开，
 * 调用方据此决定要不要发 open-url 事件或下发 fileBaseUrl。
 */
function resolveFileOrigin(options = {}) {
  const zones = fileOriginZones();
  // configured 是唯一不过可信域白名单的一级，这是有意的不对称：
  // CODEX_WEB_FILE_ORIGIN 由运维在 gateway 进程环境里显式钉死，不是任何请求可影响的输入，
  // 若也过白名单，运维就没法把文件域指向白名单外的自建入口（等价于让这一项配置失效）。
  // 代价与前提：能改这个环境变量（或改部署清单）的人即拥有决定文件域去向的权限，
  // 因此该变量的设置权限必须与其它 gateway 运维配置同级管控，不能交给页面侧任何输入。
  const configured = normalizeConfiguredOrigin(options.configured);
  if (configured) return { origin: configured, source: "configured" };
  // 前端自报最准（location.origin），但它由页面控制，因此同样要过可信域校验。
  const fromClient = deriveFileOriginFromAuthority(options.clientOrigin, {
    requireTrustedZone: true,
    zones,
  });
  if (fromClient) return { origin: fromClient, source: "client" };
  // Origin 为字面量 "null"（file:// 页面、sandbox iframe）时解析不出 codex 前缀，自然落到下一级。
  const fromOrigin = deriveFileOriginFromAuthority(options.origin, {
    requireTrustedZone: true,
    zones,
  });
  if (fromOrigin) return { origin: fromOrigin, source: "origin" };
  const fromReferer = deriveFileOriginFromAuthority(originFromReferer(options.referer), {
    requireTrustedZone: true,
    zones,
  });
  if (fromReferer) return { origin: fromReferer, source: "referer" };
  const fromForwardedHost = deriveFileOriginFromAuthority(options.forwardedHost, {
    defaultScheme: "https",
    requireTrustedZone: true,
    zones,
  });
  if (fromForwardedHost) return { origin: fromForwardedHost, source: "forwarded-host" };
  // Host 与其余四级同一把尺子：它是客户端/上游代理可伪造的输入，不过白名单时
  // "host: codex-x.evil.com" 就能派生出 file-x.evil.com，把本机绝对路径送到攻击者域。
  const fromHost = deriveFileOriginFromAuthority(options.host, {
    defaultScheme: "https",
    requireTrustedZone: true,
    zones,
  });
  if (fromHost) return { origin: fromHost, source: "host" };
  return { origin: fallbackFileOrigin(options.fallbackPort), source: "fallback" };
}

/**
 * 单独暴露 Host -> file 域这一环（任务契约要求可独立单测）；非 codex 域返回 null。
 * 与 resolveFileOrigin 的 host 级同样强制可信域白名单，避免这个便捷入口成为绕过校验的后门。
 */
function fileOriginFromHost(host, options = {}) {
  return deriveFileOriginFromAuthority(host, {
    defaultScheme: "https",
    requireTrustedZone: true,
    zones: options.zones,
  });
}

function fileOriginFromRequest(options = {}) {
  return resolveFileOrigin(options).origin;
}

/** 本地绝对路径 -> file 域 URL；去掉前导 / 后按段编码，不编码 / 本身。危险或相对路径返回 ""。 */
function fileUrlForPath(origin, absPath) {
  const base = String(origin || "").trim().replace(/\/+$/, "");
  // 纵深防御：base 目前只来自 resolveFileOrigin / normalizeConfiguredOrigin（两者都已过滤控制字符），
  // 没有客户端可控路径能抵达这里；再拒一次，保证将来新增调用方时 host 不会被 \r\n 走私到头里。
  if (!base || /[\u0000-\u0020\u007f-\u009f]/.test(base)) return "";
  let candidate = String(absPath || "").trim();
  if (!candidate) return "";
  // 官方 open-file 的 path 偶尔带 file:// 前缀，统一还原成本地路径再拼 URL。
  if (/^file:/i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "file:") return "";
      candidate = decodeURIComponent(parsed.pathname || "");
    } catch {
      return "";
    }
  }
  const isUnix = candidate.startsWith("/");
  const isWindows = /^[a-zA-Z]:[\\/]/.test(candidate);
  const isUnc = candidate.startsWith("\\\\");
  if (!isUnix && !isWindows && !isUnc) return "";
  if (candidate.includes("\u0000")) return "";
  // 只去掉前导分隔符，绝对路径本身原样保留；Windows 盘符的冒号落在首段里，由编码兜住。
  const segments = candidate
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  // 不做路径归一化：任何 .. 段都视为可疑输入直接拒绝，file 侧只允许正向取文件。
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return "";
  return base + "/" + segments.map((segment) => encodeURIComponent(segment)).join("/");
}

/** 是否可安全交给浏览器新标签打开：仅 http/https 且带 hostname。 */
function isSafeExternalUrl(value) {
  const raw = String(pickHeaderSingle(value) || "").trim();
  if (!raw) return false;
  // 控制字符与空白会被 WHATWG 解析器静默吞掉，javascript: 的绕过变体就是这么来的。
  if (/[\u0000-\u0020\u007f-\u009f]/.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

module.exports = {
  AUTHZ_ASSERTION_HEADERS,
  CODEX_LABEL_PREFIX,
  DEFAULT_FILE_ORIGIN_ZONES,
  FILE_LABEL_PREFIX,
  FILE_OPEN_FALLBACK_PATH,
  fileOriginFromHost,
  fileOriginFromRequest,
  fileOriginZones,
  fileUrlForPath,
  firstHeader,
  hostnameInTrustedZones,
  isSafeExternalUrl,
  isViaAuthzGateway,
  normalizeConfiguredOrigin,
  originFromReferer,
  resolveFileOrigin,
  __test: { deriveFileOriginFromAuthority, fallbackFileOrigin },
};
