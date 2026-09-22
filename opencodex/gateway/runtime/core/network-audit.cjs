/**
 * 网络审计日志（JSONL）：把出站拦截层的每次「拦截 / 放行 / Statsig 本地应答」落成一行 JSON，
 * 供 codex-desktop-gateway doctor 做升级后自检。
 *
 * 硬性约束：
 * - 每行只写 ts / event / layer / host / path / method，**绝不写 query、cookie、header、body**；
 * - 写文件是 best-effort：任何异常不得影响拦截逻辑，失败回落 console（去重，不刷屏）；
 * - 网关启动时轮转：审计文件超过 8 MiB 时重命名为 network-audit.jsonl.1（覆盖旧的）再新建。
 */

const fs = require("node:fs");

const AUDIT_LOG_ENV = "CODEX_DESKTOP_NETWORK_AUDIT_LOG";
const DEFAULT_AUDIT_LOG = "/var/log/codex-desktop/network-audit.jsonl";
// 轮转阈值 8 MiB：单文件 .1 备份，doctor 默认只看最近 1h，8 MiB 足够宽裕。
const ROTATE_SIZE_BYTES = 8 * 1024 * 1024;

const LAYERS = new Set(["gateway-net-fetch", "gateway-ipc", "desktop-net-fetch", "desktop-webrequest", "desktop-webview"]);
const EVENTS = new Set(["block", "allow-path", "statsig-local", "config"]);

// 控制台回落去重：同一「事件+host+path+layer」组合只提示一次，避免无写权限时刷爆日志。
const warnedFallback = new Set();

/**
 * 解析审计文件路径：未设置时用默认路径；显式设为 off/0/none 视为关闭（返回 null）。
 */
function resolveAuditLogPath(envValue) {
  const raw = String(envValue == null ? "" : envValue).trim();
  if (raw === "off" || raw === "0" || raw === "none") return null;
  return raw || DEFAULT_AUDIT_LOG;
}

function auditLogPathFromEnv(env = process.env) {
  return resolveAuditLogPath(env[AUDIT_LOG_ENV]);
}

/**
 * 启动轮转：审计文件超过阈值时重命名为 .1（已存在则覆盖），调用方随后新建。
 * 目录不存在时静默跳过（首次写入会再尝试一次并走 fallback）。
 */
function rotateAuditLog(filePath) {
  const file = String(filePath || "");
  if (!file) return;
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > ROTATE_SIZE_BYTES) {
      fs.renameSync(file, file + ".1");
    }
  } catch {
    // 轮转失败不影响启动与拦截；后续写入会再次尝试。
  }
}

function fallbackConsole(event, layer, details) {
  const key = event + "|" + layer + "|" + (details && details.host) + "|" + (details && details.path);
  if (warnedFallback.has(key)) return;
  warnedFallback.add(key);
  console.warn(
    "[network-audit] " + event + " 审计写入失败（layer=" + layer + "），本次会话同组合事件不再重复提示"
  );
}

/**
 * 追加一条审计记录。details 只接受白名单字段；host/path/method 之外的内容一律丢弃。
 * 返回 true 表示已写入文件或审计被显式关闭；false 表示写入失败（已 console 回落）。
 */
function appendAuditEvent(event, layer, details = {}) {
  const filePath = auditLogPathFromEnv();
  if (!filePath) return true;
  if (!EVENTS.has(event) || !LAYERS.has(layer)) {
    // 非法 layer/event 属于调用方 bug：不能打断拦截路径，静默丢弃。
    return false;
  }
  const record = {
    ts: new Date().toISOString(),
    event,
    layer,
    host: sanitizeHost(details.host),
    path: sanitizePath(details.path),
    method: sanitizeMethod(details.method),
  };
  if (event === "config") {
    record.blocked = Number.isFinite(details.blocked) ? details.blocked : 0;
    record.allowed = Number.isFinite(details.allowed) ? details.allowed : 0;
    record.allowedPaths = Number.isFinite(details.allowedPaths) ? details.allowedPaths : 0;
  }
  let line = "";
  try {
    line = JSON.stringify(record);
  } catch {
    return true;
  }
  try {
    fs.appendFileSync(filePath, line + "\n", "utf-8");
    return true;
  } catch {
    fallbackConsole(event, layer, details);
    return false;
  }
}

// 三个字段各自做最后一道清洗：host 限主机名字符；path 只保留 pathname（剥 query/fragment）；
// method 只保留字母。保证「绝不写 query/cookie/header/body」是结构性的，不依赖调用方自觉。
function sanitizeHost(value) {
  const host = String(value || "").trim().toLowerCase();
  return /^[a-z0-9.*-]{0,255}$/.test(host) ? host : "";
}

function sanitizePath(value) {
  const path = String(value || "");
  const stripped = path.replace(/[?#].*$/, "");
  return stripped.length <= 2048 ? stripped : stripped.slice(0, 2048);
}

function sanitizeMethod(value) {
  const method = String(value || "").trim().toUpperCase();
  return /^[A-Z]{0,16}$/.test(method) ? method : "";
}

module.exports = {
  AUDIT_LOG_ENV,
  DEFAULT_AUDIT_LOG,
  ROTATE_SIZE_BYTES,
  resolveAuditLogPath,
  auditLogPathFromEnv,
  rotateAuditLog,
  appendAuditEvent,
  __test: {
    sanitizeHost,
    sanitizePath,
    sanitizeMethod,
    resetFallbackWarned: () => {
      warnedFallback.clear();
    },
  },
};
