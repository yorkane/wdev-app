const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PROVIDER_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "web-shell", "internal", "providers", "codex-js-error-capture.js"),
  "utf8"
);
const STATIC_ASSETS_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "gateway", "runtime", "http", "static-assets.cjs"),
  "utf8"
);
const CATALOG_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "gateway", "src", "modification", "catalog.ts"),
  "utf8"
);
const BROWSER_HOST_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "web-shell", "src", "modification-browser-host.ts"),
  "utf8"
);
const RUNTIME_BUNDLE = fs.readFileSync(
  path.join(REPO_ROOT, "gateway", "dist", "web", "opencodex-modification-runtime.js"),
  "utf8"
);
const NEWLINE = String.fromCharCode(10);
// host 原生实现引用：测试里删除 host 内置后用于恢复，也用于对齐语义。
const nativeHasOwn = Object.hasOwn;
const nativeReplaceAll = String.prototype.replaceAll;

const POINT_ID = "web.runtime.dom.js-error-capture";
const PROVIDER_KEY = "js-error-capture";
const PROVIDER_URL_PATH = "/codex-js-error-capture.js";
const I18N_KEY = "web.runtimeCompatibility.point." + POINT_ID + ".description";


test("the provider parses under an es2019 target and avoids newer syntax", () => {
  // 聚合 bootstrap 与独立脚本都会下发本文件；老内核（Kiki）上任何 ES2019+ 语法
  // 都可能让整段注入失效，因此按 es2019 目标做硬校验。
  const esbuild = require("esbuild");
  const out = esbuild.transformSync(PROVIDER_SOURCE, { target: "es2019" });
  const clean = out.code;
  assert.ok(!clean.includes("?."), "降级后不应残留可选链");
  assert.ok(!clean.includes("??"), "降级后不应残留空值合并");
  assert.ok(!clean.includes("(?<=<") && !clean.includes("(?<!"), "降级后不应残留 lookbehind");
  // 运行时 API 只用 ES2017 及更早：不允许裸调用 ES2018+ 才有的内置
  //（探针/守卫里以 typeof 形式出现是允许的）。
  const modernApis = [
    "structuredClone", "requestIdleCallback", "Object.hasOwn", "URL.parse",
    "Promise.withResolvers", "Array.fromAsync", "toSorted", "findLast", "groupBy",
    "Intl.Segmenter", "AbortSignal.timeout", "matchAll",
  ];
  for (const api of modernApis) {
    const escaped = api.replace(/[.*]/g, (ch) => "\\" + ch);
    const bareCalls = clean.match(new RegExp(escaped + "\\s*\\(", "g"));
    assert.equal(bareCalls, null, "provider 不应裸调用 ES2018+ API: " + api);
  }
});

test("the provider is wired in all required places", () => {
  // 五处 static-assets 注册。
  assert.ok(STATIC_ASSETS_SOURCE.includes("const CODEX_JS_ERROR_CAPTURE_PATH = \"" + PROVIDER_URL_PATH + "\""));
  assert.ok(STATIC_ASSETS_SOURCE.includes("[path.join(INTERNAL_PROVIDER_DIR, \"codex-js-error-capture.js\"), \"" + PROVIDER_KEY + "\"]"));
  assert.ok(STATIC_ASSETS_SOURCE.includes("[CODEX_JS_ERROR_CAPTURE_PATH, path.join(INTERNAL_PROVIDER_DIR, \"codex-js-error-capture.js\")]"));
  const bootstrapBlock = STATIC_ASSETS_SOURCE.slice(STATIC_ASSETS_SOURCE.indexOf("afterPlugins: ["));
  assert.ok(bootstrapBlock.includes("CODEX_JS_ERROR_CAPTURE_PATH"), "聚合 bootstrap 缺少 provider");
  const runtimeScriptsBlock = STATIC_ASSETS_SOURCE.slice(STATIC_ASSETS_SOURCE.indexOf("const runtimeScripts = useRuntimeBundle"));
  assert.ok(runtimeScriptsBlock.includes("runtimeScript(CODEX_JS_ERROR_CAPTURE_PATH)"), "逐文件回退缺少 provider");

  const catalogLines = CATALOG_SOURCE.split(NEWLINE).filter((line) => line.includes("\"" + POINT_ID + "\""));
  assert.equal(catalogLines.length, 1, "修改点必须且只能声明一次");
  assert.ok(catalogLines[0].includes("G.rendererUi"));
  assert.ok(catalogLines[0].includes("A.semanticView"));
  const bindingLines = BROWSER_HOST_SOURCE.split(NEWLINE).filter((line) => line.includes(POINT_ID));
  assert.equal(bindingLines.length, 1, "修改点必须只绑定一个 provider");
  assert.ok(bindingLines[0].includes("key: \"" + PROVIDER_KEY + "\""));
  assert.ok(RUNTIME_BUNDLE.includes("js-error-capture"), "聚合 bundle 未包含 provider 绑定");

  const enMessages = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "shared", "i18n", "locales", "runtime-compatibility-en-US.json"), "utf8")
  );
  assert.ok(String(enMessages[I18N_KEY] || "").trim(), "缺少 " + I18N_KEY);
});

/** 最小假浏览器环境：core 显式持有宿主内置对象与假浏览器对象（不用 Proxy，
 * 保证“删除宿主内置模拟老内核缺失”的测试语义干净可控）。 */
function createFakeBrowser() {
  const timers = [];
  const fetchCalls = [];
  const eventListeners = new Map();
  const scopeEffects = { primary: { emit: () => {} } };
  const disposers = [];
  let timerId = 0;

  const windowObj = {
    __OpenCodexCurrentProviderScope: {
      generation: 1,
      effects: scopeEffects,
      own: (dispose) => { disposers.push(dispose); return () => dispose(); },
    },
    __CODEX_WEB_CONFIG__: {},
    sessionStorage: {
      store: {},
      getItem(k) { return this.store[k] === undefined ? null : this.store[k]; },
      setItem(k, v) { this.store[k] = String(v); },
    },
    navigator: { userAgent: "FakeBrowser/1.0 (Kiki-like) Chrome/80.0.0.0 Mobile", platform: "Linux armv8l" },
    location: { href: "http://127.0.0.1:13737/chat?token=secret123" },
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    document: { readyState: "complete" },
    fetch: (url, options) => {
      fetchCalls.push({ url, options });
      return Promise.resolve({ ok: true });
    },
    addEventListener: () => {},
    dispatchEvent: () => true,
  };
  if (typeof AbortController !== "undefined") {
    windowObj.AbortController = AbortController;
    windowObj.AbortSignal = AbortSignal;
  }

  const scheduler = {
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.push({ id, callback, at: delay || 0 });
      return id;
    },
    clearTimeout: (id) => {
      const index = timers.findIndex((item) => item.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  };

  const adapterHost = {
    scheduler: { capture: () => scheduler },
    events: {
      observe: ({ key, type, callback }) => {
        if (!eventListeners.has(type)) eventListeners.set(type, []);
        eventListeners.get(type).push({ key, callback });
        return () => {
          const list = eventListeners.get(type) || [];
          const index = list.findIndex((item) => item.key === key);
          if (index >= 0) list.splice(index, 1);
        };
      },
    },
  };
  windowObj.__OpenCodexAdapterHost = adapterHost;

  const core = {
    window: windowObj,
    document: windowObj.document,
    navigator: windowObj.navigator,
    location: windowObj.location,
    sessionStorage: windowObj.sessionStorage,
    crypto: windowObj.crypto,
    fetch: windowObj.fetch,
    console: { warn: () => {}, log: () => {}, error: () => {} },
    // 宿主内置显式注入：provider 的探针与 polyfill 都作用在这份对象上，
    // 测试删除它们即可模拟老内核缺失（finally 恢复）。
    Promise,
    Map,
    Set,
    Date,
    URL,
    URLSearchParams,
    Object,
    Array,
    String,
    Number,
    RegExp,
    Math,
    JSON,
    Error,
    TypeError,
    Event,
  };
  vm.createContext(core);
  return { sandbox: core, windowObj, fetchCalls, eventListeners, timers, disposers };
}

function runProvider(browser) {
  vm.runInContext(PROVIDER_SOURCE, browser.sandbox, { filename: "codex-js-error-capture.js" });
}

function fireWindow(browser, type, payload) {
  for (const item of browser.eventListeners.get(type) || []) item.callback(payload);
}

function runFlushTimers(browser) {
  let guard = 0;
  for (;;) {
    const due = browser.timers.slice().sort((a, b) => a.at - b.at);
    const next = due[0];
    if (!next) return;
    const index = browser.timers.findIndex((item) => item.id === next.id);
    if (index >= 0) browser.timers.splice(index, 1);
    next.callback();
    guard += 1;
    if (guard > 200) throw new Error("timer 循环未收敛");
  }
}

function reportedEvents(browser) {
  return browser.fetchCalls.flatMap((call) => JSON.parse(call.options.body).events);
}

test("error capture reports through /api/client-log with UA and markdown tag", (t) => {
  const browser = createFakeBrowser();
  runProvider(browser);
  fireWindow(browser, "error", {
    message: "Unexpected token ')' in markdown renderer chunk",
    filename: "http://127.0.0.1:13737/official/assets/app-initial-74b69e67976a.js",
    lineno: 1658,
    colno: 120,
    error: new Error("boom"),
  });
  runFlushTimers(browser);
  assert.equal(browser.fetchCalls.length, 1, "应发起一次批量上报");
  assert.equal(browser.fetchCalls[0].url, "/api/client-log");
  const payload = JSON.parse(browser.fetchCalls[0].options.body);
  assert.ok(payload.clientId, "应带 clientId");
  const event = payload.events.find((item) => item.event === "js-error");
  assert.ok(event, "批量里应有 js-error 事件");
  assert.equal(event.data.kind, "error");
  assert.ok(String(event.data.message).includes("markdown renderer"), "应保留 message");
  assert.ok(String(event.data.source).includes("app-initial"), "应保留 source");
  assert.equal(event.data.line, 1658);
  assert.equal(event.data.tag, "markdown", "markdown 相关错误应打 tag");
  assert.ok(String(event.data.ua).includes("Kiki-like"), "必须带 UA");
  assert.ok(!String(event.data.href).includes("secret123"), "href 必须脱敏 token");
});

test("unrelated errors are reported without the markdown tag", (t) => {
  const browser = createFakeBrowser();
  runProvider(browser);
  fireWindow(browser, "error", {
    message: "Cannot read properties of undefined (reading 'size')",
    filename: "http://127.0.0.1:13737/official/assets/app-primary.js",
    lineno: 1004,
    colno: 33,
  });
  runFlushTimers(browser);
  const event = reportedEvents(browser).find((item) => item.event === "js-error");
  assert.ok(event);
  assert.equal(event.data.tag, undefined, "非 markdown 错误不应有 tag");
});

test("repeated errors are rate limited on the client side", (t) => {
  const browser = createFakeBrowser();
  runProvider(browser);
  const payload = { message: "same failure", filename: "chunk.js", lineno: 1, colno: 1 };
  fireWindow(browser, "error", payload);
  fireWindow(browser, "error", payload);
  fireWindow(browser, "error", { message: "different failure", filename: "chunk.js", lineno: 2, colno: 1 });
  runFlushTimers(browser);
  const events = reportedEvents(browser).filter((item) => item.event === "js-error");
  assert.equal(events.length, 1, "同签名与同页面限流后只应剩一条");
  assert.equal(events[0].data.message, "same failure");
});

test("unhandledrejection is captured", (t) => {
  const browser = createFakeBrowser();
  runProvider(browser);
  fireWindow(browser, "unhandledrejection", { reason: new Error("segmentation failed in micromark pipeline") });
  runFlushTimers(browser);
  const event = reportedEvents(browser).find((item) => item.event === "js-unhandled-rejection");
  assert.ok(event);
  assert.equal(event.data.tag, "markdown", "micromark 相关 rejection 应打 markdown tag");
  assert.ok(String(event.data.reason).includes("segmentation failed"));
});

test("script load failure (error without message) is captured", (t) => {
  const browser = createFakeBrowser();
  runProvider(browser);
  fireWindow(browser, "error", {
    target: { tagName: "SCRIPT", src: "http://127.0.0.1:13737/official/assets/app-initial.js" },
  });
  runFlushTimers(browser);
  const event = reportedEvents(browser).find((item) => item.event === "js-error");
  assert.ok(event);
  assert.equal(event.data.kind, "script-load", "无 message 的 error 应标记为 script-load");
});

test("Array.at polyfill is installed when missing and matches native semantics", (t) => {
  const originalAt = Array.prototype.at;
  delete Array.prototype.at;
  try {
    const browser = createFakeBrowser();
    assert.equal(typeof Array.prototype.at, "undefined", "前置：at 确实缺失");
    runProvider(browser);
    fireWindow(browser, "load", {});
    runFlushTimers(browser);
    const capability = reportedEvents(browser).find((item) => item.event === "js-capability");
    assert.ok(capability, "应上报 js-capability");
    assert.ok(capability.data.missing.includes("Array.prototype.at"), "missing 应报告 at");
    assert.ok(capability.data.applied.includes("Array.prototype.at"), "applied 应报告补齐 at");
    // 补齐后的语义与原生一致。
    const arr = [1, 2, 3];
    assert.equal(arr.at(-1), 3);
    assert.equal(arr.at(0), 1);
    assert.equal(arr.at(99), undefined);
    assert.equal(arr.at(-99), undefined);
  } finally {
    Array.prototype.at = originalAt;
  }
});

test("Object.hasOwn polyfill is installed when missing and matches native semantics", (t) => {
  delete Object.hasOwn;
  try {
    const browser = createFakeBrowser();
    assert.equal(typeof Object.hasOwn, "undefined", "前置：hasOwn 确实缺失");
    runProvider(browser);
    fireWindow(browser, "load", {});
    runFlushTimers(browser);
    const capability = reportedEvents(browser).find((item) => item.event === "js-capability");
    assert.ok(capability.data.missing.includes("Object.hasOwn"), "missing 应报告 hasOwn");
    assert.ok(capability.data.applied.includes("Object.hasOwn"), "applied 应报告补齐 hasOwn");
    // 与原生语义一致：自有属性、原型链属性、null/undefined 抛错。
    assert.equal(Object.hasOwn({ a: 1 }, "a"), true);
    assert.equal(Object.hasOwn({}, "b"), false);
    assert.throws(() => Object.hasOwn(null, "a"), TypeError);
    const child = Object.create({ inherited: 1 });
    child.own = 2;
    assert.equal(Object.hasOwn(child, "inherited"), false);
    assert.equal(Object.hasOwn(child, "own"), true);
  } finally {
    Object.hasOwn = nativeHasOwn;
  }
});

test("replaceAll polyfill is installed when missing and matches native semantics", (t) => {
  delete String.prototype.replaceAll;
  try {
    const browser = createFakeBrowser();
    assert.equal(typeof String.prototype.replaceAll, "undefined", "前置：replaceAll 确实缺失");
    runProvider(browser);
    fireWindow(browser, "load", {});
    runFlushTimers(browser);
    const capability = reportedEvents(browser).find((item) => item.event === "js-capability");
    assert.ok(capability.data.missing.includes("String.prototype.replaceAll"), "missing 应报告 replaceAll");
    assert.ok(capability.data.applied.includes("String.prototype.replaceAll"), "applied 应报告补齐 replaceAll");
    // 字符串替换、空串替换、全局正则、非全局正则报错，逐项与原生对齐。
    assert.equal("a-b-c".replaceAll("-", "+"), "a+b+c");
    assert.equal("a--b".replaceAll("-", ""), "ab");
    assert.equal("abc".replaceAll(/b/g, "X"), "aXc");
    assert.throws(() => "abc".replaceAll(/b/, "X"), TypeError);
    assert.equal("abc".replaceAll("", "Z"), nativeReplaceAll.call("abc", "", "Z"));
    // 函数替换器：(match, index, string) 语义与原生一致。
    assert.equal(
      "x1y2z".replaceAll(/\d/g, (m, idx) => "#" + idx),
      nativeReplaceAll.call("x1y2z", /\d/g, (m, idx) => "#" + idx)
    );
  } finally {
    String.prototype.replaceAll = nativeReplaceAll;
  }
});

test("URL.parse polyfill is installed when missing and matches native semantics", (t) => {
  const originalParse = URL.parse;
  delete URL.parse;
  try {
    const browser = createFakeBrowser();
    // 真实浏览器里 window.URL 就是全局 URL；harness 需显式挂上再删 parse。
    browser.windowObj.URL = URL;
    assert.equal(typeof URL.parse, "undefined", "前置：URL.parse 确实缺失");
    runProvider(browser);
    fireWindow(browser, "load", {});
    runFlushTimers(browser);
    const capability = reportedEvents(browser).find((item) => item.event === "js-capability");
    assert.ok(capability.data.missing.includes("URL.parse"), "missing 应报告 URL.parse");
    assert.ok(capability.data.applied.includes("URL.parse"), "applied 应报告补齐 URL.parse");
    // 语义与原生一致：合法 URL 返回解析对象，非法 URL 返回 null（不抛错）。
    const parsed = URL.parse("https://example.com/a?b=1");
    assert.equal(parsed.protocol, "https:");
    assert.equal(parsed.hostname, "example.com");
    assert.equal(parsed.pathname, "/a");
    assert.equal(parsed.search, "?b=1");
    assert.equal(URL.parse("not a url"), null);
    // base 参数生效，与原生对齐。
    const withBase = URL.parse("/p", "https://example.com/x");
    assert.equal(withBase.href, "https://example.com/p");
    // 补齐不应破坏已有 URL 实例构造。
    assert.equal(new URL("https://a.b/c").href, "https://a.b/c");
  } finally {
    URL.parse = originalParse;
  }
});

test("capability probe does not override existing implementations", (t) => {
  const browser = createFakeBrowser();
  runProvider(browser);
  fireWindow(browser, "load", {});
  runFlushTimers(browser);
  const capability = reportedEvents(browser).find((item) => item.event === "js-capability");
  assert.ok(capability, "完整内核也应上报一次能力清单");
  assert.equal(capability.data.engine, "chrome", "UA 含 Chrome 应识别为 chrome");
  assert.ok(!capability.data.applied.includes("Object.hasOwn"), "已有实现不应被 polyfill 覆盖");
  assert.ok(!capability.data.applied.includes("Array.prototype.at"));
  assert.ok(!capability.data.applied.includes("String.prototype.replaceAll"));
  // 每页面只报一次。
  fireWindow(browser, "load", {});
  runFlushTimers(browser);
  const capabilities = reportedEvents(browser).filter((item) => item.event === "js-capability");
  assert.equal(capabilities.length, 1, "能力清单每页面只上报一次");
});

test("disableJsErrorCapture turns the provider off", (t) => {
  const browser = createFakeBrowser();
  browser.windowObj.__CODEX_WEB_CONFIG__ = { disableJsErrorCapture: true };
  runProvider(browser);
  assert.equal(browser.eventListeners.get("error"), undefined);
  runFlushTimers(browser);
  assert.equal(browser.fetchCalls.length, 0);
});

test("provider is idempotent across reinstall in the same generation", (t) => {
  const browser = createFakeBrowser();
  runProvider(browser);
  const afterFirst = (browser.eventListeners.get("error") || []).length;
  runProvider(browser);
  const afterSecond = (browser.eventListeners.get("error") || []).length;
  assert.equal(afterFirst, 1);
  assert.equal(afterSecond, 1, "同 generation 重复安装不应重复挂监听");
});

test("dispose releases observers and flushes pending events", (t) => {
  const browser = createFakeBrowser();
  runProvider(browser);
  fireWindow(browser, "error", { message: "pending before dispose", filename: "x.js", lineno: 1, colno: 1 });
  assert.ok(browser.disposers.length >= 1);
  browser.disposers.forEach((dispose) => dispose());
  assert.equal(browser.fetchCalls.length, 1, "dispose 前未发送的错误应被 flush");
  assert.equal(browser.windowObj.__opencodexJsErrorCaptureInstalled, undefined, "dispose 后应清除安装标记");
  assert.equal((browser.eventListeners.get("error") || []).length, 0);
});
