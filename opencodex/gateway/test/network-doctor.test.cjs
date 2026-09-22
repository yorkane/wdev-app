#!/usr/bin/env node
"use strict";

/**
 * network-doctor（出站拦截自检）的单元测试。
 *
 * 策略：fs.mkdtempSync 伪造审计 JSONL / 日志 / config.yaml / env-file，
 * 本地起一个临时 http server 顶替网关（/api/health 200、/codex-web-config.js 动态文本），
 * 然后 require("../dev/network-doctor.cjs") 直接调 main([...]) 并捕获 stdout。
 * 不依赖真实 systemd / 外网。
 */

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const doctor = require("../dev/network-doctor.cjs");

// ---------- 测试脚手架 ----------

const tempDirs = [];
// 兜底：所有临时网关 server 登记在册；测试即使断言失败漏掉 close，
// afterEach 与进程退出钩子也会强制断开，保证 node --test 一定能退出。
const openServers = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-test-"));
  tempDirs.push(dir);
  return dir;
}

/** 构造一套固定的假环境：审计/日志/config/env 文件；返回各文件路径。 */
function makeFixture({ auditLines, logText, brandName, allowPaths }) {
  const dir = makeTempDir();
  const auditFile = path.join(dir, "network-audit.jsonl");
  const logFile = path.join(dir, "gateway.log");
  const configFile = path.join(dir, "config.yaml");
  const envFile = path.join(dir, "gateway.env");
  fs.writeFileSync(auditFile, (auditLines || []).join("\n") + (auditLines && auditLines.length ? "\n" : ""));
  fs.writeFileSync(logFile, logText == null ? "" : logText);
  const yaml = [
    "brand:",
    "  name: " + (brandName || "WasuDev"),
    "network:",
    "  block:",
    '    - "*.chatgpt.com"',
    '    - "statsigapi.net"',
    "  allow: []",
    "  allowPaths:",
  ];
  for (const rule of allowPaths || []) yaml.push('    - "' + rule + '"');
  fs.writeFileSync(configFile, yaml.join("\n") + "\n");
  fs.writeFileSync(envFile, "HOST=127.0.0.1\nPORT=0\nCODEX_DESKTOP_LOCALE=zh-CN\n");
  return { dir, auditFile, logFile, configFile, envFile };
}

/** 起临时 http server 顶替网关；返回 Promise<{ host, port, close }>。 */
function startFakeGateway({ webConfigBody, rootBody }) {
  const server = http.createServer((req, res) => {
    server.keepAliveTimeout = 200;
    openServers.push(server);
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/codex-web-config.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(webConfigBody == null ? "window.__CODEX_WEB_CONFIG__ = {};" : webConfigBody);
      return;
    }
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(rootBody == null ? "<html></html>" : rootBody);
      return;
    }
    if (req.url && req.url.startsWith("/official-patched-v8-")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ assets: [] }));
      return;
    }
    res.writeHead(404);
      res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        host: "127.0.0.1",
        port,
        close: () =>
          new Promise((done) => {
            // 先断开未结束的探测连接，再等 server 真正关闭。
            try {
              server.closeAllConnections();
            } catch {
              /* 老版本 Node 没有该方法 */
            }
            server.close(() => done());
            // 双保险：极端情况下 close 回调不来，定时强制退出。
            setTimeout(() => done(), 1500).unref();
          }),
      });
    });
  });
}

function runDoctor(args) {
  // 不能全局替换 process.stdout：node --test 的 TAP 事件流也走 stdout，
  // 替换成「恒返回 false（反压）」的假实现会把父进程的 TAP 行吞掉，导致用例不被计数。
  // 改走 main 的注入口：给一个内存 Writable，测试只读它，不碰全局。
  const chunks = [];
  const fakeStdout = {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  };
  // 注入固定 nowMs 使窗口边界可复现。
  return doctor.main(args, { nowMs: NOW_MS, stdout: fakeStdout }).then((code) => ({ code, out: chunks.join("") }));
}

// 固定「现在」，保证窗口边界可复现。
const NOW_MS = Date.parse("2026-09-21T17:00:00.000Z");
const ts = (iso) => iso;

// ---------- 测试 ----------

test("parseSince：支持 m/h/d 且拒绝非法输入", () => {
  assert.equal(doctor.parseSince("30m"), 30 * 60_000);
  assert.equal(doctor.parseSince("1h"), 3_600_000);
  assert.equal(doctor.parseSince("24h"), 24 * 3_600_000);
  assert.equal(doctor.parseSince("2d"), 2 * 86_400_000);
  assert.equal(doctor.parseSince("abc"), null);
  assert.equal(doctor.parseSince("1x"), null);
  assert.equal(doctor.parseSince("0h"), null);
});

test("aggregateAudit：窗口内计数、host+path 分组与倒序排序", () => {
  const fixture = makeFixture({
    auditLines: [
      // 窗口内（相对 NOW_MS=17:00，--since 1h → 切线 16:00）：
      JSON.stringify({ ts: ts("2026-09-21T16:30:00.000Z"), event: "block", host: "chatgpt.com", path: "/backend-api/wham/usage", method: "POST" }),
      JSON.stringify({ ts: ts("2026-09-21T16:40:00.000Z"), event: "block", host: "chatgpt.com", path: "/backend-api/wham/usage", method: "POST" }),
      JSON.stringify({ ts: ts("2026-09-21T16:50:00.000Z"), event: "block", host: "chatgpt.com", path: "/backend-api/wham/usage", method: "POST" }),
      JSON.stringify({ ts: ts("2026-09-21T16:55:00.000Z"), event: "allow-path", host: "chatgpt.com", path: "/backend-api/wham/usage", method: "POST" }),
      JSON.stringify({ ts: ts("2026-09-21T16:58:00.000Z"), event: "statsig-local", host: "ab.chatgpt.com", path: "/v1/initialize", method: "POST" }),
      // 窗口外（15:00）与 config 事件：不应计入。
      JSON.stringify({ ts: ts("2026-09-21T15:00:00.000Z"), event: "block", host: "chatgpt.com", path: "/backend-api/old", method: "GET" }),
      JSON.stringify({ ts: ts("2026-09-21T16:59:00.000Z"), event: "config", host: "", path: "", blocked: 2 }),
      // 坏行：跳过。
      "{not json",
    ],
  });
  const audit = doctor.aggregateAudit(fixture.auditFile, 3_600_000, NOW_MS);
  assert.equal(audit.available, true);
  assert.equal(audit.totalInWindow, 5);
  assert.equal(audit.totalBlock, 3);
  assert.equal(audit.entries.length, 2);
  assert.deepEqual(audit.entries[0], {
    host: "chatgpt.com",
    path: "/backend-api/wham/usage",
    total: 4,
    block: 3,
    lastTs: Date.parse("2026-09-21T16:55:00.000Z"),
  });
  assert.equal(audit.entries[1].host, "ab.chatgpt.com");
  assert.equal(audit.entries[1].total, 1);
  assert.equal(audit.entries[1].block, 0);
});

test("buildSuggestionRules：≥min-count 收敛成前缀 glob，含多段/单段/host-only 且去重", () => {
  const entries = [
    { host: "chatgpt.com", path: "/backend-api/wham/usage", total: 5, block: 5, lastTs: NOW_MS },
    { host: "chatgpt.com", path: "/backend-api/other/thing", total: 5, block: 5, lastTs: NOW_MS }, // 收敛后与上一条同规则 → 去重
    { host: "ab.chatgpt.com", path: "/v1/initialize", total: 4, block: 4, lastTs: NOW_MS }, // 两段 → /v1/*
    { host: "statsigapi.net", path: "/initialize", total: 4, block: 4, lastTs: NOW_MS }, // 单段 → /initialize*
    { host: "statsigapi.net", path: "/", total: 4, block: 4, lastTs: NOW_MS }, // 0 段 → host-only
    { host: "statsigapi.net", path: "/sdk", total: 2, block: 2, lastTs: NOW_MS }, // block < 3 → 不进建议
  ];
  const rules = doctor.buildSuggestionRules(entries, 3);
  assert.deepEqual(
    rules.map((r) => r.rule),
    ["chatgpt.com/backend-api/*", "ab.chatgpt.com/v1/*", "statsigapi.net", "statsigapi.net/initialize*"]
  );
});

test("initialize 判据：statsig-local 且无 block 时 PASS；被 block 时 FAIL；都无时 UNKNOWN", () => {
  // 用临时目录造审计文件后走 aggregateAudit，保证事件明细真实。
  const mk = (lines) => {
    const fixture = makeFixture({ auditLines: lines });
    return doctor.aggregateAudit(fixture.auditFile, 3_600_000, NOW_MS);
  };
  const passAudit = mk([
    JSON.stringify({ ts: ts("2026-09-21T16:50:00.000Z"), event: "statsig-local", host: "ab.chatgpt.com", path: "/v1/initialize", method: "POST" }),
  ]);
  assert.equal(doctor.checkInitialize(passAudit, null).status, "PASS");

  const failAudit = mk([
    JSON.stringify({ ts: ts("2026-09-21T16:50:00.000Z"), event: "statsig-local", host: "ab.chatgpt.com", path: "/v1/initialize", method: "POST" }),
    JSON.stringify({ ts: ts("2026-09-21T16:51:00.000Z"), event: "block", host: "ab.chatgpt.com", path: "/v1/initialize", method: "POST" }),
  ]);
  const failCheck = doctor.checkInitialize(failAudit, null);
  assert.equal(failCheck.status, "FAIL");
  assert.match(failCheck.evidence, /界面可能卡英文/);

  const unknownAudit = mk([
    JSON.stringify({ ts: ts("2026-09-21T16:50:00.000Z"), event: "block", host: "other.example", path: "/x", method: "GET" }),
  ]);
  assert.equal(doctor.checkInitialize(unknownAudit, null).status, "UNKNOWN");
  // 无审计文件（available=false）且日志也无痕迹 → UNKNOWN。
  const empty = doctor.aggregateAudit(path.join(os.tmpdir(), "不存在的审计文件.jsonl"), 3_600_000, NOW_MS);
  assert.equal(doctor.checkInitialize(empty, null).status, "UNKNOWN");
});

test("main：--strict 时 FAIL/窗口内 block → 退出码 2；无 FAIL → 0", async () => {
  const webConfigBody =
    "window.__CODEX_WEB_CONFIG__ = {" +
    'brand: {"name":"WasuDev","source":"config","configured":true},' +
    'network: {"blockedHosts":["*.chatgpt.com","statsigapi.net"],"allowedHosts":[],' +
    'allowedPaths":["chatgpt.com/backend-api/*"]},' +
    'locale: "zh-CN"};';

  // 场景 A：statsig-local 正常（无 block）→ 无 FAIL → strict 也 0。
  {
    const fixture = makeFixture({
      auditLines: [
        JSON.stringify({ ts: ts("2026-09-21T16:50:00.000Z"), event: "statsig-local", host: "ab.chatgpt.com", path: "/v1/initialize", method: "POST" }),
      ],
      logText: "normal gateway line\n",
      brandName: "WasuDev",
      allowPaths: ["chatgpt.com/backend-api/*"],
    });
    const gw = await startFakeGateway({ webConfigBody, rootBody: '<script src="/official-patched-v8-AbC123xY9z/app.js"></script>' });
    const code = await runDoctor([
      "--since", "1h",
      "--audit-file", fixture.auditFile,
      "--log-file", fixture.logFile,
      "--config-file", fixture.configFile,
      "--env-file", fixture.envFile,
      "--host", gw.host,
      "--port", String(gw.port),
      "--strict",
    ]);
    assert.equal(code.code, 0);
    await gw.close();
  }

  // 场景 B：initialize 被 block（FAIL）→ strict 退出码 2。
  {
    const fixture = makeFixture({
      auditLines: [
        JSON.stringify({ ts: ts("2026-09-21T16:50:00.000Z"), event: "block", host: "ab.chatgpt.com", path: "/v1/initialize", method: "POST" }),
      ],
      logText: "normal gateway line\n",
      brandName: "WasuDev",
    });
    const gw = await startFakeGateway({ webConfigBody });
    const code = await runDoctor([
      "--since", "1h",
      "--audit-file", fixture.auditFile,
      "--log-file", fixture.logFile,
      "--config-file", fixture.configFile,
      "--env-file", fixture.envFile,
      "--host", gw.host,
      "--port", String(gw.port),
      "--strict",
    ]);
    assert.equal(code.code, 2);
    await gw.close();
  }
});

test("main：--json 输出可 JSON.parse，含 checks/suggestions 五段结构化数据", async () => {
  const webConfigBody =
    "window.__CODEX_WEB_CONFIG__ = {" +
    'brand: {"name":"WasuDev","source":"config","configured":true},' +
    'network: {"blockedHosts":["*.chatgpt.com","statsigapi.net"],"allowedHosts":[]},' +
    'locale: "zh-CN"};';
  const fixture = makeFixture({
    auditLines: [
      // 同一 host+path block×3（达到默认 min-count=3 → 应出现在建议里）。
      JSON.stringify({ ts: ts("2026-09-21T16:50:00.000Z"), event: "block", host: "chatgpt.com", path: "/backend-api/wham/usage", method: "POST" }),
      JSON.stringify({ ts: ts("2026-09-21T16:51:00.000Z"), event: "block", host: "chatgpt.com", path: "/backend-api/wham/usage", method: "POST" }),
      JSON.stringify({ ts: ts("2026-09-21T16:52:00.000Z"), event: "block", host: "chatgpt.com", path: "/backend-api/wham/usage", method: "POST" }),
      JSON.stringify({ ts: ts("2026-09-21T16:53:00.000Z"), event: "statsig-local", host: "ab.chatgpt.com", path: "/v1/initialize", method: "POST" }),
    ],
    logText: "normal gateway line\n",
    brandName: "WasuDev",
  });
  const gw = await startFakeGateway({ webConfigBody, rootBody: '<link href="/official-patched-v8-AbC123xY9z/app.js">' });
  const code = await runDoctor([
    "--since", "1h",
    "--audit-file", fixture.auditFile,
    "--log-file", fixture.logFile,
    "--config-file", fixture.configFile,
    "--env-file", fixture.envFile,
    "--host", gw.host,
    "--port", String(gw.port),
    "--json",
  ]);
  const report = JSON.parse(code.out);
  // 五段：service / config / activity / checks / suggestions。
  assert.ok(report.service && (typeof report.service.healthStatus === "number" || typeof report.service.healthStatus === "string"));
  assert.equal(report.service.healthStatus, 200);
  assert.equal(report.config.brand.name, "WasuDev");
  assert.equal(report.config.locale, "zh-CN");
  assert.equal(report.config.blockedHosts.length, 2);
  assert.equal(report.activity.totalBlock, 3);
  assert.ok(Array.isArray(report.checks) && report.checks.length === 4);
  assert.ok(Array.isArray(report.suggestions));
  assert.ok(report.suggestions.some((s) => s.rule === "chatgpt.com/backend-api/*"));
  assert.match(report.suggestionsYaml, /allowPaths:/);
  assert.match(report.suggestionsYaml, /chatgpt\.com\/backend-api\/\*/);
  // 非 strict 且存在 block → 退出码仍是 0。
  assert.equal(code.code, 0);
  await gw.close();
});

test("main：日志坏模式命中时判据 FAIL", async () => {
  const webConfigBody =
    "window.__CODEX_WEB_CONFIG__ = {" +
    'brand: {"name":"WasuDev","source":"config","configured":true},' +
    'network: {"blockedHosts":["*.chatgpt.com"],"allowedHosts":[]},' +
    'locale: "zh-CN"};';
  const fixture = makeFixture({
    auditLines: [
      JSON.stringify({ ts: ts("2026-09-21T16:50:00.000Z"), event: "statsig-local", host: "ab.chatgpt.com", path: "/v1/initialize", method: "POST" }),
    ],
    // 假日志：含一条 Statsig 解析失败坏模式。
    logText: "boot ok\n[Statsig] Failed to parse Response for https://ab.chatgpt.com/v1/initialize\n",
    brandName: "WasuDev",
  });
  const gw = await startFakeGateway({ webConfigBody, rootBody: '<script src="/official-patched-v8-AbC123xY9z/app.js"></script>' });
  const code = await runDoctor([
    "--since", "1h",
    "--audit-file", fixture.auditFile,
    "--log-file", fixture.logFile,
    "--config-file", fixture.configFile,
    "--env-file", fixture.envFile,
    "--host", gw.host,
    "--port", String(gw.port),
    "--json",
  ]);
  const report = JSON.parse(code.out);
  const logCheck = report.checks.find((c) => c.id === "log-patterns");
  assert.equal(logCheck.status, "FAIL");
  assert.match(logCheck.evidence, /L2/);
  await gw.close();
});

test("main：坏参数（--since abc / 未知选项）退出码 1", async () => {
  const fixture = makeFixture({ auditLines: [] });
  const base = [
    "--audit-file", fixture.auditFile,
    "--log-file", fixture.logFile,
    "--config-file", fixture.configFile,
    "--env-file", fixture.envFile,
  ];
  const bad1 = await runDoctor(["--since", "abc", ...base]);
  assert.equal(bad1.code, 1);
  const bad2 = await runDoctor(["--nope", "1", ...base]);
  assert.equal(bad2.code, 1);
  const bad3 = await runDoctor(["--top", "zero", ...base]);
  assert.equal(bad3.code, 1);
});

test("main：窗口内无活动 → 报告含「（窗口内无拦截活动）」且无建议", async () => {
  const fixture = makeFixture({ auditLines: [] });
  const gw = await startFakeGateway({});
  const code = await runDoctor([
    "--since", "1h",
    "--audit-file", fixture.auditFile,
    "--log-file", fixture.logFile,
    "--config-file", fixture.configFile,
    "--env-file", fixture.envFile,
    "--host", gw.host,
    "--port", String(gw.port),
  ]);
  assert.equal(code.code, 0);
  assert.match(code.out, /窗口内无拦截活动/);
  assert.match(code.out, /无需临时放行建议/);
  await gw.close();
});

afterEach(() => {
  // 强制收尾任何漏关的临时网关。
  while (openServers.length) {
    const server = openServers.pop();
    try {
      server.closeAllConnections();
      server.close();
    } catch {
      /* 已关闭 */
    }
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
});

// 进程级最后防线：退出前断开所有残留 socket（防 keep-alive 残留句柄挂住 node --test）。
process.on("exit", () => {
  for (const server of openServers) {
    try {
      server.closeAllConnections();
      server.close();
    } catch {
      /* 忽略 */
    }
  }
});
