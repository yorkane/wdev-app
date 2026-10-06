// 幂等读 TTL 结果缓存：折叠前端轮询/roster 风暴（thread/read、turns/list、items/list 等）。
// 风格参照 model-router/turn-route-status.cjs：小工厂 + 纯内存态 + snapshot 观测。
//
// 背景（2026-10-06 取证）：浏览器轮询的热点读取全部以
//   channel=codex_desktop:message-from-view,
//   args=[{type:"mcp-request", hostId, request:{id, method, params}}]
//   的 JSON-RPC 包裹进入 executeIpcInvoke；invokeOfficialIpc 的返回值只是 ok 占位，
//   真实数据由 app-server 稍后经 mcp-response（按 request id 路由回页面）推送。
//   因此缓存必须做「请求登记 + 出站 mcp-response 观察 + 命中时合成回推」，
//   单纯缓存 executeIpcInvoke 的返回值对轮询折叠没有任何收益。
//
// 安全边界：
// - 只缓存白名单内的只读方法（大小写敏感精确匹配）；turn/start 等写方法绝不在列。
// - 只缓存成功结果：message 必须自带 result 且无 error；不可序列化/超大值不缓存（宁可不缓存）。
// - 失效事件（query-cache-invalidate / turn 终端 / thread 生命周期通知）一律全量清空，
//   宁可多失效不可脏读。
// - 命中回推失败（页面 WS 掉线等）自动退回真实调用，保证不缺帧、不吞请求。
// - 缓存保存 JSON 规范化深拷贝并整体冻结，调用方改坏不了缓存本体。

const DEFAULT_TTL_MS = 1500;
const TTL_MIN_MS = 250;
const TTL_MAX_MS = 10000;
const DEFAULT_MAX_ENTRIES = 256;
const ENTRIES_MIN = 16;
const ENTRIES_MAX = 2048;
// pending 登记表：官方回包可能晚于 TTL 才到，登记窗口只要覆盖「请求→回包」的往返即可。
const PENDING_TTL_MS = 30000;
const PENDING_MAX_ENTRIES = 1024;
// 单条缓存值的序列化字符上限：防 2048 条 × MB 级会话大包把堆顶满（评审 S2）。
// 超限响应直接不入库（真实调用照常，页面不受影响），并在 snapshot 暴露 droppedOversize。
const MAX_CACHED_VALUE_JSON_CHARS = 512 * 1024;

function clampNumber(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

// 官方轮询里只读、可安全短缓存的方法集合；白名单外一律直通官方。
// mcpServerStatus/list 取证结论：官方 main 侧是普通 request/response（listMcpServers 还有同参
// in-flight promise 去重），不是等待型长轮询；p50≈506ms 固定成本，收益最大，保留在白名单。
// 评审修复（2026-10-06）：account/read 与 getAuthStatus 是跨 client 共享的账户级语义方法——
// entries 键不含 clientId，不同登录态/权限视角的页面会在 1.5s 窗口内互相串账户状态；
// 两者调用频率低、缓存收益小、串号风险不对称，移出白名单（直通官方）。
const IDEMPOTENT_READ_METHODS = Object.freeze([
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "experimentalFeature/list",
  "config/read",
  "model/list",
  "mcpServerStatus/list",
]);

// 收到即全量清空（宁可多失效不可脏读）：turn 终端 + thread 生命周期类通知。
const INVALIDATING_NOTIFICATION_METHODS = new Set([
  "turn/completed",
  "turn/failed",
  "turn/interrupted",
  "thread/started",
  "thread/name",
  "thread/name/updated",
  "thread/archived",
  "thread/unarchived",
  "thread/deleted",
]);
// 官方列表失效广播（runThreadListInvalidation 的 query-cache-invalidate）走 ipc-broadcast 外壳。
const INVALIDATING_BROADCAST_METHODS = new Set([
  "query-cache-invalidate",
  "thread-archived",
  "thread-unarchived",
]);

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    if (value[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(value[key])}`);
  }
  return `{${parts.join(",")}}`;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function parseInvokeRequest(channel, args) {
  // 只认单 payload 形态的 mcp-request；其余（订阅/流式/写方法/未知）一律返回 null 直通。
  if (channel !== "codex_desktop:message-from-view") return null;
  if (!Array.isArray(args) || args.length !== 1) return null;
  const payload = plainObject(args[0]);
  if (!payload || payload.type !== "mcp-request") return null;
  const request = plainObject(payload.request);
  if (!request) return null;
  const method = typeof request.method === "string" ? request.method : "";
  if (!IDEMPOTENT_READ_METHODS.includes(method)) return null;
  const requestId = request.id == null ? "" : String(request.id);
  if (!requestId) return null;
  const hostId = typeof payload.hostId === "string" ? payload.hostId : "";
  const params = plainObject(request.params);
  // key 里刻意剔除 request.id / timeoutMs / trace / priority 等每次请求都会变的字段。
  const cacheKey = stableStringify({ channel, hostId, method, params });
  return { cacheKey, hostId, method, requestId, threadId: typeof params?.threadId === "string" ? params.threadId : "" };
}

// pending 登记表按 clientId+request.id 双键：官方 renderer 的 JSON-RPC id 在多页面并发时可能重复，
// 只有"该请求确实由这个 client 发出"的回包才允许入库，杜绝跨页面串数据。
// 评审修复（2026-10-06，必修 1）：同页面同 JSON-RPC id 并发/交错时，pending 键会碰撞。
// 登记时校验 cacheKey：同键二次登记且 cacheKey（hostId/method/params）不一致 → 该键标"弃用"，
// 其后的响应一律不入库（宁可少缓存不可脏读），请求照常放行真实调用。弃用标记保留到
// pending TTL 清理，防止"先消费掉弃用标记、迟到响应再撞上后来同名登记"的二次串位。
function pendingKeyFor(clientId, requestId) {
  return `${clientId}\u0000${requestId}`;
}

function createIdempotentReadCache(options = {}) {
  const env = options.env || process.env;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const disabled = options.disabled === true || env.OPENCODEX_IPC_READ_CACHE_DISABLED === "1";
  const ttlMs = clampNumber(options.ttlMs != null ? options.ttlMs : env.OPENCODEX_IPC_READ_CACHE_TTL_MS, DEFAULT_TTL_MS, TTL_MIN_MS, TTL_MAX_MS);
  const maxEntries = clampNumber(options.maxEntries != null ? options.maxEntries : env.OPENCODEX_IPC_READ_CACHE_MAX_ENTRIES, DEFAULT_MAX_ENTRIES, ENTRIES_MIN, ENTRIES_MAX);

  // cacheKey -> { hostId, method, threadId, payload(规范化冻结深拷贝), storedAt }
  const entries = new Map();
  // pendingKey -> { cacheKey, hostId, method, threadId, clientId, registeredAt, synthetic?, discarded? }
  const pending = new Map();
  let hits = 0;
  let misses = 0;
  let invalidations = 0;
  let stores = 0;
  let droppedOversize = 0;

  function prunePending() {
    // pending 只是请求→响应的短暂桥：超量或超时按最旧清理，避免无响应请求泄漏。
    const deadline = now() - PENDING_TTL_MS;
    while (pending.size > PENDING_MAX_ENTRIES) pending.delete(pending.keys().next().value);
    for (const [requestId, entry] of [...pending]) {
      if (entry.registeredAt < deadline) pending.delete(requestId);
    }
  }

  function rememberPending(parsed, clientId) {
    if (disabled || !parsed) return;
    const owner = typeof clientId === "string" ? clientId : "";
    if (!owner) return;
    registerPending(parsed, owner, false);
    prunePending();
  }

  // 命中合成帧自己也会经过 sendTo 观察：提前登记 tombstone，让 observe 消费掉它但绝不入库，
  // 同时杜绝"缓存命中帧被误当成某个真实 pending 的响应"导致的串 key 污染。
  function rememberSyntheticPending(parsed, clientId) {
    if (disabled || !parsed) return;
    const owner = typeof clientId === "string" ? clientId : "";
    if (!owner) return;
    registerPending(parsed, owner, true);
    prunePending();
  }

  function registerPending(parsed, owner, synthetic) {
    const key = pendingKeyFor(owner, parsed.requestId);
    const existing = pending.get(key);
    // 同键碰撞（id 复用但 cacheKey 不同，或撞上既有弃用标记）：键进入"弃用"态，响应永不入库。
    if (existing && (existing.discarded === true || existing.cacheKey !== parsed.cacheKey)) {
      pending.set(key, {
        cacheKey: existing.cacheKey,
        clientId: owner,
        discarded: true,
        hostId: existing.hostId,
        method: existing.method,
        registeredAt: now(),
        threadId: existing.threadId,
      });
      return;
    }
    pending.set(key, {
      cacheKey: parsed.cacheKey,
      clientId: owner,
      hostId: parsed.hostId,
      method: parsed.method,
      registeredAt: now(),
      synthetic,
      threadId: parsed.threadId,
    });
  }

  function clearPendingForClient(clientId) {
    if (!clientId) return;
    for (const [requestId, entry] of [...pending]) {
      if (entry.clientId === clientId) pending.delete(requestId);
    }
  }

  function lookup(cacheKey) {
    if (disabled) return null;
    const entry = entries.get(cacheKey);
    if (!entry) {
      return null;
    }
    if (now() - entry.storedAt > ttlMs) {
      entries.delete(cacheKey);
      return null;
    }
    // LRU：命中即刷新最近使用位置。
    entries.delete(cacheKey);
    entries.set(cacheKey, entry);
    return entry;
  }

  // 观测口径只在 runExecuteIpcInvoke 的决策点记一次：lookup 本身可被测试/reload 复用而不污染计数。
  function noteHit() {
    hits += 1;
  }

  function noteMiss() {
    misses += 1;
  }

  function storeMessage(entry, message) {
    // 深拷贝规范化一次：缓存与官方 main 的对象彻底脱钩，也顺带保证可安全序列化。
    // 体量判断按序列化后的字符数：超过 MAX_CACHED_VALUE_JSON_CHARS（评审 S2，512KB/条）
    // 不入库并计入 droppedOversize，防 2048 条极端上界把堆顶满。真实调用不受影响。
    let json = "";
    try {
      json = JSON.stringify(message);
    } catch {
      return false;
    }
    if (!json) return false;
    if (json.length > MAX_CACHED_VALUE_JSON_CHARS) {
      droppedOversize += 1;
      return false;
    }
    let clone = null;
    try {
      clone = JSON.parse(json);
    } catch {
      return false;
    }
    deepFreeze(clone);
    entries.set(entry.cacheKey, {
      hostId: entry.hostId,
      method: entry.method,
      threadId: entry.threadId,
      message: clone,
      valueChars: json.length,
      storedAt: now(),
    });
    stores += 1;
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return true;
  }

  function invalidate(channelPrefix) {
    invalidations += 1;
    // 失效后到达的在途响应可能已经脏了：连同 pending 一起丢弃，宁可少缓存不可脏读。
    pending.clear();
    if (typeof channelPrefix !== "string" || !channelPrefix) {
      entries.clear();
      return;
    }
    for (const key of [...entries.keys()]) {
      if (key.startsWith(channelPrefix)) entries.delete(key);
    }
  }

  function observeOutboundEnvelope(envelope, meta = {}) {
    if (disabled) return;
    const payload = envelope && typeof envelope === "object" ? envelope.payload : null;
    if (!payload || typeof payload !== "object") return;
    const type = typeof payload.type === "string" ? payload.type : "";
    const method = typeof payload.method === "string" ? payload.method : "";
    if (type === "query-cache-invalidate") {
      // 列表失效广播：无法证明缓存哪一条还新鲜，全清最保守。
      invalidate();
      return;
    }
    if (type === "ipc-broadcast" && INVALIDATING_BROADCAST_METHODS.has(method)) {
      // threadListInvalidation 的真实帧形态：{type:"ipc-broadcast", method:"query-cache-invalidate"}。
      invalidate();
      return;
    }
    if (type === "broadcast" && method === "thread-stream-state-changed") {
      // scheduleThreadListEventSync 的 isPeerThreadSnapshot 分支：任务流状态快照变化即内容变化。
      const change = payload.params && typeof payload.params === "object" ? payload.params.change : null;
      if (change && change.type === "snapshot") invalidate();
      return;
    }
    if (type === "mcp-notification") {
      if (INVALIDATING_NOTIFICATION_METHODS.has(method)) invalidate();
      return;
    }
    if (type === "mcp-response") {
      const message = plainObject(payload.message);
      if (!message) return;
      // 定向回包才会命中 pending（官方对浏览器 invoke 的响应走 sendTo）；广播帧没有归属，一律不入库。
      const targetClientId = typeof meta.clientId === "string" ? meta.clientId : "";
      if (!targetClientId) return;
      const requestId = message.id == null ? "" : String(message.id);
      const key = requestId ? pendingKeyFor(targetClientId, requestId) : "";
      const entry = key ? pending.get(key) : null;
      if (!entry) return;
      // 评审修复（必修 1）：碰撞过 cacheKey 的键已标"弃用"——响应无法归属到具体请求，永不入库。
      // 弃用标记保留在 Map 里（不 delete），直到 pending TTL/prune 清理；
      // 否则首个弃用响应把标记消费掉后，同名登记的迟到响应可能撞上后续新登记造成二次串位。
      if (entry.discarded === true) return;
      pending.delete(key);
      if (entry.synthetic) return;
      // 归属再校验：回包 hostId 与登记 hostId 不一致同样视为无法归属（宁可不缓存）。
      const responseHostId = typeof payload.hostId === "string" ? payload.hostId : "";
      if (responseHostId && entry.hostId && responseHostId !== entry.hostId) return;
      // 只缓存成功结果：带 error、缺 result 的一律丢弃（宁可不缓存）。
      if (message.error != null) return;
      if (!Object.prototype.hasOwnProperty.call(message, "result")) return;
      storeMessage(entry, message);
    }
  }

  return {
    clearPendingForClient,
    invalidate,
    lookup,
    noteHit,
    noteMiss,
    observeOutboundEnvelope,
    rememberPending,
    rememberSyntheticPending,
    snapshot() {
      return {
        disabled,
        entries: entries.size,
        cachedChars: Array.from(entries.values()).reduce((total, item) => total + (item.valueChars || 0), 0),
        droppedOversize,
        hits,
        invalidations,
        maxEntries,
        misses,
        pending: pending.size,
        stores,
        ttlMs,
        whitelistedMethods: Array.from(IDEMPOTENT_READ_METHODS),
      };
    },
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * executeIpcInvoke 的可测核心：白名单命中缓存则直接合成 mcp-response 定向回推并返回，
 * 未命中则登记 pending、放行真实调用。invokeFn 即真实 invokeOfficialIpc 包装，
 * deliver(clientId, envelope) 由 server.cjs 注入（走 wsHub.sendTo）。
 */
async function runExecuteIpcInvoke(parsed, invokeFn, context = {}) {
  const deliver = typeof context.deliver === "function" ? context.deliver : null;
  const readCache = context.readCache || null;
  const channel = typeof parsed && typeof parsed.channel === "string" ? parsed.channel : "";
  const args = parsed && Array.isArray(parsed.args) ? parsed.args : [];
  const clientId = parsed && typeof parsed.clientId === "string" ? parsed.clientId : "";
  const parsedRequest = readCache ? parseInvokeRequest(channel, args) : null;
  if (parsedRequest && deliver && clientId) {
    const hit = readCache.lookup(parsedRequest.cacheKey);
    if (hit) {
      // 命中：把缓存的 JSON-RPC 响应换成这次的新 id 定向回推；页面按 id 匹配，语义与真实回包一致。
      let delivered = false;
      try {
        readCache.rememberSyntheticPending(parsedRequest, clientId);
        delivered = await deliver(clientId, {
          channel: "codex_desktop:message-for-view",
          payload: {
            type: "mcp-response",
            hostId: hit.hostId,
            message: Object.assign({}, hit.message, { id: parsedRequest.requestId }),
          },
        });
      } catch {
        delivered = false;
      }
      // 与真实链路一致：message-from-view 的 invoke 返回值本来就是 undefined，数据走 mcp-response。
      if (delivered) {
        readCache.noteHit();
        return undefined;
      }
      // 回推失败（页面 WS 掉线等）：退回真实调用，绝不吞请求。
      // 真实调用照常进行，登记 pending 让官方回包仍能入库供后续轮询命中。
      readCache.noteMiss();
      readCache.rememberPending(parsedRequest, clientId);
    } else {
      readCache.noteMiss();
      // 未命中也要先登记再放行：官方回包可能在 invoke 返回前就已广播。
      readCache.rememberPending(parsedRequest, clientId);
    }
  } else if (parsedRequest && readCache) {
    // 无法定向回推（无 clientId 或无 deliver）时不缓存该请求，但登记没有意义：直通。
  }
  return invokeFn(parsed);
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  ENTRIES_MAX,
  ENTRIES_MIN,
  IDEMPOTENT_READ_METHODS,
  INVALIDATING_NOTIFICATION_METHODS,
  MAX_CACHED_VALUE_JSON_CHARS,
  PENDING_MAX_ENTRIES,
  PENDING_TTL_MS,
  TTL_MAX_MS,
  TTL_MIN_MS,
  createIdempotentReadCache,
  deepFreeze,
  parseInvokeRequest,
  runExecuteIpcInvoke,
  stableStringify,
};
