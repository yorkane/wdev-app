(() => {
  const w = window;
  const existing = w.OpenCodexRuntimeCompatibility;
  if (existing?.apiVersion === 2 && typeof existing.ingestSnapshot === "function") return;

  const ENDPOINT = "/api/opencodex/runtime-compatibility/reports";
  const MAX_REPORTS_PER_FLUSH = 16;
  // 反馈环自保护参数：失败退避 1s→2s→4s…封顶 60s；全量重放按滑动窗口预算限流；
  // 同端点 1 分钟内超过 30 次请求即进入 5 分钟静默冷却。
  const FLUSH_DEBOUNCE_MS = 80;
  const RETRY_MIN_MS = 1_000;
  const RETRY_MAX_MS = 60_000;
  const MAX_RESTORED_REPORTS = 20;
  const REQUEST_WINDOW_MS = 60_000;
  const REQUEST_BUDGET = 30;
  const COOLDOWN_MS = 300_000;
  const MAX_REPLAYS_PER_WINDOW = 3;
  // 连续失败达到该次数后不再沿退避阶梯重试，直接静默冷却，避免长期低速反复打端点。
  const MAX_CONSECUTIVE_FAILURES = 8;
  const PENDING_STORAGE_KEY = "opencodex.runtime-compatibility.pending.v2";
  const clientId =
    w.crypto?.randomUUID?.() || `browser_page_${Math.random().toString(36).slice(2, 18)}`;
  const queue = new Map();
  const catalogQueue = new Map();
  const latestReports = new Map();
  const latestCatalogs = new Map();
  const sentSignatures = new Map();
  const sentCatalogSignatures = new Map();
  const recentRequestTimes = [];
  const recentReplayTimes = [];
  let flushTimer = null;
  let flushing = false;
  let retryDelayMs = RETRY_MIN_MS;
  let consecutiveFailures = 0;
  let cooldownUntil = 0;
  let cooldownTimer = null;
  let cooldownWarned = false;
  let generation = 1;
  let sequence = 0;
  let observedDocument = null;
  let serverReportEpoch = "";
  let replayedReportEpoch = "";

  function handleVisibilityChange() {
    if (document.visibilityState === "visible" && queue.size > 0) scheduleFlush();
  }

  function nowMs() {
    return Date.now();
  }

  function pruneWindow(times, windowMs) {
    const now = nowMs();
    while (times.length > 0 && now - times[0] >= windowMs) times.shift();
    return times;
  }

  function inCooldown() {
    return nowMs() < cooldownUntil;
  }

  function enterCooldown() {
    cooldownUntil = nowMs() + COOLDOWN_MS;
    if (!cooldownWarned) {
      cooldownWarned = true;
      w.console?.warn?.("[codex-runtime-compatibility] 1 分钟内对上报端点的请求超过 " + REQUEST_BUDGET + " 次，进入 5 分钟静默冷却；待发送队列已保留，冷却结束后自动续跑。");
    }
    if (cooldownTimer) clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      if (queue.size > 0) scheduleFlush();
    }, COOLDOWN_MS);
  }

  // 一次性自保护：真正发起 fetch 前计数，超出预算就把调度器整体压入冷却。
  function acquireRequestSlot() {
    if (inCooldown()) return false;
    pruneWindow(recentRequestTimes, REQUEST_WINDOW_MS);
    if (recentRequestTimes.length >= REQUEST_BUDGET) {
      enterCooldown();
      return false;
    }
    recentRequestTimes.push(nowMs());
    return true;
  }

  // 全量重放预算：同一滑动窗口内最多 MAX_REPLAYS_PER_WINDOW 次，阻断 epoch 抖动引发的重放风暴。
  function acquireReplaySlot() {
    pruneWindow(recentReplayTimes, REQUEST_WINDOW_MS);
    if (recentReplayTimes.length >= MAX_REPLAYS_PER_WINDOW) {
      w.console?.warn?.("[codex-runtime-compatibility] 跳过本次全量重放：1 分钟内重放次数已达上限。");
      return false;
    }
    recentReplayTimes.push(nowMs());
    return true;
  }

  // latestReports / latestCatalogs 是重放与恢复的唯一数据源，按“最近写入”封顶 N 条：
  // 先删再插让 Map 保持写入时间序，避免每次重放都携带全量历史。
  function rememberLatest(store, key, entry) {
    store.delete(key);
    store.set(key, entry);
    while (store.size > MAX_RESTORED_REPORTS) {
      const oldestKey = store.keys().next().value;
      store.delete(oldestKey);
    }
  }

  // 失败报告跨刷新恢复：sessionStorage 只保留最近 MAX_RESTORED_REPORTS 条，
  // 每次 flush 收尾同步一次，队列排空立即清除标记，避免每次加载重放全量历史。
  function pendingStorage() {
    try {
      const storage = w.sessionStorage;
      if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") return null;
      return storage;
    } catch {
      // 隐私模式/配额受限拿不到 sessionStorage：上报退化为纯内存队列。
      return null;
    }
  }

  function syncPendingStorage() {
    const storage = pendingStorage();
    if (!storage) return;
    try {
      if (queue.size === 0) {
        if (typeof storage.removeItem === "function") storage.removeItem(PENDING_STORAGE_KEY);
        return;
      }
      const items = Array.from(queue.values())
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, MAX_RESTORED_REPORTS)
        .map((report) => ({
          point: report.point,
          signature: report.signature,
          pluginId: report.pluginId || "",
        }));
      storage.setItem(PENDING_STORAGE_KEY, JSON.stringify({ clientId, items }));
    } catch {
      // 落盘是旁路能力，配额或序列化失败都不能影响上报本身。
    }
  }

  function restorePendingReports() {
    const storage = pendingStorage();
    if (!storage) return;
    let raw = null;
    try {
      raw = storage.getItem(PENDING_STORAGE_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    // 读取后立即清除存储标记：恢复只发生一次，不会在后续每次调度重复重放。
    try {
      if (typeof storage.removeItem === "function") storage.removeItem(PENDING_STORAGE_KEY);
    } catch {
      // 清除失败时至多下一次加载再恢复一次，仍受条数上限与去重约束。
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    let restored = 0;
    for (const item of items.slice(0, MAX_RESTORED_REPORTS)) {
      const point = normalizedPoint(item?.point);
      if (!point.id || point.contributions.length === 0) continue;
      const pointSignature = signature(point);
      if (queue.get(point.id)?.signature === pointSignature) continue;
      if (sentSignatures.get(point.id) === pointSignature) continue;
      const pluginId = String(item?.pluginId || "");
      rememberLatest(latestReports, point.id, { generation, point, signature: pointSignature, pluginId });
      queue.set(point.id, { generation, point, sequence: ++sequence, signature: pointSignature, pluginId });
      restored += 1;
    }
    if (restored > 0) scheduleFlush();
  }

  function bindCurrentDocument() {
    if (observedDocument === document) return;
    observedDocument?.removeEventListener?.("visibilitychange", handleVisibilityChange);
    observedDocument = document;
    observedDocument.addEventListener("visibilitychange", handleVisibilityChange);
  }

  function safeReason(value) {
    return String(value instanceof Error ? value.message : value || "")
      .replace(/\b[A-Za-z]:\\[^\s]+/g, "[path]")
      .replace(/\/(?:Users|home|private|Volumes|var|tmp)\/[^\s]+/g, "[path]")
      .replace(/([?&](?:token|auth|authorization|code|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]")
      .replace(/\b(Bearer)\s+[a-zA-Z0-9._~+/-]+=*/gi, "$1 [redacted]")
      .replace(
        /\b(token|auth|authorization|access_token|refresh_token)\s*[:=]\s*(?:Bearer\s+)?(?:\[redacted\]|[^\s,;]+)/gi,
        "$1=[redacted]"
      )
      .slice(0, 240);
  }

  function normalizedContribution(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      id: String(source.id || ""),
      directAdapterId: String(source.directAdapterId || ""),
      adapterId: String(source.adapterId || ""),
      adapterChainIds: Array.isArray(source.adapterChainIds)
        ? source.adapterChainIds.map((item) => String(item || ""))
        : [],
      location: String(source.location || "unresolved"),
      application: String(source.application || "pending"),
      verification: String(source.verification || "pending"),
      activation: String(source.activation || "inactive"),
      exercise: String(source.exercise || "not-exercised"),
      hitCount: Math.max(0, Math.trunc(Number(source.hitCount) || 0)),
      fallbackActive: source.fallbackActive === true,
      fallbackReason: safeReason(source.fallbackReason),
      reason: safeReason(source.reason),
    };
  }

  function normalizedPoint(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      id: String(source.id || ""),
      description: safeReason(source.description),
      owner: String(source.owner || ""),
      plugin: source.plugin && typeof source.plugin === "object"
        ? { id: String(source.plugin.id || ""), name: safeReason(source.plugin.name) }
        : null,
      groupId: String(source.groupId || ""),
      status: String(source.status || "pending"),
      directAdapterIds: Array.isArray(source.directAdapterIds)
        ? source.directAdapterIds.map((item) => String(item || ""))
        : [],
      adapterChainIds: Array.isArray(source.adapterChainIds)
        ? source.adapterChainIds.map((item) => String(item || ""))
        : [],
      contributions: Array.isArray(source.contributions)
        ? source.contributions.map(normalizedContribution)
        : [],
    };
  }

  function disabledPoint(point, reason) {
    return {
      ...point,
      status: "disabled",
      contributions: point.contributions.map((contribution) => ({
        ...contribution,
        application: "disabled",
        verification: "not-required",
        activation: "inactive",
        exercise: "disabled",
        hitCount: 0,
        fallbackActive: false,
        fallbackReason: "",
        reason: safeReason(reason || "Plugin disabled"),
      })),
    };
  }

  function normalizedPluginCatalog(snapshot, plugin) {
    const normalizedPlugin = {
      id: String(plugin?.id || ""),
      name: safeReason(plugin?.name),
    };
    if (!normalizedPlugin.id || !normalizedPlugin.name) return null;
    const points = (Array.isArray(snapshot?.points) ? snapshot.points : [])
      .map(normalizedPoint)
      .filter((point) => point.plugin?.id === normalizedPlugin.id && point.plugin?.name === normalizedPlugin.name);
    if (points.length === 0) return null;
    const groupIds = new Set(points.map((point) => point.groupId));
    const adapterIds = new Set(points.flatMap((point) => point.adapterChainIds));
    return {
      plugin: normalizedPlugin,
      groups: (Array.isArray(snapshot?.groups) ? snapshot.groups : [])
        .filter((group) => groupIds.has(String(group?.id || "")))
        .map((group) => ({
          id: String(group.id || ""),
          name: safeReason(group.name),
          description: safeReason(group.description),
          order: Number(group.order),
        })),
      adapterTypes: (Array.isArray(snapshot?.adapterTypes) ? snapshot.adapterTypes : [])
        .filter((adapter) => adapterIds.has(String(adapter?.id || "")))
        .map((adapter) => ({
          id: String(adapter.id || ""),
          name: safeReason(adapter.name),
          description: safeReason(adapter.description),
          kind: String(adapter.kind || ""),
          dependencies: Array.isArray(adapter.dependencies) ? adapter.dependencies.map(String) : [],
        })),
      points: points.map((point) => ({
        id: point.id,
        description: point.description,
        owner: point.owner,
        plugin: point.plugin,
        groupId: point.groupId,
        directAdapterIds: point.directAdapterIds,
        adapterChainIds: point.adapterChainIds,
      })),
    };
  }

  function signature(point) {
    return JSON.stringify(point);
  }

  function scheduleFlush(delayMs = FLUSH_DEBOUNCE_MS) {
    if (flushTimer || flushing) return;
    // 页面隐藏一律不调度：隐藏期间入队的报告由 visibilitychange 恢复续跑。
    if (document.visibilityState !== "visible") return;
    // 冷却期只拒绝新的 80ms 调度；delayMs===0 是 flush 自己的排空续跑，放行后仍会
    // 被 flush 入口的请求预算闸门拒绝并转入冷却，避免冷却定时器被调度空挡吞掉。
    if (delayMs !== 0 && inCooldown()) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (document.visibilityState !== "visible") return;
      void flush();
    }, delayMs);
  }

  function restoreFailedReport(report) {
    if (report.generation !== generation) return;
    const queued = queue.get(report.point.id);
    if (queued && queued.sequence > report.sequence) return;
    queue.set(report.point.id, report);
  }

  function replayLatestReports() {
    // 服务端重置后旧去重签名已经无效；用新序号重放本页掌握的完整最新状态。
    queue.clear();
    catalogQueue.clear();
    sentSignatures.clear();
    sentCatalogSignatures.clear();
    for (const entry of latestCatalogs.values()) {
      if (entry.generation === generation) catalogQueue.set(entry.catalog.plugin.id, entry);
    }
    for (const entry of latestReports.values()) {
      if (entry.generation !== generation) continue;
      queue.set(entry.point.id, {
        ...entry,
        sequence: ++sequence,
      });
    }
    scheduleFlush(0);
  }

  async function flush() {
    if (flushing || queue.size === 0) return;
    // 自保护闸门：冷却期内（包括外部直接调用 flush）一律不发请求，队列原样保留。
    if (!acquireRequestSlot()) return;
    flushing = true;
    let failed = false;
    const orderedReports = Array.from(queue.values()).sort((left, right) => left.sequence - right.sequence);
    const batchPluginId = orderedReports[0]?.pluginId || "";
    const reports = [];
    // 服务端按全局 sequence 接收回执；这里只取同来源的连续前缀，不能跨过其它来源后再发送更大的序号。
    for (const report of orderedReports) {
      if ((report.pluginId || "") !== batchPluginId || reports.length >= MAX_REPORTS_PER_FLUSH) break;
      reports.push(report);
    }
    const pluginIds = new Set(reports.map((report) => report.pluginId).filter(Boolean));
    const catalogs = [...pluginIds].map((pluginId) => catalogQueue.get(pluginId)).filter(Boolean);
    for (const report of reports) queue.delete(report.point.id);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId,
          generation,
          reportEpoch: serverReportEpoch,
          catalogs: catalogs.map((entry) => entry.catalog),
          reports,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let responsePayload = null;
      try {
        if (typeof response.json === "function") responsePayload = await response.json();
      } catch {
        // 兼容尚未返回代际字段的旧 Gateway；成功响应仍按原有确认逻辑处理。
      }
      const responseEpoch = typeof responsePayload?.reportEpoch === "string"
        ? responsePayload.reportEpoch
        : "";
      const responseMatchesGeneration = reports[0]?.generation === generation;
      const shouldReplay = responseMatchesGeneration && !!responseEpoch && (
        responsePayload?.resync === true || responseEpoch !== serverReportEpoch
      ) && responseEpoch !== replayedReportEpoch;
      if (responseMatchesGeneration && responseEpoch) serverReportEpoch = responseEpoch;
      for (const report of reports) {
        if (report.generation === generation) sentSignatures.set(report.point.id, report.signature);
      }
      // 请求飞行期间同一份内容可能被高频 ingest 重新入队；确认回执后直接丢弃这些等价条目，
      // 保证同一 report 不会被重复发送（内容变化的条目签名不同，仍会照常补发）。
      for (const report of reports) {
        const queued = queue.get(report.point.id);
        if (queued && queued.generation === generation && queued.signature === report.signature) {
          queue.delete(report.point.id);
        }
      }
      for (const entry of catalogs) {
        if (entry.generation !== generation) continue;
        sentCatalogSignatures.set(entry.catalog.plugin.id, entry.signature);
        if (catalogQueue.get(entry.catalog.plugin.id) === entry) catalogQueue.delete(entry.catalog.plugin.id);
      }
      if (shouldReplay) {
        // 预算内的 resync 才允许全量重放；被拒绝时保留 serverReportEpoch 同步结果，
        // 由后续普通 ingest 路径增量补齐，不再连锁 0ms 全量重放。
        if (acquireReplaySlot()) {
          replayedReportEpoch = responseEpoch;
          replayLatestReports();
        }
      }
      retryDelayMs = RETRY_MIN_MS;
      consecutiveFailures = 0;
      cooldownWarned = false;
    } catch {
      failed = true;
      consecutiveFailures += 1;
      for (const report of reports) restoreFailedReport(report);
      // Gateway 重启后会丢失动态目录；任意失败都带上最新插件目录重试，以便自动恢复注册。
      for (const pluginId of pluginIds) {
        const entry = latestCatalogs.get(pluginId);
        if (entry) catalogQueue.set(pluginId, entry);
      }
    } finally {
      flushing = false;
      syncPendingStorage();
      if (queue.size > 0 && document.visibilityState === "visible") {
        if (failed) {
          // 连续失败到阈值直接进冷却，避免 1s→60s 退避阶梯长期停留在高位反复打端点。
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            enterCooldown();
          } else {
            scheduleFlush(retryDelayMs);
          }
          retryDelayMs = Math.min(RETRY_MAX_MS, retryDelayMs * 2);
        } else {
          // 首批保留去抖；开始排空后立即发送下一段连续序列，避免短生命周期页面留下大量待检测点。
          scheduleFlush(0);
        }
      }
    }
  }

  function ingestSnapshot(snapshot, options = {}) {
    const pluginCatalog = options?.plugin ? normalizedPluginCatalog(snapshot, options.plugin) : null;
    if (options?.plugin && !pluginCatalog) return;
    if (pluginCatalog) {
      const catalogSignature = signature(pluginCatalog);
      if (sentCatalogSignatures.get(pluginCatalog.plugin.id) !== catalogSignature) {
        const entry = {
          generation,
          catalog: pluginCatalog,
          signature: catalogSignature,
        };
        rememberLatest(latestCatalogs, pluginCatalog.plugin.id, entry);
        catalogQueue.set(pluginCatalog.plugin.id, entry);
      }
    }
    for (const value of Array.isArray(snapshot?.points) ? snapshot.points : []) {
      let point = normalizedPoint(value);
      const pluginId = pluginCatalog?.plugin.id || "";
      if (pluginId ? point.plugin?.id !== pluginId : !point.id.startsWith("web.runtime.")) continue;
      if (point.contributions.length === 0) continue;
      if (pluginId && options.disabled === true) point = disabledPoint(point, options.reason);
      const pointSignature = signature(point);
      rememberLatest(latestReports, point.id, {
        generation,
        point,
        signature: pointSignature,
        pluginId,
      });
      // 幂等去重：队列中已有同内容（同 signature）的条目时直接跳过，
      // 既不重复入队也不额外消耗序号，杜绝高频 ingest 把同一份 report 反复推上发送路径。
      if (queue.get(point.id)?.signature === pointSignature) continue;
      if (sentSignatures.get(point.id) === pointSignature && !queue.has(point.id)) continue;
      queue.set(point.id, {
        generation,
        point,
        sequence: ++sequence,
        signature: pointSignature,
        pluginId,
      });
    }
    scheduleFlush();
  }

  function beginGeneration() {
    bindCurrentDocument();
    generation += 1;
    sequence = 0;
    queue.clear();
    catalogQueue.clear();
    latestReports.clear();
    latestCatalogs.clear();
    sentSignatures.clear();
    sentCatalogSignatures.clear();
    serverReportEpoch = "";
    replayedReportEpoch = "";
    // 每代际重置退避与重放预算；请求预算与冷却必须跨代际保留，
    // 否则移动端高频 beginGeneration（软键盘、根节点替换、SPA 路由抖动）会把自保护清零并继续风暴。
    retryDelayMs = RETRY_MIN_MS;
    consecutiveFailures = 0;
    recentReplayTimes.length = 0;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  const api = Object.freeze({
    apiVersion: 2,
    clientId,
    beginGeneration,
    ingestSnapshot,
    flush,
  });
  Object.defineProperty(w, "OpenCodexRuntimeCompatibility", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: api,
  });
  // 仅供 node --test 断言内部状态；浏览器路径不读取该对象，对外全局行为保持不变。
  Object.defineProperty(w, "__OpenCodexRuntimeCompatibilityTestHooks", {
    configurable: true,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      latestReportCount: () => latestReports.size,
      latestCatalogCount: () => latestCatalogs.size,
      queuedCount: () => queue.size,
      retryDelay: () => retryDelayMs,
      consecutiveFailures: () => consecutiveFailures,
      cooldownRemaining: () => Math.max(0, cooldownUntil - nowMs()),
      scheduledRequestCount: () => recentRequestTimes.length,
    }),
  });
  bindCurrentDocument();
  restorePendingReports();
  w.addEventListener("online", () => queue.size > 0 && scheduleFlush());
})();
