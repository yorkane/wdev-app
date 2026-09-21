/**
 * 出站网络拦截 Provider。
 *
 * 站点网络策略（config.yaml 的 network.block / network.allow）由 gateway 注入到
 * window.__CODEX_WEB_CONFIG__.network。这里在浏览器端把该策略应用到三条出站通道：
 * window.fetch、XMLHttpRequest、navigator.sendBeacon。命中拦截时本地模拟一次 200
 * 可读响应，避免把请求真正发往被拦截的域名造成信息泄露；未命中一律透传原实现。
 *
 * 该 Provider 独立成文件，由骨架装配层按 provider key 自动注册，因此上游
 * codex-bridge-polyfill.js 可以保持零改动。
 *
 * 域名匹配逻辑（*.x.com 只匹配子域、命中 allow 放行、否则命中 block 拦截）
 * 在 gateway 侧 site-config.cjs 已有一份 CJS 实现，但浏览器端不能 require CJS 模块，
 * 也不该为这点引依赖，因此本文件内再实现一份，语义与 gateway 严格保持一致。
 */
(function () {
  const w = window;
  const modificationScope = w.__OpenCodexCurrentProviderScope;
  const modificationEffects = modificationScope?.effects;
  const providerGeneration = modificationScope?.generation || document;
  if (w.__opencodexNetworkGuardInstalled === providerGeneration) return;

  const config = w.__CODEX_WEB_CONFIG__ || {};
  const network = config.network;
  // 未配置任何域名策略（network 缺失或 configured 为 false）时完全不安装，避免无谓开销。
  if (!network || network.configured !== true) return;
  const blockedHosts = Array.isArray(network.blockedHosts) ? network.blockedHosts : [];
  const allowedHosts = Array.isArray(network.allowedHosts) ? network.allowedHosts : [];
  // 没有 block 清单时没有任何可拦截目标，同样不安装。
  if (!blockedHosts.length) return;

  const adapterHost = w.__OpenCodexAdapterHost;
  // 模拟 XHR 响应要等 SDK 在 send 返回后挂好监听器再派发，不能同步触发；
  // 宿主没给 scheduler 时退回 window 计时器。
  const scheduler = adapterHost?.scheduler?.capture?.() || w;
  if (!scheduler || typeof scheduler.setTimeout !== "function") return;
  w.__opencodexNetworkGuardInstalled = providerGeneration;

  const MOCK_RESPONSE_BODY = "{}";

  // Statsig initialize 端点（ab.chatgpt.com/v1/initialize）的匹配：与 codex-bridge-polyfill.js
  // 里的 isStatsigInitializeUrl 保持同语义（浏览器端不能 require 别的 provider，只能各带一份）。
  function isStatsigInitializeUrl(raw) {
    try {
      const parsed = new URL(String(raw || ""), location.href);
      return (
        parsed.hostname === "ab.chatgpt.com" &&
        parsed.pathname.replace(/\/+$/, "") === "/v1/initialize"
      );
    } catch {
      return false;
    }
  }

  // Statsig 评估端点（ab.chatgpt.com/v1/*）的匹配：SDK 除 /v1/initialize 外还会请求
  // /v1/download_config_specs、/v1/eval、/v1/deltas、live overlay 变体，这些响应同样
  // 要过 _typedJsonParse 的类型校验，必须给出含 has_updates 的合法 JSON，不能回 "{}"。
  function isStatsigEvaluationUrl(raw) {
    try {
      const parsed = new URL(String(raw || ""), location.href);
      return (
        parsed.hostname === "ab.chatgpt.com" &&
        parsed.pathname.replace(/\/+$/, "").startsWith("/v1/")
      );
    } catch {
      return false;
    }
  }

  /**
   * initialize 端点的本地兜底响应体。
   * 为什么不能像其他被拦域名一样回裸 "{}"：Statsig SDK 的 StatsigEvaluationsDataAdapter
   * 要求 initialize 响应带 has_updates / feature_gates / dynamic_configs / layer_configs
   * 等字段，"{}" 会让它解析失败并在控制台刷 "[Statsig] Failed to parse Response"。
   * payload 构造器由 bridge polyfill（更早安装、在内层）挂到
   * window.__OpenCodexStatsigInitializeFallback；拿不到时退回 "{}" 只是保底，
   * 正常装配顺序下一定能拿到完整 payload。
   * 遥测端点（rgstr / log_event）只回 "{}" 即可，因为 SDK 对它们只关心 HTTP 200、
   * 不解析响应体，形状合法与否不影响行为。
   */
  function statsigInitializeBody() {
    const fallback = w.__OpenCodexStatsigInitializeFallback;
    if (typeof fallback !== "function") return MOCK_RESPONSE_BODY;
    try {
      return JSON.stringify(fallback());
    } catch {
      return MOCK_RESPONSE_BODY;
    }
  }

  /**
   * 非 initialize 评估端点的本地响应体（XHR 通道用）。
   * 形状与 polyfill 的 buildStatsigEvaluationResponse 一致：has_updates:false 让 SDK
   * 认为"无更新"、不再要求内容；deltas 路径附 checksum，overlay 路径附 response_mode。
   * 优先复用 polyfill 挂出的构造器（保证两层形状一致），钩子缺失时用本地同形状兜底，
   * 仍然远比裸 "{}" 安全（裸体缺 has_updates 必刷 parse error）。
   */
  function statsigEvaluationBody(pathname) {
    const fallback = w.__OpenCodexStatsigEvaluationFallback;
    if (typeof fallback === "function") {
      try {
        return JSON.stringify(fallback(pathname));
      } catch {}
    }
    return JSON.stringify({ has_updates: false, time: Date.now(), feature_gates: {}, dynamic_configs: {}, layer_configs: {} });
  }

  /**
   * 域名匹配：与 gateway site-config.hostMatchesPattern 同语义。
   * 通配规则 *.example.com 只匹配子域，不匹配 example.com 本身；其余按精确主机名相等。
   */
  function hostMatchesPattern(host, pattern) {
    const value = String(host || "").trim().toLowerCase();
    const rule = String(pattern || "").trim().toLowerCase();
    if (!value || !rule) return false;
    if (rule.startsWith("*.")) return value.endsWith("." + rule.slice(2));
    return value === rule;
  }

  /** 解析 fetch/XHR/Beacon 的目标 URL；解析不出（私有协议、非法串）返回 null 交给原实现。 */
  function parseUrl(raw) {
    try {
      let value = raw;
      // fetch 的入参可能是 Request 对象，取其 url；其余按字符串处理。
      if (value && typeof value === "object" && typeof value.url === "string") value = value.url;
      else if (typeof value !== "string") value = value == null ? "" : String(value);
      if (!value) return null;
      return new URL(value, location.href);
    } catch {
      return null;
    }
  }

  /**
   * 是否应拦截该 URL。语义：命中 allow 直接放行，否则命中 block 即拦截；
   * 非 http(s) 或解析不出 hostname 的输入一律不拦。
   */
  function isBlocked(parsed) {
    if (!parsed || (!parsed.protocol || (parsed.protocol !== "http:" && parsed.protocol !== "https:"))) {
      return false;
    }
    const host = (parsed.hostname || "").toLowerCase();
    if (!host) return false;
    if (allowedHosts.some((pattern) => hostMatchesPattern(host, pattern))) return false;
    return blockedHosts.some((pattern) => hostMatchesPattern(host, pattern));
  }

  /**
   * XHR 的 status/statusText/response/responseText/readyState 是只读 IDL 属性，
   * 非严格模式下直接赋值会被静默忽略，必须在实例上 defineProperty 覆盖只读 getter。
   */
  function defineReadOnly(target, name, value) {
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: true,
        get: () => value,
      });
    } catch {}
  }

  function safeDispatch(target, type) {
    try {
      target.dispatchEvent(new Event(type));
    } catch {}
  }

  const disposers = [];

  // 通道一：fetch。命中时回一个本地 200 JSON 响应，调用方不会把它当错误处理。
  if (typeof w.fetch === "function") {
    const originalFetch = w.fetch;
    w.fetch = (input, init) => {
      const parsed = parseUrl(input);
      if (!isBlocked(parsed)) {
        return originalFetch(input, init);
      }
      // Statsig 评估端点（initialize + 其余 /v1/*）特判：透传回内层实现，而不是回裸 "{}"。
      // 内层（codex-bridge-polyfill 的 fetch 包装）会为整个 ab.chatgpt.com/v1/* 本地合成
      // 合法 payload（initialize 给完整 feature_gates，其余给 has_updates:false 最小体），
      // 请求并不会真的出网，所以透传不存在信息泄露；而 "{}" 缺 has_updates 会让 SDK
      // 的 _typedJsonParse 解析失败刷 "[Statsig] Failed to parse Response"。
      if (isStatsigEvaluationUrl(parsed.toString())) {
        return originalFetch(input, init);
      }
      // 按骨架约定，安装完成只代表 ready，命中只能在真实拦截发生时上报。
      modificationEffects?.primary?.emit();
      return Promise.resolve(new Response(MOCK_RESPONSE_BODY, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }));
    };
    disposers.push(() => {
      w.fetch = originalFetch;
    });
  }

  // 通道二：XMLHttpRequest。open 是唯一能拿到目标 URL 的时机，先记在实例上供 send 判定。
  if (typeof w.XMLHttpRequest === "function") {
    const originalOpen = w.XMLHttpRequest.prototype.open;
    const originalSend = w.XMLHttpRequest.prototype.send;

    w.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__opencodexNetworkUrl = typeof url === "string" ? url : "";
      return originalOpen.apply(this, [method, url, ...rest]);
    };
    disposers.push(() => {
      w.XMLHttpRequest.prototype.open = originalOpen;
    });

    w.XMLHttpRequest.prototype.send = function (body) {
      const xhr = this;
      const parsed = parseUrl(xhr.__opencodexNetworkUrl);
      if (!isBlocked(parsed)) {
        return originalSend.call(this, body);
      }

      modificationEffects?.primary?.emit();
      // 跳过真实网络请求：loadstart 同步补发，其余状态异步补齐，
      // 因为 SDK 通常在 send 返回之后才注册 load 监听器。
      // Statsig 评估端点不用裸 "{}"：initialize 走全局钩子取完整 payload（SDK 必须能
      // 解析出 feature_gates 等字段），其余评估路径走最小合法体（has_updates:false），
      // 两者都满足 _typedJsonParse 的 has_updates 键校验；其余被拦 URL 维持裸 "{}"。
      const rawUrl = String(xhr.__opencodexNetworkUrl || "");
      let responseBody = MOCK_RESPONSE_BODY;
      if (isStatsigInitializeUrl(rawUrl)) {
        responseBody = statsigInitializeBody();
      } else if (isStatsigEvaluationUrl(rawUrl)) {
        let pathname = "";
        try {
          pathname = new URL(rawUrl, location.href).pathname;
        } catch {}
        responseBody = statsigEvaluationBody(pathname);
      }
      safeDispatch(xhr, "loadstart");
      scheduler.setTimeout(() => {
        defineReadOnly(xhr, "status", 200);
        defineReadOnly(xhr, "statusText", "OK");
        defineReadOnly(xhr, "response", responseBody);
        defineReadOnly(xhr, "responseText", responseBody);
        defineReadOnly(xhr, "readyState", 4);
        safeDispatch(xhr, "readystatechange");
        safeDispatch(xhr, "load");
        safeDispatch(xhr, "loadend");
      }, 0);
      return undefined;
    };
    disposers.push(() => {
      w.XMLHttpRequest.prototype.send = originalSend;
    });
  }

  // 通道三：sendBeacon。没有响应可模拟，命中时本地吞掉并按“已送达”返回 true 即可。
  if (w.navigator && typeof w.navigator.sendBeacon === "function") {
    const originalSendBeacon = w.navigator.sendBeacon;
    // Beacon 的 this 绑定 navigator，转发前先固定接收者，避免 dispose 后仍引用补丁。
    const boundSendBeacon = originalSendBeacon.bind(w.navigator);
    w.navigator.sendBeacon = (url, ...rest) => {
      const parsed = parseUrl(url);
      if (isBlocked(parsed)) {
        modificationEffects?.primary?.emit();
        return true;
      }
      return boundSendBeacon(url, ...rest);
    };
    disposers.push(() => {
      w.navigator.sendBeacon = originalSendBeacon;
    });
  }

  // 换页或关闭时由宿主逆序 dispose：还原 fetch 原型与 Beacon，避免旧补丁继续吃掉新页面请求。
  modificationScope?.own?.(() => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {}
    }
    if (w.__opencodexNetworkGuardInstalled === providerGeneration) {
      w.__opencodexNetworkGuardInstalled = undefined;
    }
  });
})();
