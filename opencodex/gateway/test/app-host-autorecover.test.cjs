#!/usr/bin/env node
"use strict";

/**
 * 隐藏渲染页 app-host 自愈（auto-recover）单元测试。
 *
 * 背景：浏览器页的 app-host 会话会覆盖隐藏渲染页自己的 view 注册槽（同 webContents.id），
 * 之后隐藏渲染页的轮询持续报 "no such export ID: 1"。缓解：60s 窗口内该错误 ≥ 3 次
 * 且当前没有任何浏览器客户端连接时，网关自动 reload 隐藏渲染页（限流：全局 10 分钟冷却，
 * 可被 OPENCODEX_APP_HOST_AUTORECOVER=0 关闭）。见 doc/SESSION-IDLE-AND-KIKI-DIAGNOSIS.md。
 *
 * 测试策略：official-runtime.cjs 顶层 require("electron") 在纯 Node 下只得到一个可执行
 * 路径字符串（官方 runtime 尚未 require，不会触碰它），本文件只调用 __test 暴露的
 * 纯函数与注入的假 webContents / 假 ws-hub，全程不启动 Electron。
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { __test, setWsHub } = require("../runtime/ipc/official-runtime.cjs");
const rec = __test.appHostAutoRecover;

// ---------- 脚手架 ----------

function makeWebContents() {
  const wc = { id: 1, destroyed: false, reloadCount: 0 };
  wc.isDestroyed = () => wc.destroyed;
  wc.reload = () => { wc.reloadCount += 1; };
  return wc;
}

/** 构造一个假 ws-hub：clients 集合里的 socket 带 readyState（1 = OPEN）。 */
function makeFakeHub(clientCount, { onRemoved } = {}) {
  const clients = new Set();
  for (let i = 0; i < clientCount; i += 1) clients.add({ readyState: 1, OPEN: 1 });
  return {
    clients,
    onClientReady() { return () => {}; },
    onClientRemoved(listener) {
      if (onRemoved) onRemoved(listener);
      return () => {};
    },
  };
}

const ENV_KEY = "OPENCODEX_APP_HOST_AUTORECOVER";
const ENV_COOLDOWN = "OPENCODEX_APP_HOST_AUTORECOVER_COOLDOWN_MS";
let previousEnabled = process.env[ENV_KEY];
let previousCooldown = process.env[ENV_COOLDOWN];

function setEnabled(value) {
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = String(value);
}

function cleanState(enabled) {
  rec.uninstallConsoleObserver();
  rec.installConsoleObserver();
  rec.reset();
  // 去重状态是进程级观测状态，逐条测试前必须复位，否则上一条测试的同文本行会吞掉本条计数。
  rec.resetObservationDedupe();
  setEnabled(enabled);
  process.env[ENV_COOLDOWN] = String(10 * 60_000);
}

test.afterEach(() => {
  setEnabled(previousEnabled);
  if (previousCooldown === undefined) delete process.env[ENV_COOLDOWN];
  else process.env[ENV_COOLDOWN] = previousCooldown;
  setWsHub(null);
  rec.uninstallConsoleObserver();
  rec.installConsoleObserver();
  rec.reset();
  rec.resetObservationDedupe();
  rec.setHiddenWebContentsForTest(null);
});

// ---------- 行识别 ----------

test("isFailureLine：只认隐藏渲染页（id=1 / visible=false）的 export 表错位行", () => {
  cleanState("1");
  const hidden = makeWebContents();
  rec.setHiddenWebContentsForTest(hidden);
  const good = "[electron-message-handler] sa_server_request_failed {\"message\":\"no such export ID: 1\"} rendererWebContentsId=1 rendererWindowVisible=false";
  const hiddenEntry = "[electron-message-handler] sa_server_request_failed {\"message\":\"no such entry on exports table\"} rendererWebContentsId=1 rendererWindowVisible=false";
  assert.equal(rec.isFailureLine(good), true, "id=1 的隐藏渲染页行必须命中");
  assert.equal(rec.isFailureLine(hiddenEntry), true, "exports table 变体必须命中");
  // 带 id 但 id≠1：不是隐藏渲染页（即使 visible 恰好也是 false 也不计）。
  assert.equal(rec.isFailureLine("[x] no such export ID: 1 rendererWebContentsId=2 rendererWindowVisible=false"), false);
  // 无 id 字段：按 visible=false 特征计。
  assert.equal(rec.isFailureLine("[electron-message-handler] no such export ID: 9 rendererWindowVisible=false"), true);
  // 浏览器页（visible=true）的同类错误不算。
  assert.equal(rec.isFailureLine("[x] no such export ID: 1 rendererWebContentsId=1 rendererWindowVisible=true"), false);
  assert.equal(rec.isFailureLine("[x] no such export ID: 1 rendererWindowVisible=true"), false);
  // 无关行。
  assert.equal(rec.isFailureLine("[gateway] request_failed {\"error\":\"boom\"}"), false);
  assert.equal(rec.isFailureLine(""), false);

  // 隐藏窗口尚未建立时，带 id 的行不计入（避免把别人家的 id=1 误认成隐藏页）。
  rec.setHiddenWebContentsForTest(null);
  assert.equal(rec.isFailureLine(good), false);
  assert.equal(rec.isFailureLine("[x] no such export ID: 9 rendererWindowVisible=false"), true);
});

// ---------- console 观测 ----------

test("console.log 观测：命中行计入窗口，非命中行不计数", () => {
  cleanState("1");
  rec.setHiddenWebContentsForTest(makeWebContents());
  setWsHub(makeFakeHub(0));
  // 装配顺序：先拆观测器拿回原生 console.log，再挂捕获 sink，最后重装观测器
  // （观测器的 inner 指向 sink）→ 命中行既计数、又原样落到 sink。
  rec.uninstallConsoleObserver();
  const original = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.map(String).join(" "));
  rec.installConsoleObserver();
  console.log("[electron-message-handler] sa_server_request_failed no such export ID: 1 rendererWindowVisible=false");
  console.log("[gateway] unrelated line");
  rec.uninstallConsoleObserver();
  console.log = original;
  const state = rec.state();
  assert.equal(state.failures.length, 1, "只有命中行计入 60s 窗口");
  assert.ok(logged.some((line) => line.includes("no such export ID")), "原日志行为不受观测影响");
  assert.ok(logged.some((line) => line.includes("unrelated")));
});

// ---------- stream 观测（新捕获点：process.stdout / process.stderr write） ----------
//
// 生产缺陷的根因就在这里：官方 main 的 logger 按级别分发（error→console.error、
// warning→console.warn、info→console.info、debug→console.debug、trace→console.log），
// 而 sa_server_request_failed 这类症状行是 error/warning 级 → 只经 process.stderr，
// 旧的 console.log hook 一行都抓不到（生产日志 14.6 万行症状行 / 0 次 autorecover）。
// 本组测试必须用 console.error / console.warn 走 stream 路径验证，不能用旧的 console.log 注入。

function attachObserverToSink() {
  rec.uninstallConsoleObserver();
  const captured = { out: [], err: [] };
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = function collectingStdoutWrite(chunk, ...rest) {
    captured.out.push(String(chunk));
    // 只吞掉本测试植入的症状行，其余原文（含 node --test 报告输出）继续交给真 fd。
    return String(chunk).includes("no such ") ? true : originalOut.apply(process.stdout, [chunk, ...rest]);
  };
  process.stderr.write = function collectingStderrWrite(chunk, ...rest) {
    captured.err.push(String(chunk));
    return String(chunk).includes("no such ") ? true : originalErr.apply(process.stderr, [chunk, ...rest]);
  };
  rec.installConsoleObserver();
  assert.equal(rec.streamObserverInstalled(), true, "安装观测器必须同时挂上 stdout/stderr 的 write hook");
  return {
    captured,
    detach() {
      rec.uninstallConsoleObserver();
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      rec.installConsoleObserver();
    },
  };
}

const HIDDEN_FAILURE_LINE =
  "[electron-message-handler] sa_server_request_failed {\"message\":\"no such export ID: 1\"} rendererWebContentsId=1 rendererWindowVisible=false";

/**
 * 生产里的症状行文本带 itemId / threadId / export id 等可变字段，彼此并不相同；
 * 用编号造行以区分「不同的真实投递」与「同一次投递被两层重复观测」。
 */
function hiddenFailureLine(n) {
  return '[electron-message-handler] sa_server_request_failed {"message":"no such export ID: 1"}' +
    ' rendererWebContentsId=1 rendererWindowVisible=false itemId=item_' + n;
}

test("stream 捕获：console.error（官方 error 级）的症状行计入窗口且日志原样落盘", () => {
  cleanState("1");
  const hidden = makeWebContents();
  rec.setHiddenWebContentsForTest(hidden);
  setWsHub(makeFakeHub(0));
  const sink = attachObserverToSink();
  try {
    console.error(HIDDEN_FAILURE_LINE);
    assert.equal(rec.state().failures.length, 1, "error 级症状行必须由 stream 捕获点计入");
    assert.ok(sink.captured.err.some((l) => l.includes("no such export ID")), "原 stderr 输出不受观测影响");
  } finally {
    sink.detach();
  }
});

test("stream 捕获：console.warn / 直接 process.stderr.write / Buffer 写入都能计数", () => {
  cleanState("1");
  const hidden = makeWebContents();
  rec.setHiddenWebContentsForTest(hidden);
  setWsHub(makeFakeHub(0));
  const sink = attachObserverToSink();
  try {
    console.warn(hiddenFailureLine(1)); // warning 级（官方 logger 的 warning 路径）
    assert.equal(rec.state().failures.length, 1, "warn 级症状行计入");
    assert.equal(hidden.reloadCount, 0, "1 次未达阈值不 reload");
    process.stderr.write(hiddenFailureLine(2) + "\n"); // 不经 console 的直写
    assert.equal(rec.state().failures.length, 2, "直写 stderr 也计入");
    process.stderr.write(Buffer.from(hiddenFailureLine(3) + "\n")); // Buffer chunk → 第 3 次达阈值
    assert.equal(hidden.reloadCount, 1, "经新捕获路径刷满阈值后必须真正 reload");
    assert.equal(rec.state().recoverCount, 1);
    assert.equal(rec.state().failures.length, 0, "reload 后症状窗口清空");
    assert.ok(sink.captured.err.some((l) => l.includes("itemId=item_1")), "warn 原文仍写进 stderr");
    assert.ok(sink.captured.err.some((l) => l.includes("itemId=item_3")), "Buffer 原文仍写进 stderr");
  } finally {
    sink.detach();
  }
});

test("stream 捕获：非症状行与浏览器页（visible=true）行不计入，且不影响其它日志", () => {
  cleanState("1");
  const hidden = makeWebContents();
  rec.setHiddenWebContentsForTest(hidden);
  setWsHub(makeFakeHub(0));
  const sink = attachObserverToSink();
  try {
    console.error("[electron-message-handler] sa_server_request_failed {\"message\":\"no such export ID: 1\"} rendererWebContentsId=1 rendererWindowVisible=true");
    console.error("[gateway] unrelated failure details");
    console.warn("plain warn");
    process.stdout.write("plain stdout\n");
    assert.equal(rec.state().failures.length, 0, "可见浏览器页与无关行不得计入");
    assert.equal(hidden.reloadCount, 0);
    assert.ok(sink.captured.err.some((l) => l.includes("unrelated")), "无关 stderr 原样落盘");
    assert.ok(sink.captured.out.some((l) => l.includes("plain stdout")), "无关 stdout 原样落盘");
  } finally {
    sink.detach();
  }
});

test("去重：console.log 的同一次投递只计一次（console hook 与其下游 stream 不重复计数）", () => {
  cleanState("1");
  const hidden = makeWebContents();
  rec.setHiddenWebContentsForTest(hidden);
  setWsHub(makeFakeHub(0));
  const sink = attachObserverToSink();
  try {
    // console hook 与它下游的 stdout stream hook 会各看到一次同一条日志 → 只计 1 次。
    console.log(hiddenFailureLine(1));
    assert.equal(rec.state().failures.length, 1, "同一次 console.log 投递只能计 1 次");
    assert.equal(rec.observerStats().streamYieldedToConsole, 1, "stream 层必须让路给 console 层的同一次投递");
    assert.equal(rec.observerStats().consoleCounted, 1);
    assert.equal(rec.observerStats().streamCounted, 0, "经 console 的投递不得由 stream 层重复计数");
    // 多参数形式：console 层只看到格式化前的 message，stream 层看到拼上 util.format 结果的全文。
    // 多参数：console 层按 util.format 规则格式化后仍命中，且只计 1 次。
    console.log("[electron-message-handler] sa_server_request_failed", { error: new Error("no such export ID: 1"), rendererWebContentsId: 1, rendererWindowVisible: false });
    assert.equal(rec.state().failures.length, 2, "多参数 console.log 同样只计 1 次");
    assert.equal(rec.observerStats().consoleCounted, 2, "第二行由 console 层计数");
    // 不经过 console 的直写：stream 层必须自己计数（不能被认领逻辑吞掉）→ 第 3 次达阈值。
    const statsBefore = rec.observerStats();
    process.stdout.write(hiddenFailureLine(3) + "\n");
    assert.equal(rec.observerStats().streamCounted, statsBefore.streamCounted + 1, "直写 stdout 由 stream 层自行计数");
    assert.equal(hidden.reloadCount, 1, "三种来源合计达阈值后触发 reload");
    assert.equal(rec.state().recoverCount, 1);
    assert.equal(rec.state().failures.length, 0, "reload 后症状窗口清空");
  } finally {
    sink.detach();
  }
});

test("去重窗口外的重复症状行仍分别计数（保证 60s/3 次阈值不被去重吞掉）", () => {
  cleanState("1");
  const hidden = makeWebContents();
  rec.setHiddenWebContentsForTest(hidden);
  setWsHub(makeFakeHub(0));
  const sink = attachObserverToSink();
  try {
    const originalNow = Date.now;
    let fake = originalNow.call(Date);
    Date.now = () => fake;
    try {
      console.error(hiddenFailureLine(1));
      fake += 1000; // 1s 后（真实轮询节奏）
      console.error(hiddenFailureLine(1));
      fake += 1000;
      console.error(hiddenFailureLine(1));
    } finally {
      Date.now = originalNow;
    }
    assert.equal(hidden.reloadCount, 1, "秒级间隔的重复症状必须逐次计数并触发");
  } finally {
    sink.detach();
  }
});

test("去重不会吞掉真实突发：同文本症状行毫秒级连发 3 次仍计 3 次并触发", () => {
  // 生产实测：症状行是密集突发（同一次故障里相邻两行只差 3~5ms、文本可以完全相同），
  // 所以任何"同文本+短时间窗"的去重都会把阈值误判成 1 次。这里用同文本连发做最严苛回归。
  cleanState("1");
  const hidden = makeWebContents();
  rec.setHiddenWebContentsForTest(hidden);
  setWsHub(makeFakeHub(0));
  const sink = attachObserverToSink();
  try {
    const burst = hiddenFailureLine("burst");
    console.error(burst);
    console.error(burst);
    assert.equal(rec.state().failures.length, 2, "同文本连发的第 2 次也要计数");
    console.error(burst);
    assert.equal(hidden.reloadCount, 1, "同文本连发 3 次必须达阈值并 reload");
    assert.equal(rec.state().recoverCount, 1);
    // 未经 console 的直写突发同样不受去重影响。
    rec.reset();
    const reloadsBefore = hidden.reloadCount;
    process.stderr.write(burst + "\n");
    process.stderr.write(burst + "\n");
    process.stderr.write(burst + "\n");
    assert.equal(rec.state().failures.length, 0, "第 3 次直写达阈值 → 立即 reload 并清空窗口");
    assert.equal(rec.state().recoverCount, 1, "reset 后重新计数：直写突发同样触发自愈");
    assert.equal(hidden.reloadCount, reloadsBefore + 1, "直写突发必须再做一次 reload");
  } finally {
    sink.detach();
  }
});

test("观测器可反复装卸：hook 不叠加、卸完后 stream 与 console 还原为原生实现", () => {
  cleanState("1");
  const hidden = makeWebContents();
  rec.setHiddenWebContentsForTest(hidden);
  setWsHub(makeFakeHub(0));
  // cleanState 已经装了一层观测器，先卸载才能取到真正的原生实现作为还原基准。
  rec.uninstallConsoleObserver();
  const nativeOut = process.stdout.write;
  const nativeErr = process.stderr.write;
  const nativeLog = console.log;
  assert.equal(rec.streamObserverInstalled(), false, "卸载后不应残留 stream hook");
  // 顶层已安装一次；再装若干次必须是幂等的（否则同一次投递会被计数多次 → 假阳性 reload）。
  rec.installConsoleObserver();
  rec.installConsoleObserver();
  rec.uninstallConsoleObserver();
  rec.installConsoleObserver();
  assert.equal(rec.streamObserverInstalled(), true);
  assert.notEqual(process.stdout.write, nativeOut, "安装后 stdout.write 应为观测 hook");
  assert.notEqual(console.log, nativeLog, "安装后 console.log 应为观测 hook");

  const counted = hiddenFailureLine("idem");
  process.stderr.write(counted + "\n");
  process.stderr.write(counted + "\n");
  assert.equal(rec.state().failures.length, 2, "反复装卸后每次投递仍只计一次");

  rec.uninstallConsoleObserver();
  assert.equal(process.stdout.write, nativeOut, "卸载必须还原原生 stdout.write");
  assert.equal(process.stderr.write, nativeErr, "卸载必须还原原生 stderr.write");
  assert.equal(console.log, nativeLog, "卸载必须还原安装前的 console.log");
  assert.equal(rec.streamObserverInstalled(), false);

  const before = rec.state().failures.length;
  process.stderr.write(hiddenFailureLine("after") + "\n");
  assert.equal(rec.state().failures.length, before, "卸载后不再观测");
  rec.installConsoleObserver();
});

// ---------- 触发/安全条件 ----------

test("达阈值 + 无客户端 → 触发 reload 一次", () => {
  cleanState("1");
  const hidden = makeWebContents();
  rec.setHiddenWebContentsForTest(hidden);
  setWsHub(makeFakeHub(0));
  const now = Date.now();
  rec.recordFailure(now - 1000);
  rec.recordFailure(now - 500);
  assert.equal(hidden.reloadCount, 0, "2 次（未达阈值）不 reload");
  rec.recordFailure(now);
  assert.equal(hidden.reloadCount, 1, "第 3 次达到阈值必须 reload 一次");
  const state = rec.state();
  assert.equal(state.recoverCount, 1);
  assert.equal(state.failures.length, 0, "reload 后清空症状窗口");
});

test("达阈值 + 有客户端 → 不 reload，记 deferred", () => {
  cleanState("1");
  const hidden = makeWebContents();
  rec.setHiddenWebContentsForTest(hidden);
  setWsHub(makeFakeHub(2));
  const now = Date.now();
  rec.recordFailure(now - 1000);
  rec.recordFailure(now - 500);
  rec.recordFailure(now);
  assert.equal(hidden.reloadCount, 0, "有客户端连接时不能 reload（会打断用户会话）");
  assert.equal(rec.state().recoverCount, 0);
  assert.ok(rec.state().deferredSinceMs !== null, "必须记 deferred");
  // 窗口内的失败仍在计数：客户端断开后的下一个检测窗口（client-gone）应能触发。
  setWsHub(makeFakeHub(0));
  rec.evaluate(Date.now(), "client-gone");
  assert.equal(hidden.reloadCount, 1, "客户端全断后的下一个窗口必须补做自愈");
  assert.equal(rec.state().deferredSinceMs, null, "自愈后复位 defer 标记");
});

test("冷却期内再次达阈值 → 不再 reload，但客户端断开后窗口再触发仍受冷却约束", () => {
  cleanState("1");
  const hidden = makeWebContents();
  rec.setHiddenWebContentsForTest(hidden);
  setWsHub(makeFakeHub(0));
  const now = Date.now();
  rec.recordFailure(now - 2000);
  rec.recordFailure(now - 1500);
  rec.recordFailure(now - 1000);
  assert.equal(hidden.reloadCount, 1);
  // 冷却期内（默认 10 分钟）再刷满阈值：不再 reload。
  rec.recordFailure(now);
  rec.recordFailure(now + 50);
  rec.recordFailure(now + 100);
  assert.equal(hidden.reloadCount, 1, "冷却期内不得二次 reload");
  assert.ok(rec.state().deferredSinceMs !== null, "冷却期内记 deferred");
  // 冷却期结束后恢复动作能力。
  rec.evaluate(now + 10 * 60_000 + 1000, "failure");
  assert.equal(hidden.reloadCount, 2, "冷却期过后允许下一次自愈");
});

test("OPENCODEX_APP_HOST_AUTORECOVER=0 → 完全不动作", () => {
  cleanState("0");
  const hidden = makeWebContents();
  rec.setHiddenWebContentsForTest(hidden);
  setWsHub(makeFakeHub(0));
  const now = Date.now();
  rec.recordFailure(now - 1000);
  rec.recordFailure(now - 500);
  rec.recordFailure(now);
  assert.equal(hidden.reloadCount, 0, "开关关闭时绝不动作");
  assert.equal(rec.state().recoverCount, 0);
  assert.equal(rec.state().deferredSinceMs, null, "关闭时不记 deferred");
  // 其他关闭写法：off / false。
  cleanState("off");
  rec.recordFailure(Date.now());
  rec.recordFailure(Date.now() + 1);
  rec.recordFailure(Date.now() + 2);
  assert.equal(hidden.reloadCount, 0, "off 等价于关闭");
  cleanState("false");
  rec.recordFailure(Date.now());
  rec.recordFailure(Date.now() + 1);
  rec.recordFailure(Date.now() + 2);
  assert.equal(hidden.reloadCount, 0, "false 等价于关闭");
});

test("未达阈值 → 不动作", () => {
  cleanState("1");
  const hidden = makeWebContents();
  rec.setHiddenWebContentsForTest(hidden);
  setWsHub(makeFakeHub(0));
  const now = Date.now();
  rec.recordFailure(now - 5000);
  rec.recordFailure(now - 4000);
  assert.equal(hidden.reloadCount, 0);
  assert.equal(rec.state().recoverCount, 0);
  assert.equal(rec.state().deferredSinceMs, null);
  // 窗口内 1 条（<3）：evaluate 不动作。
  rec.reset();
  rec.recordFailure(now - 10_000);
  rec.evaluate(now, "failure");
  assert.equal(hidden.reloadCount, 0, "窗口内仅 1 次（<3）不动作");
  // 窗口滑动：120s 之前的失败在计入时即滑出 60s 窗口，不会累计成假阳性。
  rec.reset();
  const old = now - 120_000;
  rec.recordFailure(old);
  rec.recordFailure(old + 1000);
  rec.evaluate(now, "failure");
  assert.equal(hidden.reloadCount, 0, "窗口外历史失败不触发");
});

test("隐藏窗口已销毁 → 跳过并记 skipped，不抛异常", () => {
  cleanState("1");
  const hidden = makeWebContents();
  hidden.destroyed = true;
  rec.setHiddenWebContentsForTest(hidden);
  setWsHub(makeFakeHub(0));
  const now = Date.now();
  rec.recordFailure(now - 1000);
  rec.recordFailure(now - 500);
  assert.doesNotThrow(() => rec.recordFailure(now));
  assert.equal(rec.state().recoverCount, 0, "销毁窗口不能算自愈成功");
  assert.ok(rec.state().deferredSinceMs !== null, "销毁后按推迟处理（窗口恢复后可再评估）");
  // webContents 为 null 同理。
  rec.reset();
  rec.setHiddenWebContentsForTest(null);
  assert.doesNotThrow(() => rec.evaluate(Date.now(), "failure"));
  assert.equal(rec.state().recoverCount, 0);
});

test("reload 抛异常 → 只记日志，不冒泡", () => {
  cleanState("1");
  const hidden = { id: 1, isDestroyed: () => false, reload() { throw new Error("boom"); } };
  rec.setHiddenWebContentsForTest(hidden);
  setWsHub(makeFakeHub(0));
  const now = Date.now();
  rec.recordFailure(now - 1000);
  rec.recordFailure(now - 500);
  assert.doesNotThrow(() => rec.recordFailure(now));
  assert.equal(rec.state().recoverCount, 0, "失败不算成功触发");
});

test("冷却时间可被 OPENCODEX_APP_HOST_AUTORECOVER_COOLDOWN_MS 覆盖", () => {
  cleanState("1");
  process.env[ENV_COOLDOWN] = "1"; // 1ms 冷却：第二次几乎立即放行
  const hidden = makeWebContents();
  rec.setHiddenWebContentsForTest(hidden);
  setWsHub(makeFakeHub(0));
  const now = Date.now();
  rec.recordFailure(now - 2000);
  rec.recordFailure(now - 1500);
  rec.recordFailure(now - 1000);
  assert.equal(hidden.reloadCount, 1);
  // reload 后症状窗口清空；再刷 3 次，冷却 1ms 早已过 → 允许第二次自愈。
  rec.recordFailure(now);
  rec.recordFailure(now + 50);
  rec.recordFailure(now + 100);
  assert.equal(hidden.reloadCount, 2, "自定义冷却 1ms 后应立即允许第二次");
});

test("setWsHub(null) 断开 hub 后客户端计数按 0 处理（不误伤，也不 reload 风暴）", () => {
  cleanState("1");
  const hidden = makeWebContents();
  rec.setHiddenWebContentsForTest(hidden);
  setWsHub(makeFakeHub(3));
  const now = Date.now();
  rec.recordFailure(now - 500);
  rec.recordFailure(now - 400);
  assert.equal(hidden.reloadCount, 0);
  // hub 被摘除（进程收尾路径）：计数回落为 0，阈值满足时允许 reload。
  setWsHub(null);
  rec.recordFailure(now - 300);
  assert.equal(hidden.reloadCount, 1);
});
