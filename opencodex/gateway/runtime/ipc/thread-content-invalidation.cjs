// 回合/子智能体内容失效广播：让浏览器在不整页刷新的情况下看到内容更新。
//
// 背景（2026-10-06 e8_liveui 取证，/data/tmp/aq_analysis/e8_liveui/report.md）：
//   官方 main 收到 app-server 的全部 item/*、turn/* 通知，但只对 conversations 表里的会话
//   广播快照；子智能体线程（生产 28,821 条 item 事件 / 854 个 distinct threadId）以
//   "Received item/completed for unknown conversation" 被直接丢弃，浏览器收不到任何内容更新，
//   只能手动整页刷新。
//   浏览器侧 React Query 的 query-cache-invalidate 消费端支持任意 queryKey
//   （app-initial-74b69e67976a.js @8377686：Kh(`query-cache-invalidate`, e => g.invalidateQueries({queryKey: e.params.queryKey}))），
//   而当前只有 sidebar 的 recent-conversations-meta 在用（runThreadListInvalidation）。
//   因此网关在同一事件源上补齐"线程内容类" key 的失效广播即可，浏览器零改动。
//
// 失效 key 的形状全部来自官方 bundle 里真实存在的 useQuery 声明（证据见
// /data/tmp/aq_analysis/live_fix/report.md）：
//   ["prompt-rail-history", threadId]                       —— listThreadTurns 驱动的回合历史 @280478
//   ["mcp","servers","status", hostId, "thread", threadId]  —— 线程维度 MCP 工具状态 @2851260/@8865262
//   ["thread-title-app-tool-inventory", hostId, threadId]   —— 标题栏工具清单 @3255625
//   ["security", hostId, "scan-thread", threadId]           —— hydrateBackgroundThreads 驱动的线程装载 @87585
//   ["recent-conversations-meta"]                           —— sidebar（仅 turn 终端附带）
// invalidateQueries 走前缀匹配，未挂载的 key 是纯 no-op，多广播几条不会给未打开的会话增加请求。
//
// 安全边界：
// - 只处理白名单内的通知方法；写类请求与未知类型一律忽略。
// - 帧格式与 runThreadListInvalidation 完全一致（{channel, payload:{type:"ipc-broadcast",
//   method:"query-cache-invalidate", params:{queryKey}}}），浏览器协议不动。
// - 只订阅既有事件源（ws-hub observeOutboundPayload），不另起监听链；本模块自己发出的
//   query-cache-invalidate 帧不在触发集内，天然不会自激。
// - per-thread 尾沿合并去抖：同线程突发只在一帧窗口里发一次。
// - 任何异常静默降级为不发，绝不影响 WS 投递。

const MESSAGE_FOR_VIEW_CHANNEL = "codex_desktop:message-for-view";

// 与 runThreadListInvalidation 的 sidebar key 保持一致（official-runtime.cjs:2245）。
const RECENT_CONVERSATIONS_META_QUERY_KEY = Object.freeze(["recent-conversations-meta"]);

const DEFAULT_DEBOUNCE_MS = 500;
const DEBOUNCE_MIN_MS = 100;
const DEBOUNCE_MAX_MS = 5000;
// 单线程一轮窗口里最多携带的 key 数：防御 key 表膨胀成帧风暴。
const MAX_KEYS_PER_THREAD = 8;
// 同时在途的线程窗口上限：极端风暴下最旧窗口被丢弃（不发即无损，下一轮通知会重新排程）。
const MAX_PENDING_THREADS = 512;

// 内容类通知：item/* + turn/* + thread 生命周期（与 THREAD_LIST_INVALIDATION_METHODS 对齐并补内容类）。
const THREAD_CONTENT_INVALIDATION_METHODS = Object.freeze(
  new Set([
    "item/started",
    "item/updated",
    "item/completed",
    "item/agentMessage/delta",
    "item/reasoning/textDelta",
    "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
    "item/plan/delta",
    "turn/started",
    "turn/completed",
    "turn/failed",
    "turn/interrupted",
    "thread/started",
    "thread/name",
    "thread/name/updated",
    "thread/archived",
    "thread/unarchived",
    "thread/deleted",
    // 子智能体状态：官方用 thread/started + thread/name 通报后代线程，再补两条 app-server
    // 实际会发的线程状态通知（前缀匹配同一批 key，无额外副作用）。
    "thread/tokenUsage/updated",
    "thread/status/changed",
  ])
);

// turn 终端：额外附带 sidebar 的 recent-conversations-meta。
const TURN_TERMINAL_METHODS = Object.freeze(new Set(["turn/completed", "turn/failed", "turn/interrupted"]));

// peer 广播类失效源（与 THREAD_LIST_BROADCAST_INVALIDATION_METHODS / isPeerThreadSnapshot 对齐）。
const PEER_BROADCAST_INVALIDATION_METHODS = Object.freeze(new Set(["thread-archived", "thread-unarchived"]));

function clampNumber(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// threadId 直接从通知 params 取：子智能体线程不在官方 conversations 表里，网关不依赖它。
// threadId / conversationId / thread.id 任一到货即可，全部取不到就跳过并计数。
function threadIdFromPayload(payload) {
  const params = plainObject(payload && payload.params);
  if (!params) return "";
  if (typeof params.threadId === "string" && params.threadId) return params.threadId;
  if (typeof params.conversationId === "string" && params.conversationId) return params.conversationId;
  const thread = plainObject(params.thread);
  if (thread && typeof thread.id === "string" && thread.id) return thread.id;
  return "";
}

function hostIdFromPayload(payload) {
  return payload && typeof payload.hostId === "string" && payload.hostId ? payload.hostId : "";
}

/**
 * 派生某线程需要失效的 React Query key 列表（不含 sidebar key）。
 * hostId 缺失时只发不带 hostId 的 key：带 hostId 的那几条匹配不到真实查询，省掉帧。
 */
function threadContentQueryKeys(threadId, hostId) {
  if (!threadId) return [];
  const keys = [["prompt-rail-history", threadId]];
  if (hostId) {
    keys.push(["mcp", "servers", "status", hostId, "thread", threadId]);
    keys.push(["thread-title-app-tool-inventory", hostId, threadId]);
    keys.push(["security", hostId, "scan-thread", threadId]);
  }
  return keys.slice(0, MAX_KEYS_PER_THREAD);
}

// 与 threadListInvalidationEnvelope() 同构（outgoingWsEnvelope 对单参数 args 只保留 payload）。
function queryCacheInvalidateEnvelope(queryKey) {
  return {
    channel: MESSAGE_FOR_VIEW_CHANNEL,
    payload: {
      type: "ipc-broadcast",
      method: "query-cache-invalidate",
      params: { queryKey },
    },
  };
}

// 事件分类：返回 {threadId, hostId, terminal} 或 null。
// 事件源与 idempotent-read-cache 同一份：ws-hub 的 observeOutboundPayload(envelope, meta)。
function classifyOutboundEnvelope(envelope) {
  const payload = plainObject(envelope && envelope.payload);
  if (!payload) return null;
  const type = typeof payload.type === "string" ? payload.type : "";
  const method = typeof payload.method === "string" ? payload.method : "";
  if (type === "mcp-notification") {
    if (!THREAD_CONTENT_INVALIDATION_METHODS.has(method)) return null;
    return {
      threadId: threadIdFromPayload(payload),
      hostId: hostIdFromPayload(payload),
      terminal: TURN_TERMINAL_METHODS.has(method),
    };
  }
  if (type === "ipc-broadcast" || type === "broadcast") {
    const params = plainObject(payload.params);
    const isPeerListChange = PEER_BROADCAST_INVALIDATION_METHODS.has(method);
    const isPeerThreadSnapshot =
      method === "thread-stream-state-changed" && params && params.change && params.change.type === "snapshot";
    if (!isPeerListChange && !isPeerThreadSnapshot) return null;
    return {
      threadId: threadIdFromPayload(payload),
      hostId: hostIdFromPayload(payload),
      terminal: isPeerThreadSnapshot,
    };
  }
  return null;
}

/**
 * 工厂：小状态机 + 纯内存态 + snapshot 观测（风格同 idempotent-read-cache.cjs）。
 * options.wsHub 只需要 broadcast；options.env 默认 process.env，便于单测注入开关与去抖窗口。
 */
function createThreadContentInvalidation(options = {}) {
  const env = options.env || process.env;
  const injectedHub = options.wsHub || null;
  let boundHub = null;
  const schedule = typeof options.setTimeoutFn === "function" ? options.setTimeoutFn : (fn, ms) => setTimeout(fn, ms);
  const unschedule = typeof options.clearTimeoutFn === "function" ? options.clearTimeoutFn : (id) => clearTimeout(id);
  const onLog = typeof options.onLog === "function" ? options.onLog : () => {};

  const disabled = String(env.OPENCODEX_THREAD_CONTENT_INVALIDATE || "").toLowerCase() === "off";
  const debounceMs = clampNumber(
    options.debounceMs != null ? options.debounceMs : env.OPENCODEX_THREAD_CONTENT_INVALIDATE_DEBOUNCE_MS,
    DEFAULT_DEBOUNCE_MS,
    DEBOUNCE_MIN_MS,
    DEBOUNCE_MAX_MS
  );

  // threadId -> { hostId, terminal, keyJsons:Set<string>, keys:Array<array>, timer }
  const pending = new Map();
  let triggers = 0;
  let coalesced = 0;
  let sent = 0;
  let skippedNoThreadId = 0;
  let skippedDisabled = 0;
  let sendFailures = 0;
  let framesAttempted = 0;

  function hubOf() {
    return injectedHub || boundHub || options.wsHub || null;
  }

  function dropTimer(entry) {
    if (entry.timer == null) return;
    try {
      unschedule(entry.timer);
    } catch {}
    entry.timer = null;
  }

  // 去抖定时器绝不能拖住网关退出：真实 setTimeout 句柄一律 unref。
  function maybeUnref(timer) {
    if (timer && typeof timer.unref === "function") {
      try {
        timer.unref();
      } catch {}
    }
  }

  function flush(threadId) {
    const entry = pending.get(threadId);
    if (!entry) return;
    pending.delete(threadId);
    dropTimer(entry);
    const hub = hubOf();
    if (!hub || typeof hub.broadcast !== "function") return;
    const keys = entry.keys.slice(0, MAX_KEYS_PER_THREAD);
    // turn 终端顺带刷新 sidebar 元信息（与既有列表失效同一协议，帧数 +1）。
    if (entry.terminal) keys.push(Array.from(RECENT_CONVERSATIONS_META_QUERY_KEY));
    for (const key of keys) {
      try {
        framesAttempted += 1;
        const recipientCount = hub.broadcast(queryCacheInvalidateEnvelope(key), { suppressDiagnostic: true });
        if (Number(recipientCount) > 0) sent += 1;
      } catch (error) {
        sendFailures += 1;
        onLog("thread-content-invalidation", "broadcast_failed", {
          error: error instanceof Error ? error.message : String(error || ""),
          threadId,
        });
      }
    }
    onLog("thread-content-invalidation", "invalidation_broadcast", {
      frameCount: keys.length,
      threadId,
    });
  }

  // 尾沿合并：窗口内新到的通知只往同一条目补 key，窗口到期才真正发帧。
  function note(envelope) {
    if (disabled) {
      skippedDisabled += 1;
      return false;
    }
    const classified = classifyOutboundEnvelope(envelope);
    if (!classified) return false;
    triggers += 1;
    if (!classified.threadId) {
      skippedNoThreadId += 1;
      return false;
    }
    const hub = hubOf();
    if (!hub || typeof hub.broadcast !== "function") return false;

    const existing = pending.get(classified.threadId);
    if (existing) {
      coalesced += 1;
      existing.terminal = existing.terminal || classified.terminal;
      if (!existing.hostId && classified.hostId) existing.hostId = classified.hostId;
      // hostId 可能在后续通知里才带上来，此时需要把缺的 key 补进同一窗口。
      for (const key of threadContentQueryKeys(classified.threadId, existing.hostId)) {
        const json = JSON.stringify(key);
        if (existing.keyJsons.has(json) || existing.keyJsons.size >= MAX_KEYS_PER_THREAD) continue;
        existing.keyJsons.add(json);
        existing.keys.push(key);
      }
      return true;
    }
    if (pending.size >= MAX_PENDING_THREADS) {
      // 极端风暴：丢掉最旧窗口（不发即无损）。
      const oldest = pending.keys().next().value;
      dropTimer(pending.get(oldest));
      pending.delete(oldest);
    }
    const keys = threadContentQueryKeys(classified.threadId, classified.hostId);
    const entry = {
      hostId: classified.hostId,
      keyJsons: new Set(keys.map((key) => JSON.stringify(key))),
      keys,
      terminal: classified.terminal,
      timer: null,
    };
    entry.timer = schedule(() => flush(classified.threadId), debounceMs);
    maybeUnref(entry.timer);
    pending.set(classified.threadId, entry);
    return true;
  }

  return {
    classifyOutboundEnvelope,
    note,
    // server.cjs 在 createWsHub 装配完成后绑定 hub；装配前到的通知直接忽略（无接收方）。
    bindWsHub(hub) {
      boundHub = hub && typeof hub.broadcast === "function" ? hub : null;
    },
    // 单测/优雅退出用：立刻冲刷所有在途窗口（不等待去抖）。
    flushPending() {
      for (const threadId of [...pending.keys()]) flush(threadId);
    },
    pendingThreadIds() {
      return Array.from(pending.keys());
    },
    snapshot() {
      return {
        coalesced,
        debounceMs,
        disabled,
      pendingThreads: pending.size,
      sendFailures,
      sent,
      framesAttempted,
      skippedDisabled,
      skippedNoThreadId,
      triggers,
      };
    },
  };
}

module.exports = {
  DEFAULT_DEBOUNCE_MS,
  DEBOUNCE_MAX_MS,
  DEBOUNCE_MIN_MS,
  MAX_KEYS_PER_THREAD,
  MAX_PENDING_THREADS,
  MESSAGE_FOR_VIEW_CHANNEL,
  PEER_BROADCAST_INVALIDATION_METHODS,
  RECENT_CONVERSATIONS_META_QUERY_KEY,
  THREAD_CONTENT_INVALIDATION_METHODS,
  TURN_TERMINAL_METHODS,
  classifyOutboundEnvelope,
  createThreadContentInvalidation,
  hostIdFromPayload,
  queryCacheInvalidateEnvelope,
  threadContentQueryKeys,
  threadIdFromPayload,
};
