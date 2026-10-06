"use strict";
// runtime-compatibility 上报调度器的回归测试（node --test）。
//
// 加载方式：codex-runtime-compatibility.js 是浏览器全局脚本（IIFE + window），
// 因此沿用 gateway/test/web-runtime-compatibility.test.cjs 的做法，用 node:vm 在隔离
// context 里加载源码，并把 setTimeout/clearTimeout/Date/fetch/sessionStorage 换成可驱动的
// 假实现：假 timer 由测试显式推进（advanceBy/run），假 fetch 记录调用次数并可注入
// 成功/失败/挂起，从而在毫秒级验证 1s→2s→4s… 退避与 5 分钟冷却，无需真实等待。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const REPORTER_SOURCE = fs.readFileSync(
  // 允许用 RUNTIME_COMPATIBILITY_SOURCE 指向其它副本（例如备份文件），
  // 便于验证本套用例会如期抓出旧实现的反馈环。
  process.env.RUNTIME_COMPATIBILITY_SOURCE ||
    path.resolve(__dirname, "..", "codex-runtime-compatibility.js"),
  "utf8"
);
const PENDING_STORAGE_KEY = "opencodex.runtime-compatibility.pending.v2";

function createFakeClock(startMs) {
  let nowValue = startMs || 1_000_000;
  let nextId = 1;
  const timers = new Map();
  const clock = {
    now: () => nowValue,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, at: nowValue + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending() {
      return Array.from(timers.values())
        .map((timer) => timer.at - nowValue)
        .sort((left, right) => left - right);
    },
    earliest() {
      let best = null;
      for (const [id, timer] of timers) {
        if (!best || timer.at < best.timer.at) best = { id, timer };
      }
      return best;
    },
    async fireEarliest() {
      const best = clock.earliest();
      if (!best) return false;
      timers.delete(best.id);
      nowValue = Math.max(nowValue, best.timer.at);
      best.timer.callback();
      await flushMicrotasks();
      return true;
    },
    async advanceBy(ms) {
      const target = nowValue + Math.max(0, Number(ms) || 0);
      for (let step = 0; step < 5_000; step += 1) {
        const best = clock.earliest();
        if (!best || best.timer.at > target) break;
        await clock.fireEarliest();
      }
      nowValue = target;
      await flushMicrotasks();
    },
    async run(maxSteps) {
      const limit = maxSteps || 500;
      for (let step = 0; step < limit; step += 1) {
        if (!timers.size) return;
        await clock.fireEarliest();
      }
    },
  };
  return clock;
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createStorage(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

function pointSnapshot(id, overrides) {
  return Object.assign(
    {
      id,
      groupId: "renderer-core",
      status: "ready",
      directAdapterIds: ["adapter.desktop-bridge"],
      adapterChainIds: ["adapter.desktop-bridge", "adapter.runtime-hook"],
      contributions: [
        {
          id: id + "::0.0",
          directAdapterId: "adapter.desktop-bridge",
          adapterId: "adapter.runtime-hook",
          adapterChainIds: ["adapter.desktop-bridge", "adapter.runtime-hook"],
          location: "resolved",
          application: "applied",
          verification: "verified",
          activation: "ready",
          exercise: "not-exercised",
          hitCount: 0,
          reason: "",
        },
      ],
    },
    overrides || {}
  );
}

function snapshotOf(id, overrides) {
  return { points: [pointSnapshot(id, overrides)] };
}

// 只改 Contribution 内容（例如 hitCount），用于验证“内容变化必须补发”。
function snapshotWithContribution(id, contributionOverrides) {
  const point = pointSnapshot(id);
  return {
    points: [
      Object.assign({}, point, {
        status: "active",
        contributions: [Object.assign({}, point.contributions[0], contributionOverrides)],
      }),
    ],
  };
}

function createContext(options) {
  const config = options || {};
  const documentListeners = new Map();
  const windowListeners = new Map();
  const calls = [];
  const warn = config.warn || { messages: [] };
  const clock = config.clock || createFakeClock();
  const context = {
    crypto: { randomUUID: () => "browser_page_123" },
    console: { warn: (...args) => warn.messages.push(args.join(" ")), log: () => {} },
    Date: { now: () => clock.now() },
    document: {
      visibilityState: "visible",
      addEventListener(type, listener) {
        documentListeners.set(type, listener);
      },
      removeEventListener(type, listener) {
        if (documentListeners.get(type) === listener) documentListeners.delete(type);
      },
    },
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    fetch: async (url, options) => {
      const payload = JSON.parse(options.body);
      calls.push({ url, payload });
      if (config.fetchImpl) return config.fetchImpl(calls.length, payload, calls);
      return { ok: true, status: 200 };
    },
  };
  if (config.sessionStorage) context.sessionStorage = config.sessionStorage;
  context.window = context;
  vm.runInNewContext(REPORTER_SOURCE, context, { filename: "codex-runtime-compatibility.js" });
  const reporter = context.OpenCodexRuntimeCompatibility;
  const hooks = context.__OpenCodexRuntimeCompatibilityTestHooks;
  assert.equal(typeof reporter && typeof reporter.ingestSnapshot, "function", "reporter must expose ingestSnapshot");
  assert.equal(typeof hooks && typeof hooks.queuedCount, "function", "test hooks must be exposed for node --test");
  return { context, reporter, hooks, calls, clock, warn, documentListeners, windowListeners };
}

test("失败重试按 1s→2s→4s 指数退避推进，成功后复位为 1s", async () => {
  const harness = createContext({
    fetchImpl: async (count) => {
      if (count <= 3) throw new Error("offline");
      return { ok: true, status: 200 };
    },
  });
  harness.reporter.ingestSnapshot(snapshotOf("web.runtime.bridge.desktop-api"));

  await harness.clock.advanceBy(80);
  assert.equal(harness.calls.length, 1, "首次去抖后发起第一次发送");
  assert.equal(harness.hooks.retryDelay(), 2_000, "首次失败后下一次等待 2s");
  assert.deepEqual(harness.clock.pending(), [1_000], "本次失败使用 1s 起跳");

  await harness.clock.advanceBy(1_000);
  assert.equal(harness.calls.length, 2);
  assert.deepEqual(harness.clock.pending(), [2_000], "连续失败后等待时间翻倍");

  await harness.clock.advanceBy(2_000);
  assert.equal(harness.calls.length, 3);
  assert.deepEqual(harness.clock.pending(), [4_000]);

  await harness.clock.advanceBy(4_000);
  assert.equal(harness.calls.length, 4, "第 4 次发送成功");
  assert.equal(harness.hooks.retryDelay(), 1_000, "成功后退避复位为 1s");
  assert.equal(harness.hooks.queuedCount(), 0, "成功后队列排空");
  assert.deepEqual(harness.clock.pending(), [], "成功后不留重试定时器");
});

test("退避封顶 60s，连续失败达到阈值后进入静默冷却不再打端点", async () => {
  const harness = createContext({
    fetchImpl: async () => {
      throw new Error("gateway down");
    },
  });
  harness.reporter.ingestSnapshot(snapshotOf("web.runtime.bridge.desktop-api"));
  await harness.clock.advanceBy(80);

  // 前 7 次失败沿 1s→2s→…→60s 阶梯退避；第 8 次失败后改为静默冷却。
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    assert.equal(harness.calls.length, attempt, "第 " + attempt + " 次尝试");
    const expected = Math.min(60_000, 1_000 * Math.pow(2, attempt - 1));
    assert.equal(harness.clock.pending()[0], expected, "第 " + attempt + " 次失败后的调度间隔");
    await harness.clock.advanceBy(expected);
  }
  assert.equal(harness.calls.length, 8, "退避阶梯排满后仍有第 8 次尝试");
  assert.equal(harness.hooks.consecutiveFailures(), 8);
  assert.ok(harness.hooks.cooldownRemaining() > 0, "连续失败到阈值必须进入冷却");
  assert.ok(harness.warn.messages.length >= 1, "进入冷却必须 console.warn");

  const before = harness.calls.length;
  await harness.clock.advanceBy(120_000);
  assert.equal(harness.calls.length, before, "冷却期内不得继续发送");
});

test("同一份 report 幂等去重：高频同内容 ingest 只发一次且不重复消耗序号", async () => {
  const harness = createContext();
  const snapshot = snapshotOf("web.runtime.bridge.desktop-api", { status: "active" });
  harness.reporter.ingestSnapshot(snapshot);
  for (let i = 0; i < 50; i += 1) harness.reporter.ingestSnapshot(snapshot);
  await harness.clock.run();

  assert.equal(harness.calls.length, 1, "同内容重复 ingest 不应产生额外请求");
  assert.equal(harness.calls[0].payload.reports.length, 1);
  assert.equal(harness.calls[0].payload.reports[0].sequence, 1, "重复 ingest 不应消耗新的序号");
  assert.equal(harness.hooks.latestReportCount(), 1);

  for (let i = 0; i < 50; i += 1) harness.reporter.ingestSnapshot(snapshot);
  await harness.clock.run();
  assert.equal(harness.calls.length, 1, "已确认的同内容不得再次发送");
});

test("请求飞行期间被重新入队的同内容条目在确认后丢弃，内容变化仍补发", async () => {
  const pending = [];
  const harness = createContext({
    fetchImpl: () => new Promise((resolve) => pending.push(resolve)),
  });
  const snapshot = snapshotOf("web.runtime.bridge.mobile-keyboard");
  harness.reporter.ingestSnapshot(snapshot);
  await harness.clock.advanceBy(80);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.hooks.queuedCount(), 0, "入批即从队列摘除");

  for (let i = 0; i < 20; i += 1) harness.reporter.ingestSnapshot(snapshot);
  assert.equal(harness.hooks.queuedCount(), 1, "飞行期间同内容会临时回到队列");

  pending[0]({ ok: true, status: 200 });
  await harness.clock.advanceBy(0);
  assert.equal(harness.calls.length, 1, "同内容不得在确认后重发");
  assert.equal(harness.hooks.queuedCount(), 0);

  harness.reporter.ingestSnapshot(
    snapshotWithContribution("web.runtime.bridge.mobile-keyboard", { hitCount: 7 })
  );
  await harness.clock.advanceBy(500);
  assert.equal(harness.calls.length, 2, "内容变化必须补发");
  assert.equal(harness.calls[1].payload.reports[0].point.contributions[0].hitCount, 7);
});

test("页面隐藏时暂停调度，恢复可见后续跑", async () => {
  const harness = createContext();
  harness.context.document.visibilityState = "hidden";
  harness.reporter.ingestSnapshot(snapshotOf("web.runtime.bridge.hidden"));
  await harness.clock.advanceBy(5_000);
  assert.equal(harness.calls.length, 0, "hidden 期间不得发起请求");
  assert.deepEqual(harness.clock.pending(), [], "hidden 期间不得留下待触发 timer");

  harness.context.document.visibilityState = "visible";
  const listener = harness.documentListeners.get("visibilitychange");
  assert.equal(typeof listener, "function", "必须绑定 visibilitychange");
  listener();
  await harness.clock.advanceBy(200);
  assert.equal(harness.calls.length, 1, "恢复可见后必须续跑");
  assert.equal(harness.calls[0].payload.reports[0].point.id, "web.runtime.bridge.hidden");
});

test("resync 风暴抑制：服务端持续要求重放时发送必须收敛而非无限连锁", async () => {
  let revision = 0;
  const harness = createContext({
    fetchImpl: async () => {
      revision += 1;
      // 每次都返回一个新的 reportEpoch，制造 epoch 抖动（历史反馈环的触发形态）。
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, accepted: 1, reportEpoch: "instance_x:" + revision, resync: true }),
      };
    },
  });
  harness.reporter.ingestSnapshot(snapshotOf("web.runtime.bridge.desktop-api"));
  await harness.clock.run(2_000);

  assert.ok(harness.calls.length <= 30, "1 分钟内请求数必须被预算封顶，实际 " + harness.calls.length);
  const sends = harness.calls.filter((call) => call.payload.reports.length > 0).length;
  assert.ok(sends < 12, "重放驱动的发送必须收敛，实际 " + sends);
  assert.ok(harness.calls[0].payload.reports[0].sequence === 1);
});

test("请求预算：60s 内超过 30 次请求即静默冷却，冷却结束后自动续跑", async () => {
  const warn = { messages: [] };
  const harness = createContext({ warn });
  const points = Array.from({ length: 500 }, (_v, index) =>
    pointSnapshot("web.runtime.bulk." + String(index).padStart(3, "0"))
  );
  harness.reporter.ingestSnapshot({ points });
  await harness.clock.advanceBy(80);

  assert.equal(harness.calls.length, 30, "预算内应恰好发出 30 次请求，实际 " + harness.calls.length);
  assert.ok(harness.hooks.cooldownRemaining() > 0, "超预算必须进入冷却");
  assert.ok(warn.messages.some((line) => line.indexOf("静默冷却") >= 0), "冷却必须 console.warn");

  assert.ok(harness.hooks.queuedCount() > 0, "冷却必须保留待发送队列，不能丢报告");
  await harness.clock.advanceBy(239_000);
  assert.equal(harness.calls.length, 30, "冷却未结束前不得恢复发送");

  await harness.clock.advanceBy(61_000);
  await harness.clock.advanceBy(1_000);
  assert.ok(harness.calls.length > 30, "冷却结束后必须自动续跑，实际 " + harness.calls.length);
});

test("sessionStorage 恢复：上限 20 条、读后立即清除标记、失败时才落盘", async () => {
  const items = Array.from({ length: 50 }, (_v, index) => ({
    point: pointSnapshot("web.runtime.restore." + String(index).padStart(2, "0")),
    signature: "stale-signature",
    pluginId: "",
  }));
  const storage = createStorage();
  storage.setItem(PENDING_STORAGE_KEY, JSON.stringify({ clientId: "stale_client", items }));
  const harness = createContext({
    sessionStorage: storage,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });

  assert.equal(harness.hooks.queuedCount(), 20, "恢复条数必须封顶 20 条");
  assert.equal(harness.hooks.latestReportCount(), 20);
  assert.equal(storage.store.has(PENDING_STORAGE_KEY), false, "恢复后必须立即清除存储标记");

  await harness.clock.advanceBy(80);
  assert.equal(harness.calls.length, 1);
  assert.equal(storage.store.has(PENDING_STORAGE_KEY), true, "失败报告需要可跨刷新恢复");
  const persisted = JSON.parse(storage.getItem(PENDING_STORAGE_KEY));
  assert.equal(persisted.items.length, 20, "落盘同样受 20 条上限约束");
  assert.equal(persisted.clientId, harness.reporter.clientId);
});

test("恢复只发生一次：队列排空后标记清除，第二次加载不重放历史", async () => {
  const storage = createStorage();
  const first = createContext({ sessionStorage: storage });
  first.reporter.ingestSnapshot(snapshotOf("web.runtime.persist.a"));
  await first.clock.advanceBy(80);
  assert.equal(first.calls.length, 1);
  assert.equal(storage.store.has(PENDING_STORAGE_KEY), false, "队列排空后必须清除标记");

  const second = createContext({ sessionStorage: storage });
  await second.clock.advanceBy(60_000);
  assert.equal(second.calls.length, 0, "空存储不得重放任何历史报告");
  assert.equal(second.hooks.queuedCount(), 0);
});
