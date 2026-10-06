const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ENTRIES_MAX,
  ENTRIES_MIN,
  IDEMPOTENT_READ_METHODS,
  TTL_MAX_MS,
  TTL_MIN_MS,
  MAX_CACHED_VALUE_JSON_CHARS,
  createIdempotentReadCache,
  parseInvokeRequest,
  runExecuteIpcInvoke,
  stableStringify,
} = require("../runtime/ipc/idempotent-read-cache.cjs");

// 与生产链路一致的请求形态：mcp-request 包裹 + JSON-RPC request.id。
function mcpArgs(method, params, requestId, hostId = "local") {
  return [
    {
      type: "mcp-request",
      hostId,
      request: { id: requestId, method, params },
    },
  ];
}

function mcpResponseEnvelope(requestId, result, hostId = "local") {
  return {
    channel: "codex_desktop:message-for-view",
    payload: {
      type: "mcp-response",
      hostId,
      message: { id: requestId, result },
    },
  };
}

// mcp-response 入库要求带定向归属（真实链路里 sendTo 才能携带 clientId）。
function observeResponse(cache, requestId, result, hostId = "local", clientId = "client-1") {
  cache.observeOutboundEnvelope(mcpResponseEnvelope(requestId, result, hostId), { clientId });
}

function makeCache(options = {}) {
  let nowMs = options.startAt ?? 1000;
  const cache = createIdempotentReadCache({
    env: {},
    maxEntries: options.maxEntries,
    now: () => nowMs,
    ttlMs: options.ttlMs,
  });
  return { advance: (delta) => { nowMs += delta; }, cache };
}

async function invokeOnce(cache, { args, deliver, method = "thread/read", params, requestId, clientId = "client-1" }) {
  let invokeCalls = 0;
  const result = await runExecuteIpcInvoke(
    { args: args || mcpArgs(method, params, requestId), channel: "codex_desktop:message-from-view", clientId },
    async () => {
      invokeCalls += 1;
      return "PASSED_THROUGH";
    },
    // 生产链路 HTTP/WS 两条路径都会带 clientId+deliver；默认 () => false 等价"有 hub 但该 client 不在线"，
    // 保证未命中请求照常登记 pending（真实官方回包才能入库）。
    { deliver: deliver || (() => false), readCache: cache }
  );
  return { invokeCalls, result };
}

test("TTL 过期后回源真实调用", async () => {
  const { advance, cache } = makeCache({ ttlMs: 1500 });
  const invoke1 = await invokeOnce(cache, { method: "thread/read", params: { threadId: "t1" }, requestId: "r1" });
  assert.equal(invoke1.invokeCalls, 1, "首次请求必须放行真实调用");
  observeResponse(cache, "r1", { items: [1] });

  advance(1501);
  const invoke2 = await invokeOnce(cache, { method: "thread/read", params: { threadId: "t1" }, requestId: "r2" });
  assert.equal(invoke2.invokeCalls, 1, "TTL 过期后必须回源");
  assert.equal(invoke2.result, "PASSED_THROUGH");
});

test("TTL 内命中缓存且不再触发真实调用", async () => {
  const { advance, cache } = makeCache({ ttlMs: 1500 });
  await invokeOnce(cache, { method: "thread/read", params: { threadId: "t1" }, requestId: "r1" });
  observeResponse(cache, "r1", { items: [1] });

  advance(1400);
  const delivered = [];
  const invoke2 = await invokeOnce(cache, {
    deliver: (clientId, envelope) => {
      delivered.push({ clientId, envelope });
      return true;
    },
    method: "thread/read",
    params: { threadId: "t1" },
    requestId: "r2",
  });
  assert.equal(invoke2.invokeCalls, 0, "命中时不得再打官方 IPC");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].clientId, "client-1");
  const frame = delivered[0].envelope;
  assert.equal(frame.channel, "codex_desktop:message-for-view");
  assert.equal(frame.payload.type, "mcp-response");
  assert.equal(frame.payload.message.id, "r2", "命中帧必须换成新请求的 JSON-RPC id，页面才能按 id 匹配");
  assert.deepEqual(frame.payload.message.result, { items: [1] });

  const snapshot = cache.snapshot();
  assert.equal(snapshot.hits, 1);
  assert.equal(snapshot.entries, 1);
});

test("LRU 超容量按最旧逐出", async () => {
  const { cache } = makeCache({ maxEntries: ENTRIES_MIN, ttlMs: 10000 });
  const total = ENTRIES_MIN + 3;
  for (let index = 0; index < total; index += 1) {
    const requestId = "req-" + index;
    await invokeOnce(cache, { method: "config/read", params: { page: index }, requestId });
    observeResponse(cache, requestId, { page: index });
  }
  const snapshot = cache.snapshot();
  assert.equal(snapshot.entries, ENTRIES_MIN, "容量必须钳制在 maxEntries");
  assert.equal(snapshot.stores, total);

  // 最旧的 3 条已被逐出：再次请求要回源。
  const invokeOldest = await invokeOnce(cache, { method: "config/read", params: { page: 0 }, requestId: "again-0" });
  assert.equal(invokeOldest.invokeCalls, 1);
  // 最新一条仍在 TTL 内：命中回推。
  let hitDelivered = 0;
  const invokeNewest = await invokeOnce(cache, {
    deliver: () => {
      hitDelivered += 1;
      return true;
    },
    method: "config/read",
    params: { page: total - 1 },
    requestId: "again-new",
  });
  assert.equal(invokeNewest.invokeCalls, 0);
  assert.equal(hitDelivered, 1);
});

test("invalidate 清空全部条目与在途登记", async () => {
  const { cache } = makeCache();
  await invokeOnce(cache, { method: "thread/turns/list", params: { threadId: "t1" }, requestId: "r1" });
  observeResponse(cache, "r1", { turns: ["a"] });
  assert.equal(cache.snapshot().entries, 1);

  cache.invalidate();
  assert.equal(cache.snapshot().entries, 0);
  assert.equal(cache.snapshot().invalidations, 1);

  // 失效前登记的在途响应被丢弃：晚到的 mcp-response 不允许入库（宁可少缓存不可脏读）。
  await invokeOnce(cache, { method: "thread/items/list", params: { threadId: "t2" }, requestId: "r2" });
  assert.equal(cache.snapshot().pending, 1);
  cache.invalidate();
  assert.equal(cache.snapshot().pending, 0);
  observeResponse(cache, "r2", { items: ["stale"] });
  assert.equal(cache.snapshot().entries, 0, "失效后到达的响应不得入库");
});

test("query-cache-invalidate 与 turn 终端通知触发全量失效", () => {
  const { cache } = makeCache();
  cache.observeOutboundEnvelope({
    channel: "codex_desktop:message-for-view",
    payload: { type: "ipc-broadcast", method: "query-cache-invalidate", params: { queryKey: ["recent-conversations-meta"] } },
  });
  assert.equal(cache.snapshot().invalidations, 1);

  cache.observeOutboundEnvelope({
    channel: "codex_desktop:message-for-view",
    payload: { type: "mcp-notification", method: "turn/completed", params: { threadId: "t1" } },
  });
  assert.equal(cache.snapshot().invalidations, 2);

  cache.observeOutboundEnvelope({
    channel: "codex_desktop:message-for-view",
    payload: { type: "mcp-notification", method: "item/agentMessage/delta", params: { threadId: "t1" } },
  });
  assert.equal(cache.snapshot().invalidations, 2, "非失效通知不得触发清空");

  // thread-stream-state-changed 的 snapshot 分支（runThreadListInvalidation 同款判据）触发全清。
  cache.observeOutboundEnvelope({
    channel: "thread-stream-state-changed",
    payload: { type: "broadcast", method: "thread-stream-state-changed", params: { change: { type: "snapshot" } } },
  });
  assert.equal(cache.snapshot().invalidations, 3);
  // 非 snapshot 的流状态变化不触发。
  cache.observeOutboundEnvelope({
    channel: "thread-stream-state-changed",
    payload: { type: "broadcast", method: "thread-stream-state-changed", params: { change: { type: "delta" } } },
  });
  assert.equal(cache.snapshot().invalidations, 3);
});

test("白名单外方法与写方法直通", async () => {
  const { cache } = makeCache();
  const invokeTurn = await invokeOnce(cache, { method: "turn/start", params: { threadId: "t1" }, requestId: "w1" });
  assert.equal(invokeTurn.invokeCalls, 1);
  assert.equal(cache.snapshot().pending, 0, "写方法不允许登记");

  const invokeOther = await invokeOnce(cache, { method: "thread/list", params: {}, requestId: "w2" });
  assert.equal(invokeOther.invokeCalls, 1);
  assert.equal(cache.snapshot().pending, 0);

  // 大小写敏感：Thread/Read 不在白名单。
  const parsed = parseInvokeRequest("codex_desktop:message-from-view", mcpArgs("Thread/Read", {}, "w3"));
  assert.equal(parsed, null);

  // 非 mcp-request 形态（订阅类）直通。
  const subscribe = [{ type: "shared-object-subscribe", key: "k" }];
  assert.equal(parseInvokeRequest("codex_desktop:message-from-view", subscribe), null);

  // 非 message-from-view channel 直通。
  assert.equal(parseInvokeRequest("pick-files", mcpArgs("thread/read", {}, "w4")), null);
});

test("同参数不同键序视为同一缓存 key", async () => {
  const { cache } = makeCache();
  const parsedA = parseInvokeRequest("codex_desktop:message-from-view", mcpArgs("thread/items/list", { threadId: "t9", cursor: "c1", limit: 20 }, "k1"));
  const parsedB = parseInvokeRequest("codex_desktop:message-from-view", [
    {
      type: "mcp-request",
      hostId: "local",
      request: { id: "k2", method: "thread/items/list", params: { limit: 20, cursor: "c1", threadId: "t9" } },
    },
  ]);
  assert.equal(parsedA.cacheKey, parsedB.cacheKey);
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), stableStringify({ a: { c: 3, d: 2 }, b: 1 }));

  await invokeOnce(cache, { method: "thread/items/list", params: { cursor: "c1", limit: 20, threadId: "t9" }, requestId: "k1" });
  observeResponse(cache, "k1", { items: ["x"] });
  let delivered = 0;
  const hit = await invokeOnce(cache, {
    deliver: () => {
      delivered += 1;
      return true;
    },
    method: "thread/items/list",
    // 键序不同 + 每次都会变的 id 字段不同：仍应命中。
    params: { limit: 20, threadId: "t9", cursor: "c1" },
    requestId: "k2",
  });
  assert.equal(hit.invokeCalls, 0);
  assert.equal(delivered, 1);
});

test("错误结果与不可缓存响应不入库", async () => {
  const { cache } = makeCache();
  await invokeOnce(cache, { method: "mcpServerStatus/list", params: {}, requestId: "e1" });
  cache.observeOutboundEnvelope({
    channel: "codex_desktop:message-for-view",
    payload: { type: "mcp-response", hostId: "local", message: { id: "e1", error: { code: -1, message: "boom" } } },
  }, { clientId: "client-1" });
  assert.equal(cache.snapshot().entries, 0, "带 error 的响应不得缓存");

  await invokeOnce(cache, { method: "mcpServerStatus/list", params: {}, requestId: "e2" });
  cache.observeOutboundEnvelope({
    channel: "codex_desktop:message-for-view",
    payload: { type: "mcp-response", hostId: "local", message: { id: "e2" } },
  }, { clientId: "client-1" });
  assert.equal(cache.snapshot().entries, 0, "缺 result 的响应不得缓存");

  // 两次失败后 pending 都被消费掉（不再入库），第三次正常响应可入库。
  await invokeOnce(cache, { method: "mcpServerStatus/list", params: {}, requestId: "e3" });
  observeResponse(cache, "e3", { servers: [] });
  assert.equal(cache.snapshot().entries, 1);
});

test("命中回推失败退回真实调用（绝不吞请求）", async () => {
  const { cache } = makeCache();
  await invokeOnce(cache, { method: "model/list", params: {}, requestId: "f1" });
  observeResponse(cache, "f1", { models: ["a"] });

  const invoke2 = await invokeOnce(cache, {
    deliver: () => false, // 页面 WS 掉线
    method: "model/list",
    params: {},
    requestId: "f2",
  });
  assert.equal(invoke2.invokeCalls, 1, "回推失败必须放行真实调用");
  assert.equal(invoke2.result, "PASSED_THROUGH");
  assert.equal(cache.snapshot().hits, 0);
  // 计数含首次入库前的 miss(f1) + 本次回推失败的 miss(f2)。
  assert.equal(cache.snapshot().misses, 2, "回推失败计入 miss");

  const invoke3 = await invokeOnce(cache, {
    deliver: () => {
      throw new Error("send boom");
    },
    method: "model/list",
    params: {},
    requestId: "f3",
  });
  assert.equal(invoke3.invokeCalls, 1, "deliver 抛错也必须放行真实调用");
});

test("缓存内容为冻结深拷贝", async () => {
  const { cache } = makeCache();
  await invokeOnce(cache, { method: "experimentalFeature/list", params: {}, requestId: "g1" });
  const message = { id: "g1", result: { features: [{ id: "x", flags: { on: true } }] } };
  cache.observeOutboundEnvelope({
    channel: "codex_desktop:message-for-view",
    payload: { type: "mcp-response", hostId: "local", message },
  }, { clientId: "client-1" });
  // 官方对象后续被改动不能污染缓存。
  message.result.features[0].flags.on = false;

  const delivered = [];
  await invokeOnce(cache, {
    deliver: (clientId, envelope) => {
      delivered.push(envelope);
      return true;
    },
    method: "experimentalFeature/list",
    params: {},
    requestId: "g2",
  });
  assert.equal(delivered.length, 1);
  const frame = delivered[0].payload.message;
  assert.equal(frame.result.features[0].flags.on, true, "缓存必须是深拷贝快照");
  assert.ok(Object.isFrozen(frame.result.features[0].flags), "缓存内容必须冻结");
});

test("env 覆盖与钳制生效", () => {
  const low = createIdempotentReadCache({ env: { OPENCODEX_IPC_READ_CACHE_TTL_MS: "1", OPENCODEX_IPC_READ_CACHE_MAX_ENTRIES: "1" } });
  const lowSnapshot = low.snapshot();
  assert.equal(lowSnapshot.ttlMs, TTL_MIN_MS, "TTL 下限钳制");
  assert.equal(lowSnapshot.maxEntries, ENTRIES_MIN, "容量下限钳制");

  const high = createIdempotentReadCache({ env: { OPENCODEX_IPC_READ_CACHE_TTL_MS: "999999", OPENCODEX_IPC_READ_CACHE_MAX_ENTRIES: "999999" } });
  assert.equal(high.snapshot().ttlMs, TTL_MAX_MS, "TTL 上限钳制");
  assert.equal(high.snapshot().maxEntries, ENTRIES_MAX, "容量上限钳制");

  const broken = createIdempotentReadCache({ env: { OPENCODEX_IPC_READ_CACHE_TTL_MS: "abc" } });
  assert.equal(broken.snapshot().ttlMs, 1500, "非法值回默认");

  const off = createIdempotentReadCache({ env: { OPENCODEX_IPC_READ_CACHE_DISABLED: "1" } });
  assert.equal(off.snapshot().disabled, true);
  off.rememberPending({ cacheKey: "k", hostId: "local", method: "thread/read", requestId: "x", threadId: "" }, "c");
  assert.equal(off.snapshot().pending, 0, "禁用开关下完全直通");
});

test("白名单内容与关键只读方法对齐", () => {
  for (const method of ["thread/read", "thread/turns/list", "thread/items/list", "experimentalFeature/list", "config/read", "model/list", "mcpServerStatus/list"]) {
    assert.ok(IDEMPOTENT_READ_METHODS.includes(method), method + " 必须在白名单");
  }
  for (const write of ["turn/start", "thread/start", "thread/archive", "config/write", "mcpServer/tool/call"]) {
    assert.equal(IDEMPOTENT_READ_METHODS.includes(write), false, write + " 绝不能在白名单");
  }
  // 评审修复（必修 2）：跨 client 共享的账户语义方法必须留在白名单外（entries 键不含 clientId）。
  for (const shared of ["account/read", "getAuthStatus"]) {
    assert.equal(IDEMPOTENT_READ_METHODS.includes(shared), false, shared + " 是跨 client 共享语义，绝不能在白名单");
    assert.equal(parseInvokeRequest("codex_desktop:message-from-view", mcpArgs(shared, {}, "acc-1")), null, shared + " 必须直通");
  }
});

// —— 评审修复（2026-10-06 必修 1）：同页面同 JSON-RPC id 交错不得串位 ——

test("同 client 同 id 不同 threadId 并发交错：不串位且不入库", async () => {
  const { cache } = makeCache();
  // 同一页面用同一个 JSON-RPC id 先后发两个不同 threadId 的读取（评审探针 P10 形态）。
  await invokeOnce(cache, { method: "thread/turns/list", params: { threadId: "A" }, requestId: "same" });
  await invokeOnce(cache, { method: "thread/turns/list", params: { threadId: "B" }, requestId: "same" });
  assert.equal(cache.snapshot().pending, 1, "同键碰撞后只保留一条弃用态登记");

  // A 的真实响应到达：无法归属，禁止入库（否则 for-A 会被存进 B 的 cacheKey）。
  observeResponse(cache, "same", { turns: "for-A" });
  assert.equal(cache.snapshot().entries, 0, "弃用键的响应不得入库");
  // B 的迟到响应同样不入库，且弃用标记不被提前消费。
  observeResponse(cache, "same", { turns: "for-B" });
  assert.equal(cache.snapshot().entries, 0, "弃用键的迟到响应也不得入库");

  // 两个线程后续都必须各自回源，且不会拿到对方的内容。
  let delivered = 0;
  const hitA = await invokeOnce(cache, {
    deliver: () => {
      delivered += 1;
      return true;
    },
    method: "thread/turns/list",
    params: { threadId: "A" },
    requestId: "q1",
  });
  assert.equal(hitA.invokeCalls, 1, "A 必须回源，不能命中脏缓存");
  const hitB = await invokeOnce(cache, {
    deliver: () => {
      delivered += 1;
      return true;
    },
    method: "thread/turns/list",
    params: { threadId: "B" },
    requestId: "q2",
  });
  assert.equal(hitB.invokeCalls, 1, "B 必须回源，不能拿到 A 的内容");
  assert.equal(delivered, 0, "碰撞后两侧都不得出现合成命中");
});

test("同 client 同 id 不同方法：不串位且不入库", async () => {
  const { cache } = makeCache();
  await invokeOnce(cache, { method: "thread/read", params: { threadId: "t1" }, requestId: "shared-id" });
  await invokeOnce(cache, { method: "config/read", params: {}, requestId: "shared-id" });
  assert.equal(cache.snapshot().pending, 1);

  // 第一个请求（thread/read）的回包到达：键已弃用，两条 cacheKey 都不允许被写入。
  observeResponse(cache, "shared-id", { thread: "data" });
  assert.equal(cache.snapshot().entries, 0, "跨方法碰撞的响应不得入库");
  // 换 hostId 也无法绕过（登记 hostId 与回包 hostId 不一致同样拒绝入库）。
  observeResponse(cache, "shared-id", { thread: "data" }, "other-host");
  assert.equal(cache.snapshot().entries, 0);

  const readAgain = await invokeOnce(cache, { method: "thread/read", params: { threadId: "t1" }, requestId: "again-1" });
  assert.equal(readAgain.invokeCalls, 1, "thread/read 必须回源");
  const configAgain = await invokeOnce(cache, { method: "config/read", params: {}, requestId: "again-2" });
  assert.equal(configAgain.invokeCalls, 1, "config/read 必须回源");
});

test("登记 hostId 与回包 hostId 不一致时不入库", async () => {
  const { cache } = makeCache();
  await invokeOnce(cache, { method: "thread/read", params: { threadId: "t1" }, requestId: "h1" });
  // 同 id 但回包 hostId 与登记不一致：无法证明归属，宁可不缓存。
  observeResponse(cache, "h1", { thread: "x" }, "wrong-host");
  assert.equal(cache.snapshot().entries, 0);
  assert.equal(cache.snapshot().pending, 0, "归属失败的登记已被消费");
  // 同一条登记不会因后续正确 hostId 的迟到帧而入库（登记已消费）。
  observeResponse(cache, "h1", { thread: "x" }, "local");
  assert.equal(cache.snapshot().entries, 0);
});

test("单条缓存值超字符上限不入库并计入 droppedOversize（评审 S2）", async () => {
  const { cache } = makeCache();
  assert.equal(MAX_CACHED_VALUE_JSON_CHARS, 512 * 1024, "单条上限 512KB");

  await invokeOnce(cache, { method: "thread/read", params: { threadId: "big" }, requestId: "big-1" });
  observeResponse(cache, "big-1", { blob: "x".repeat(600 * 1024) });
  const oversize = cache.snapshot();
  assert.equal(oversize.entries, 0, "超限响应不得入库");
  assert.equal(oversize.droppedOversize, 1, "超限必须计数");
  assert.equal(oversize.stores, 0);

  // 正常体量照常入库，cachedChars 暴露占用。
  await invokeOnce(cache, { method: "thread/read", params: { threadId: "small" }, requestId: "small-1" });
  observeResponse(cache, "small-1", { items: [1, 2, 3] });
  const after = cache.snapshot();
  assert.equal(after.entries, 1);
  assert.equal(after.stores, 1);
  assert.ok(after.cachedChars > 0 && after.cachedChars < MAX_CACHED_VALUE_JSON_CHARS, "cachedChars 应暴露真实占用");
  assert.equal(after.droppedOversize, 1);

  // 超限请求仍放行真实调用，页面不受影响。
  const retry = await invokeOnce(cache, { method: "thread/read", params: { threadId: "big" }, requestId: "big-2" });
  assert.equal(retry.invokeCalls, 1, "超限未入库 → 必须回源而不是挂住");
});

test("clearPendingForClient 清理掉线页面的在途登记", async () => {
  const { cache } = makeCache();
  await invokeOnce(cache, { clientId: "client-a", method: "thread/read", params: { threadId: "t1" }, requestId: "c-a1" });
  await invokeOnce(cache, { clientId: "client-b", method: "thread/read", params: { threadId: "t2" }, requestId: "c-b1" });
  assert.equal(cache.snapshot().pending, 2);
  cache.clearPendingForClient("client-a");
  assert.equal(cache.snapshot().pending, 1);
  // client-a 的迟到响应不入库；client-b 正常入库。
  observeResponse(cache, "c-a1", { leaked: true }, "local", "client-a");
  assert.equal(cache.snapshot().entries, 0);
  observeResponse(cache, "c-b1", { ok: true }, "local", "client-b");
  assert.equal(cache.snapshot().entries, 1);
});

test("广播帧与跨 client 的同 id 回包不得入库", async () => {
  const { cache } = makeCache();
  await invokeOnce(cache, { clientId: "client-a", method: "thread/read", params: { threadId: "t1" }, requestId: "dup" });
  // 广播形态（无归属 clientId）：即使 id 匹配也不入库。
  cache.observeOutboundEnvelope(mcpResponseEnvelope("dup", { leaked: true }));
  assert.equal(cache.snapshot().entries, 0);
  // 别的 client 定向回包带了相同 JSON-RPC id：同样不入库。
  cache.observeOutboundEnvelope(mcpResponseEnvelope("dup", { leaked: true }), { clientId: "client-x" });
  assert.equal(cache.snapshot().entries, 0);
  // 归属正确的定向回包正常入库。
  observeResponse(cache, "dup", { ok: true }, "local", "client-a");
  assert.equal(cache.snapshot().entries, 1);
});
