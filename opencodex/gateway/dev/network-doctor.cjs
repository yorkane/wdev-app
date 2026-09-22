#!/usr/bin/env node
"use strict";

/**
 * 出站域名拦截自检命令（doctor）。
 *
 * 背景：桌面覆盖层会拦截一批官方域名并本地短路成 200；官方 app 升级后新增的
 * 必需端点若落在拦截域族里，会被本地 200 顶掉（历史上曾导致界面卡英文）。
 * doctor 汇总「服务健康 / 生效配置 / 拦截活动榜 / 升级自检判据 / 临时放行建议」
 * 五段报告，帮助升级后快速复核拦截策略是否误伤。
 *
 * 数据来源：
 *   - 审计 JSONL：各拦截层每次 block / allow-path / statsig-local / config 记一行
 *     （契约见 doc/NETWORK-BLOCK-SELFCHECK.md；绝不写 query/cookie/header/body）。
 *   - 网关日志：grep 三条「坏模式」判定升级后运行时是否健康。
 *   - HTTP 探测：/api/health、/codex-web-config.js、版本化资源命名空间。
 *   - systemctl：unit ActiveState / NRestarts（不可用时标 UNKNOWN，不崩）。
 *
 * 只使用 node 内置模块；除 ../runtime/core/site-config.cjs 外不 require 任何仓库模块。
 * 所有外部探测均 try/catch 兜底为 UNKNOWN —— 网关没起来时 doctor 本身不能崩。
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawnSync } = require("child_process");

// 站点配置读取（品牌名 / block / allow）；本仓库无 YAML 依赖，复用其极小子集解析。
const { loadSiteConfig } = require("../runtime/core/site-config.cjs");

// 安装版本文件：打包态在 <网关树根>/VERSION（本文件在 gateway/dev/ 下，故上溯两级）。
const VERSION_FILE = path.resolve(__dirname, "..", "..", "VERSION");
const PACKAGE_JSON_FILE = path.resolve(__dirname, "..", "..", "package.json");
// 版本化资源命名空间：/official-patched-v8-<10位指纹>/（与 static-assets.cjs 同一形态）。
const VERSIONED_PREFIX_RE = /\/official-patched-v8-[A-Za-z0-9_-]{10}\//;
// 健康端点（匿名可访问）。注意：网关没有 /healthz 路由。
const HEALTH_PATH = "/api/health";
// 运行时配置脚本：动态生成 window.__CODEX_WEB_CONFIG__ = {...}。
const WEB_CONFIG_PATH = "/codex-web-config.js";

// 日志坏模式：任一条命中，「日志坏模式」判据即 FAIL。
const LOG_BAD_PATTERNS = [
  { name: "brand-network-overlay install failed", re: /brand-network-overlay[^\n]*install failed/ },
  { name: "Statsig 解析失败", re: /\[Statsig\] Failed to parse Response/ },
  { name: "ERR_MODULE_NOT_FOUND", re: /ERR_MODULE_NOT_FOUND/ },
];

// 参与拦截活动榜聚合的事件类型（config 事件是启动快照，不进榜单）。
const AGGREGATED_EVENTS = new Set(["block", "allow-path", "statsig-local"]);
const DEFAULT_MIN_COUNT = 3;

// 活动榜排序：total 倒序，同次数按 host+path 字典序稳定化。
function compareCountDesc(a, b) {
  if (a.total !== b.total) return b.total - a.total;
  const ka = a.host + a.path;
  const kb = b.host + b.path;
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  return 0;
}

// 建议排序：block 次数倒序，同次数按 host+path 字典序稳定化。
function compareBlockDesc(a, b) {
  if (a.block !== b.block) return b.block - a.block;
  const ka = a.host + a.path;
  const kb = b.host + b.path;
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  return 0;
}

function statusLabel(code) {
  return code === "PASS" ? "PASS" : code === "FAIL" ? "FAIL" : "UNKNOWN";
}

function trimText(value, max) {
  const oneLine = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}

/** 解析时间窗口：30m / 1h / 24h / 2d 等；非法输入返回 null（调用方 exit 1）。 */
function parseSince(raw) {
  const match = /^\s*(\d+)\s*([mhd])\s*$/.exec(String(raw || ""));
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return value * unitMs;
}

function usageText() {
  return [
    "用法: network-doctor.cjs [选项]",
    "",
    "  --since <时长>    统计窗口（30m/1h/24h/2d 等，默认 1h）",
    "  --top <n>         拦截活动榜取前 n 条（默认 15）",
    "  --min-count <n>   生成放行建议的最小 block 次数（默认 3）",
    "  --json            以 JSON 输出报告",
    "  --strict          存在 FAIL 判据时退出码 2（适合巡检/CI）",
    "  --fail-on-block   窗口内只要有 block 事件就退出码 2（默认不启用：拦截遥测是设计内行为）",
    "  --audit-file <p>  审计 JSONL（默认 /var/log/codex-desktop/network-audit.jsonl）",
    "  --log-file <p>    网关日志（默认 /var/log/codex-desktop/gateway.log）",
    "  --config-file <p> config.yaml（默认 /etc/codex-desktop/config.yaml）",
    "  --env-file <p>    gateway.env（默认 /etc/codex-desktop/gateway.env）",
    "  --host <h>        覆盖 env-file 里的 HOST（默认 127.0.0.1）",
    "  --port <p>        覆盖 env-file 里的 PORT（默认 3737）",
    "",
    "退出码: 0 正常；1 参数错误；2 命中 --strict（有 FAIL 判据）或 --fail-on-block（有 block 事件）。",
  ].join("\n");
}

/** 解析命令行选项；返回 { options, sinceMs } 或 { error }（错误时打印 usage 并 exit 1）。 */
function parseArgs(argv) {
  const options = {
    since: "1h",
    top: 15,
    minCount: DEFAULT_MIN_COUNT,
    json: false,
    strict: false,
    failOnBlock: false,
    auditFile: "/var/log/codex-desktop/network-audit.jsonl",
    logFile: "/var/log/codex-desktop/gateway.log",
    configFile: "/etc/codex-desktop/config.yaml",
    envFile: "/etc/codex-desktop/gateway.env",
    host: "127.0.0.1",
    port: 3737,
    hostProvided: false,
    portProvided: false,
  };
  const needValue = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined) return { error: "缺少参数值: " + flag };
    return { value, next: i + 1 };
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let result;
    switch (arg) {
      case "--since":
        result = needValue("--since", i);
        if (result.error) return result;
        options.since = result.value;
        i = result.next;
        break;
      case "--top":
        result = needValue("--top", i);
        if (result.error) return result;
        options.top = Number(result.value);
        i = result.next;
        break;
      case "--min-count":
        result = needValue("--min-count", i);
        if (result.error) return result;
        options.minCount = Number(result.value);
        i = result.next;
        break;
      case "--json":
        options.json = true;
        break;
      case "--strict":
        options.strict = true;
        break;
      case "--fail-on-block":
        options.failOnBlock = true;
        break;
      case "--audit-file":
        result = needValue("--audit-file", i);
        if (result.error) return result;
        options.auditFile = result.value;
        i = result.next;
        break;
      case "--log-file":
        result = needValue("--log-file", i);
        if (result.error) return result;
        options.logFile = result.value;
        i = result.next;
        break;
      case "--config-file":
        result = needValue("--config-file", i);
        if (result.error) return result;
        options.configFile = result.value;
        i = result.next;
        break;
      case "--env-file":
        result = needValue("--env-file", i);
        if (result.error) return result;
        options.envFile = result.value;
        i = result.next;
        break;
      case "--host":
        result = needValue("--host", i);
        if (result.error) return result;
        options.host = result.value;
        options.hostProvided = true;
        i = result.next;
        break;
      case "--port":
        result = needValue("--port", i);
        if (result.error) return result;
        options.port = Number(result.value);
        options.portProvided = true;
        i = result.next;
        break;
      default:
        return { error: "未知选项: " + arg };
    }
  }
  // --since 解析失败属于参数错误（exit 1）。
  const sinceMs = parseSince(options.since);
  if (sinceMs === null) return { error: "无法解析 --since: " + options.since };
  if (!Number.isInteger(options.top) || options.top <= 0) return { error: "非法 --top: " + options.top };
  if (!Number.isInteger(options.minCount) || options.minCount <= 0)
    return { error: "非法 --min-count: " + options.minCount };
  if (typeof options.port !== "number" || !Number.isFinite(options.port) || options.port <= 0)
    return { error: "非法 --port: " + options.port };
  return { options, sinceMs };
}

/** 读取 KEY=value 形态的 env-file；只取最后一次出现的键，剥掉首尾引号与行尾注释。 */
function parseEnvFile(filePath) {
  const result = {};
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return result; // 文件不存在时按空处理，doctor 继续跑。
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (key) result[key] = value;
  }
  return result;
}

/** 从 config.yaml 的 network 块提取 allowPaths 条目（与 site-config 相同的极小子集语法）。 */
function extractAllowPaths(configText) {
  const lines = String(configText || "").split("\n");
  let inNetwork = false;
  let inAllowPaths = false;
  const items = [];
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      // 顶层键：network: 开启该块，其余顶层键关闭。
      const top = line.trim().match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
      if (top && !top[2]) {
        inNetwork = top[1] === "network";
        inAllowPaths = false;
      } else {
        inNetwork = false;
        inAllowPaths = false;
      }
      continue;
    }
    if (!inNetwork) continue;
    const item = line.trim().match(/^\-\s+(.+)$/);
    if (item) {
      let value = item[1].trim();
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
      else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) value = value.slice(1, -1);
      else {
        const hash = value.indexOf(" #");
        if (hash >= 0) value = value.slice(0, hash).trim();
      }
      if (value && inAllowPaths) items.push(value);
      continue;
    }
    const child = line.trim().match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (child) {
      inAllowPaths = child[1] === "allowPaths" && !child[2].trim();
    } else {
      inAllowPaths = false;
    }
  }
  return items;
}

/** 读审计 JSONL 并在窗口内按 host+path 聚合；解析不了的行直接跳过。 */
function aggregateAudit(auditFile, sinceMs, nowMs) {
  const result = {
    available: false,
    path: auditFile,
    sinceMs,
    nowMs,
    totalInWindow: 0,
    totalBlock: 0,
    entries: [],
    // 窗口内事件明细（event/host/path），供 initialize 判据精确判断 statsig-local。
    eventsInWindow: [],
  };
  let raw = "";
  try {
    raw = fs.readFileSync(auditFile, "utf-8");
  } catch {
    return result; // 文件不存在 → 无数据，不是参数错误。
  }
  const cutoff = nowMs - sinceMs;
  const groups = new Map();
  const eventsInWindow = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue; // 半截行/坏行跳过。
    }
    if (!record || typeof record !== "object") continue;
    if (!AGGREGATED_EVENTS.has(record.event)) continue;
    const ts = Date.parse(record.ts);
    if (!Number.isFinite(ts) || ts < cutoff || ts > nowMs) continue;
    eventsInWindow.push({ event: record.event, host: String(record.host || ""), path: String(record.path || "") });
    const host = String(record.host || "");
    const reqPath = String(record.path || "");
    const key = host + reqPath;
    let entry = groups.get(key);
    if (!entry) {
      entry = { host, path: reqPath, total: 0, block: 0, lastTs: ts };
      groups.set(key, entry);
    }
    entry.total += 1;
    if (record.event === "block") entry.block += 1;
    if (ts > entry.lastTs) entry.lastTs = ts;
  }
  const entries = Array.from(groups.values()).sort(compareCountDesc);
  result.available = true;
  result.totalInWindow = entries.reduce((sum, entry) => sum + entry.total, 0);
  result.totalBlock = entries.reduce((sum, entry) => sum + entry.block, 0);
  result.entries = entries;
  result.eventsInWindow = eventsInWindow;
  return result;
}

/**
 * 把「被拦 host+path」收敛成可粘贴的 allowPaths 前缀 glob：
 *   段数≥2 → host/首段/*；段数=1 → host/首段*；段数=0 → host（host-only）。
 * 按 block 次数倒序、去重。
 */
function buildSuggestionRules(entries, minCount) {
  const rules = [];
  const seen = new Set();
  const sorted = Array.from(entries)
    .filter((entry) => entry.block >= minCount)
    .sort(compareBlockDesc);
  for (const entry of sorted) {
    const segments = String(entry.path || "").split("/").filter(Boolean);
    let rule;
    if (segments.length >= 2) rule = entry.host + "/" + segments[0] + "/*";
    else if (segments.length === 1) rule = entry.host + "/" + segments[0] + "*";
    else rule = entry.host;
    if (seen.has(rule)) continue;
    seen.add(rule);
    rules.push({ host: entry.host, path: entry.path, block: entry.block, rule });
  }
  return rules;
}

/** systemctl show 读取 unit 状态；不可用（容器/无 systemd）时全部 UNKNOWN。 */
function checkUnitStatus(unit) {
  const status = { unit, activeState: "UNKNOWN", restarts: "UNKNOWN", available: false };
  try {
    const run = spawnSync("systemctl", ["show", unit, "-p", "ActiveState", "-p", "NRestarts"], {
      encoding: "utf-8",
      timeout: 8000,
    });
    if (run.status !== 0) return status;
    const text = String(run.stdout || "");
    const active = text.match(/^ActiveState=(.*)$/m);
    const restarts = text.match(/^NRestarts=(.*)$/m);
    if (active) {
      status.activeState = (active[1] || "").trim() || "UNKNOWN";
      status.available = true;
    }
    if (restarts) status.restarts = (restarts[1] || "").trim() || "0";
  } catch {
    // systemctl 不存在或执行异常：保持 UNKNOWN。
  }
  return status;
}

/** HTTP 探测：返回 { status, body } 或 { error }；任何失败都归入 error，调用方判 UNKNOWN。 */
function probeHttp(host, port, reqPath) {
  return new Promise((resolve) => {
    // agent:false → 一次性连接（Connection: close），探测完即断开；
    // 否则 keep-alive 空闲连接会让测试里的临时 server 无法 close。
    const req = http.request(
      { host, port, path: reqPath, method: "GET", timeout: 5000, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          let body = Buffer.concat(chunks).toString("utf-8");
          if (res.headers["content-encoding"] === "gzip") {
            try {
              body = require("zlib").gunzipSync(Buffer.concat(chunks)).toString("utf-8");
            } catch {
              /* 解压失败保留原文 */
            }
          }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout after 5000ms"));
    });
    req.on("error", (error) => resolve({ error: error && error.message ? error.message : String(error) }));
    req.end();
  });
}

/** 判据 1：ab.chatgpt.com/v1/initialize 必须是本地应答、不能被 block。 */
function checkInitialize(audit, logText) {
  const inWindow = audit.available
    ? audit.entries.filter((entry) => entry.host === "ab.chatgpt.com" && entry.path === "/v1/initialize")
    : [];
  let hasBlock = false;
  for (const entry of inWindow) {
    if (entry.block > 0) hasBlock = true;
  }
  const events = Array.isArray(audit.eventsInWindow) ? audit.eventsInWindow : [];
  const hasStatsig = events.some(
    (e) => e.event === "statsig-local" && e.host === "ab.chatgpt.com" && e.path === "/v1/initialize"
  );
  if (hasStatsig && !hasBlock) {
    return { id: "initialize-local", status: "PASS", evidence: "窗口内 ab.chatgpt.com/v1/initialize 出现 statsig-local 本地应答，且无 block" };
  }
  if (hasBlock) {
    return { id: "initialize-local", status: "FAIL", evidence: "窗口内出现对 ab.chatgpt.com/v1/initialize 的 block（界面可能卡英文）" };
  }
  // 审计里没有直接证据时，退而看网关日志里的本地应答标记。
  if (typeof logText === "string" && /net_fetch_served_local[^\n]*\/v1\/initialize/.test(logText)) {
    return { id: "initialize-local", status: "PASS", evidence: "日志出现 net_fetch_served_local 且 URL 含 /v1/initialize（审计窗口内无直接事件）" };
  }
  return { id: "initialize-local", status: "UNKNOWN", evidence: "窗口内与日志中都没有 ab.chatgpt.com/v1/initialize 的本地应答或 block 记录" };
}

/** 判据 2：/codex-web-config.js 可取，且 brand/network 与 config 解析值一致。 */
async function checkWebConfig(host, port, siteConfig) {
  const probe = await probeHttp(host, port, WEB_CONFIG_PATH);
  if (probe.error || probe.status !== 200) {
    return {
      id: "web-config",
      status: "UNKNOWN",
      evidence: "GET " + WEB_CONFIG_PATH + " 失败或状态码 " + (probe.status || "无响应") + (probe.error ? "（" + probe.error + "）" : ""),
    };
  }
  const body = probe.body || "";
  // brand/network 是 JSON.stringify 的对象字面量，network 里的 allowedPaths 数组带内层 {}，
  // [^}]* 正则会在第一个内层 } 截断导致 JSON.parse 失败误报；改用括号配对取完整对象。
  const brandLiteral = extractObjectLiteral(body, "brand:");
  const networkLiteral = extractObjectLiteral(body, "network:");
  if (!brandLiteral || !networkLiteral) {
    return { id: "web-config", status: "UNKNOWN", evidence: "响应里没解析到 brand / network 字段" };
  }
  let brand;
  let network;
  try {
    brand = JSON.parse(brandLiteral);
    network = JSON.parse(networkLiteral);
  } catch {
    return { id: "web-config", status: "UNKNOWN", evidence: "brand / network 字段不是合法 JSON" };
  }
  const expectedBlocked = (siteConfig.network.blockedHosts || []).length;
  const expectedAllowed = (siteConfig.network.allowedHosts || []).length;
  const expectedAllowedPaths = (siteConfig.network.allowedPaths || []).length;
  const actualBlocked = Array.isArray(network.blockedHosts) ? network.blockedHosts.length : NaN;
  const actualAllowed = Array.isArray(network.allowedHosts) ? network.allowedHosts.length : NaN;
  const actualAllowedPaths = Array.isArray(network.allowedPaths) ? network.allowedPaths.length : NaN;
  const brandOk = brand && typeof brand.name === "string" && brand.name === siteConfig.brand.name;
  const countsOk =
    actualBlocked === expectedBlocked &&
    actualAllowed === expectedAllowed &&
    actualAllowedPaths === expectedAllowedPaths;
  if (brandOk && countsOk) {
    return {
      id: "web-config",
      status: "PASS",
      evidence:
        "GET 200；brand.name=" + brand.name + "、blockedHosts " + actualBlocked + " 条 / allowedHosts " + actualAllowed + " 条 / allowPaths " + actualAllowedPaths + " 条，与配置一致",
    };
  }
  return {
    id: "web-config",
    status: "FAIL",
    evidence:
      "brand.name=" + (brand && brand.name) + "（期望 " + siteConfig.brand.name + "），blockedHosts " + actualBlocked + "（期望 " + expectedBlocked + "），allowedHosts " + actualAllowed + "（期望 " + expectedAllowed + "），allowedPaths " + actualAllowedPaths + "（期望 " + expectedAllowedPaths + "）",
  };
}

/** 在文本里找 key（如 network:）后跟的 JSON 对象字面量，按括号配对取完整对象（忽略字符串内的括号）。 */
function extractObjectLiteral(text, key) {
  const source = String(text || "");
  const idx = source.indexOf(key);
  if (idx < 0) return "";
  const start = source.indexOf("{", idx + key.length);
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return "";
}

/** 判据 3：版本化资源命名空间可访问，且 /api/health 正常。 */
async function checkVersionedNamespace(host, port, healthStatus) {
  const root = await probeHttp(host, port, "/");
  const config = await probeHttp(host, port, WEB_CONFIG_PATH);
  let prefix = null;
  for (const body of [root.body, config.body]) {
    if (typeof body !== "string") continue;
    const match = VERSIONED_PREFIX_RE.exec(body);
    if (match) {
      prefix = match[0];
      break;
    }
  }
  if (root.error && config.error) {
    return { id: "namespace-health", status: "UNKNOWN", evidence: "GET / 与 /codex-web-config.js 均连接失败（" + root.error + "）" };
  }
  if (!prefix) {
    return { id: "namespace-health", status: "UNKNOWN", evidence: "GET / 与 /codex-web-config.js 响应里都没有 /official-patched-v8-<指纹>/ 前缀" };
  }
  // 裸前缀目录在这套静态服务上没有目录列表路由（返回 500 属正常），必须探测前缀下的
  // 真实 asset 文件才能判断命名空间是否可用。
  const assetRef = extractVersionedAssetRef(root.body, prefix) || extractVersionedAssetRef(config.body, prefix);
  if (!assetRef) {
    return {
      id: "namespace-health",
      status: "UNKNOWN",
      evidence: "找到了版本前缀 " + prefix + "，但响应里没有引用该前缀下的真实 asset，无法验证",
    };
  }
  const probe = await probeHttp(host, port, assetRef);
  if (probe.error) {
    return { id: "namespace-health", status: "UNKNOWN", evidence: "GET " + assetRef + " 连接失败（" + probe.error + "）" };
  }
  const statusOk = probe.status === 200 || probe.status === 304;
  const healthPart =
    typeof healthStatus === "number"
      ? "GET " + HEALTH_PATH + " 返回 " + healthStatus
      : "GET " + HEALTH_PATH + " 无响应";
  if (statusOk) {
    return { id: "namespace-health", status: "PASS", evidence: "GET " + assetRef + " 返回 " + probe.status + "；" + healthPart };
  }
  return { id: "namespace-health", status: "FAIL", evidence: "GET " + assetRef + " 返回异常状态 " + probe.status + "；" + healthPart };
}

/** Extract the real asset ref under a versioned prefix (query stripped) from a response body. */
function extractVersionedAssetRef(body, prefix) {
  const source = String(body || '');
  const BACKSLASH = String.fromCharCode(92);
  let escapedPrefix = '';
  for (const ch of String(prefix)) {
    escapedPrefix += /[A-Za-z0-9_]/.test(ch) ? ch : BACKSLASH + ch;
  }
  const re = new RegExp(escapedPrefix + '(assets/[A-Za-z0-9._-]+)');
  const match = re.exec(source);
  return match ? prefix + match[1] : '';
}

/**
 * 从日志行里取时间戳（网关行首形如 [2026-09-22T00:38:55.421Z]）。
 * 取不到返回 null：无法定年的行（例如栈续行）不参与窗口过滤，按「可能是本次」保留。
 */
function logLineTimestamp(line) {
  const match = /^\s*\[?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(line);
  if (!match) return null;
  const parsed = Date.parse(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 判据 4：网关日志里三条坏模式逐条检查。
 * 只统计统计窗口内的行：否则修复前的历史条目会让本判据永久 FAIL，
 * 失去「升级后是否新引入问题」的判据意义。
 *
 * 实现为**从尾部倒扫**：日志按时间追加，遇到第一条「有时间戳且早于窗口」的行即停，
 * 其前面的行必然也在窗口外。这样 Electron 控制台那种**没有时间戳**的行（例如
 * `[brand-network-overlay] … install failed`）会按位置归入窗口内或窗口外，
 * 而不是像「无时间戳一律算窗口内」那样把陈年旧账永久算成 FAIL。
 */
function checkLogPatterns(logFile, options = {}) {
  const cutoff = Number.isFinite(options.cutoffMs) ? options.cutoffMs : null;
  let raw = "";
  try {
    raw = fs.readFileSync(logFile, "utf-8");
  } catch {
    return { id: "log-patterns", status: "UNKNOWN", evidence: "日志文件不存在或不可读: " + logFile, text: null };
  }
  const lines = raw.split("\n");
  // 倒扫确定窗口边界：stopAtRightOf 之上的行都在窗口内，之下的都在窗口外。
  let windowStartIndex = 0; // 0 = 整个文件都在窗口内
  if (cutoff !== null) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const ts = logLineTimestamp(lines[i]);
      if (ts !== null && ts < cutoff) {
        windowStartIndex = i + 1;
        break;
      }
    }
  }
  const hits = [];
  let skipped = 0;
  LOG_BAD_PATTERNS.forEach((pattern) => {
    lines.forEach((line, index) => {
      if (!pattern.re.test(line)) return;
      if (index < windowStartIndex) { skipped += 1; return; }
      hits.push({ pattern: pattern.name, line: index + 1, content: trimText(line, 120), ts: logLineTimestamp(line) });
    });
  });
  if (hits.length === 0) {
    const scope = cutoff === null ? "" : "窗口内 ";
    const note = skipped > 0 ? "（窗口外还有 " + skipped + " 处历史命中，不计入）" : "";
    return { id: "log-patterns", status: "PASS", evidence: scope + "三条坏模式均未命中（brand-network-overlay install failed / Statsig 解析失败 / ERR_MODULE_NOT_FOUND）" + note, text: raw, skipped };
  }
  const detail = hits
    .slice(0, 5)
    .map((hit) => "L" + hit.line + (hit.ts ? " @" + new Date(hit.ts).toISOString() : "") + " [" + hit.pattern + "] " + hit.content)
    .join("；");
  return { id: "log-patterns", status: "FAIL", evidence: "窗口内命中 " + hits.length + " 处：" + detail, text: raw, skipped };
}

function readInstallVersion() {
  try {
    return fs.readFileSync(VERSION_FILE, "utf-8").trim() || "unknown";
  } catch {
    // dev 树没有 VERSION 时回落到 package.json，避免报告里出现无意义的 unknown。
    try {
      const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_FILE, "utf-8"));
      return pkg && pkg.version ? String(pkg.version) : "unknown";
    } catch {
      return "unknown";
    }
  }
}

/** 渲染人类可读报告（五段）。 */
function renderHuman(report) {
  const out = [];
  out.push("=== codex-desktop 网关 出站拦截自检 ===");
  out.push("生成时间: " + report.generatedAt + "　窗口: 最近 " + report.since + "（--since）");
  out.push("");
  const s = report.service;
  out.push("【1】服务/健康");
  out.push("  unit 状态: " + s.unit + "  ActiveState=" + s.activeState + "  NRestarts=" + s.restarts);
  out.push("  地址: " + s.url + "　GET " + HEALTH_PATH + " 状态码: " + s.healthStatus);
  out.push("  安装版本: " + s.version);
  out.push("");
  const c = report.config;
  out.push("【2】配置（" + c.configFile + "）");
  out.push("  品牌名: " + c.brand.name + "（来源: " + c.brand.source + (c.brand.configured ? "" : "，未配置") + "）");
  out.push("  语言: " + c.locale);
  out.push("  block（" + c.blockedHosts.length + " 条）: " + (c.blockedHosts.join(", ") || "（空）"));
  out.push("  allow（" + c.allowedHosts.length + " 条）: " + (c.allowedHosts.join(", ") || "（空）"));
  out.push("  allowPaths（" + c.allowedPaths.length + " 条）: " + (c.allowedPaths.join(", ") || "（空）"));
  out.push("");
  const a = report.activity;
  out.push("【3】拦截活动榜（top " + report.top + "，共 " + a.totalInWindow + " 次，其中 block " + a.totalBlock + " 次）");
  if (!a.available) {
    out.push("  （审计文件不可读: " + a.path + "）");
  } else if (a.entries.length === 0) {
    out.push("  （窗口内无拦截活动）");
  } else {
    const rows = a.entries.slice(0, report.top);
    const width = Math.min(72, Math.max(...rows.map((row) => row.host.length + row.path.length)) + 4);
    out.push("  " + "host+path".padEnd(width) + "总次数  block  最后出现");
    for (const row of rows) {
      const key = row.host + row.path;
      out.push("  " + key.slice(0, width).padEnd(width) + String(row.total).padStart(4) + "  " + String(row.block).padStart(5) + "  " + new Date(row.lastTs).toISOString());
    }
    if (a.entries.length > rows.length) out.push("  … 其余 " + (a.entries.length - rows.length) + " 条未显示");
  }
  out.push("");
  out.push("【4】升级自检判据");
  for (const check of report.checks) {
    out.push("  [" + statusLabel(check.status) + "] " + check.name);
    out.push("      " + check.evidence);
  }
  out.push("");
  out.push("【5】建议（临时放行，升级后请复核并收窄/移除）");
  if (report.suggestions.length === 0) {
    out.push("  （无需临时放行建议）");
  } else {
    out.push(report.suggestionsYaml);
  }
  return out.join("\n");
}

/** doctor 主入口；返回进程退出码（0/1/2），报告写 stdout（--json 时只写 JSON）。 */
async function main(argv, injected = {}) {
  const nowMs = injected.nowMs || Date.now();
  const stdout = injected.stdout || process.stdout;
  const stderr = injected.stderr || process.stderr;
  const parsed = parseArgs(argv);
  if (parsed.error) {
    stderr.write(usageText() + "\n");
    stderr.write("参数错误: " + parsed.error + "\n");
    return 1;
  }
  const options = parsed.options;
  const sinceMs = parsed.sinceMs;

  try {
    // env-file 解析：HOST/PORT 供探测使用；品牌名/语言注入 process.env 后再 loadSiteConfig，
    // 从而报告「真实生效值」（loadSiteConfig 内部读 CODEX_DESKTOP_BRAND_NAME）。
    const envValues = parseEnvFile(options.envFile);
    const host = options.hostProvided ? options.host : envValues.HOST || "127.0.0.1";
    const port = options.portProvided ? options.port : Number(envValues.PORT) || 3737;
    if (envValues.CODEX_DESKTOP_BRAND_NAME) process.env.CODEX_DESKTOP_BRAND_NAME = envValues.CODEX_DESKTOP_BRAND_NAME;
    if (envValues.CODEX_DESKTOP_LOCALE) process.env.CODEX_DESKTOP_LOCALE = envValues.CODEX_DESKTOP_LOCALE;
    const locale = envValues.CODEX_DESKTOP_LOCALE || "zh-CN";

    let configText = "";
    try {
      configText = fs.readFileSync(options.configFile, "utf-8");
    } catch {
      configText = "";
    }
    const siteConfig = loadSiteConfig({ configPath: options.configFile });
    const allowedPaths = extractAllowPaths(configText);

    // 服务状态（systemctl 不可用 → UNKNOWN，不崩）。
    const unitStatus = checkUnitStatus("codex-desktop-gateway.service");
    const health = await probeHttp(host, port, HEALTH_PATH);
    const healthStatus = health.error || health.status === undefined ? "UNKNOWN" : health.status;

    // 审计窗口聚合（eventsInWindow 用于 initialize 判据精确判断 statsig-local）。
    const audit = aggregateAudit(options.auditFile, sinceMs, nowMs);

    // 四条升级自检判据（HTTP 探测并行，日志判据同步）。
    const logCheck = checkLogPatterns(options.logFile, { cutoffMs: nowMs - sinceMs });
    const logText = logCheck.text;
    const [webConfigCheck, namespaceCheck] = await Promise.all([
      checkWebConfig(host, port, siteConfig),
      checkVersionedNamespace(host, port, healthStatus),
    ]);
    const initializeCheck = checkInitialize(audit, logText);
    const checks = [
      { name: "ab.chatgpt.com/v1/initialize 本地应答", ...initializeCheck },
      { name: "/codex-web-config.js 与配置一致", ...webConfigCheck },
      { name: "版本化资源命名空间 + /api/health", ...namespaceCheck },
      { name: "日志坏模式检查", ...logCheck },
    ];

    const suggestions = buildSuggestionRules(audit.entries, options.minCount);
    const suggestionsYaml = suggestions.length
      ? [
          "# 临时放行建议（来自 doctor，升级后请复核并收窄/移除）：",
          "network:",
          "  allowPaths:",
          ...suggestions.map((rule) => '    - "' + rule.rule + '"'),
        ].join("\n")
      : "";

    const report = {
      generatedAt: new Date(nowMs).toISOString(),
      since: options.since,
      top: options.top,
      minCount: options.minCount,
      strict: options.strict,
      failOnBlock: options.failOnBlock,
      service: {
        unit: unitStatus.unit,
        activeState: unitStatus.activeState,
        restarts: unitStatus.restarts,
        url: "http://" + host + ":" + port + "/",
        healthStatus,
        healthPath: HEALTH_PATH,
        version: readInstallVersion(),
      },
      config: {
        configFile: options.configFile,
        brand: siteConfig.brand,
        locale,
        blockedHosts: siteConfig.network.blockedHosts,
        allowedHosts: siteConfig.network.allowedHosts,
        allowedPaths,
      },
      activity: {
        path: audit.path,
        available: audit.available,
        totalInWindow: audit.totalInWindow,
        totalBlock: audit.totalBlock,
        entries: audit.entries.slice(0, options.top),
        totalEntries: audit.entries.length,
      },
      checks,
      suggestions,
      suggestionsYaml,
    };

    const hasFail = checks.some((check) => check.status === "FAIL");
    const hasBlock = audit.totalBlock > 0;
    if (options.json) {
      stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      stdout.write(renderHuman(report) + "\n");
    }
    // --strict 只对「判据 FAIL」报警：窗口内出现 block 是设计内行为（遥测本就被拦），
    // 若把它也算失败，健康机器会永远退出 2，失去巡检价值。需要那种语义时用 --fail-on-block。
    if (options.strict && hasFail) return 2;
    if (options.failOnBlock && hasBlock) return 2;
    return 0;
  } catch (error) {
    // 兜底：doctor 本身不能因任何外部探测崩溃。
    stderr.write("doctor 运行异常（兜底）: " + (error && error.message ? error.message : String(error)) + "\n");
    return 1;
  }
}

module.exports = {
  main,
  parseSince,
  buildSuggestionRules,
  aggregateAudit,
  checkInitialize,
  extractAllowPaths,
  parseEnvFile,
  __test: { parseArgs, usageText, LOG_BAD_PATTERNS, AGGREGATED_EVENTS, compareCountDesc, compareBlockDesc },
};

if (require.main === module) {
  // main 是 async：等待 Promise 后以返回码退出。
  Promise.resolve(main(process.argv.slice(2))).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write("doctor 崩溃（不应发生）: " + (error && error.stack ? error.stack : String(error)) + "\n");
      process.exitCode = 1;
    }
  );
}
