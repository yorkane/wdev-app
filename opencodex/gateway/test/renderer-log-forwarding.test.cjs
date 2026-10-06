"use strict";

/**
 * 回归测试：官方 renderer 的 log-message 不得逐条占用网络 IPC。
 *
 * 线上症状：一次流式回答期间页面疯狂向 /api/ipc/invoke 发 POST 且全部停在 pending，
 * model/list、thread/list、mcp-request 这类真实 IPC 全被挤死；gateway 日志同一时刻记录
 * delta_events_last_30s≈5000，内容全是 item/reasoning/textDelta 的 trace 级 log-message。
 *
 * 根因：桌面端 ipcRenderer.send("codex_desktop:message-from-view", {type:"log-message"}) 是进程内调用，
 * Web 壳却把它变成一次「浏览器→反代→gateway」往返；而隐藏 main 处理该消息时又会把低于 maxLogLevel
 * （prod 默认 info，由 CODEX_MAX_LOG_LEVEL 决定）的行直接丢弃。数千条注定被丢弃的日志因此挤满了
 * 真实 IPC 的并发额度，并把 APISIX 到 gateway 的少量 upstream keepalive 连接全部占住。
 *
 * 现修法：页面侧按 main 的同一阈值在发出前丢弃（阈值由 gateway 配置脚本下发），幸存的日志改走
 * 既有的最低优先级队列，且失败不回传官方 —— 官方 logger 一旦收到失败会再记一条 log-message，
 * 那会把拥塞放大成自激循环。
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BRIDGE_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "web-shell", "internal", "providers", "codex-bridge-polyfill.js"),
  "utf8"
);
const OFFICIAL_RUNTIME_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "gateway", "runtime", "ipc", "official-runtime.cjs"),
  "utf8"
);
const { __test: officialRuntimeTest } = require("../runtime/ipc/official-runtime.cjs");

const MESSAGE_FROM_VIEW_CHANNEL = "codex_desktop:message-from-view";

function extractConst(source, name) {
  const anchor = "const " + name + " =";
  const start = source.indexOf(anchor);
  if (start === -1) throw new Error("const not found: " + name);
  return source.slice(start, source.indexOf(";", start) + 1);
}

function extractFunction(source, anchor) {
  const start = source.indexOf(anchor);
  if (start === -1) throw new Error("anchor not found: " + anchor);
  let depth = 0;
  const braceStart = source.indexOf("{", start);
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces for: " + anchor);
}

const GATE_FN_SOURCES = [
  extractFunction(BRIDGE_SOURCE, "function isRendererLogMessagePayload(channel, payload) {"),
  extractFunction(BRIDGE_SOURCE, "function rendererLogForwardMaxRank() {"),
  extractFunction(BRIDGE_SOURCE, "function rendererLogMessageRank(payload) {"),
  extractFunction(BRIDGE_SOURCE, "function forwardRendererLogMessage(payload) {"),
];

/**
 * 只装载日志过滤所需的切片：低优先级队列与真正的 IPC 发送都用探针替代，
 * 这样断言可以精确区分「本地丢弃」「入队」和「真正发出」。
 */
function makeEnv(options = {}) {
  const env = {
    queued: [],
    sent: [],
    cfg: { rendererLogLevel: options.rendererLogLevel },
    immediateResults: options.immediateResults || [],
  };
  const sandbox = {
    cfg: env.cfg,
    CLIENT_DIAGNOSTICS_ENABLED: true,
    ipcDiagnosticSummary: (channel, payload) => ({
      channel,
      payloadType: payload && payload.type,
      level: payload && payload.level,
    }),
    enqueueLowPriorityIpc(summary, task) {
      const item = { enqueued: true, reject: null, resolve: null, summary, task };
      env.queued.push(item);
      if (options.queueFull) {
        // 真实队列在 512 条上限处直接 reject，让上层自己决定怎么处置。
        return Promise.reject(new Error("Low-priority IPC queue limit exceeded"));
      }
      // 真实队列由 pump 在并发额度内取出任务；这里保持同样的「入队不等于发出」语义。
      return new Promise((resolve, reject) => {
        item.resolve = resolve;
        item.reject = reject;
      });
    },
    invokeGatewayImmediate(channel, ipcArgs, payload) {
      env.sent.push({ channel, ipcArgs, payload });
      const index = env.sent.length - 1;
      const outcome = env.immediateResults[index] || { ok: true };
      return outcome.reject ? Promise.reject(new Error(outcome.reject)) : Promise.resolve(outcome.value);
    },
  };
  vm.runInNewContext(
    [
      extractConst(BRIDGE_SOURCE, "RENDERER_LOG_LEVEL_RANK"),
      ...GATE_FN_SOURCES,
      "globalThis.__gate = {",
      "  isRendererLogMessagePayload,",
      "  rendererLogForwardMaxRank,",
      "  rendererLogMessageRank,",
      "  forwardRendererLogMessage,",
      "};",
    ].join("\n"),
    sandbox
  );
  env.gate = sandbox.__gate;
  /** 取出全部已入队任务并真正发送，模拟 pump 的并发放行。 */
  env.drain = async () => {
    const items = env.queued.splice(0, env.queued.length);
    for (const item of items) {
      try {
        item.resolve(await item.task());
      } catch (error) {
        item.reject(error);
      }
    }
    return items.length;
  };
  return env;
}

const logPayload = (level, message = "probe") => ({ level, message, type: "log-message" });

test("trace and debug renderer logs never reach the network", async () => {
  const env = makeEnv({ rendererLogLevel: "info" });

  for (const level of ["trace", "debug", "TRACE", "Debug"]) {
    assert.equal(await env.gate.forwardRendererLogMessage(logPayload(level)), true, "level: " + level);
  }
  assert.equal(env.queued.length, 0, "被 main 丢弃的等级不能进入 IPC 队列");
  assert.equal(env.sent.length, 0, "被 main 丢弃的等级不能产生网络往返");
});

test("logs the hidden main actually keeps are forwarded once", async () => {
  const env = makeEnv({ rendererLogLevel: "info" });

  const info = env.gate.forwardRendererLogMessage(logPayload("info", "thread_stream_view_activity_changed"));
  const warning = env.gate.forwardRendererLogMessage(logPayload("warning"));
  const error = env.gate.forwardRendererLogMessage(logPayload("error"));
  assert.equal(env.queued.length, 3, "幸存日志必须排队而不是并发抢占真实 IPC");
  assert.deepEqual(env.sent, [], "排队阶段不得提前发出");

  await env.drain();
  assert.equal(await info, true);
  assert.equal(await warning, true);
  assert.equal(await error, true);
  assert.equal(env.sent.length, 3);
  for (const call of env.sent) {
    assert.equal(call.channel, MESSAGE_FROM_VIEW_CHANNEL);
    assert.equal(call.ipcArgs.length, 1, "日志正文只能随 args 发送一份");
    assert.equal(call.ipcArgs[0], call.payload);
    assert.equal(call.payload.type, "log-message");
  }
});

test("the page threshold follows the gateway maxLogLevel", async () => {
  for (const [configured, forwardedLevels] of [
    ["error", ["error"]],
    ["warning", ["error", "warning"]],
    ["debug", ["error", "warning", "info", "debug"]],
    ["trace", ["error", "warning", "info", "debug", "trace"]],
    ["", ["error", "warning", "info"]],
    ["  INFO ", ["error", "warning", "info"]],
    // 拼错的等级不能让日志面意外打开成 trace。
    ["verbose", ["error", "warning", "info"]],
    [undefined, ["error", "warning", "info"]],
  ]) {
    const env = makeEnv({ rendererLogLevel: configured });
    const levels = ["error", "warning", "info", "debug", "trace"];
    for (const level of levels) await env.gate.forwardRendererLogMessage(logPayload(level));
    await env.drain();
    assert.deepEqual(
      env.sent.map((call) => call.payload.level),
      forwardedLevels,
      "rendererLogLevel=" + JSON.stringify(configured)
    );
  }
});

test("unknown or missing log levels are dropped like the official main drops them", async () => {
  const env = makeEnv({ rendererLogLevel: "trace" });

  for (const payload of [
    { message: "no level", type: "log-message" },
    { level: "", message: "empty level", type: "log-message" },
    { level: "critical", message: "unknown level", type: "log-message" },
    { level: 3, message: "numeric level", type: "log-message" },
  ]) {
    assert.equal(await env.gate.forwardRendererLogMessage(payload), true);
  }
  assert.equal(env.queued.length, 0);
  assert.equal(env.sent.length, 0);
});

test("a failed log delivery never rejects and never feeds the log loop back", async () => {
  const env = makeEnv({
    immediateResults: [{ reject: "WebSocket IPC request timed out" }, { reject: "gateway offline" }],
    rendererLogLevel: "info",
  });

  // 官方 renderer 对 sendMessageFromView 的 rejection 会记 warning 级 log-message；
  // 拥塞时那等于把同一份负载重发第二遍，因此这里必须把失败吃成成功。
  assert.equal(await env.gate.forwardRendererLogMessage(logPayload("info")), true);
  assert.equal(await env.gate.forwardRendererLogMessage(logPayload("warning")), true);
  await env.drain();
  assert.equal(env.sent.length, 2, "失败只走一次发送，不留重试尾巴");
});

test("the queue limit is swallowed too instead of surfacing to the official logger", async () => {
  const env = makeEnv({ queueFull: true, rendererLogLevel: "info" });

  const settled = [];
  for (const level of ["info", "warning"]) {
    settled.push(env.gate.forwardRendererLogMessage(logPayload(level)));
  }
  assert.deepEqual(await Promise.all(settled), [true, true], "队列饱和不得把异常冒回官方 logger");
  assert.equal(env.sent.length, 0);
});

test("only message-from-view log payloads are filtered", async () => {
  const env = makeEnv({ rendererLogLevel: "info" });

  assert.equal(env.gate.isRendererLogMessagePayload(MESSAGE_FROM_VIEW_CHANNEL, logPayload("info")), true);
  assert.equal(
    env.gate.isRendererLogMessagePayload("codex_desktop:worker:1:from-view", logPayload("info")),
    false,
    "worker 通道另有语义，不能顺手过滤"
  );
  assert.equal(env.gate.isRendererLogMessagePayload("thread-stream-state-changed", logPayload("info")), false);
  assert.equal(env.gate.isRendererLogMessagePayload(MESSAGE_FROM_VIEW_CHANNEL, { type: "fetch" }), false);
  assert.equal(env.gate.isRendererLogMessagePayload(MESSAGE_FROM_VIEW_CHANNEL, null), false);
  assert.equal(env.gate.isRendererLogMessagePayload(MESSAGE_FROM_VIEW_CHANNEL, "log-message"), false);
});

test("invokeGateway routes renderer logs through the filter before any transport", () => {
  const funnel = extractFunction(BRIDGE_SOURCE, "async function invokeGateway(channel, args) {");
  const filterIndex = funnel.indexOf("forwardRendererLogMessage(payload)");
  const connectorIndex = funnel.indexOf("handleConnectorLogoFetchInvoke(");
  const immediateIndex = funnel.indexOf("invokeGatewayImmediate(channel, ipcArgs, payload)");
  assert.ok(filterIndex >= 0, "invokeGateway 必须先过滤渲染端日志");
  assert.ok(connectorIndex > filterIndex && immediateIndex > filterIndex, "过滤必须发生在任何发送分支之前");
  // 官方 renderer 的日志唯一入口是 sendMessageFromView → invoke → invokeGateway。
  const entry = extractFunction(BRIDGE_SOURCE, "target.sendMessageFromView = async (payload) =>");
  assert.match(entry, /return invoke\("codex_desktop:message-from-view", payload\);/);
});

test("the gateway publishes the same threshold the hidden main filters with", () => {
  const original = process.env.CODEX_MAX_LOG_LEVEL;
  try {
    for (const [value, expected] of [
      ["trace", "trace"],
      [" DEBUG ", "debug"],
      ["error", "error"],
      ["nonsense", "info"],
      ["", "info"],
      [undefined, "info"],
    ]) {
      if (value === undefined) delete process.env.CODEX_MAX_LOG_LEVEL;
      else process.env.CODEX_MAX_LOG_LEVEL = value;
      assert.equal(officialRuntimeTest.rendererLogForwardLevel(), expected, "CODEX_MAX_LOG_LEVEL=" + value);
    }
  } finally {
    if (original === undefined) delete process.env.CODEX_MAX_LOG_LEVEL;
    else process.env.CODEX_MAX_LOG_LEVEL = original;
  }

  // 阈值必须随首屏配置脚本下发，否则页面无法知道 main 侧的丢弃阈值。
  assert.match(
    OFFICIAL_RUNTIME_SOURCE,
    /rendererLogLevel: \$\{JSON\.stringify\(rendererLogForwardLevel\(\)\)\}/
  );
});
