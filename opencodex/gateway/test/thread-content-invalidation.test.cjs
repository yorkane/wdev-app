const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEBOUNCE_MAX_MS,
  DEBOUNCE_MIN_MS,
  MAX_KEYS_PER_THREAD,
  MESSAGE_FOR_VIEW_CHANNEL,
  RECENT_CONVERSATIONS_META_QUERY_KEY,
  THREAD_CONTENT_INVALIDATION_METHODS,
  TURN_TERMINAL_METHODS,
  classifyOutboundEnvelope,
  createThreadContentInvalidation,
  queryCacheInvalidateEnvelope,
  threadContentQueryKeys,
  threadIdFromPayload,
} = require("../runtime/ipc/thread-content-invalidation.cjs");

// 假 wsHub：只记录 broadcast 帧，返回固定收件人数（真实 hub 返回 sent 计数）。
function fakeHub(recipientCount = 3) {
  const frames = [];
  return {
    frames,
    broadcast(payload) {
      frames.push(payload);
      return recipientCount;
    },
  };
}

// 手工定时器：note() 只登记窗口，runDue() 模拟窗口到期，避免真实 500ms 等待。
function fakeTimers() {
  const queued = [];
  return {
    setTimeoutFn(fn, ms) {
      const timer = { fn, ms, cancelled: false };
      queued.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      if (timer) timer.cancelled = true;
    },
    runDue() {
      const due = queued.filter((timer) => !timer.cancelled);
      queued.length = 0;
      for (const timer of due) timer.fn();
      return due.length;
    },
    queuedTimers: queued,
  };
}

function notification(method, params, hostId = "local") {
  return {
    channel: MESSAGE_FOR_VIEW_CHANNEL,
    payload: { type: "mcp-notification", hostId, method, params },
  };
}

function makeInvalidation(options = {}) {
  const hub = options.hub || fakeHub();
  const timers = fakeTimers();
  const invalidation = createThreadContentInvalidation({
    debounceMs: options.debounceMs,
    env: options.env || {},
    hub: hub,
    onLog: options.onLog,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    wsHub: options.wsHub === undefined ? hub : options.wsHub,
  });
  return { hub, invalidation, timers };
}

// 浏览器实际消费的 key 形状（从官方 bundle 提取，见 report.md 的证据偏移）。
const THREAD_ID = "01a110e4-e666-7c31-a088-d0c7f1255e3e";
const EXPECTED_CONTENT_KEYS = Object.freeze([
  ["prompt-rail-history", THREAD_ID],
  ["mcp", "servers", "status", "local", "thread", THREAD_ID],
  ["thread-title-app-tool-inventory", "local", THREAD_ID],
  ["security", "local", "scan-thread", THREAD_ID],
]);

function queryKeysOf(frames) {
  return frames.map((frame) => frame.payload.params.queryKey);
}

test("内容 key 派生使用 bundle 里的真实 queryKey 形状", () => {
  assert.deepEqual(threadContentQueryKeys(THREAD_ID, "local"), EXPECTED_CONTENT_KEYS);
  // 无 hostId 时只发不依赖 hostId 的 key：带 hostId 的形状匹配不到真实查询，宁可不发。
  assert.deepEqual(threadContentQueryKeys(THREAD_ID, ""), [["prompt-rail-history", THREAD_ID]]);
  assert.deepEqual(threadContentQueryKeys("", "local"), []);
  // sidebar key 单独由 turn 终端附带，不参与内容 key 派生。
  assert.ok(!threadContentQueryKeys(THREAD_ID, "local").some((key) => key[0] === "recent-conversations-meta"));
});

test("触发方法集覆盖 item/*、turn/* 与 thread 生命周期", () => {
  for (const method of [
    "item/started",
    "item/updated",
    "item/completed",
    "item/agentMessage/delta",
    "item/reasoning/textDelta",
    "item/commandExecution/outputDelta",
    "turn/started",
    "turn/completed",
    "turn/failed",
    "turn/interrupted",
    "thread/started",
    "thread/name",
    "thread/archived",
  ]) {
    assert.ok(THREAD_CONTENT_INVALIDATION_METHODS.has(method), method + " 必须触发内容失效");
  }
  // 与 idempotent-read-cache / THREAD_LIST_INVALIDATION_METHODS 的终端语义对齐。
  assert.deepEqual([...TURN_TERMINAL_METHODS].sort(), ["turn/completed", "turn/failed", "turn/interrupted"]);
  // 非内容类通知不得触发（避免无关广播放大成 refetch 风暴）。
  assert.equal(classifyOutboundEnvelope(notification("account/rateLimits/updated", { rateLimits: {} })), null);
  assert.equal(classifyOutboundEnvelope(notification("item/unknownFutureThing", { threadId: THREAD_ID })), null);
  assert.equal(classifyOutboundEnvelope({ channel: MESSAGE_FOR_VIEW_CHANNEL, payload: { type: "mcp-response", message: { id: 1, result: {} } } }), null);
});

test("同线程突发通知合并为一帧/每 key（尾沿去抖）", () => {
  const { hub, invalidation, timers } = makeInvalidation();
  for (let i = 0; i < 25; i += 1) {
    invalidation.note(notification("item/started", { threadId: THREAD_ID, turnId: "turn-1" }));
  }
  invalidation.note(notification("item/completed", { threadId: THREAD_ID, turnId: "turn-1", item: { id: "i1" } }));
  assert.equal(hub.frames.length, 0, "窗口未到期前不能发帧");
  assert.deepEqual(invalidation.pendingThreadIds(), [THREAD_ID]);
  assert.equal(timers.runDue(), 1, "同线程只登记一个定时器");
  assert.equal(hub.frames.length, EXPECTED_CONTENT_KEYS.length, "突发只发一轮 key 帧");
  assert.deepEqual(queryKeysOf(hub.frames), EXPECTED_CONTENT_KEYS);
  const snapshot = invalidation.snapshot();
  assert.equal(snapshot.triggers, 26);
  assert.equal(snapshot.coalesced, 25);
  assert.equal(snapshot.sent, EXPECTED_CONTENT_KEYS.length);
});

test("帧格式复用 runThreadListInvalidation 的 envelope（浏览器零改动）", () => {
  const envelope = queryCacheInvalidateEnvelope(EXPECTED_CONTENT_KEYS[0]);
  assert.equal(envelope.channel, "codex_desktop:message-for-view");
  assert.deepEqual(Object.keys(envelope), ["channel", "payload"]);
  assert.deepEqual(envelope.payload, {
    type: "ipc-broadcast",
    method: "query-cache-invalidate",
    params: { queryKey: EXPECTED_CONTENT_KEYS[0] },
  });
  // 与既有 sidebar 帧同外壳。
  assert.deepEqual(queryCacheInvalidateEnvelope(RECENT_CONVERSATIONS_META_QUERY_KEY).payload.type, "ipc-broadcast");
});

test("turn 终端附带 sidebar 的 recent-conversations-meta", () => {
  const { hub, invalidation, timers } = makeInvalidation();
  invalidation.note(notification("turn/completed", { threadId: THREAD_ID, turn: { id: "turn-1" } }));
  timers.runDue();
  const keys = queryKeysOf(hub.frames);
  assert.deepEqual(keys, [...EXPECTED_CONTENT_KEYS, ["recent-conversations-meta"]]);

  // 纯内容类通知不附带 sidebar key（列表更新仍由既有列表失效负责）。
  const plain = makeInvalidation();
  plain.invalidation.note(notification("item/completed", { threadId: THREAD_ID }));
  plain.timers.runDue();
  assert.deepEqual(queryKeysOf(plain.hub.frames), EXPECTED_CONTENT_KEYS);
});

test("turn 终端在合并窗口内被后来的通知保留", () => {
  const { hub, invalidation, timers } = makeInvalidation();
  invalidation.note(notification("turn/completed", { threadId: THREAD_ID }));
  invalidation.note(notification("item/started", { threadId: THREAD_ID }));
  timers.runDue();
  assert.ok(queryKeysOf(hub.frames).some((key) => key[0] === "recent-conversations-meta"), "终端标记不能被后续通知冲掉");
});

test("kill switch：OPENCODEX_THREAD_CONTENT_INVALIDATE=off 完全直通", () => {
  const { hub, invalidation, timers } = makeInvalidation({
    env: { OPENCODEX_THREAD_CONTENT_INVALIDATE: "off" },
  });
  invalidation.note(notification("item/completed", { threadId: THREAD_ID }));
  invalidation.note(notification("turn/completed", { threadId: THREAD_ID }));
  assert.equal(timers.runDue(), 0);
  assert.equal(hub.frames.length, 0);
  const snapshot = invalidation.snapshot();
  assert.equal(snapshot.disabled, true);
  assert.equal(snapshot.triggers, 0);
  assert.equal(snapshot.sent, 0);
  assert.equal(snapshot.skippedDisabled, 2);
});

test("取不到 threadId 时跳过并计数", () => {
  const { hub, invalidation, timers } = makeInvalidation();
  invalidation.note(notification("item/completed", { turnId: "turn-1" }));
  invalidation.note(notification("turn/failed", {}));
  invalidation.note({ channel: MESSAGE_FOR_VIEW_CHANNEL, payload: { type: "mcp-notification", method: "item/started" } });
  assert.equal(timers.runDue(), 0);
  assert.equal(hub.frames.length, 0);
  const snapshot = invalidation.snapshot();
  assert.equal(snapshot.triggers, 3);
  assert.equal(snapshot.skippedNoThreadId, 3);
  assert.equal(snapshot.sent, 0);
  // thread.id / conversationId 两种形态仍能识别。
  assert.equal(threadIdFromPayload({ params: { thread: { id: "t-9" } } }), "t-9");
  assert.equal(threadIdFromPayload({ params: { conversationId: "c-9" } }), "c-9");
});

test("子智能体线程与主线程各自独立去抖", () => {
  const SUB_ID = "01a110e4-0000-7000-8000-000000000001";
  const { hub, invalidation, timers } = makeInvalidation();
  invalidation.note(notification("item/started", { threadId: THREAD_ID }));
  invalidation.note(notification("item/completed", { threadId: SUB_ID }));
  invalidation.note(notification("item/started", { threadId: SUB_ID }));
  assert.deepEqual(invalidation.pendingThreadIds().sort(), [SUB_ID, THREAD_ID].sort());
  assert.equal(timers.runDue(), 2, "不同线程不互相合并");
  const keys = queryKeysOf(hub.frames);
  assert.equal(keys.length, EXPECTED_CONTENT_KEYS.length * 2);
  assert.ok(keys.some((key) => key[1] === SUB_ID || (key[key.length - 1] || "") === SUB_ID), "子智能体线程同样覆盖");
});

test("peer 广播：thread-stream-state-changed snapshot 与 thread-archived 触发内容失效", () => {
  const { hub, invalidation, timers } = makeInvalidation();
  invalidation.note({
    channel: "thread-stream-state-changed",
    payload: {
      type: "broadcast",
      method: "thread-stream-state-changed",
      hostId: "local",
      params: { conversationId: THREAD_ID, hostId: "local", change: { type: "snapshot", revision: 6 } },
    },
  });
  invalidation.note({
    channel: MESSAGE_FOR_VIEW_CHANNEL,
    payload: { type: "ipc-broadcast", method: "thread-archived", params: { hostId: "local", conversationId: THREAD_ID } },
  });
  assert.equal(timers.runDue(), 1);
  // peer snapshot 等同终端 → 带 sidebar key。
  assert.ok(queryKeysOf(hub.frames).some((key) => key[0] === "recent-conversations-meta"));
  // 非 snapshot 的流状态变化（patch/心跳）不触发。
  const other = makeInvalidation();
  other.invalidation.note({
    channel: "thread-stream-state-changed",
    payload: { type: "broadcast", method: "thread-stream-state-changed", params: { conversationId: THREAD_ID, change: { type: "patch" } } },
  });
  assert.equal(other.invalidation.snapshot().triggers, 0);
  assert.equal(other.hub.frames.length, 0);
});

test("hub 未装配 / broadcast 抛错时静默降级", () => {
  // hub 缺失：不排队、不抛错。
  const idle = createThreadContentInvalidation({ env: {}, setTimeoutFn: () => ({}) });
  assert.equal(idle.note(notification("item/completed", { threadId: THREAD_ID })), false);
  assert.equal(idle.snapshot().triggers, 1);

  // broadcast 抛错：计入 sendFailures，不影响后续通知继续排程。
  const broken = fakeHub();
  broken.broadcast = () => {
    throw new Error("socket closed");
  };
  const { invalidation, timers } = makeInvalidation({ hub: broken });
  invalidation.note(notification("item/completed", { threadId: THREAD_ID }));
  timers.runDue();
  assert.equal(invalidation.snapshot().sendFailures, EXPECTED_CONTENT_KEYS.length);
  invalidation.note(notification("item/completed", { threadId: "t-later" }));
  assert.deepEqual(invalidation.pendingThreadIds(), ["t-later"]);
});

test("去抖窗口 env 可配并被钳在 100-5000ms", () => {
  assert.equal(createThreadContentInvalidation({ env: { OPENCODEX_THREAD_CONTENT_INVALIDATE_DEBOUNCE_MS: "120" } }).snapshot().debounceMs, 120);
  assert.equal(createThreadContentInvalidation({ env: { OPENCODEX_THREAD_CONTENT_INVALIDATE_DEBOUNCE_MS: "1" } }).snapshot().debounceMs, DEBOUNCE_MIN_MS);
  assert.equal(createThreadContentInvalidation({ env: { OPENCODEX_THREAD_CONTENT_INVALIDATE_DEBOUNCE_MS: "999999" } }).snapshot().debounceMs, DEBOUNCE_MAX_MS);
  assert.equal(createThreadContentInvalidation({ env: { OPENCODEX_THREAD_CONTENT_INVALIDATE_DEBOUNCE_MS: "garbage" } }).snapshot().debounceMs, 500);
  const { timers } = makeInvalidation({ env: { OPENCODEX_THREAD_CONTENT_INVALIDATE_DEBOUNCE_MS: "800" } });
  assert.equal(timers.queuedTimers.length, 0);
});

test("每线程 key 数有上限，flushPending 可立刻冲刷", () => {
  const { hub, invalidation, timers } = makeInvalidation();
  invalidation.note(notification("item/started", { threadId: THREAD_ID }));
  assert.equal(invalidation.snapshot().pendingThreads, 1);
  invalidation.flushPending();
  assert.equal(invalidation.snapshot().pendingThreads, 0);
  assert.equal(hub.frames.length, EXPECTED_CONTENT_KEYS.length);
  // 冲刷后定时器作废，到期不会二次发帧。
  assert.equal(timers.runDue(), 0);
  assert.equal(hub.frames.length, EXPECTED_CONTENT_KEYS.length);
  assert.ok(MAX_KEYS_PER_THREAD >= EXPECTED_CONTENT_KEYS.length);
});

test("bindWsHub：hub 在装配后才可用，之前的通知不排队", () => {
  const hub = fakeHub();
  const timers = fakeTimers();
  const invalidation = createThreadContentInvalidation({
    env: {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  assert.equal(invalidation.note(notification("item/completed", { threadId: THREAD_ID })), false);
  assert.deepEqual(invalidation.pendingThreadIds(), []);
  invalidation.bindWsHub(hub);
  invalidation.note(notification("item/completed", { threadId: THREAD_ID }));
  assert.deepEqual(invalidation.pendingThreadIds(), [THREAD_ID]);
  timers.runDue();
  assert.equal(hub.frames.length, EXPECTED_CONTENT_KEYS.length);
  invalidation.bindWsHub(null);
  assert.equal(invalidation.note(notification("turn/failed", { threadId: "t-x" })), false);
});

test("hostId 在后续通知才到货时补齐 host 维度 key", () => {
  const noHost = fakeHub();
  const t1 = fakeTimers();
  const inv1 = createThreadContentInvalidation({ env: {}, wsHub: noHost, setTimeoutFn: t1.setTimeoutFn, clearTimeoutFn: t1.clearTimeoutFn });
  inv1.note({ channel: MESSAGE_FOR_VIEW_CHANNEL, payload: { type: "mcp-notification", method: "item/started", params: { threadId: THREAD_ID } } });
  inv1.note({ channel: MESSAGE_FOR_VIEW_CHANNEL, payload: { type: "mcp-notification", method: "item/completed", params: { threadId: THREAD_ID } } });
  t1.runDue();
  assert.deepEqual(queryKeysOf(noHost.frames), [["prompt-rail-history", THREAD_ID]]);

  const later = fakeHub();
  const t2 = fakeTimers();
  const inv2 = createThreadContentInvalidation({ env: {}, wsHub: later, setTimeoutFn: t2.setTimeoutFn, clearTimeoutFn: t2.clearTimeoutFn });
  inv2.note({ channel: MESSAGE_FOR_VIEW_CHANNEL, payload: { type: "mcp-notification", method: "item/started", params: { threadId: THREAD_ID } } });
  inv2.note(notification("item/completed", { threadId: THREAD_ID }, "remote-7"));
  t2.runDue();
  assert.deepEqual(queryKeysOf(later.frames), [
    ["prompt-rail-history", THREAD_ID],
    ["mcp", "servers", "status", "remote-7", "thread", THREAD_ID],
    ["thread-title-app-tool-inventory", "remote-7", THREAD_ID],
    ["security", "remote-7", "scan-thread", THREAD_ID],
  ]);
});

test("snapshot 暴露完整诊断计数", () => {
  const { invalidation } = makeInvalidation({ env: { OPENCODEX_THREAD_CONTENT_INVALIDATE_DEBOUNCE_MS: "777" } });
  const s = invalidation.snapshot();
  for (const key of ["triggers", "coalesced", "sent", "skippedNoThreadId", "skippedDisabled", "sendFailures", "framesAttempted", "pendingThreads", "debounceMs", "disabled"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(s, key), key + " 必须出现在 snapshot");
  }
  assert.equal(s.debounceMs, 777);
});

test("自激防护：自己发出的 query-cache-invalidate 不再触发新一轮失效", () => {
  const { hub, invalidation, timers } = makeInvalidation();
  invalidation.note(notification("item/completed", { threadId: THREAD_ID }));
  timers.runDue();
  const before = hub.frames.length;
  for (const frame of hub.frames) {
    assert.equal(invalidation.note({ channel: frame.channel, payload: frame.payload }), false);
  }
  timers.runDue();
  assert.equal(hub.frames.length, before, "回灌自己的帧不得产生新帧");
  assert.equal(invalidation.snapshot().triggers, 1);
});
