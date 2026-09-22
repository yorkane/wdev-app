/**
 * 浏览器内核错误捕获与能力兜底 Provider。
 *
 * 移动端第三方浏览器（例如 Kiki）内核版本低于官方 bundle 的最低要求时，
 * 会出现「部分 Markdown 内容渲染失败」这类内核 API 缺失导致的静默错误。
 * 本 Provider 做两件事，都通过共享宿主能力实现，不引入新的全局事件所有权：
 *
 * 1. 全局 JS 错误捕获（默认开启，长期保留的可用性埋点）：
 *    window 的 error / unhandledrejection 经 adapterHost.events.observe 接管，
 *    内容（message、source、line、col、UA、platform、deviceMemory /
 *    hardwareConcurrency、脱敏 href）批量限流后走 /api/client-log 上报，
 *    事件名 js-error / js-unhandled-rejection。服务端对 js-* 事件默认落盘，
 *    不依赖 CODEX_WEB_DEBUG。message/source 命中 markdown|remark|micromark|
 *    mdast|shiki|katex 时附 tag:"markdown" 便于过滤。
 *    这里不复用 bridge 的 clientDiagnostic：它受 CLIENT_DIAGNOSTICS_ENABLED
 *    门控，而我们要求错误上报默认开启；/api/client-log 端点本就为浏览器
 *    批量诊断开放。
 *
 * 2. 内核能力探测 + 最小 polyfill：启动后延迟探测关键 API 缺失清单并上报
 *    （js-capability，每页面一次）；对可安全补齐的 API 打极简 polyfill，
 *    只补缺失项、不覆盖已有实现（幂等），可配置整体关闭。
 *
 * 老内核兼容是本文件的硬约束：不出现可选链（?.）、空值合并（??）、
 * 模板字符串等 ES2019+ 语法，不引用 ES2019 之后的运行时 API；
 * 聚合运行时构建时 esbuild 会统一再降级一层，这里是双保险。
 */
(function () {
  "use strict";
  var w = window;
  var modificationScope = w.__OpenCodexCurrentProviderScope;
  var modificationEffects = modificationScope && modificationScope.effects;
  var providerGeneration = modificationScope && modificationScope.generation;
  if (providerGeneration === undefined || providerGeneration === null) providerGeneration = document;
  if (w.__opencodexJsErrorCaptureInstalled === providerGeneration) return;

  var config = w.__CODEX_WEB_CONFIG__ || {};
  // 错误上报默认开启；显式配置可整体关闭。
  if (config.disableJsErrorCapture === true) return;

  var adapterHost = w.__OpenCodexAdapterHost;
  if (!adapterHost || !adapterHost.events || typeof adapterHost.events.observe !== "function") return;
  var scheduler = adapterHost.scheduler && typeof adapterHost.scheduler.capture === "function"
    ? adapterHost.scheduler.capture()
    : w;
  if (!scheduler || typeof scheduler.setTimeout !== "function") return;
  w.__opencodexJsErrorCaptureInstalled = providerGeneration;

  // ---------------------------------------------------------------- 错误捕获
  // 监听在 Provider 工厂运行时就挂上（聚合 bootstrap 是 defer 脚本，早于官方
  // bundle 的动态 import 解析），保证官方 chunk 在老内核上的解析失败不丢。
  var MARKDOWN_HINT_RE = /markdown|remark|micromark|mdast|shiki|katex/i;
  var SIGNATURE_REPEAT_MS = 30 * 1000; // 同签名错误 30 秒内只报一次
  var CLIENT_REPEAT_MS = 10 * 1000; // 同页面任意 JS 错误 10 秒内最多一条
  var SIGNATURE_STATE_MAX = 512;
  var PENDING_MAX = 64;
  var FLUSH_DELAY_MS = 150;
  var CAPABILITY_DELAY_MS = 800; // 等官方 bundle 完成一轮解析后再探测

  var clientId = "";
  try {
    var stored = w.sessionStorage && w.sessionStorage.getItem("opencodex-js-error-client-id");
    if (stored && typeof stored === "string" && stored.length <= 64) clientId = stored;
  } catch (ignored) {}
  if (!clientId) {
    var generated = "";
    try {
      if (w.crypto && typeof w.crypto.randomUUID === "function") generated = w.crypto.randomUUID();
    } catch (ignored) {}
    if (!generated) generated = "web-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
    clientId = generated;
    try {
      w.sessionStorage.setItem("opencodex-js-error-client-id", clientId);
    } catch (ignored) {}
  }

  var lastEmitSignatureAt = new Map();
  var lastEmitClientAt = 0;
  var pendingEvents = [];
  var flushTimer = 0;
  var capabilityReported = false;
  var loadEventKey = {};
  var disposeLoadEvent = function () {};

  function shortString(value, limit) {
    var text = String(value == null ? "" : value);
    return text.length > limit ? text.slice(0, limit) + "..." : text;
  }

  function reasonToText(reason) {
    if (reason == null) return "";
    if (typeof reason === "string") return reason;
    if (reason instanceof Error) return (reason.name ? reason.name + ": " : "") + reason.message;
    try {
      return JSON.stringify(reason);
    } catch (ignored) {
      return String(reason);
    }
  }

  function redactHref() {
    try {
      var parsed = new URL(w.location.href);
      var sensitive = ["token", "auth", "authorization", "code", "access_token", "refresh_token"];
      for (var i = 0; i < sensitive.length; i += 1) {
        if (parsed.searchParams.has(sensitive[i])) parsed.searchParams.set(sensitive[i], "[redacted]");
      }
      return shortString(parsed.pathname + parsed.search, 260);
    } catch (ignored) {
      return "";
    }
  }

  function deviceFingerprint() {
    var nav = w.navigator || {};
    return {
      ua: shortString(nav.userAgent || "", 320),
      platform: shortString(nav.platform || "", 80),
      deviceMemory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : undefined,
      hardwareConcurrency: typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : undefined,
    };
  }

  function detectEngine() {
    var ua = String((w.navigator && w.navigator.userAgent) || "");
    if (/Edg\//.test(ua)) return "edge";
    if (/Chrome\//.test(ua)) return "chrome";
    if (/Firefox\//.test(ua)) return "firefox";
    if (/Safari\//.test(ua)) return "safari";
    return "unknown";
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = scheduler.setTimeout(function () {
      flushTimer = 0;
      flushNow();
    }, FLUSH_DELAY_MS);
  }

  function flushNow() {
    if (pendingEvents.length === 0) return;
    var events = pendingEvents.splice(0, pendingEvents.length);
    try {
      w.fetch("/api/client-log", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: clientId, events: events }),
      }).catch(function () {});
    } catch (ignored) {}
  }

  function emit(event, data) {
    // 限流在序列化之前完成：同签名 30 秒、同页面 10 秒，双保险防止刷屏。
    var signatureKey = event + "|" + shortString(data.message || data.reason || "", 160) + "|" +
      shortString(data.source || "", 120) + "|" + (data.line || 0);
    var now = Date.now();
    var lastSignatureAt = lastEmitSignatureAt.get(signatureKey) || 0;
    if (now - lastSignatureAt < SIGNATURE_REPEAT_MS) return false;
    if (event === "js-error" || event === "js-unhandled-rejection") {
      // 能力探测事件不占错误限流预算，但自身每页面只报一次（签名含 missing 清单）。
      if (now - lastEmitClientAt < CLIENT_REPEAT_MS) return false;
      lastEmitClientAt = now;
    }
    if (lastEmitSignatureAt.size >= SIGNATURE_STATE_MAX) {
      var oldestKey = lastEmitSignatureAt.keys().next().value;
      if (oldestKey !== undefined) lastEmitSignatureAt.delete(oldestKey);
    }
    lastEmitSignatureAt.set(signatureKey, now);
    try {
      if (modificationEffects && modificationEffects.primary && typeof modificationEffects.primary.emit === "function") {
        modificationEffects.primary.emit(1);
      }
    } catch (ignored) {}
    var entry = {};
    var fingerprint = deviceFingerprint();
    for (var key in fingerprint) {
      if (Object.prototype.hasOwnProperty.call(fingerprint, key) && fingerprint[key] !== undefined) entry[key] = fingerprint[key];
    }
    for (var dataKey in data) {
      if (Object.prototype.hasOwnProperty.call(data, dataKey) && data[dataKey] !== undefined) entry[dataKey] = data[dataKey];
    }
    entry.clientId = clientId;
    entry.href = redactHref();
    if ((event === "js-error" || event === "js-unhandled-rejection") &&
        (MARKDOWN_HINT_RE.test(String(entry.message || "")) || MARKDOWN_HINT_RE.test(String(entry.source || "")))) {
      entry.tag = "markdown";
    }
    if (pendingEvents.length >= PENDING_MAX) return true;
    pendingEvents.push({ event: event, data: entry });
    scheduleFlush();
    return true;
  }

  function onWindowError(event) {
    var message = shortString(event && event.message ? event.message : "uncaught error", 320);
    var source = shortString(event && event.filename ? event.filename : "", 240);
    var line = event && typeof event.lineno === "number" ? event.lineno : 0;
    var col = event && typeof event.colno === "number" ? event.colno : 0;
    var stack = event && event.error && typeof event.error.stack === "string"
      ? shortString(event.error.stack, 512)
      : undefined;
    // 脚本加载失败（error 事件带 target 且无 message）：官方 chunk 在老内核上
    // 解析失败时会走这个形态，source 里带着 chunk 文件名，正是我们要的证据。
    emit("js-error", {
      kind: event && event.message ? "error" : "script-load",
      message: message,
      source: source,
      line: line,
      col: col,
      stack: stack,
    });
  }

  function onUnhandledRejection(event) {
    var reason = event && event.reason;
    var text = shortString(reasonToText(reason), 320);
    var source = reason instanceof Error && typeof reason.stack === "string"
      ? shortString(reason.stack, 512)
      : undefined;
    emit("js-unhandled-rejection", {
      kind: "unhandled-rejection",
      reason: text || "unhandled rejection",
      reasonName: reason instanceof Error ? shortString(reason.name, 80) : undefined,
      source: source,
    });
  }

  var errorEventKey = {};
  var rejectionEventKey = {};
  var disposeErrorEvent = function () {};
  var disposeRejectionEvent = function () {};
  try {
    disposeErrorEvent = adapterHost.events.observe({
      key: errorEventKey,
      target: w,
      type: "error",
      capture: true,
      passive: true,
      callback: onWindowError,
    });
    disposeRejectionEvent = adapterHost.events.observe({
      key: rejectionEventKey,
      target: w,
      type: "unhandledrejection",
      capture: true,
      passive: true,
      callback: onUnhandledRejection,
    });
  } catch (ignored) {
    return;
  }

  // 能力探测与 polyfill 放到 load 之后：此时官方 bundle 已完成一轮解析，
  // polyfill 补齐的是后续懒加载 chunk 会用到的 API；load 前页面已就绪的
  // 极端情况用定时器兜住（某些内核 load 事件时机异常）。
  function scheduleProbe() {
    if (capabilityReported) return;
    if (w.document && w.document.readyState === "complete") {
      runCapabilityProbe();
      return;
    }
    var probed = false;
    var onLoaded = function () {
      if (probed) return;
      probed = true;
      runCapabilityProbe();
    };
    try {
      disposeLoadEvent = adapterHost.events.observe({
        key: loadEventKey,
        target: w,
        type: "load",
        capture: true,
        passive: true,
        once: true,
        callback: onLoaded,
      });
    } catch (ignored) {}
    var fallbackTimer = scheduler.setTimeout(function () {
      if (probed) return;
      probed = true;
      try { disposeLoadEvent(); } catch (ignored) {}
      onLoaded();
    }, CAPABILITY_DELAY_MS + 4000);
    probeFallbackTimers.push(fallbackTimer);
  }

  // ---------------------------------------------------------------- 能力兜底

  function installPolyfills() {
    if (config.disableCompatPolyfill === true) return [];
    var applied = [];

    function install(target, name, reportName, factory, guard) {
      try {
        if (!guard()) return;
        Object.defineProperty(target, name, {
          configurable: true,
          writable: true,
          value: factory(),
        });
        // applied 用探针全名，与 missing 一致，便于服务端按名对齐。
        applied.push(reportName);
      } catch (ignored) {
        // 补齐失败时保留内核原状（缺失即缺失），绝不影响官方逻辑。
      }
    }

    install(Array.prototype, "at", "Array.prototype.at", function () {
      return function (index) {
        var length = this.length;
        var relative = Number(index);
        if (relative < 0) relative += length;
        if (relative < 0 || relative >= length) return undefined;
        return this[relative];
      };
    }, function () { return typeof Array.prototype.at !== "function"; });

    install(String.prototype, "replaceAll", "String.prototype.replaceAll", function () {
      return function (searchValue, replaceValue) {
        if (typeof searchValue === "string") {
          if (searchValue === "") {
            // 原生语义：在每个 code point 边界插入替换值（"abc" -> "ZaZbZcZ"）。
            var emptyPieces = [];
            var emptyIndex = 0;
            for (var emptyChar of this) {
              emptyPieces.push(typeof replaceValue === "function"
                ? String(replaceValue("", emptyIndex, this))
                : String(replaceValue));
              emptyPieces.push(emptyChar);
              emptyIndex += emptyChar.length;
            }
            emptyPieces.push(typeof replaceValue === "function"
              ? String(replaceValue("", this.length, this))
              : String(replaceValue));
            return emptyPieces.join("");
          }
          return this.split(searchValue).join(String(replaceValue));
        }
        if (searchValue instanceof RegExp) {
          if (!searchValue.global) {
            throw new TypeError("String.prototype.replaceAll called with a non-global RegExp");
          }
          var lastIndex = 0;
          var pieces = [];
          var match;
          var pattern = new RegExp(searchValue.source, searchValue.flags);
          while ((match = pattern.exec(this)) !== null) {
            var groups = match.length > 1 ? match : null;
            var replacement = typeof replaceValue === "function"
              ? replaceValue(match[0], match.index, this, groups)
              : String(replaceValue);
            pieces.push(this.slice(lastIndex, match.index), replacement);
            lastIndex = match.index + match[0].length;
            if (match[0] === "") pattern.lastIndex += 1;
          }
          pieces.push(this.slice(lastIndex));
          return pieces.join("");
        }
        throw new TypeError("String.prototype.replaceAll requires a string or RegExp");
      };
    }, function () { return typeof String.prototype.replaceAll !== "function"; });

    install(Object, "hasOwn", "Object.hasOwn", function () {
      return function (object, property) {
        if (object == null) {
          throw new TypeError("Cannot convert undefined or null to object");
        }
        return Object.prototype.hasOwnProperty.call(object, property);
      };
    }, function () { return typeof Object.hasOwn !== "function"; });

    // 官方只把 structuredClone 用于纯 JSON 形态的响应快照（bridge polyfill
    // 的 fallback 同款写法），JSON 往返语义与原实现一致，足够安全。
    install(w, "structuredClone", "structuredClone", function () {
      return function (value) {
        if (value === null || typeof value !== "object") return value;
        return JSON.parse(JSON.stringify(value));
      };
    }, function () { return typeof w.structuredClone !== "function"; });

    install(w, "requestIdleCallback", "requestIdleCallback", function () {
      return function (callback) {
        return scheduler.setTimeout(function () {
          try {
            callback({ didTimeout: false, timeRemaining: function () { return 50; } });
          } catch (ignored) {}
        }, 1);
      };
    }, function () { return typeof w.requestIdleCallback !== "function"; });
    install(w, "cancelIdleCallback", "cancelIdleCallback", function () {
      return function (handle) {
        scheduler.clearTimeout(handle);
      };
    }, function () { return typeof w.cancelIdleCallback !== "function"; });

    install(w, "queueMicrotask", "queueMicrotask", function () {
      return function (callback) {
        // callback 抛错会让该 Promise rejected，浏览器原生 unhandledrejection
        // 事件接管，正好被本 Provider 的捕获逻辑收到，不重复造事件。
        Promise.resolve().then(callback);
      };
    }, function () { return typeof w.queueMicrotask !== "function"; });

    // 官方消息分段/diff 路径会用到 toSorted 与 findLast（app-initial chunk，
    // 无 fallback）：老内核缺失时直接抛 TypeError，表现为部分 Markdown 内容
    // 渲染失败。两者语义简单、可安全补齐。
    install(Array.prototype, "toSorted", "Array.prototype.toSorted", function () {
      return function (compareFn) {
        return Array.prototype.slice.call(this).sort(compareFn);
      };
    }, function () { return typeof Array.prototype.toSorted !== "function"; });
    install(Array.prototype, "findLast", "Array.prototype.findLast", function () {
      return function (predicate) {
        for (var index = this.length - 1; index >= 0; index -= 1) {
          if (predicate.call(this, this[index], index, this)) return this[index];
        }
        return undefined;
      };
    }, function () { return typeof Array.prototype.findLast !== "function"; });
    install(Array.prototype, "findLastIndex", "Array.prototype.findLastIndex", function () {
      return function (predicate) {
        for (var index = this.length - 1; index >= 0; index -= 1) {
          if (predicate.call(this, this[index], index, this)) return index;
        }
        return -1;
      };
    }, function () { return typeof Array.prototype.findLastIndex !== "function"; });

    // 官方图片 URL 校验（app-primary:1004 / app-initial:8066）用 URL.parse（Chromium 123+），
    // 老内核缺失时图片消息渲染抛错。URL.parse 只是 new URL 的宽松别名，补齐安全。
    if (typeof w.URL === "function" && typeof w.URL.parse !== "function") {
      try {
        Object.defineProperty(w.URL, "parse", {
          configurable: true,
          writable: true,
          value: function (input, base) {
            try {
              return new w.URL(input, base);
            } catch (ignored) {
              return null;
            }
          },
        });
        applied.push("URL.parse");
      } catch (ignored) {}
    }

    if (typeof w.AbortSignal === "function" && typeof w.AbortSignal.timeout !== "function") {
      try {
        Object.defineProperty(w.AbortSignal, "timeout", {
          configurable: true,
          writable: true,
          value: function (milliseconds) {
            var signal = new w.AbortController().signal;
            var delay = Number(milliseconds);
            scheduler.setTimeout(function () {
              signal.dispatchEvent(new w.Event("abort"));
            }, delay > 0 ? delay : 0);
            return signal;
          },
        });
        applied.push("AbortSignal.timeout");
      } catch (ignored) {}
    }

    return applied;
  }

  var CAPABILITY_PROBES = [
    { name: "Intl.Segmenter", missing: function () { return !w.Intl || typeof w.Intl.Segmenter !== "function"; } },
    { name: "structuredClone", missing: function () { return typeof w.structuredClone !== "function"; } },
    { name: "requestIdleCallback", missing: function () { return typeof w.requestIdleCallback !== "function"; } },
    { name: "AbortSignal.timeout", missing: function () { return typeof w.AbortSignal !== "function" || typeof w.AbortSignal.timeout !== "function"; } },
    { name: "URL.parse", missing: function () { return typeof w.URL !== "function" || typeof w.URL.parse !== "function"; } },
    { name: "Array.prototype.at", missing: function () { return typeof Array.prototype.at !== "function"; } },
    { name: "Array.prototype.toSorted", missing: function () { return typeof Array.prototype.toSorted !== "function"; } },
    { name: "Array.prototype.findLast", missing: function () { return typeof Array.prototype.findLast !== "function"; } },
    { name: "Object.hasOwn", missing: function () { return typeof Object.hasOwn !== "function"; } },
    { name: "Object.groupBy", missing: function () { return typeof Object.groupBy !== "function"; } },
    { name: "String.prototype.replaceAll", missing: function () { return typeof String.prototype.replaceAll !== "function"; } },
    { name: "Promise.withResolvers", missing: function () { return typeof Promise.withResolvers !== "function"; } },
    { name: "queueMicrotask", missing: function () { return typeof w.queueMicrotask !== "function"; } },
    { name: "ResizeObserver", missing: function () { return typeof w.ResizeObserver !== "function"; } },
  ];

  function runCapabilityProbe() {
    if (capabilityReported) return;
    capabilityReported = true;
    var missing = [];
    // 先探测再补齐：missing 报告内核真实缺失（诊断依据），applied 报告补了哪些。
    // 单个探针抛错只标记该探针，不影响其它探针（老内核上探测表达式本身可能抛错）。
    for (var i = 0; i < CAPABILITY_PROBES.length; i += 1) {
      try {
        if (CAPABILITY_PROBES[i].missing()) missing.push(CAPABILITY_PROBES[i].name);
      } catch (ignored) {
        missing.push(CAPABILITY_PROBES[i].name + ":[probe-throw]");
      }
    }
    var applied = [];
    try {
      applied = installPolyfills();
    } catch (ignored) {}
    emit("js-capability", {
      kind: "capability",
      missing: missing,
      applied: applied,
      engine: detectEngine(),
    });
  }

  // 探测在 load 之后触发；声明全部就位后再调度，避免读到未初始化的常量。
  var probeFallbackTimers = [];
  scheduleProbe();

  modificationScope && modificationScope.own && modificationScope.own(function () {
    for (var i = 0; i < probeFallbackTimers.length; i += 1) {
      scheduler.clearTimeout(probeFallbackTimers[i]);
    }
    try { disposeLoadEvent(); } catch (ignored) {}
    if (flushTimer) scheduler.clearTimeout(flushTimer);
    try { disposeErrorEvent(); } catch (ignored) {}
    try { disposeRejectionEvent(); } catch (ignored) {}
    if (pendingEvents.length > 0) flushNow();
    if (w.__opencodexJsErrorCaptureInstalled === providerGeneration) {
      w.__opencodexJsErrorCaptureInstalled = undefined;
    }
  });
})();
