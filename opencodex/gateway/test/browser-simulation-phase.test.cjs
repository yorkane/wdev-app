"use strict";

/**
 * 桥接迁移 Phase 1：浏览器侧模拟层旗标化停用的回归测试。
 *
 * 覆盖 e7 盘点（/data/tmp/aq_analysis/e7_bridge/report.md）的三层：
 *   L13 polyfill 本地 fetch 拦截与响应合成（report.md:37）
 *   L15 runtime-compatibility 浏览器上报 + 服务端「接管即推进 epoch」（report.md:39）
 *   L18 浏览器 UI 补丁簇（report.md:42）
 * L14 浏览器出站拦截（report.md:38）按用户裁决保留到 Phase 2，必须两条 phase 都在场。
 *
 * 旗标：env OPENCODEX_BROWSER_SIMULATION_PHASE = legacy（默认）| phase1，
 * 非法值回退 legacy 并 warn；两工厂都支持显式入参以便同进程对照。
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

/** 与 static-assets 套件同样的做法：钉死配置路径，避免宿主环境的 config.yaml 让清单断言漂移。 */
process.env.CODEX_WEB_CONFIG_PATH = path.join(os.tmpdir(), "opencodex-browser-simulation-phase-absent.yaml");

const { resolveBrowserSimulationPhase } = require("../runtime/core/config.cjs");
const { createStaticAssetService } = require("../runtime/http/static-assets.cjs");
const { createCompatibilityService } = require("../runtime/compatibility/service.cjs");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BRIDGE_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "web-shell", "internal", "providers", "codex-bridge-polyfill.js"),
  "utf-8"
);

const L13_ENTRIES = ["/codex-bridge-polyfill.js"];
const L15_ENTRIES = ["/codex-runtime-compatibility.js"];
const L18_ENTRIES = [
  "/codex-sidebar-preview.js",
  "/codex-offscreen-animation-guard.js",
  "/opencodex/internal/providers/mobile-keyboard-optimization.js",
  "/opencodex/internal/providers/ios-fix.js",
  "/opencodex/internal/providers/mobile-sidebar-auto-collapse.js",
  "/codex-window-controls-overlay.js",
  "/codex-tooltip-dismiss-guard.js",
  "/codex-brand-text.js",
  "/codex-menu-item-guard.js",
];
/** L14（Phase 2 前保留）与传输/桥接骨架：两条 phase 都必须在场。 */
const MUST_STAY = [
  "/codex-network-guard.js",
  "/codex-statsig-telemetry-guard.js",
  "/codex-app-host-message-codec.js",
  "/codex-remote-file-actions.js",
  "/codex-workspace-root-picker.js",
  "/codex-js-error-capture.js",
  "/opencodex-plugin-system.js",
];

function makeOfficialWebviewDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-phase-test-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    "<html><head><title>Codex</title></head><body></body></html>"
  );
  return dir;
}

function makeStaticService(t, phase) {
  return createStaticAssetService({
    getI18nSnapshot: () => ({ locale: "en-US", messages: {} }),
    getOfficialBundle: () => ({ webviewDir: makeOfficialWebviewDir(t) }),
    browserSimulationPhase: phase,
  });
}

function rendererHtml(service) {
  const html = service.createRendererResponse();
  assert.ok(html, "官方 renderer HTML 应当可用");
  return html;
}

function bootstrapSource(service) {
  const res = { headers: {}, setHeader() {}, removeHeader() {}, writeHead() {}, end(body) { res.body = body; } };
  service.serveRuntimeBootstrap({ headers: {} }, res);
  assert.equal(res.status, undefined);
  return String(res.body);
}

function providerKeys(source) {
  return [...source.matchAll(/providers\.register\(\s*"([^"]+)"/g)].map((match) => match[1]);
}

// ---------------------------------------------------------------------------
// 旗标解析
// ---------------------------------------------------------------------------

test("phase 旗标解析：缺省与非法值回退 legacy，phase1 归一化", () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  assert.equal(resolveBrowserSimulationPhase(undefined, warn), "legacy");
  assert.equal(resolveBrowserSimulationPhase("", warn), "legacy");
  assert.equal(resolveBrowserSimulationPhase("phase1", warn), "phase1");
  assert.equal(resolveBrowserSimulationPhase("  Phase1 ", warn), "phase1");
  assert.equal(resolveBrowserSimulationPhase("legacy", warn), "legacy");
  assert.equal(resolveBrowserSimulationPhase("phase2", warn), "legacy");
  assert.equal(resolveBrowserSimulationPhase("true", warn), "legacy");
  assert.ok(warnings.length >= 2, "非法值必须 warn：" + JSON.stringify(warnings));
  assert.ok(warnings.every((line) => line.includes("OPENCODEX_BROWSER_SIMULATION_PHASE")));
});

// ---------------------------------------------------------------------------
// L15 / L18：注入清单
// ---------------------------------------------------------------------------

function makeExternalPluginDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-phase-plugin-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  // 外部插件带真实入口时 canBundleRuntimeBootstrap() 为 false，HTML 走逐文件注入清单，
  // 这正是要对照 L13/L15/L18 条目的那条链路。
  const dir = path.join(root, "external-plugin");
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({ id: "example.phase", apiVersion: 2, entry: "dist/index.mjs", sdkVersion: "^2.0.0" })
  );
  fs.writeFileSync(path.join(dir, "dist", "index.mjs"), "export default sdk => void sdk;");
  return root;
}

function makeStaticServiceWithExternalPlugin(t, phase) {
  const previous = process.env.OPENCODEX_PLUGIN_DIRS;
  process.env.OPENCODEX_PLUGIN_DIRS = makeExternalPluginDir(t);
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODEX_PLUGIN_DIRS;
    else process.env.OPENCODEX_PLUGIN_DIRS = previous;
  });
  return makeStaticService(t, phase);
}

test("phase=legacy 时注入清单含 L13/L15/L18 全部条目（今天的行为快照）", (t) => {
  // 逐文件链路：外部插件在场时 HTML 直接带 <script src> 清单。
  const html = rendererHtml(makeStaticServiceWithExternalPlugin(t, "legacy"));
  for (const reqPath of [...L13_ENTRIES, ...L15_ENTRIES, ...L18_ENTRIES]) {
    assert.ok(html.includes('<script defer src="' + reqPath + '"></script>'), "legacy 逐文件清单缺少 " + reqPath);
  }
  // 聚合链路把源码正文内联（不含 URL），因此按 provider key 与文件独有标识断言。
  const aggregated = bootstrapSource(makeStaticService(t, "legacy"));
  const keys = providerKeys(aggregated);
  for (const key of ["sidebar-preview", "offscreen-animation", "mobile-keyboard", "ios-layout", "mobile-sidebar", "window-controls", "tooltip-dismiss", "brand-text", "menu-item-guard", "bridge", "network-guard", "statsig-telemetry-guard"]) {
    assert.ok(keys.includes(key), "legacy 聚合运行时缺少 provider " + key);
  }
  assert.ok(aggregated.includes("OpenCodexRuntimeCompatibility"), "legacy 聚合运行时缺 L15 上报脚本");
  assert.ok(aggregated.includes("opencodex-structured-clone-v1"), "legacy 聚合运行时缺 L10 编解码");
  assert.ok(aggregated.includes("__codexBridgePolyfillInstalled"), "legacy 聚合运行时缺 L13 所在 polyfill");
});

test("phase1 时 L15/L18 条目从逐文件注入清单缺席，L14 与桥接骨架仍在", (t) => {
  const html = rendererHtml(makeStaticServiceWithExternalPlugin(t, "phase1"));
  for (const reqPath of [...L15_ENTRIES, ...L18_ENTRIES]) {
    assert.ok(
      !html.includes('<script defer src="' + reqPath + '"></script>'),
      "phase1 逐文件清单仍注入 " + reqPath
    );
  }
  for (const reqPath of MUST_STAY) {
    assert.ok(html.includes('<script defer src="' + reqPath + '"></script>'), "phase1 误删保留条目 " + reqPath);
  }
  // L13 的注入单元是整个 polyfill（L11/L12/L17 同文件），因此条目本体必须仍在，停用发生在文件内部。
  assert.ok(html.includes('<script defer src="/codex-bridge-polyfill.js"></script>'));
});

test("phase1 时 L15/L18 provider 从聚合运行时缺席，L14 provider 在场", (t) => {
  const keys = providerKeys(bootstrapSource(makeStaticService(t, "phase1")));
  for (const key of ["sidebar-preview", "offscreen-animation", "mobile-keyboard", "ios-layout", "mobile-sidebar", "window-controls", "tooltip-dismiss", "brand-text", "menu-item-guard"]) {
    assert.ok(!keys.includes(key), "phase1 聚合运行时仍注入 " + key);
  }
  for (const key of ["network-guard", "statsig-telemetry-guard", "bridge", "js-error-capture", "token-usage-inline", "project-recent-sort"]) {
    assert.ok(keys.includes(key), "phase1 误删 provider " + key);
  }
});

test("phase=legacy 与 phase1 的注入清单差异只包含 L15/L18 条目", (t) => {
  const legacyKeys = providerKeys(bootstrapSource(makeStaticService(t, "legacy")));
  const phase1Keys = providerKeys(bootstrapSource(makeStaticService(t, "phase1")));
  const removed = legacyKeys.filter((key) => !phase1Keys.includes(key));
  const added = phase1Keys.filter((key) => !legacyKeys.includes(key));
  assert.deepEqual(added, [], "phase1 不应新增 provider");
  assert.deepEqual(removed.slice().sort(), [...L18_PROVIDER_KEYS].sort(), "被停用的 provider 必须恰好是 L18 清单");
});

const L18_PROVIDER_KEYS = [
  "sidebar-preview",
  "offscreen-animation",
  "mobile-keyboard",
  "ios-layout",
  "mobile-sidebar",
  "window-controls",
  "tooltip-dismiss",
  "brand-text",
  "menu-item-guard",
];

test("phase1 的官方 HTML 带阶段全局变量，legacy 不带（保证 legacy 字节等价）", (t) => {
  const legacy = rendererHtml(makeStaticService(t, "legacy"));
  const phase1 = rendererHtml(makeStaticService(t, "phase1"));
  assert.ok(!legacy.includes("__OPENCODEX_BROWSER_SIMULATION_PHASE__"));
  assert.match(phase1, /window\.__OPENCODEX_BROWSER_SIMULATION_PHASE__="phase1"/);
  assert.ok(legacy.includes("/codex-web-config.js"), "两条链路都要带 web-config");
  assert.ok(phase1.includes("/codex-web-config.js"));
});

// ---------------------------------------------------------------------------
// L13：polyfill 本地 fetch 合成
// ---------------------------------------------------------------------------

test("phase1 下 polyfill 的四处本地 fetch 合成分发整组停用", () => {
  const callSites = [
    "handlePickFilesFetchMessage(payload)",
    "handleIdeContextFetchMessage(payload)",
    "handlePostLoginStatsigBootstrapFetchMessage(payload)",
    "handleStatsigTelemetryFetchMessage(payload)",
  ];
  const guard = BRIDGE_SOURCE.indexOf('if (BROWSER_SIMULATION_PHASE !== "phase1") {');
  assert.ok(guard > 0, "缺少 L13 分发点的 phase 守卫");
  const window = BRIDGE_SOURCE.slice(guard, guard + 900);
  for (const callSite of callSites) {
    assert.ok(window.includes(callSite), "分发点未被包进 phase1 守卫：" + callSite);
  }
  // 四个 handler 本体不得引用旗标（它们会被 source-extraction 单测单独执行）。
  for (const name of callSites) {
    const start = BRIDGE_SOURCE.indexOf("  function " + name.replace("(payload)", ""));
    assert.ok(start > 0);
    const body = BRIDGE_SOURCE.slice(start, BRIDGE_SOURCE.indexOf("\n  }", start));
    assert.ok(!body.includes("BROWSER_SIMULATION_PHASE"), name + " 本体不应读旗标");
  }
});

test("phase1 下 window.fetch 包装不再本地合成，legacy 分支保持原顺序", () => {
  const start = BRIDGE_SOURCE.indexOf("if (typeof w.fetch === \"function\" && !w.__codexWebFetchPatched)");
  assert.ok(start > 0, "找不到 fetch 包装");
  const window = BRIDGE_SOURCE.slice(start, start + 1200);
  assert.ok(window.includes('if (BROWSER_SIMULATION_PHASE === "phase1") return originalFetch(input, init);'));
  // 2026-10-07 修订：sentry-ipc:// 是不可传输的 Electron 私有协议，两个阶段都空响应兜底
  // （phase1 下不兜底会被 CSP 拒绝并无限刷屏）；phase1 透传判定只须先于其余合成分支。
  assert.ok(
    window.indexOf('url.startsWith("sentry-ipc://")') < window.indexOf('if (BROWSER_SIMULATION_PHASE === "phase1")'),
    "sentry-ipc 兜底必须先于 phase 判定（两阶段都拦截）",
  );
  assert.ok(
    window.indexOf('if (BROWSER_SIMULATION_PHASE === "phase1")') < window.indexOf("isStatsigInitializeUrl(url)"),
    "phase1 透传判定必须先于其余合成分支",
  );
});

test("L13 停用不影响 L14 所需的 Statsig payload 构造器", () => {
  assert.match(BRIDGE_SOURCE, /w\.__OpenCodexStatsigInitializeFallback = buildStatsigInitializeResponse/);
  assert.match(BRIDGE_SOURCE, /w\.__OpenCodexStatsigEvaluationFallback = buildStatsigEvaluationResponse/);
  assert.doesNotMatch(BRIDGE_SOURCE, /delete w\.__OpenCodexStatsig/);
});

test("phase1 页面里四条合成消息直接落回官方通道（行为级）", () => {
  // 把生产分发块原样搬进沙箱，四个 handler 换成记名桩函数：
  // phase1 必须一次都不调用 handler、legacy 必须仍然本地合成。
  const guard = BRIDGE_SOURCE.indexOf('if (BROWSER_SIMULATION_PHASE !== "phase1") {');
  assert.ok(guard > 0, "缺少 L13 分发点的 phase 守卫");
  const block = BRIDGE_SOURCE.slice(guard, BRIDGE_SOURCE.indexOf("emitOpenCodexPluginEvent", guard));
  const stubs = [
    "function dispatch(payload) {",
    "  const calls = [];",
    "  function handlePickFilesFetchMessage() { calls.push(\"pick\"); return false; }",
    "  function handleIdeContextFetchMessage() { calls.push(\"ide\"); return false; }",
    "  function handlePostLoginStatsigBootstrapFetchMessage() { calls.push(\"statsig\"); return false; }",
    "  function handleStatsigTelemetryFetchMessage() { calls.push(\"telemetry\"); return false; }",
    block,
    "  calls.push(\"fallthrough\"); return calls;",
    "}",
    "dispatch",
  ];
  const script = stubs.join(String.fromCharCode(10));
  const run = (phase) => vm.runInNewContext(script, { BROWSER_SIMULATION_PHASE: phase }, {
    filename: "bridge-l13-phase.sandbox.js",
  })({ type: "fetch", url: "vscode://codex/pick-files", requestId: "r1" });
  // 沙箱出来的 Array 与宿主 realm 原型不同，deepEqual 会因跨 realm 失败：统一 JSON 化断言。
  assert.equal(
    JSON.stringify(run("phase1")),
    JSON.stringify(["fallthrough"]),
    "phase1 下任何本地合成都不得发生"
  );
  assert.ok(
    JSON.stringify(run("legacy")).includes("pick"),
    "legacy 必须仍然本地合成 pick-files"
  );
});
test("phase1 下上报端点回 200 确认但零落库（防灰度期残留标签页退避重试风暴）", async () => {
  const { handleRuntimeCompatibilityApi } = require("../runtime/http/runtime-compatibility.cjs");
  const { EventEmitter } = require("node:events");
  const service = createCompatibilityService({ browserSimulationPhase: "phase1" });
  try {
    assert.equal(service.browserSimulationPhase, "phase1");
    const fixture = kernelReportFixture();
    const req = new EventEmitter();
    req.method = "POST";
    const res = { status: 0, body: "", headers: {}, writeHead(s, h) { this.status = s; this.headers = h || {}; }, end(b) { this.body = String(b || ""); } };
    const url = { pathname: "/api/opencodex/runtime-compatibility/reports", searchParams: new URLSearchParams() };
    process.nextTick(() => {
      req.emit("data", Buffer.from(JSON.stringify({ clientId: fixture.clientId, generation: 1, reports: [fixture.report], reportEpoch: "x:0" })));
      req.emit("end");
    });
    assert.equal(await handleRuntimeCompatibilityApi(req, res, url, service), true);
    assert.equal(res.status, 200, "必须是 200 确认，400 会把旧页面推进重试阶梯");
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.accepted, 0);
    assert.equal(payload.dormant, true);
    assert.equal(payload.resync, false);
    const active = service.snapshot().points.filter((point) => point.status === "active" || point.status === "healthy");
    assert.deepEqual(active.map((point) => point.id), [], "phase1 端点不得写 Registry");
  } finally {
    service.dispose();
  }
});

test("legacy 下上报端点仍然真实落库（对照，证明 phase1 分流而非全局停用）", async () => {
  const { handleRuntimeCompatibilityApi } = require("../runtime/http/runtime-compatibility.cjs");
  const { EventEmitter } = require("node:events");
  const service = createCompatibilityService({ browserSimulationPhase: "legacy" });
  try {
    const fixture = kernelReportFixture();
    const req = new EventEmitter();
    req.method = "POST";
    const res = { status: 0, body: "", headers: {}, writeHead(s, h) { this.status = s; this.headers = h || {}; }, end(b) { this.body = String(b || ""); } };
    const url = { pathname: "/api/opencodex/runtime-compatibility/reports", searchParams: new URLSearchParams() };
    process.nextTick(() => {
      req.emit("data", Buffer.from(JSON.stringify({ clientId: fixture.clientId, generation: 1, reports: [fixture.report], reportEpoch: "x:0" })));
      req.emit("end");
    });
    await handleRuntimeCompatibilityApi(req, res, url, service);
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.accepted, 1, "legacy 必须继续接受上报");
    assert.equal(payload.dormant, undefined);
    assert.match(payload.reportEpoch, /:1$/);
  } finally {
    service.dispose();
  }
});

// ---------------------------------------------------------------------------
// L15：网关 epoch 接管 dormant
// ---------------------------------------------------------------------------

const { POINT_DEFINITION_BY_ID } = require("../dist/modification/catalog.js");
const { createProductionModificationCoordinator } = require("../dist/modification/production.js");

/** 复用 compatibility-service 套件的取证过夹具形态：点位必须来自目录定义，否则被 canAccept 拒绝。 */
function browserKernelPoint(id, { active = false } = {}) {
  const point = POINT_DEFINITION_BY_ID.get(id);
  let snapshot = null;
  const coordinator = createProductionModificationCoordinator({
    host: "browser",
    publish(value) { snapshot = value; },
  });
  const capability = coordinator.bind(point, () => true);
  if (active) capability();
  return snapshot;
}

function kernelReportFixture() {
  return {
    clientId: "browser_page_phase_test",
    generation: 1,
    report: { sequence: 1, point: browserKernelPoint("web.runtime.bridge.desktop-api", { active: true }) },
    reportEpoch: "instance:0",
  };
}

test("phase1 下 browserKernelReportResult 接口存在但不落库、resync 恒 false", () => {
  const service = createCompatibilityService({ browserSimulationPhase: "phase1" });
  try {
    assert.equal(typeof service.browserKernelReportResult, "function");
    const first = service.browserKernelReportResult(kernelReportFixture());
    assert.equal(first.accepted, false);
    assert.equal(first.resync, false);
    assert.match(first.reportEpoch, /:\d+$/);
    const again = service.browserKernelReportResult(kernelReportFixture());
    assert.equal(again.reportEpoch, first.reportEpoch, "phase1 代际必须冻结");
    assert.equal(service.snapshot().points.filter((point) => point.id.startsWith("web.runtime.")).every((point) => point.status !== "active"), true,
      "phase1 不能让任何 web.runtime.* 点位因浏览器上报变 active");
  } finally {
    service.dispose();
  }
});

test("legacy 下浏览器接管仍然推进 epoch 并落库（与今天一致）", () => {
  const legacy = createCompatibilityService({ browserSimulationPhase: "legacy" });
  const phase1 = createCompatibilityService({ browserSimulationPhase: "phase1" });
  try {
    const accepted = legacy.browserKernelReportResult(kernelReportFixture());
    assert.equal(accepted.accepted, true, "legacy 必须仍然接受合法上报");
    assert.match(accepted.reportEpoch, /:1$/);
    const repeat = legacy.browserKernelReportResult({ ...kernelReportFixture(), reportEpoch: "stale" });
    assert.equal(repeat.resync, true, "legacy 代际不一致仍要触发 resync");
    const frozen = phase1.browserKernelReportResult(kernelReportFixture());
    assert.match(frozen.reportEpoch, /:0$/, "phase1 永不自增代际");
  } finally {
    legacy.dispose();
    phase1.dispose();
  }
});

test("旗标缺省时两个工厂都读模块级 env 并保持 legacy 行为", (t) => {
  const previous = process.env.OPENCODEX_BROWSER_SIMULATION_PHASE;
  try {
    delete process.env.OPENCODEX_BROWSER_SIMULATION_PHASE;
    const service = createStaticAssetService({
      getI18nSnapshot: () => ({ locale: "en-US", messages: {} }),
      getOfficialBundle: () => ({ webviewDir: makeOfficialWebviewDir(t) }),
    });
    const keys = providerKeys(bootstrapSource(service));
    assert.ok(keys.includes("menu-item-guard") && keys.includes("window-controls"));
    const compat = createCompatibilityService();
    try {
      assert.equal(compat.browserKernelReportResult(kernelReportFixture()).accepted, true);
    } finally {
      compat.dispose();
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_BROWSER_SIMULATION_PHASE;
    else process.env.OPENCODEX_BROWSER_SIMULATION_PHASE = previous;
  }
});
