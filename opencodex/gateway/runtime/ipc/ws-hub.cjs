const crypto = require("crypto");
let WebSocketServer = null;
try {
  ({ WebSocketServer } = require("ws"));
} catch {}
const { diagnosticLog, diagnosticWarn, shortId } = require("../core/diagnostics.cjs");
const { DEBUG_LOGS } = require("../core/config.cjs");
const appHostMessageCodec = require("../../../web-shell/codex-app-host-message-codec.js");

// 下面这些阈值只服务于 OPENCODEX_DEBUG_WS=1 的链路排障；默认运行不会采样慢 WS 发送。
const WS_LARGE_MESSAGE_BYTES = Number(process.env.OPENCODEX_WS_LARGE_LOG_BYTES || 256 * 1024);
const WS_SEND_SLOW_MS = Number(process.env.OPENCODEX_WS_SEND_SLOW_MS || 80);
const WS_STRINGIFY_SLOW_MS = Number(process.env.OPENCODEX_WS_STRINGIFY_SLOW_MS || 20);
const WS_BUFFERED_LOG_BYTES = Number(process.env.OPENCODEX_WS_BUFFERED_LOG_BYTES || 512 * 1024);
const APP_HOST_TRAFFIC_FLUSH_MS = Number(process.env.OPENCODEX_APP_HOST_TRAFFIC_FLUSH_MS || 2000);
const APP_HOST_LARGE_FRAME_BYTES = Number(process.env.OPENCODEX_APP_HOST_LARGE_FRAME_BYTES || 64 * 1024);
// WS 压缩和 debug 采集分开控制：压缩默认开启，诊断默认关闭。
const WS_DEFLATE_DISABLED = process.env.OPENCODEX_WS_DISABLE_DEFLATE === "1";
const WS_DEFLATE_THRESHOLD = Number(process.env.OPENCODEX_WS_DEFLATE_THRESHOLD || 64 * 1024);
const WS_DEFLATE_CONCURRENCY = Number(process.env.OPENCODEX_WS_DEFLATE_CONCURRENCY || 4);
const WS_DEFLATE_LEVEL = Number(process.env.OPENCODEX_WS_DEFLATE_LEVEL || 3);
const WS_DEBUG_ENABLED = process.env.OPENCODEX_DEBUG_WS === "1";
const WS_MAX_CLIENTS = Math.max(1, Number(process.env.OPENCODEX_WS_MAX_CLIENTS) || 128);
const WS_MAX_PAYLOAD_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.OPENCODEX_WS_MAX_PAYLOAD_BYTES) || 100 * 1024 * 1024
);
const WS_MAX_BUFFERED_BYTES = Math.max(
  1024,
  Number(process.env.OPENCODEX_WS_MAX_BUFFERED_BYTES) || 64 * 1024 * 1024
);
const APP_HOST_RELAY_MAX_ENTRIES = Math.max(1, Number(process.env.OPENCODEX_APP_HOST_MAX_RELAYS) || 64);
// WS 临时断开时官方 app-host 会话的保留时长：页面重连窗口内保留官方 MessagePortMain，
// 让浏览器旧 MessagePort 重挂回同一条 relay，避免官方 main 新建 session 后 export 表错位。
// 默认放宽到 30 分钟：手机切后台/系统挂起常远超 5 分钟，5 分钟一过 TTL 到期即触发
// app-host-port-reset（页面整页重载），正在进行的会话会被打断，代价明显高于保留成本。
// 代价是官方 main 侧 session 多保留一份（每条约一个 MessagePortMain + 少量缓冲帧），
// 由 orphanAppHostRelays 的全局上限（按最旧优先回收）兜底，内存不会无界增长。
const APP_HOST_ORPHAN_TTL_MS = Math.max(5_000, Number(process.env.OPENCODEX_APP_HOST_ORPHAN_TTL_MS) || 30 * 60_000);
// 孤儿/重挂/回收事件的诊断限流：同一 port 窗口内最多一条，避免断线抖动刷屏。
const APP_HOST_LIFECYCLE_LOG_WINDOW_MS = 30_000;
const WS_IPC_MAX_IN_FLIGHT = Math.max(32, Number(process.env.OPENCODEX_WS_IPC_MAX_IN_FLIGHT) || 4096);
const ROUTE_ID_SCAN_MAX_NODES = 128;
const BROADCAST_DEDUPE_MAX_ENTRIES_PER_SOCKET = 16;
const BROADCAST_DEDUPE_MAX_WINDOW_MS = 60_000;

function byteLength(value) {
  // WebSocket bufferedAmount 用字节衡量；日志里也统一按 UTF-8 字节估算，方便对齐网络层现象。
  return Buffer.byteLength(String(value || ""), "utf-8");
}

function routeIdFromPayload(value, depth = 0, state = null) {
  // 官方 IPC 版本变化时 requestId 可能藏在 payload/request/response/body 里，递归提取比写死类型更稳。
  const traversal = state || { remaining: ROUTE_ID_SCAN_MAX_NODES, seen: new WeakSet() };
  if (!value || typeof value !== "object" || depth > 4 || traversal.remaining <= 0) return "";
  if (traversal.seen.has(value)) return "";
  traversal.seen.add(value);
  traversal.remaining -= 1;
  if (Array.isArray(value)) {
    const childCount = Math.min(value.length, traversal.remaining);
    for (let index = 0; index < childCount && traversal.remaining > 0; index += 1) {
      const nested = routeIdFromPayload(value[index], depth + 1, traversal);
      if (nested) return nested;
    }
    return "";
  }
  if (typeof value.requestId === "string" && value.requestId) return value.requestId;
  if (value.request && typeof value.request === "object" && value.request.id != null) return String(value.request.id);
  if (value.id != null && (depth > 0 || value.method || value.jsonrpc || value.type)) return String(value.id);
  for (const key of ["payload", "message", "response", "body"]) {
    const nested = routeIdFromPayload(value[key], depth + 1, traversal);
    if (nested) return nested;
  }
  return "";
}

function wsPayloadSummary(payload) {
  // 摘要只保留路由相关字段，不把正文、prompt、文件内容写进日志。
  const summary = {};
  if (payload && typeof payload === "object") {
    if (typeof payload.channel === "string") summary.channel = payload.channel;
    if (typeof payload.portId === "string") summary.portId = shortId(payload.portId);
    const nestedPayload = payload.payload && typeof payload.payload === "object" ? payload.payload : payload.payload;
    if (nestedPayload && typeof nestedPayload === "object" && typeof nestedPayload.type === "string") {
      summary.type = nestedPayload.type;
    }
    if (payload.type && typeof payload.type === "string") summary.type = payload.type;
    const requestId = routeIdFromPayload(payload);
    if (requestId) summary.requestId = requestId;
    // 诊断形状不枚举完整对象键集，避免大快照在发送失败时又被额外全量扫描。
    summary.payloadType = Array.isArray(nestedPayload)
      ? `array(${nestedPayload.length})`
      : nestedPayload && typeof nestedPayload === "object"
        ? "object"
        : typeof nestedPayload;
  }
  return summary;
}

function wsCompressionOptions() {
  if (WS_DEFLATE_DISABLED) return false;
  return {
    // 只压缩大会话快照/历史消息这类大 JSON，小 IPC 保持原样，避免 CPU 成本抵消收益。
    threshold: WS_DEFLATE_THRESHOLD,
    // 不跨消息复用压缩上下文，降低内存占用和压缩侧信道风险。
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    concurrencyLimit: WS_DEFLATE_CONCURRENCY,
    zlibDeflateOptions: {
      level: WS_DEFLATE_LEVEL,
    },
  };
}

// ws-hub 不理解官方 IPC 协议，只负责维护连接和按 clientId 投递 JSON 消息。
/** 创建 WebSocket hub，负责浏览器连接管理和 gateway 事件分发。 */
function createWsHub(
  server,
  {
    createAppHostRelay,
    handleIpcInvoke,
    handleNotificationEvent,
    isAuthed,
    maxAppHostRelays = APP_HOST_RELAY_MAX_ENTRIES,
    orphanTtlMs = APP_HOST_ORPHAN_TTL_MS,
    maxBufferedBytes = WS_MAX_BUFFERED_BYTES,
    maxClients = WS_MAX_CLIENTS,
    maxPayloadBytes = WS_MAX_PAYLOAD_BYTES,
    observeAppHostFrame,
  }
) {
  if (!WebSocketServer) {
    throw new Error("The ws package is required for gateway websocket support.");
  }

  const perMessageDeflate = wsCompressionOptions();
  const effectiveMaxBufferedBytes = Math.max(1024, Number(maxBufferedBytes) || WS_MAX_BUFFERED_BYTES);
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate,
    maxPayload: Math.max(1024 * 1024, Number(maxPayloadBytes) || WS_MAX_PAYLOAD_BYTES),
  });
  if (WS_DEBUG_ENABLED) {
    // 压缩配置只在排障模式打印；压缩本身始终按上面的配置生效。
    diagnosticLog("ws-hub", "compression_configured", {
      debugWs: WS_DEBUG_ENABLED,
      enabled: !!perMessageDeflate,
      threshold: perMessageDeflate ? perMessageDeflate.threshold : 0,
      concurrencyLimit: perMessageDeflate ? perMessageDeflate.concurrencyLimit : 0,
      level: perMessageDeflate ? perMessageDeflate.zlibDeflateOptions.level : 0,
    });
  }
  const clients = new Set();
  // clientsById 是定向回包索引；clients 是广播索引，二者都需要维护。
  const clientsById = new Map();
  const clientReadyListeners = new Set();
  const clientRemovedListeners = new Set();
  let lastAuthRejectLogAtMs = 0;
  let suppressedAuthRejectCount = 0;
  const appHostTraffic = new Map();
  let nextAppHostRelayGeneration = 0;
  // 官方 app-host relay 的孤儿表：key 是 clientId:portId。WS 断开时 relay 不在这里销毁，
  // 而是保留官方 MessagePortMain 等页面重连；官方 main 的 RPC session 与 MessagePort 终身绑定，
  // 一旦这里先销毁，页面重连后建出的新 session 必然和页面旧 MessagePort 的 export 表错位
  // （生产日志表现为 sa_server_request_failed "no such export ID: 1"，刷新页面才能恢复）。
  const orphanedAppHostRelays = new Map();
  const orphanedAppHostByClient = new Map();
  const appHostLifecycleLogState = new Map();
  // 曾经建立过官方会话的 clientId:portId 记录。重连时若同名端口没有可重挂的孤儿（已过期/已死），
  // 说明页面 MessagePort 背后的官方 session 已经不存在，新 relay 建的必然是错位的新 session；
  // 此时通知页面走 app-host-port-reset 自愈（页面自动重载重建 port），而不是让用户手动刷新。
  const everLiveAppHostPorts = new Map();
  const EVER_LIVE_PORT_MAX_ENTRIES = 1024;
  // 孤儿窗口内官方→浏览器方向帧的缓冲上限：RPC 的 push 帧直接决定两端 export 表长度，
  // 丢一帧就是永久性 export 错位，所以断线窗口内的下行帧必须完整缓冲，重挂后按序冲刷。
  const ORPHAN_FRAME_LIMIT = 4000;
  const ORPHAN_FRAME_CHARS_LIMIT = 16 * 1024 * 1024;

  function logAppHostLifecycle(scope, portKey, event, details = {}) {
    const now = Date.now();
    const state = appHostLifecycleLogState.get(portKey) || { lastAt: 0, suppressed: 0 };
    if (now - state.lastAt < APP_HOST_LIFECYCLE_LOG_WINDOW_MS) {
      state.suppressed += 1;
      appHostLifecycleLogState.set(portKey, state);
      if (state.suppressed % 100 !== 0) return;
      // 被限流的事件只在第 100 次时补一条汇总，既保留可计数性又不刷屏。
      diagnosticWarn(scope, `${event}_throttled`, { ...details, suppressed: state.suppressed });
      state.suppressed = 0;
      state.lastAt = now;
      return;
    }
    state.lastAt = now;
    if (state.suppressed > 0) details.suppressedBefore = state.suppressed;
    appHostLifecycleLogState.set(portKey, state);
    diagnosticWarn(scope, event, details);
  }

  function orphanKeyFor(clientId, portId) {
    return `${clientId}:${portId}`;
  }

  function rememberEverLivePort(clientId, portId) {
    const key = orphanKeyFor(clientId, portId);
    everLiveAppHostPorts.set(key, Date.now());
    while (everLiveAppHostPorts.size > EVER_LIVE_PORT_MAX_ENTRIES) {
      const oldest = everLiveAppHostPorts.keys().next().value;
      if (oldest === undefined) break;
      everLiveAppHostPorts.delete(oldest);
    }
  }

  function removeOrphanEntry(entry) {
    if (orphanedAppHostRelays.get(entry.key) === entry) orphanedAppHostRelays.delete(entry.key);
    const ports = orphanedAppHostByClient.get(entry.clientId);
    if (ports) {
      ports.delete(entry.key);
      if (ports.size === 0) orphanedAppHostByClient.delete(entry.clientId);
    }
    if (entry.timer) clearTimeout(entry.timer);
  }

  function findOrphanEntry(clientId, portId) {
    return orphanedAppHostRelays.get(orphanKeyFor(clientId, portId)) || null;
  }

  function dropOrphanForContext(context, reason) {
    // relay 在孤儿期间自行终止（官方端关闭端口/编码失败等）：官方 session 已死，
    // 条目必须移除，页面回来时只能走新 relay + reset 自愈路径。
    const entry = findOrphanEntry(context.clientId, context.portId);
    if (!entry) return;
    removeOrphanEntry(entry);
    logAppHostLifecycle("ws-hub", entry.key, "app_host_orphan_dropped", {
      clientId: shortId(context.clientId),
      portId: shortId(context.portId),
      reason,
    });
  }

  function enqueueOrphanFrame(context, data) {
    if (context.terminalState !== "orphaned") return false;
    let wireData;
    try {
      wireData = appHostMessageCodec.encodeMessageData(data);
    } catch (error) {
      logAppHostLifecycle("ws-hub", orphanKeyFor(context.clientId, context.portId), "app_host_orphan_encode_failed", {
        clientId: shortId(context.clientId),
        portId: shortId(context.portId),
        error: error instanceof Error ? error.message : String(error),
      });
      // 先落 terminal 再 close，保证 close 回调里 relayIsCurrent 按 closed 判定，不会误发端口错误帧。
      context.terminalState = "closed";
      dropOrphanForContext(context, "orphan_encode_failed");
      try {
        context.relay?.close("orphan_encode_failed");
      } catch {}
      return false;
    }
    if (!context.orphanFrames) {
      context.orphanFrames = [];
      context.orphanFrameChars = 0;
    }
    const chars = typeof wireData.data === "string"
      ? 256 + wireData.data.length
      : 256 + (JSON.stringify(wireData) || "").length;
    if (context.orphanFrames.length >= ORPHAN_FRAME_LIMIT || context.orphanFrameChars + chars > ORPHAN_FRAME_CHARS_LIMIT) {
      // 缓冲放不下说明断线窗口远超预期（或帧异常巨大）：主动终止官方 session，
      // 页面回来时收到 reset 通知后自动重载，保证可恢复而不是静默错位。
      logAppHostLifecycle("ws-hub", orphanKeyFor(context.clientId, context.portId), "app_host_orphan_buffer_overflow", {
        clientId: shortId(context.clientId),
        portId: shortId(context.portId),
        frames: context.orphanFrames.length,
        chars: context.orphanFrameChars,
      });
      dropOrphanForContext(context, "orphan_buffer_overflow");
      // 先落 terminal 再 close，同上。
      context.terminalState = "closed";
      try {
        context.relay?.close("orphan_buffer_overflow");
      } catch {}
      return false;
    }
    context.orphanFrames.push(wireData);
    context.orphanFrameChars += chars;
    return true;
  }

  function relayScopeOf(context) {
    // relay 回调在创建时闭包捕获的是当时 socket 的 map；孤儿重挂后 map 会换，
    // 必须每次动态解析，否则重挂后官方→浏览器方向的帧会被 relayIsCurrent 判成旧 generation 丢弃。
    if (context && context.relaysMap) return context.relaysMap;
    if (context && context.ws && context.ws.__codexAppHostRelays) return context.ws.__codexAppHostRelays;
    return null;
  }

  function recycleOrphan(entry) {
    const { key, clientId, portId, context, timer } = entry;
    if (timer) clearTimeout(timer);
    if (orphanedAppHostRelays.get(key) !== entry) return;
    orphanedAppHostRelays.delete(key);
    const ports = orphanedAppHostByClient.get(clientId);
    if (ports) {
      ports.delete(key);
      if (ports.size === 0) orphanedAppHostByClient.delete(clientId);
    }
    if (context.terminalState !== "active" && context.terminalState !== "orphaned") return;
    // 回收时按正常 peer-close 释放官方 session：先 null 再关端口，官方端把它当作页面关闭。
    let graceful = false;
    try {
      graceful = context.relay?.postMessage(null) === true;
    } catch {}
    if (!graceful) {
      try {
        context.relay?.close("orphan_expired");
      } catch {}
    }
    context.terminalState = "closed";
    logAppHostLifecycle("ws-hub", key, "app_host_orphan_recycled", {
      clientId: shortId(clientId),
      portId: shortId(portId),
      waitedMs: Math.max(0, Date.now() - entry.sinceAt),
    });
  }

  function orphanAppHostRelays(ws, ttlMs) {
    const relays = ws.__codexAppHostRelays;
    if (!relays || relays.size === 0) return 0;
    const clientId = socketClientId(ws);
    let count = 0;
    for (const [portId, context] of [...relays]) {
      if (context.terminalState !== "active" || context.registered !== true) continue;
      relays.delete(portId);
      const key = orphanKeyFor(clientId, portId);
      const existing = orphanedAppHostRelays.get(key);
      if (existing) {
        // 同名孤儿还在保留窗口内：让新断开取代旧条目（同一页面只有一份官方 port）。
        clearTimeout(existing.timer);
        existing.context.terminalState = "closed";
        try {
          existing.context.relay?.close("replaced_by_newer_disconnect");
        } catch {}
      }
      context.terminalState = "orphaned";
      context.terminalNotified = false;
      // 关闭旧 socket 与 relay 的绑定：relay 的 onMessage/onClose 都按 relayIsCurrent 判定，
      // 这里不再属于任何 socket 的 relays 表；孤儿窗口内官方→浏览器帧改走 enqueueOrphanFrame 缓冲。
      context.relaysMap = null;
      const entry = { key, clientId, portId, context, sinceAt: Date.now(), timer: null };
      entry.timer = setTimeout(() => recycleOrphan(entry), Math.max(1, Number(ttlMs) || APP_HOST_ORPHAN_TTL_MS));
      if (typeof entry.timer.unref === "function") entry.timer.unref();
      rememberEverLivePort(clientId, portId);
      orphanedAppHostRelays.set(key, entry);
      let ports = orphanedAppHostByClient.get(clientId);
      if (!ports) {
        ports = new Map();
        orphanedAppHostByClient.set(clientId, ports);
      }
      ports.set(key, entry);
      count += 1;
    }
    // 全局孤儿上限：页面反复 reload 会不断产生新 clientId 的孤儿会话，按最旧优先回收，
    // 上限与每 socket 的 relay 上限同量级，避免官方 main 侧 session 无界累积。
    while (orphanedAppHostRelays.size > Math.max(1, Number(maxAppHostRelays) || 1)) {
      const oldest = orphanedAppHostRelays.entries().next().value;
      if (!oldest) break;
      recycleOrphan(oldest[1]);
    }
    if (count > 0) {
      logAppHostLifecycle("ws-hub", `${clientId}:orphan-batch`, "app_host_orphaned", {
        clientId: shortId(clientId),
        orphanedPorts: count,
        ttlMs: Math.max(1, Number(ttlMs) || APP_HOST_ORPHAN_TTL_MS),
      });
    }
    return count;
  }

  function reattachOrphanedAppHostRelay(ws, clientId, portId) {
    const key = orphanKeyFor(clientId, portId);
    const entry = orphanedAppHostRelays.get(key);
    if (!entry) return null;
    const { context, timer } = entry;
    if (context.terminalState !== "orphaned") {
      orphanedAppHostRelays.delete(key);
      const ports = orphanedAppHostByClient.get(clientId);
      if (ports) ports.delete(key);
      return null;
    }
    clearTimeout(timer);
    orphanedAppHostRelays.delete(key);
    const ports = orphanedAppHostByClient.get(clientId);
    if (ports) {
      ports.delete(key);
      if (ports.size === 0) orphanedAppHostByClient.delete(clientId);
    }
    // 重新挂回当前 socket：复用同一条 relay 和同一个官方 MessagePortMain，
    // 官方 main 侧的 RPC session 从头到尾没有换过，页面 MessagePort 的 export 表保持有效。
    context.terminalState = "active";
    context.ws = ws;
    context.relaysMap = appHostRelaysForSocket(ws);
    context.terminalNotified = false;
    context.relaysMap.set(portId, context);
    rememberEverLivePort(clientId, portId);
    // 断线窗口内缓冲的官方帧先冲刷，再发 connected 让页面冲刷它自己的上行队列；
    // 两个方向各自保持 FIFO，RPC export 表不会被乱序/丢帧打错位。
    for (const frame of context.orphanFrames || []) {
      safeSend(ws, { type: "app-host-port-message", portId, ...frame }, { suppressDiagnostic: true });
    }
    context.orphanFrames = [];
    context.orphanFrameChars = 0;
    rememberEverLivePort(clientId, portId);
    logAppHostLifecycle("ws-hub", key, "app_host_reattached", {
      clientId: shortId(clientId),
      portId: shortId(portId),
      orphanMs: Math.max(0, Date.now() - entry.sinceAt),
    });
    return context;
  }

  function socketRemoteAddress(socket) {
    return (socket && socket.__codexRemoteAddress) || "";
  }

  function socketClientId(socket) {
    return (socket && socket.__codexWebClientId) || "";
  }

  function appHostTrafficKey(clientId, portId, direction) {
    // app-host 一个页面可能同时有多个 MessagePort，聚合 key 必须带 portId 才不会混在一起。
    return `${clientId || "unknown"}\n${portId || "unknown"}\n${direction || "unknown"}`;
  }

  function flushAppHostTraffic(key) {
    if (!WS_DEBUG_ENABLED) return;
    const stat = appHostTraffic.get(key);
    if (!stat) return;
    appHostTraffic.delete(key);
    if (stat.timer) clearTimeout(stat.timer);
    // app-host 是官方新版 renderer 的 MessagePort RPC 通道。这里做聚合日志，避免逐帧日志影响冷加载。
    diagnosticLog("ws-hub", "app_host_traffic_summary", {
      bytes: stat.bytes,
      clientId: shortId(stat.clientId),
      count: stat.count,
      direction: stat.direction,
      maxBytes: stat.maxBytes,
      maxSendCallbackMs: stat.maxSendCallbackMs,
      portId: shortId(stat.portId),
      remoteAddress: stat.remoteAddress,
      windowMs: Date.now() - stat.startedAtMs,
    });
  }

  function recordAppHostTraffic(socket, direction, portId, dataBytes) {
    if (!WS_DEBUG_ENABLED) return;
    const clientId = socketClientId(socket);
    const key = appHostTrafficKey(clientId, portId, direction);
    let stat = appHostTraffic.get(key);
    if (!stat) {
      stat = {
        bytes: 0,
        clientId,
        count: 0,
        direction,
        maxBytes: 0,
        maxSendCallbackMs: 0,
        portId,
        remoteAddress: socketRemoteAddress(socket),
        startedAtMs: Date.now(),
        timer: null,
      };
      // 聚合窗口结束后只打一条 summary，避免 app-host 高频 wire 帧把会话加载日志刷爆。
      stat.timer = setTimeout(() => flushAppHostTraffic(key), APP_HOST_TRAFFIC_FLUSH_MS);
      if (stat.timer && typeof stat.timer.unref === "function") stat.timer.unref();
      appHostTraffic.set(key, stat);
    }
    stat.bytes += dataBytes;
    stat.count += 1;
    stat.maxBytes = Math.max(stat.maxBytes, dataBytes);
  }

  function recordAppHostSendCallback(socket, portId, sendCallbackMs) {
    if (!WS_DEBUG_ENABLED) return;
    const key = appHostTrafficKey(socketClientId(socket), portId, "official-to-browser");
    const stat = appHostTraffic.get(key);
    if (stat) stat.maxSendCallbackMs = Math.max(stat.maxSendCallbackMs, sendCallbackMs);
  }

  function flushAppHostTrafficForClient(clientId) {
    if (!WS_DEBUG_ENABLED) return;
    // 页面关闭时把该 client 的聚合窗口立即写出，方便复现后马上看完整统计。
    for (const [key, stat] of appHostTraffic.entries()) {
      if (stat.clientId === clientId) flushAppHostTraffic(key);
    }
  }

  function appHostPayloadInfo(payload) {
    // 只按 wire 数据估算长度，不解码 RPC 内容，同时兼容旧字符串和新版结构化帧。
    if (!payload || payload.type !== "app-host-port-message") return null;
    let serializedData = "";
    try {
      serializedData = typeof payload.data === "string" ? payload.data : JSON.stringify(payload.data);
    } catch {
      return null;
    }
    return {
      bytes: byteLength(serializedData),
      portId: typeof payload.portId === "string" ? payload.portId : "",
    };
  }

  function wsSendDiagnosticBase(socket, payload, route, messageBytes, stringifyMs, bufferedBefore, bufferedAfter, options = {}) {
    // diagnosticSummary 来自 official-runtime 的原始请求摘要，可把大回包反查到 requestMethod/url。
    return {
      ...(options.diagnosticSummary && typeof options.diagnosticSummary === "object" ? options.diagnosticSummary : {}),
      ...wsPayloadSummary(payload),
      bufferedAfter,
      bufferedBefore,
      bytes: messageBytes,
      clientId: shortId(socketClientId(socket)),
      remoteAddress: socketRemoteAddress(socket),
      route,
      stringifyMs,
    };
  }

  function shouldLogWsSend(messageBytes, stringifyMs, bufferedBefore, bufferedAfter) {
    if (!WS_DEBUG_ENABLED) return false;
    // 只在消息大、JSON 序列化慢或 socket 已经有明显积压时打慢日志。
    return (
      messageBytes >= WS_LARGE_MESSAGE_BYTES ||
      stringifyMs >= WS_STRINGIFY_SLOW_MS ||
      bufferedBefore >= WS_BUFFERED_LOG_BYTES ||
      bufferedAfter >= WS_BUFFERED_LOG_BYTES
    );
  }

  function terminateBackpressuredSocket(socket, route) {
    const bufferedAmount = Math.max(0, Number(socket?.bufferedAmount || 0));
    if (bufferedAmount <= effectiveMaxBufferedBytes) return false;
    if (!socket.__opencodexBackpressureTerminated) {
      socket.__opencodexBackpressureTerminated = true;
      // 慢连接已严重积压时立即释放 ws 内部发送队列；浏览器现有重连会重新同步权威状态。
      diagnosticWarn("ws-hub", "client_backpressure_terminated", {
        bufferedAmount,
        clientId: shortId(socketClientId(socket)),
        maxBufferedBytes: effectiveMaxBufferedBytes,
        remoteAddress: socketRemoteAddress(socket),
        route,
      });
      try {
        if (typeof socket.terminate === "function") socket.terminate();
        else socket.close?.(1013, "backpressure");
      } catch {}
    }
    return true;
  }

  function sendPrepared(socket, payload, message, options = {}) {
    /**
     * 所有下行 WS 消息最终走这里：
     * - 默认路径只做一次 socket.send，避免为了诊断增加常态开销。
     * - OPENCODEX_DEBUG_WS=1 时才读取 bufferedAmount、统计字节数、挂 send callback。
     */
    const route = options.route || "send";
    if (terminateBackpressuredSocket(socket, route)) return false;
    const stringifyMs = options.stringifyMs || 0;
    const messageBytes = WS_DEBUG_ENABLED ? byteLength(message) : 0;
    const appHostInfo = WS_DEBUG_ENABLED ? appHostPayloadInfo(payload) : null;
    const bufferedBefore = WS_DEBUG_ENABLED ? Number(socket.bufferedAmount || 0) : 0;
    let bufferedAfter = bufferedBefore;
    const sendStartedAtMs = WS_DEBUG_ENABLED ? Date.now() : 0;
    const needCallback =
      WS_DEBUG_ENABLED &&
      (shouldLogWsSend(messageBytes, stringifyMs, bufferedBefore, bufferedAfter) ||
        (appHostInfo && appHostInfo.bytes >= APP_HOST_LARGE_FRAME_BYTES));
    try {
      if (appHostInfo) recordAppHostTraffic(socket, "official-to-browser", appHostInfo.portId, appHostInfo.bytes);
      const onSent = (error) => {
        const sendCallbackMs = Date.now() - sendStartedAtMs;
        const doneBuffered = Number(socket.bufferedAmount || 0);
        if (appHostInfo) recordAppHostSendCallback(socket, appHostInfo.portId, sendCallbackMs);
        if (error) {
          diagnosticWarn("ws-hub", "send_callback_failed", {
            ...wsSendDiagnosticBase(socket, payload, route, messageBytes, stringifyMs, bufferedBefore, doneBuffered, options),
            error: error instanceof Error ? error.message : String(error),
            sendCallbackMs,
          });
          return;
        }
        if (
          messageBytes >= WS_LARGE_MESSAGE_BYTES ||
          sendCallbackMs >= WS_SEND_SLOW_MS ||
          stringifyMs >= WS_STRINGIFY_SLOW_MS ||
          bufferedBefore >= WS_BUFFERED_LOG_BYTES ||
          doneBuffered >= WS_BUFFERED_LOG_BYTES
        ) {
          diagnosticLog("ws-hub", "send_large_or_slow", {
            ...wsSendDiagnosticBase(socket, payload, route, messageBytes, stringifyMs, bufferedBefore, doneBuffered, options),
            sendCallbackMs,
          });
        }
      };
      if (needCallback) {
        socket.send(message, onSent);
      } else {
        socket.send(message);
      }
      bufferedAfter = WS_DEBUG_ENABLED ? Number(socket.bufferedAmount || 0) : 0;
      if (shouldLogWsSend(messageBytes, stringifyMs, bufferedBefore, bufferedAfter) && !needCallback) {
        diagnosticLog("ws-hub", "send_large_or_buffered", {
          ...wsSendDiagnosticBase(socket, payload, route, messageBytes, stringifyMs, bufferedBefore, bufferedAfter, options),
        });
      }
      return true;
    } catch (error) {
      diagnosticWarn("ws-hub", "send_failed", {
        ...wsSendDiagnosticBase(socket, payload, route, messageBytes, stringifyMs, bufferedBefore, bufferedAfter, options),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function stringifyForWs(payload) {
    // JSON.stringify 是必须成本；只有 debug 模式才额外记录它用了多久。
    if (!WS_DEBUG_ENABLED) return { message: JSON.stringify(payload), stringifyMs: 0 };
    const startedAtMs = Date.now();
    const message = JSON.stringify(payload);
    return { message, stringifyMs: Date.now() - startedAtMs };
  }

  function broadcastDedupeCandidate(message, options) {
    const key = typeof options.dedupeKey === "string" ? options.dedupeKey.slice(0, 160) : "";
    if (!key) return null;
    const windowMs = Math.min(
      BROADCAST_DEDUPE_MAX_WINDOW_MS,
      Math.max(1, Number(options.dedupeWindowMs) || 1)
    );
    // 基于最终序列化帧做强摘要；只有字节完全相同的广播才允许跳过，业务字段变化会立即得到不同摘要。
    const fingerprint = crypto.createHash("sha256").update(message).digest("base64url");
    return { fingerprint, key, nowMs: Date.now(), windowMs };
  }

  function socketHasRecentDuplicate(socket, candidate) {
    if (!candidate) return false;
    const recent = socket.__opencodexRecentBroadcastFingerprints;
    const previous = recent?.get(candidate.key);
    return !!(
      previous &&
      previous.fingerprint === candidate.fingerprint &&
      candidate.nowMs - previous.atMs <= candidate.windowMs
    );
  }

  function rememberSocketBroadcast(socket, candidate) {
    if (!candidate) return;
    const recent =
      socket.__opencodexRecentBroadcastFingerprints ||
      (socket.__opencodexRecentBroadcastFingerprints = new Map());
    recent.delete(candidate.key);
    recent.set(candidate.key, { atMs: candidate.nowMs, fingerprint: candidate.fingerprint });
    while (recent.size > BROADCAST_DEDUPE_MAX_ENTRIES_PER_SOCKET) {
      recent.delete(recent.keys().next().value);
    }
  }

  function safeSend(socket, payload, options = {}) {
    // 所有 WebSocket 下行都走这个出口，便于统一压日志和记录投递失败。
    if (!socket || socket.readyState !== socket.OPEN) return false;
    if (terminateBackpressuredSocket(socket, options.route || "send")) return false;
    try {
      const { message, stringifyMs } = stringifyForWs(payload);
      const sent = sendPrepared(socket, payload, message, { ...options, route: options.route || "send", stringifyMs });
      if (DEBUG_LOGS && sent && !options.suppressDiagnostic) {
        // 单点发送是 WS 下行的正常成功路径，默认不打印，避免会话流式事件把日志撑满。
        diagnosticLog("ws-hub", "send", wsPayloadSummary(payload));
      }
      return sent;
    } catch (error) {
      diagnosticWarn("ws-hub", "send_failed", {
        ...wsPayloadSummary(payload),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function appHostRelaysForSocket(ws) {
    // app-host MessagePort 的生命周期必须跟浏览器页面一致，不能做成跨页面共享的全局状态。
    if (!ws.__codexAppHostRelays) ws.__codexAppHostRelays = new Map();
    return ws.__codexAppHostRelays;
  }

  function relayIsCurrent(relays, context) {
    // map 身份和 terminal 状态共同界定当前 relay，旧 generation 的延迟回调不能影响替换端口。
    return !!context && context.terminalState === "active" && relays.get(context.portId) === context;
  }

  function failAppHostRelay(relays, context, error, reason) {
    if (!context || context.terminalState !== "active") return false;
    if (context.registered && relays.get(context.portId) !== context) return false;
    context.terminalState = "error";
    if (relays.get(context.portId) === context) relays.delete(context.portId);
    // 失败路径只发一次 error；底层 close 回调看到 terminal 状态后不会再追加 close。
    if (!context.terminalNotified) {
      context.terminalNotified = true;
      safeSend(
        context.ws,
        { type: "app-host-port-error", portId: context.portId, error: error instanceof Error ? error.message : String(error) },
        { suppressDiagnostic: true }
      );
    }
    try {
      context.relay?.close(reason);
    } catch {}
    return true;
  }

  function closeAppHostRelay(relays, context, reason, { notify = true, closePort = true } = {}) {
    if (!context || context.terminalState !== "active") return false;
    if (context.registered && relays.get(context.portId) !== context) return false;
    context.terminalState = reason === "replaced" ? "replaced" : "closed";
    if (relays.get(context.portId) === context) relays.delete(context.portId);
    if (notify && reason !== "replaced" && !context.terminalNotified) {
      context.terminalNotified = true;
      safeSend(
        context.ws,
        { type: "app-host-port-close", portId: context.portId, reason },
        { suppressDiagnostic: true }
      );
    }
    if (closePort) {
      try {
        context.relay?.close(reason);
      } catch {}
    }
    return true;
  }

  function closeAppHostRelays(ws, reason, { ttlMs } = {}) {
    const relays = ws.__codexAppHostRelays;
    if (!relays || relays.size === 0) return;
    if (reason === "client_disconnected" && ttlMs) {
      // 临时性 WS 断开：保留官方端口等页面重连，见 orphanAppHostRelays 注释。
      orphanAppHostRelays(ws, ttlMs);
      return;
    }
    // 页面断开时主动关闭官方端口，否则官方 app-host 服务会保留无主连接。
    for (const context of [...relays.values()]) {
      let graceful = false;
      if (reason === "client_disconnected") {
        // WebSocket 断开属于正常 peer-close，先给官方端发送 null 再异步释放 MessagePort。
        try {
          graceful = context.relay?.postMessage(null) === true;
        } catch {}
      }
      closeAppHostRelay(relays, context, reason, { closePort: !graceful });
    }
  }

  function removeClient(ws) {
    flushAppHostTrafficForClient(socketClientId(ws));
    // WS 断开（close/error 都会走到这里）按临时断开处理：孤儿化 relay 保留官方 session，
    // 页面重连后重新挂接；超过保留窗口仍没回来才真正释放官方端口。
    closeAppHostRelays(ws, "client_disconnected", { ttlMs: orphanTtlMs });
    clients.delete(ws);
    if (ws.__codexWebClientId && clientsById.get(ws.__codexWebClientId) === ws) {
      const clientId = ws.__codexWebClientId;
      clientsById.delete(clientId);
      for (const listener of clientRemovedListeners) {
        try {
          // 只在当前有效映射真正移除时通知；旧 socket 关闭不能清理已重连的新页面。
          listener({ clientId, socket: ws });
        } catch (error) {
          diagnosticWarn("ws-hub", "client_removed_listener_failed", {
            clientId: shortId(clientId),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  function logAuthRejected(url) {
    const now = Date.now();
    if (now - lastAuthRejectLogAtMs < 10_000) {
      suppressedAuthRejectCount += 1;
      return;
    }
    // 未登录旧页面可能持续重连 WS，这里节流汇总，避免噪声盖住真实 IPC 慢链路。
    diagnosticWarn("ws-hub", "upgrade_rejected_auth", {
      suppressedCount: suppressedAuthRejectCount,
      url,
    });
    suppressedAuthRejectCount = 0;
    lastAuthRejectLogAtMs = now;
  }

  /** 向所有在线浏览器广播 gateway 消息。 */
  function broadcast(payload, options = {}) {
    const readySockets = [];
    for (const socket of clients) {
      if (socket.readyState !== socket.OPEN) continue;
      if (terminateBackpressuredSocket(socket, "broadcast")) continue;
      readySockets.push(socket);
    }
    // 无在线浏览器时官方后台广播无需 JSON.stringify，大 snapshot 尤其不能白占主线程和堆。
    if (readySockets.length === 0) return 0;
    const { message, stringifyMs } = stringifyForWs(payload);
    const dedupeCandidate = broadcastDedupeCandidate(message, options);
    let sent = 0;
    for (const socket of readySockets) {
      // 新连接没有历史摘要，仍会收到当前通知；只跳过该 socket 在短窗口内已经成功收到的完全相同帧。
      if (socketHasRecentDuplicate(socket, dedupeCandidate)) continue;
      if (sendPrepared(socket, payload, message, { ...options, route: "broadcast", stringifyMs })) {
        rememberSocketBroadcast(socket, dedupeCandidate);
        sent += 1;
      }
    }
    if (DEBUG_LOGS && !options.suppressDiagnostic) {
      // 广播类消息在会话同步时非常高频，默认只转发不打印；需要排查 WS 路由时再打开 CODEX_WEB_DEBUG。
      diagnosticLog("ws-hub", "broadcast", {
        ...wsPayloadSummary(payload),
        clientCount: clients.size,
        sent,
      });
    }
    return sent;
  }

  /** 向指定 clientId 的浏览器发送 gateway 消息。 */
  function sendTo(clientId, payload, options = {}) {
    const socket = clientsById.get(clientId);
    if (!socket || socket.readyState !== socket.OPEN) {
      if (!options.suppressDiagnostic) {
        // 例行回包可能与页面刷新交错；调用方已标记 suppress 时不把预期离线放大成磁盘日志风暴。
        diagnosticWarn("ws-hub", "send_to_missing_client", {
          ...wsPayloadSummary(payload),
          clientId: shortId(clientId),
          readyState: socket ? socket.readyState : "missing",
        });
      }
      return false;
    }
    if (terminateBackpressuredSocket(socket, "send_to")) return false;
    try {
      const { message, stringifyMs } = stringifyForWs(payload);
      const sent = sendPrepared(socket, payload, message, { ...options, route: "send_to", stringifyMs });
      if (DEBUG_LOGS && sent && !options.suppressDiagnostic) {
        // 定向发送成功只说明路由命中，排查路由时有用，日常运行不需要持续记录。
        diagnosticLog("ws-hub", "send_to", {
          ...wsPayloadSummary(payload),
          clientId: shortId(clientId),
        });
      }
      return sent;
    } catch (error) {
      diagnosticWarn("ws-hub", "send_to_failed", {
        ...wsPayloadSummary(payload),
        clientId: shortId(clientId),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function hasClient(clientId) {
    const socket = clientsById.get(clientId);
    return !!socket && socket.readyState === socket.OPEN;
  }

  function onClientReady(listener) {
    if (typeof listener !== "function") return () => {};
    clientReadyListeners.add(listener);
    return () => clientReadyListeners.delete(listener);
  }

  function onClientRemoved(listener) {
    if (typeof listener !== "function") return () => {};
    clientRemovedListeners.add(listener);
    return () => clientRemovedListeners.delete(listener);
  }

  function normalizedWsClientId(ws, message) {
    // 控制帧允许带 clientId，但最终必须和 hello 注册到 socket 上的 clientId 一致。
    const messageClientId = message && typeof message.clientId === "string" ? message.clientId : "";
    const socketClientId = ws.__codexWebClientId || "";
    return messageClientId || socketClientId;
  }

  function validAppHostPortId(value) {
    // portId 只作为本页多条 MessagePort 的路由键，限制长度即可，不引入额外协议含义。
    return typeof value === "string" && value.length > 0 && value.length <= 160;
  }

  function handleAppHostConnect(ws, req, message) {
    // 浏览器发起 connect 后，gateway 才创建 Electron MessageChannelMain 并交给官方 listener。
    const clientId = normalizedWsClientId(ws, message);
    const portId = message && typeof message.portId === "string" ? message.portId : "";
    if (!clientId || ws.__codexWebClientId !== clientId || !validAppHostPortId(portId)) {
      diagnosticWarn("ws-hub", "app_host_connect_rejected", {
        clientId: shortId(clientId),
        mappedClientId: shortId(ws.__codexWebClientId || ""),
        portId: shortId(portId),
      });
      return true;
    }
    if (typeof createAppHostRelay !== "function") {
      diagnosticWarn("ws-hub", "app_host_connect_unavailable", {
        clientId: shortId(clientId),
        portId: shortId(portId),
      });
      safeSend(ws, { type: "app-host-port-error", portId, error: "App host relay is unavailable" });
      return true;
    }

    const reattached = reattachOrphanedAppHostRelay(ws, clientId, portId);
    if (reattached) {
      // 复用同一条 relay 与同一个官方 MessagePortMain：官方 main 的 RPC session 从未更换，
      // 页面 MessagePort 的 export 表保持有效，因此不会出现 no such export ID。
      // ack 与新建路径完全一致（{ type, portId }）；reattached 标记仅供诊断。
      safeSend(ws, { type: "app-host-port-connected", portId, reattached: true }, { suppressDiagnostic: true });
      return true;
    }

    // 孤儿窗口已过（TTL 回收/主动丢弃）但同一个 clientId:portId 曾有过正常会话：
    // 页面手里仍是旧 session 的 MessagePort，而官方 main 侧的 session 已释放，
    // 此时新建 relay 必然造出一个和页面 export 表错位的新 session（no such export ID 复发）。
    // 不新建，直接通知页面走 app-host-port-reset 自愈（页面自动重载重建 port）。
    // 精确判定：命中 everLive 表（曾有过正常会话）且当前 socket 上没有该 port 的 active relay、
    // 上面也没有可重挂的 orphan——三者同时成立才说明页面手里是已失效的旧 port。
    const everLiveSinceAt = everLiveAppHostPorts.get(orphanKeyFor(clientId, portId));
    if (everLiveSinceAt !== undefined && !appHostRelaysForSocket(ws).get(portId)) {
      logAppHostLifecycle("ws-hub", orphanKeyFor(clientId, portId), "app_host_port_reset_requested", {
        clientId: shortId(clientId),
        portId: shortId(portId),
        ageMs: Math.max(0, Date.now() - everLiveSinceAt),
      });
      safeSend(ws, { type: "app-host-port-reset", portId, reason: "session-expired" }, { suppressDiagnostic: true });
      return true;
    }

    const relays = appHostRelaysForSocket(ws);
    const existing = relays.get(portId);
    if (existing) {
      // 同一个页面重复使用 portId 时以后到者为准，先关闭旧 relay 避免双写。
      relays.delete(portId);
      existing.registered = false;
      // replacement 先发送官方 peer-close，让旧 listener 将其视为正常结束。
      let graceful = false;
      try {
        graceful = existing.relay?.postMessage(null) === true;
      } catch {}
      closeAppHostRelay(relays, existing, "replaced", { notify: false, closePort: !graceful });
    }
    while (relays.size >= Math.max(1, Number(maxAppHostRelays) || 1)) {
      const [oldestPortId, oldestContext] = relays.entries().next().value || [];
      if (!oldestPortId) break;
      // 异常页面创建过多 MessagePort 时淘汰最旧端口，正常官方端口数量远低于此上限。
      closeAppHostRelay(relays, oldestContext, "relay_limit");
    }

    const context = {
      generation: ++nextAppHostRelayGeneration,
      portId,
      clientId,
      ws,
      relay: null,
      registered: false,
      terminalNotified: false,
      terminalState: "active",
    };
    try {
      const relay = createAppHostRelay({
        clientId,
        portId,
        remoteAddress: req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "",
        onClose(reason) {
          // 旧 generation 的 close 只能释放自身资源，不能通知当前浏览器 relay；
          // relays 动态解析（relayScopeOf），孤儿重挂后 map 已换，仍能正确判定归属。
          if (!relayIsCurrent(relayScopeOf(context) || relays, context)) return;
          closeAppHostRelay(relays, context, reason);
          if (DEBUG_LOGS) {
            diagnosticLog("ws-hub", "app_host_closed", {
              clientId: shortId(clientId),
              portId: shortId(portId),
              generation: context.generation,
              reason,
            });
          }
        },
        onError(error) {
          failAppHostRelay(relays, context, error, "forward_to_browser_failed");
        },
        onMessage(data) {
          // 旧字符串保持原帧；新版结构化克隆值编码成 JSON-safe wire 数据后再进入 WebSocket。
          // 孤儿窗口内官方→浏览器帧改入缓冲队列，重挂后按 FIFO 冲刷；丢一帧就是永久 export 错位。
          if (context.terminalState === "orphaned") {
            enqueueOrphanFrame(context, data);
            return;
          }
          if (!relayIsCurrent(relayScopeOf(context) || relays, context)) return;
          let wireData;
          try {
            wireData = appHostMessageCodec.encodeMessageData(data);
          } catch (error) {
            diagnosticWarn("ws-hub", "app_host_message_encode_failed", {
              clientId: shortId(clientId),
              error: error instanceof Error ? error.message : String(error),
              portId: shortId(portId),
            });
            failAppHostRelay(relays, context, new Error("Invalid app-host transport data"), "encode_failed");
            return;
          }
          const sent = safeSend(
            context.ws,
            { type: "app-host-port-message", portId, ...wireData },
            { suppressDiagnostic: true }
          );
          if (!sent) {
            failAppHostRelay(
              relays,
              context,
              new Error("Browser WebSocket is unavailable for app-host data"),
              "forward_to_browser_failed"
            );
          }
        },
      });
      context.relay = relay;
      context.registered = true;
      if (context.terminalState !== "active" && context.terminalState !== "orphaned") {
        try {
          relay.close("connect_failed");
        } catch {}
        return true;
      }
      relays.set(portId, context);
      if (!safeSend(ws, { type: "app-host-port-connected", portId }, { suppressDiagnostic: true })) {
        failAppHostRelay(
          relays,
          context,
          new Error("Browser WebSocket is unavailable for app-host connection"),
          "forward_to_browser_failed"
        );
        return true;
      }
      if (DEBUG_LOGS) {
        // app-host 端口连接/关闭是前端组件生命周期的一部分，默认只保留失败日志。
        diagnosticLog("ws-hub", "app_host_connect", {
          clientId: shortId(clientId),
          portId: shortId(portId),
        });
      }
    } catch (error) {
      diagnosticWarn("ws-hub", "app_host_connect_failed", {
        clientId: shortId(clientId),
        error: error instanceof Error ? error.message : String(error),
        portId: shortId(portId),
      });
      safeSend(
        ws,
        {
          type: "app-host-port-error",
          portId,
          error: error instanceof Error ? error.message : String(error),
        },
        { suppressDiagnostic: true }
      );
    }
    return true;
  }

  function handleAppHostPortMessage(ws, req, message) {
    // 浏览器端 MessagePort 的后续 wire 帧从这里解码并回写到官方 Electron port。
    const clientId = normalizedWsClientId(ws, message);
    const portId = message && typeof message.portId === "string" ? message.portId : "";
    if (!clientId || ws.__codexWebClientId !== clientId || !validAppHostPortId(portId)) {
      diagnosticWarn("ws-hub", "app_host_message_rejected", {
        clientId: shortId(clientId),
        mappedClientId: shortId(ws.__codexWebClientId || ""),
        portId: shortId(portId),
      });
      return true;
    }
    const relays = appHostRelaysForSocket(ws);
    let data;
    try {
      data = appHostMessageCodec.decodeMessageData(message);
    } catch (error) {
      diagnosticWarn("ws-hub", "app_host_message_decode_failed", {
        clientId: shortId(clientId),
        error: error instanceof Error ? error.message : String(error),
        portId: shortId(portId),
      });
      const failedContext = relays.get(portId);
      if (failedContext) {
        failAppHostRelay(relays, failedContext, new Error("Invalid app-host transport data"), "decode_failed");
      } else {
        safeSend(
          ws,
          { type: "app-host-port-error", portId, error: "Invalid app-host transport data" },
          { suppressDiagnostic: true }
        );
      }
      return true;
    }
    let context = relays.get(portId);
    if (!context) {
      // WS 重连会释放旧 socket 上的 relay，但浏览器 MessagePort 仍会继续发送；按原身份懒重建后再转发首帧。
      handleAppHostConnect(ws, req, { ...message, type: "app-host-connect" });
      context = relays.get(portId);
      if (!context) {
        diagnosticWarn("ws-hub", "app_host_message_missing_relay", {
          clientId: shortId(clientId),
          portId: shortId(portId),
        });
        return true;
      }
    }
    try {
      // 观察器属于独立展示层；hub 仍只负责透明转发，不解析 App Server 协议或路由语义。
      observeAppHostFrame?.({ clientId, data, direction: "client", portId });
    } catch {}
    if (WS_DEBUG_ENABLED) {
      // 统计已经收到的 wire 数据，避免为诊断再次遍历恢复后的复杂对象。
      const wireText = typeof message.data === "string" ? message.data : JSON.stringify(message.data);
      recordAppHostTraffic(ws, "browser-to-official", portId, byteLength(wireText));
    }
    if (!relayIsCurrent(relays, context)) return true;
    try {
      const forwarded = context.relay.postMessage(data);
      if (forwarded === false) throw new Error("Official app-host port is unavailable");
    } catch (error) {
      failAppHostRelay(relays, context, error, "forward_to_official_failed");
      return true;
    }
    // 浏览器方向的 null/undefined 都已交给官方端；延迟 close 回调不能再重复通知页面。
    if (data == null) {
      closeAppHostRelay(relays, context, "browser_closed", { notify: false, closePort: false });
    }
    return true;
  }

  function handleIpcInvokeMessage(ws, req, message) {
    const clientId = normalizedWsClientId(ws, message);
    const requestId = message && typeof message.requestId === "string" ? message.requestId : "";
    const request = message && message.request && typeof message.request === "object" ? message.request : null;
    const sendResult = (result) =>
      safeSend(
        ws,
        {
          ...(result || {}),
          // 回包身份只能由当前已认证请求决定，官方 handler 的业务字段不能覆盖路由字段。
          type: "opencodex:ipc-result",
          requestId,
        },
        { route: "ipc-result", suppressDiagnostic: true }
      );
    if (
      !clientId ||
      ws.__codexWebClientId !== clientId ||
      !requestId ||
      requestId.length > 160 ||
      !request
    ) {
      // 无法关联页面或回包 id 的帧不进入官方 handler，避免跨页面路由和无主异步任务。
      if (requestId && requestId.length <= 160) {
        sendResult({ ok: false, status: 400, error: "Invalid WebSocket IPC request" });
      }
      return true;
    }
    if (typeof handleIpcInvoke !== "function") {
      sendResult({ ok: false, status: 503, error: "WebSocket IPC is unavailable" });
      return true;
    }
    const inFlight = Number(ws.__opencodexIpcInFlight || 0);
    if (inFlight >= WS_IPC_MAX_IN_FLIGHT) {
      sendResult({ ok: false, status: 429, error: "Too many in-flight WebSocket IPC requests" });
      return true;
    }

    ws.__opencodexIpcInFlight = inFlight + 1;
    // 不 await 当前 message 回调：官方首屏会并发发起大量互不依赖的读取，串行执行会重新制造队头阻塞。
    Promise.resolve()
      .then(() => handleIpcInvoke({ clientId, request, req }))
      .then((result) => sendResult(result))
      .catch((error) => {
        diagnosticWarn("ws-hub", "ipc_invoke_failed", {
          clientId: shortId(clientId),
          error: error instanceof Error ? error.message : String(error),
          requestId: shortId(requestId),
        });
        sendResult({
          ok: false,
          status: error && typeof error.status === "number" ? error.status : 500,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        ws.__opencodexIpcInFlight = Math.max(0, Number(ws.__opencodexIpcInFlight || 1) - 1);
      });
    return true;
  }

  function handleWsControlMessage(ws, req, message) {
    if (!message || typeof message !== "object") return false;
    if (message.type === "opencodex:ipc-invoke") return handleIpcInvokeMessage(ws, req, message);
    if (message.type === "opencodex:notification-event") {
      // 通知 click/close 只从已认证 WS 回传；hub 不理解官方通知语义，直接交回 runtime 的 fake Notification。
      return typeof handleNotificationEvent === "function" ? handleNotificationEvent(message, ws, req) : true;
    }
    if (message.type === "app-host-connect") return handleAppHostConnect(ws, req, message);
    if (message.type === "app-host-port-message") return handleAppHostPortMessage(ws, req, message);
    return false;
  }

  // 只接受 /ws 升级，并校验 gateway 访问 token。浏览器 WebSocket 不能自定义 header，所以允许 query/cookie。
  server.on("upgrade", (req, socket, head) => {
    // 先在 HTTP upgrade 阶段完成路径和 auth 校验，失败时不创建 WebSocket 对象。
    const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") {
      diagnosticWarn("ws-hub", "upgrade_rejected_path", { url: req.url || "" });
      return socket.destroy();
    }
    if (!isAuthed(req, url)) {
      logAuthRejected(url.pathname);
      return socket.destroy();
    }
    if (clients.size >= Math.max(1, Number(maxClients) || 1)) {
      diagnosticWarn("ws-hub", "upgrade_rejected_client_limit", {
        clientCount: clients.size,
        remoteAddress: req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "",
      });
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.__codexRemoteAddress = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
      clients.add(ws);
      if (DEBUG_LOGS) {
        // WS 握手/关闭属于页面生命周期噪声，默认不写入常规日志；认证失败和异常仍会保留。
        diagnosticLog("ws-hub", "connected", {
          clientCount: clients.size,
          remoteAddress: socketRemoteAddress(ws),
        });
      }
      ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw));
          const clientId = message && typeof message.clientId === "string" ? message.clientId : "";
          // hello 是浏览器接入 IPC 的握手消息，拿到 clientId 后才能定向投递事件。
          if (message && message.type === "hello" && clientId) {
            const previousClientId = ws.__codexWebClientId;
            if (previousClientId && previousClientId !== clientId && clientsById.get(previousClientId) === ws) {
              clientsById.delete(previousClientId);
              for (const listener of clientRemovedListeners) {
                try {
                  listener({ clientId: previousClientId, socket: ws });
                } catch (error) {
                  diagnosticWarn("ws-hub", "client_removed_listener_failed", {
                    clientId: shortId(previousClientId),
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }
            }
            // 后来重复 hello 时切到最新连接，并让旧 socket 进入 CLOSING，避免重连窗口内重复接收大广播。
            const replacedSocket = clientsById.get(clientId);
            ws.__codexWebClientId = clientId;
            clientsById.set(clientId, ws);
            if (replacedSocket && replacedSocket !== ws) {
              try {
                replacedSocket.close(1000, "replaced");
              } catch {}
            }
            if (DEBUG_LOGS) {
              diagnosticLog("ws-hub", "hello", {
                clientId: shortId(clientId),
                clientCount: clients.size,
                mappedClientCount: clientsById.size,
                remoteAddress: socketRemoteAddress(ws),
              });
            }
            try {
              // ack 明确告诉浏览器：clientId 已经进入路由表，可以开始发会产生异步回包的官方 IPC。
              ws.send(JSON.stringify({ type: "hello-ack", clientId }));
              if (DEBUG_LOGS) diagnosticLog("ws-hub", "hello_ack", { clientId: shortId(clientId) });
            } catch (error) {
              diagnosticWarn("ws-hub", "hello_ack_failed", {
                clientId: shortId(clientId),
                error: error instanceof Error ? error.message : String(error),
              });
            }
            for (const listener of clientReadyListeners) {
              try {
                listener({ clientId, socket: ws });
              } catch (error) {
                diagnosticWarn("ws-hub", "client_ready_listener_failed", {
                  clientId: shortId(clientId),
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
            return;
          }
          if (handleWsControlMessage(ws, req, message)) return;
        } catch (error) {
          diagnosticWarn("ws-hub", "message_parse_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
      ws.on("close", () => {
        // close/error 都要从两个索引里删除，避免后续 sendTo 命中过期 socket。
        const closedClientId = ws.__codexWebClientId || "";
        removeClient(ws);
        if (DEBUG_LOGS) {
          diagnosticLog("ws-hub", "closed", {
            clientId: shortId(closedClientId),
            clientCount: clients.size,
            mappedClientCount: clientsById.size,
          });
        }
      });
      ws.on("error", (error) => {
        // error 事件不一定随后触发 close，这里主动做一次相同清理。
        const erroredClientId = ws.__codexWebClientId || "";
        removeClient(ws);
        diagnosticWarn("ws-hub", "error", {
          clientId: shortId(erroredClientId),
          clientCount: clients.size,
          error: error instanceof Error ? error.message : String(error),
          mappedClientCount: clientsById.size,
        });
      });
      wss.emit("connection", ws, req);
    });
  });

  return { broadcast, clients, sendTo, hasClient, onClientReady, onClientRemoved };
}

module.exports = {
  createWsHub,
  __test: { routeIdFromPayload },
};
