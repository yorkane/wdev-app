"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  createShutdownDrain,
  resolveDrainMs,
  DEFAULT_DRAIN_MS,
  MAX_DRAIN_MS,
} = require("../runtime/shutdown-drain.cjs");

function makeClock() {
  let nowMs = 0;
  const pending = [];
  return {
    now: () => nowMs,
    setTimeoutFn: (fn, ms) => {
      pending.push({ fn, at: nowMs + ms });
      return { unref() {} };
    },
    async tick(ms) {
      const target = nowMs + ms;
      for (;;) {
        pending.sort((a, b) => a.at - b.at);
        const next = pending.shift();
        if (!next || next.at > target) {
          if (next) pending.unshift(next);
          break;
        }
        nowMs = Math.max(nowMs, next.at);
        next.fn();
      }
      nowMs = target;
      await Promise.resolve();
    },
  };
}

test("活跃 turn 降到 0 后正常清空退出并记 started/clear", async () => {
  const clock = makeClock();
  const events = [];
  let count = 2;
  const drain = createShutdownDrain({
    getActiveWorkSnapshot: () => ({ activeTurnCount: count, activeThreadIds: ["t1", "t2"].slice(0, count) }),
    log: (event, details) => events.push({ event, details }),
    drainMs: 10_000,
    pollMs: 1_000,
    ...clock,
  });
  const running = drain.run("SIGTERM");
  await clock.tick(1_000);
  count = 1;
  await clock.tick(1_000);
  count = 0;
  await clock.tick(1_000);
  await running;
  const names = events.map((e) => e.event);
  assert.ok(names.includes("shutdown_drain_started"));
  assert.ok(names.includes("shutdown_drain_progress"));
  assert.ok(names.includes("shutdown_drain_clear"));
  assert.ok(!names.includes("shutdown_drain_timeout"));
  const snapshot = drain.snapshot();
  assert.equal(snapshot.started, 1);
  assert.equal(snapshot.cleared, 1);
  assert.equal(snapshot.timeouts, 0);
});

test("窗口超时打 drain_timeout 并携带剩余线程清单", async () => {
  const clock = makeClock();
  const events = [];
  const drain = createShutdownDrain({
    getActiveWorkSnapshot: () => ({ activeTurnCount: 3, activeThreadIds: ["a", "b", "c"] }),
    log: (event, details) => events.push({ event, details }),
    drainMs: 5_000,
    pollMs: 1_000,
    ...clock,
  });
  const running = drain.run("SIGTERM");
  await clock.tick(30_000);
  await running;
  const timeoutEvent = events.find((e) => e.event === "shutdown_drain_timeout");
  assert.ok(timeoutEvent, "必须出现超时事件");
  assert.equal(timeoutEvent.details.activeTurnCount, 3);
  assert.deepEqual(timeoutEvent.details.threadIds, ["a", "b", "c"]);
  assert.equal(drain.snapshot().timeouts, 1);
});

test("OPENCODEX_SHUTDOWN_DRAIN_MS=0 完全禁用排空（回滚开关）", async () => {
  let calls = 0;
  const drain = createShutdownDrain({
    getActiveWorkSnapshot: () => {
      calls += 1;
      return { activeTurnCount: 5, activeThreadIds: ["x"] };
    },
    drainMs: 0,
  });
  await drain.run("SIGTERM");
  assert.equal(calls, 0, "禁用时不得读取快照");
  assert.equal(drain.snapshot().disabledRuns, 1);
});

test("快照缺失或抛错按无快照放行，不影响关停", async () => {
  const events = [];
  const drainMissing = createShutdownDrain({
    getActiveWorkSnapshot: () => null,
    log: (event, details) => events.push({ event, details }),
    drainMs: 5_000,
  });
  await drainMissing.run("SIGTERM");
  const drainThrowing = createShutdownDrain({
    getActiveWorkSnapshot: () => {
      throw new Error("boom");
    },
    log: (event, details) => events.push({ event, details }),
    drainMs: 5_000,
  });
  await drainThrowing.run("SIGTERM");
  assert.equal(events.filter((e) => e.event === "shutdown_drain_started" && e.details.skipped === "no-snapshot").length, 2);
  assert.equal(events.filter((e) => e.event === "shutdown_drain_timeout").length, 0);
});

test("resolveDrainMs 默认值与上下钳制", () => {
  assert.equal(resolveDrainMs(undefined), DEFAULT_DRAIN_MS);
  assert.equal(resolveDrainMs("abc"), DEFAULT_DRAIN_MS);
  assert.equal(resolveDrainMs("0"), 0);
  assert.equal(resolveDrainMs("-5"), 0);
  assert.equal(resolveDrainMs("999999"), MAX_DRAIN_MS);
  assert.equal(resolveDrainMs("7000"), 7000);
});

test("进度日志只在计数变化时触发", async () => {
  const clock = makeClock();
  const events = [];
  let count = 2;
  const drain = createShutdownDrain({
    getActiveWorkSnapshot: () => ({ activeTurnCount: count, activeThreadIds: [] }),
    log: (event, details) => events.push({ event, details }),
    drainMs: 8_000,
    pollMs: 1_000,
    ...clock,
  });
  const running = drain.run("SIGTERM");
  await clock.tick(1_000); // count 不变：无 progress
  await clock.tick(1_000); // count 不变：无 progress
  count = 0;
  await clock.tick(1_000);
  await running;
  // 两次轮询计数未变 → 零 progress；唯一的 progress 来自 2→0 这一次变化。
  assert.equal(events.filter((e) => e.event === "shutdown_drain_progress").length, 1);
  assert.equal(events.find((e) => e.event === "shutdown_drain_progress").details.previousCount, 2);
  assert.ok(events.some((e) => e.event === "shutdown_drain_clear"));
});
