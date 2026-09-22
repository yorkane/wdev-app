const {
  registerOfficialElectronModuleOverride,
} = require("./official-electron-module-hook.cjs");
const { diagnosticLog } = require("../core/diagnostics.cjs");
const { urlPolicy } = require("../core/site-config.cjs");
const { appendAuditEvent } = require("../core/network-audit.cjs");

// Electron main 的 net.fetch 是官方隐藏 renderer 所有 Statsig/遥测请求的最终出口。
// 无外网出口的服务器上，对 ab.chatgpt.com / chatgpt.com 遥测的 TCP 连接会一直黑洞挂起，
// Statsig 初始化永不返回，官方路由被 Suspense 永久挂起（浏览器镜像端只剩转圈）；
// 用 /etc/hosts 把它指回本地又会变成快速失败并打挂页面。唯一稳的做法是在这里本地短路：
// initialize 回一份合法 gate 配置（与 web-shell polyfill 默认值一致），遥测/异常上报回空对象，
// 其余 URL 原样透传给官方 net.fetch。
const STATSIG_DEFAULT_FEATURES_CONFIG = "statsig_default_enable_features";
const STATSIG_I18N_LAYER_CONFIG = "72216192";
const STATSIG_I18N_LAYER_VALUES = { enable_i18n: true, locale_source: "IDE" };
// 505458 是官方"新工作树"入口门；Web 快照必须保留该能力，取值与 polyfill 保持一致。
const STATSIG_DEFAULT_FEATURE_OVERRIDES = {
  "3903742690": true,
  "505458": true,
  artifacts: true,
};
// 官方 bundle 在 authed-route 模块初始化时调用 app-primary 的 side-effect 导出。真实网络下 Statsig
// 初始化有 100ms+ 往返，天然给官方 side-effect 模块留出注册窗口；若 0ms 返回会抢跑，概率性触发
// "n is not a function"。给合成响应加一个小延迟，复刻真实网络节奏，消除该竞态。
const STATSIG_INITIALIZE_DELAY_MS = Math.max(0, Number(process.env.OPENCODEX_STATSIG_INITIALIZE_DELAY_MS ?? 400) || 0);

function buildStatsigInitializeNetResponse() {
  const feature_gates = {};
  const dynamic_configs = {
    [STATSIG_DEFAULT_FEATURES_CONFIG]: {
      name: STATSIG_DEFAULT_FEATURES_CONFIG,
      value: { ...STATSIG_DEFAULT_FEATURE_OVERRIDES },
      rule_id: "gateway_override",
      secondary_exposures: [],
    },
  };
  for (const [name, value] of Object.entries(STATSIG_DEFAULT_FEATURE_OVERRIDES)) {
    feature_gates[name] = { name, value, rule_id: "gateway_override", secondary_exposures: [] };
  }
  return {
    has_updates: true,
    time: Date.now(),
    hash_used: "djb2",
    feature_gates,
    dynamic_configs,
    layer_configs: {
      [STATSIG_I18N_LAYER_CONFIG]: {
        name: STATSIG_I18N_LAYER_CONFIG,
        value: { ...STATSIG_I18N_LAYER_VALUES },
        rule_id: "gateway_override",
        secondary_exposures: [],
      },
    },
    param_stores: {},
    exposures: {},
    sdk_flags: {},
  };
}

// 返回本地响应体字符串；空串表示该 URL 不属于 Statsig 控制面，必须透传给官方实现。
function statsigLocalResponseBodyForUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (parsed.hostname === "ab.chatgpt.com") {
    if (pathname === "/v1/initialize") return JSON.stringify(buildStatsigInitializeNetResponse());
    if (pathname === "/v1/sdk_exception") return "{}";
    return "";
  }
  if (parsed.hostname === "chatgpt.com" && (pathname === "/ces/v1/rgstr" || pathname === "/ces/v1/log_event")) {
    return "{}";
  }
  return "";
}

function extractUrlFromNetFetchArgs(args) {
  const first = args && args[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object") {
    if (typeof first.url === "string") return first.url;
    if (typeof first.href === "string") return first.href;
    try {
      return first.toString();
    } catch {
      return "";
    }
  }
  return "";
}

// 审计只允许 host + pathname + method；这里把 URL 拆成最小定位字段。
// net.fetch 的第二参数可能是 Request（有 .method）或 init 对象（有 .method），其余形态拿不到方法就留空。
function auditFieldsFromNetFetchArgs(args) {
  const url = extractUrlFromNetFetchArgs(args);
  let host = "";
  let path = "";
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname;
  } catch {
    host = "";
    path = "";
  }
  let method = "";
  if (args && args.length > 1 && args[1] && typeof args[1] === "object") {
    if (typeof args[1].method === "string") method = args[1].method;
  }
  return { host, path, method };
}

// 构造官方 httpFetch 能消费的响应；优先用全局 Response，缺失时退回最小鸭子类型形状。
function buildStatsigNetResponse(bodyJson, url, ResponseCtor) {
  if (ResponseCtor) {
    return new ResponseCtor(bodyJson, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const buffer = Buffer.from(bodyJson, "utf-8");
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null) },
    json: async () => JSON.parse(bodyJson),
    text: async () => bodyJson,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

function installOfficialNetFetchStatsigHook(electronModule, options = {}) {
  const onIntercept = typeof options.onIntercept === "function" ? options.onIntercept : null;
  // network 策略来自 config.yaml；命中 block 清单的请求必须本地兜底而不是透传，
  // 否则受限网络下 TCP 会一直黑洞挂起，把官方路由卡在 Suspense 里。
  const network = options.network && typeof options.network === "object" ? options.network : null;
  const onBlocked = typeof options.onBlocked === "function" ? options.onBlocked : null;
  // 注册入口可注入：生产走全局 electron 模块 hook（进程内单例，只接受一个 electron 实例），
  // 单测可在不改动全局状态的前提下验证包装后的 net.fetch 行为。
  const registerOverride =
    typeof options.registerOverride === "function" ? options.registerOverride : registerOfficialElectronModuleOverride;
  const nativeNet = electronModule && electronModule.net;
  if (!nativeNet || typeof nativeNet.fetch !== "function") {
    return { installed: false, reason: "net.fetch unavailable" };
  }
  const nativeFetch = nativeNet.fetch.bind(nativeNet);
  const ResponseCtor = typeof Response === "function" ? Response : null;
  const hookedNet = Object.assign(Object.create(Object.getPrototypeOf(nativeNet)), nativeNet, {
    fetch(...args) {
      const url = extractUrlFromNetFetchArgs(args);
      const bodyJson = statsigLocalResponseBodyForUrl(url);
      if (bodyJson) {
        // Statsig 控制面必须优先于配置 block 清单：config.yaml 的 block 常包含 *.chatgpt.com，
        // 若 block 先命中，initialize 会被回裸 {}，官方 SDK 的 _typedJsonParse 解析失败落 NoValues，
        // enable_i18n 门控回落 false，官方 web UI 的 i18n 消息表整段不加载（界面停留英文）。
        if (onIntercept) onIntercept(url);
        // 审计：Statsig 控制面本地应答。initialize 的「本地应答 vs 被 block」是 doctor 升级自检判据。
        appendAuditEvent("statsig-local", "gateway-net-fetch", auditFieldsFromNetFetchArgs(args));
        diagnosticLog("statsig-net-fetch", "net_fetch_served_local", { url: String(url).split("?")[0] });
        const deliver = () => buildStatsigNetResponse(bodyJson, url, ResponseCtor);
        // 仅初始化响应加延迟以复刻真实往返、规避官方模块初始化竞态；遥测/异常上报保持即时。
        if (String(url).includes("/v1/initialize") && STATSIG_INITIALIZE_DELAY_MS > 0) {
          return new Promise((resolve) => setTimeout(() => resolve(deliver()), STATSIG_INITIALIZE_DELAY_MS));
        }
        return Promise.resolve(deliver());
      }
      // 非 Statsig 控制面的请求才按配置清单判定：被拦截的域名回 200 空对象，等价于「请求已完成」，
      // 既避免真实出网泄露信息，也避免连接挂起拖垮调用方。
      if (network) {
        const decision = urlPolicy(url, network);
        if (decision === "allow-path") {
          // 命中 allowPaths：临时放行，记审计后原样透传，让真实请求发出去。
          appendAuditEvent("allow-path", "gateway-net-fetch", auditFieldsFromNetFetchArgs(args));
        } else if (decision === "block") {
          if (onBlocked) onBlocked(url);
          appendAuditEvent("block", "gateway-net-fetch", auditFieldsFromNetFetchArgs(args));
          diagnosticLog("network-guard", "net_fetch_blocked_by_config", { url: String(url).split("?")[0] });
          return Promise.resolve(buildStatsigNetResponse("{}", url, ResponseCtor));
        }
      }
      return nativeFetch(...args);
    },
  });
  registerOverride(electronModule, "net", hookedNet);
  // 返回覆写后的 net 便于单测直接断言；线上官方代码通过 require("electron") 拿到同一包装对象。
  return { installed: true, net: hookedNet };
}

module.exports = {
  installOfficialNetFetchStatsigHook,
  __test: { statsigLocalResponseBodyForUrl, buildStatsigInitializeNetResponse },
};
