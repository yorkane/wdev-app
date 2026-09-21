const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PROVIDER_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "web-shell", "internal", "providers", "codex-brand-text.js"),
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
const { createStaticAssetService } = require("../runtime/http/static-assets.cjs");
const { messagesForLocale } = require("../../shared/i18n/index.cjs");

const POINT_ID = "web.runtime.dom.brand-text";
const PROVIDER_KEY = "brand-text";
const PROVIDER_URL_PATH = "/codex-brand-text.js";
const I18N_KEY = "web.runtimeCompatibility.point." + POINT_ID + ".description";
const NEWLINE = String.fromCharCode(10);

/** 可控计时器：命中检查走宿主调度器，测试里手动 flush。 */
function createScheduler() {
  let nextId = 1;
  const timers = new Map();
  const api = {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  return {
    api,
    timers,
    capture() {
      return {
        setTimeout: (callback, delay) => api.setTimeout(callback, delay),
        clearTimeout: (id) => api.clearTimeout(id),
      };
    },
    flush() {
      const pending = Array.from(timers.values());
      timers.clear();
      for (const timer of pending) timer.callback();
    },
  };
}

/**
 * 最小假 DOM：只实现 Provider 用到的面（TreeWalker 文本遍历、属性读写、
 * title 读写），足够证明「只改文本节点与三个用户可见属性」的窄规则。
 */
function createFakeDom() {
  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName || "div").toUpperCase();
      this.nodeName = this.tagName;
      this.nodeType = 1;
      this.attributes = new Map();
      this.children = [];
      this.parentNode = null;
    }
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }
    append(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    }
    /**
     * 最小 closest：只支持 Provider 排除清单用到的选择器形式
     * （纯标签名、[attr]、[attr="value"]，逗号分隔取或）。
     */
    closest(selector) {
      const parts = String(selector).split(",").map((part) => part.trim()).filter(Boolean);
      let current = this;
      while (current && current.nodeType === 1) {
        for (const part of parts) {
          const tagMatch = part.match(/^([a-zA-Z][a-zA-Z0-9-]*)$/);
          if (tagMatch && current.tagName === tagMatch[1].toUpperCase()) return current;
          const attrMatch = part.match(/^\[([a-zA-Z-]+)(?:=\"([^\"]*)\")?\]$/);
          if (attrMatch) {
            const name = attrMatch[1];
            const expected = attrMatch[2];
            if (current.attributes.has(name) && (expected === undefined || current.attributes.get(name) === expected)) {
              return current;
            }
          }
        }
        current = current.parentNode;
      }
      return null;
    }
    /** 收集后代文本节点（与真实 TreeWalker SHOW_TEXT 语义一致，含自身文本）。 */
    collectTextNodes() {
      const result = [];
      const visit = (node) => {
        if (node.nodeType === 3) {
          result.push(node);
          return;
        }
        for (const child of node.children || []) visit(child);
      };
      visit(this);
      return result;
    }
    get textContent() {
      return this.collectTextNodes().map((node) => node.nodeValue).join("");
    }
  }

  class FakeTextNode {
    constructor(value) {
      this.nodeType = 3;
      this.nodeName = "#text";
      this.nodeValue = String(value == null ? "" : value);
      this.parentNode = null;
    }
  }

  const documentElement = new FakeElement("html");
  const head = documentElement.append(new FakeElement("head"));
  const titleElement = head.append(new FakeElement("title"));
  const body = documentElement.append(new FakeElement("body"));

  const document = {
    documentElement,
    head,
    body,
    title: "",
    createTreeWalker(root, whatToShow, filter) {
      let cursor = 0;
      // 与真实 TreeWalker 一致：按 whatToShow 位收集元素与文本节点（前序遍历）。
      const nodes = [];
      const visit = (node) => {
        if (node.nodeType === 1) {
          if (whatToShow & 1) nodes.push(node);
        } else if (node.nodeType === 3) {
          if (whatToShow & 4) nodes.push(node);
          return;
        }
        for (const child of node.children || []) visit(child);
      };
      visit(root);
      const accepted = nodes.filter((node) => {
        if (!filter || typeof filter.acceptNode !== "function") return true;
        return filter.acceptNode(node) === 1;
      });
      return {
        nextNode() {
          return cursor < accepted.length ? accepted[cursor++] : null;
        },
      };
    },
  };
  Object.defineProperty(document, "title", {
    configurable: true,
    get() {
      return titleElement.collectTextNodes().map((node) => node.nodeValue).join("");
    },
    set(value) {
      titleElement.children = [];
      titleElement.append(new FakeTextNode(value));
    },
  });

  return { FakeElement, FakeTextNode, document, documentElement, body, titleElement };
}

/** 装配假浏览器环境并安装 Provider；observer 桩支持手动 fire 记录。 */
function createHarness(brandName) {
  const dom = createFakeDom();
  const scheduler = createScheduler();
  const subscriptions = [];
  const scope = {
    generation: 5,
    emits: 0,
    owned: [],
    effects: { primary: { emit: () => { scope.emits += 1; } } },
    own(dispose) {
      scope.owned.push(dispose);
      return () => {
        const index = scope.owned.indexOf(dispose);
        if (index >= 0) scope.owned.splice(index, 1);
      };
    },
  };

  const window = {
    __OpenCodexCurrentProviderScope: scope,
  };
  if (brandName != null) {
    window.__CODEX_WEB_CONFIG__ = { brand: { name: brandName, source: "config", configured: true } };
  }
  window.__OpenCodexAdapterHost = {
    scheduler: { capture: () => scheduler.capture() },
    dom: {
      observe(input) {
        subscriptions.push(input);
        return () => {
          const index = subscriptions.indexOf(input);
          if (index >= 0) subscriptions.splice(index, 1);
        };
      },
    },
  };

  const sandbox = {
    console,
    document: dom.document,
    window,
    Element: dom.FakeElement,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    MutationObserver: class {
      constructor() {
        throw new Error("provider must use the shared host observer");
      }
    },
  };

  return {
    dom,
    scheduler,
    subscriptions,
    scope,
    window,
    install() {
      vm.runInNewContext(PROVIDER_SOURCE, sandbox);
    },
    /** 模拟宿主派发 MutationRecord 流。 */
    fire(records) {
      assert.equal(subscriptions.length, 1, "there must be exactly one live subscription");
      subscriptions[0].callback(records, {});
    },
  };
}

test("initial scan replaces brand words in rendered title and text nodes", () => {
test("lowercase openai account label is rewritten while lowercase codex in a user title is preserved", () => {
  // 官方账号名渲染成小写 openai，必须命中；而正文里的 codex 常见于用户自己写的会话标题，
  // 大小写敏感匹配让这类内容保持原样。
  const harness = createHarness("wdev");
  const intro = new harness.dom.FakeElement("p");
  const account = new harness.dom.FakeElement("span");
  account.append(new harness.dom.FakeTextNode("openai"));
  const userTitle = new harness.dom.FakeElement("span");
  userTitle.append(new harness.dom.FakeTextNode("重启本机的codex 和 codex app"));
  intro.append(account);
  intro.append(userTitle);
  harness.dom.body.append(intro);

  harness.install();

  assert.equal(account.textContent, "wdev");
  assert.equal(userTitle.textContent, "重启本机的codex 和 codex app");
});

  const harness = createHarness("wdev");
  harness.dom.document.title = "ChatGPT - 会话名";
  const intro = new harness.dom.FakeElement("p");
  intro.append(new harness.dom.FakeTextNode("Powered by Codex and OpenAI"));
  harness.dom.body.append(intro);

  harness.install();
  assert.equal(harness.dom.document.title, "wdev - 会话名");
  assert.equal(harness.dom.body.textContent, "Powered by wdev and wdev");
  // 安装完成只代表 ready，真实替换发生后由调度器里的首次命中检查上报。
  assert.equal(harness.scope.emits, 0);
  harness.scheduler.flush();
  assert.equal(harness.scope.emits, 1, "a real rewrite reports exactly one hit");
  harness.scheduler.flush();
  assert.equal(harness.scope.emits, 1, "the hit must not be reported twice");
});

function domTextNode(harness, value) {
  const node = new harness.dom.FakeTextNode(value);
  return node;
}

test("word-boundary replacement never touches attribute names, protocols or identifiers", () => {
  const harness = createHarness("wdev");
  const el = new harness.dom.FakeElement("div");
  el.setAttribute("class", "codex-chat-panel");
  el.setAttribute("data-codex-user-id", "Codex-123");
  el.setAttribute("style", "--codex-font-size: 16px");
  el.setAttribute("href", "codex-sandbox://workspace");
  el.setAttribute("aria-label", "Open in Codex");
  el.setAttribute("title", "Codex panel");
  el.setAttribute("alt", "Codex logo");
  harness.dom.body.append(el);
  el.append(new harness.dom.FakeTextNode("codex2 and CodexApp stay, but Codex changes"));

  harness.install();

  // 窄规则：class/协议/驼峰标识符/自定义属性名与值一律不动。
  assert.equal(el.getAttribute("class"), "codex-chat-panel");
  assert.equal(el.getAttribute("data-codex-user-id"), "Codex-123");
  assert.equal(el.getAttribute("style"), "--codex-font-size: 16px");
  assert.equal(el.getAttribute("href"), "codex-sandbox://workspace");
  // 用户可见属性按词边界替换。
  assert.equal(el.getAttribute("aria-label"), "Open in wdev");
  assert.equal(el.getAttribute("title"), "wdev panel");
  assert.equal(el.getAttribute("alt"), "wdev logo");
  assert.equal(
    el.textContent,
    "codex2 and CodexApp stay, but wdev changes"
  );
});

test("dynamically inserted elements and text are rewritten by the shared observer", () => {
  const harness = createHarness("wdev");
  harness.install();
  assert.equal(harness.subscriptions.length, 1, "provider must use the host dom.observe");

  const inserted = new harness.dom.FakeElement("section");
  inserted.append(new harness.dom.FakeTextNode("Welcome to ChatGPT"));
  harness.fire([{ type: "childList", addedNodes: [inserted] }]);
  assert.equal(inserted.textContent, "Welcome to wdev");

  const text = new harness.dom.FakeTextNode("Ask OpenAI anything");
  harness.dom.body.append(text);
  harness.fire([{ type: "characterData", target: text }]);
  assert.equal(text.nodeValue, "Ask wdev anything");
});

test("attribute mutations on user-visible attributes are rewritten", () => {
  const harness = createHarness("wdev");
  harness.install();

  const el = new harness.dom.FakeElement("button");
  el.setAttribute("aria-label", "Send to Codex");
  harness.dom.body.append(el);
  harness.fire([{ type: "attributes", target: el, attributeName: "aria-label" }]);
  assert.equal(el.getAttribute("aria-label"), "Send to wdev");
});

test("conversation content and code blocks are never rewritten, only shell wording is", () => {
  const harness = createHarness("wdev");
  // 消息 markdown 正文：整棵子树排除。
  const markdown = new harness.dom.FakeElement("div");
  markdown.setAttribute("data-markdown-text-style", "");
  markdown.append(new harness.dom.FakeTextNode("The Codex agent runs ChatGPT models and OpenAI tooling"));
  harness.dom.body.append(markdown);
  // 用户消息气泡内的代码块。
  const bubble = new harness.dom.FakeElement("div");
  bubble.setAttribute("data-user-message-bubble", "");
  const code = bubble.append(new harness.dom.FakeElement("pre"));
  code.append(new harness.dom.FakeElement("code").append(new harness.dom.FakeTextNode("console.log('Codex CLI')")));
  harness.dom.body.append(bubble);
  // 可编辑正文。
  const editable = new harness.dom.FakeElement("div");
  editable.setAttribute("contenteditable", "true");
  editable.append(new harness.dom.FakeTextNode("Drafting with Codex"));
  harness.dom.body.append(editable);
  // 壳层文案：必须被替换。
  const heading = new harness.dom.FakeElement("h1");
  heading.append(new harness.dom.FakeTextNode("Codex"));
  harness.dom.body.append(heading);
  const button = new harness.dom.FakeElement("button");
  button.append(new harness.dom.FakeTextNode("New ChatGPT thread"));
  harness.dom.body.append(button);

  harness.install();

  assert.equal(
    markdown.textContent,
    "The Codex agent runs ChatGPT models and OpenAI tooling",
    "markdown body must stay untouched"
  );
  assert.equal(
    code.textContent,
    "console.log('Codex CLI')",
    "code block must stay untouched"
  );
  assert.equal(editable.textContent, "Drafting with Codex", "editable content must stay untouched");
  assert.equal(heading.textContent, "wdev", "shell heading must be rewritten");
  assert.equal(button.textContent, "New wdev thread", "shell button must be rewritten");
});

test("dynamically inserted conversation content is filtered out by the observer", () => {
  const harness = createHarness("wdev");
  harness.install();

  // 模型流式追加的消息：childList 到达时也要走排除判定。
  const markdown = new harness.dom.FakeElement("div");
  markdown.setAttribute("data-markdown-text-style", "");
  const text = markdown.append(new harness.dom.FakeTextNode("Codex wrote the patch"));
  harness.fire([{ type: "childList", addedNodes: [markdown] }]);
  assert.equal(text.nodeValue, "Codex wrote the patch", "streamed message must stay untouched");

  // 裸文本节点落在内容容器内同样跳过。
  const bubble = new harness.dom.FakeElement("div");
  bubble.setAttribute("data-user-message-bubble", "");
  const raw = bubble.append(new harness.dom.FakeTextNode("OpenAI said Codex"));
  harness.fire([{ type: "childList", addedNodes: [raw] }]);
  assert.equal(raw.nodeValue, "OpenAI said Codex");

  // 壳层动态节点仍然替换。
  const menu = new harness.dom.FakeElement("menuitem");
  menu.append(new harness.dom.FakeTextNode("Settings in ChatGPT"));
  harness.fire([{ type: "childList", addedNodes: [menu] }]);
  assert.equal(menu.textContent, "Settings in wdev");
});

test("document title with a conversation name is rewritten", () => {
  const harness = createHarness("wdev");
  harness.dom.document.title = "ChatGPT - 部署 Codex 集群";
  harness.install();
  assert.equal(harness.dom.document.title, "wdev - 部署 wdev 集群");

  // SPA 会话切换后标题变化：走共享 observer 的 characterData 流兜底重检。
  harness.dom.document.title = "ChatGPT - 新会话";
  const titleNode = harness.dom.titleElement.collectTextNodes()[0];
  harness.fire([{ type: "characterData", target: titleNode }]);
  assert.equal(harness.dom.document.title, "wdev - 新会话");
});

test("unconfigured or default brand name does not install the provider", () => {
  for (const brandName of [undefined, "OpenCodex", "  "]) {
    const harness = createHarness(brandName);
    harness.dom.document.title = "ChatGPT - x";
    harness.install();
    assert.equal(harness.subscriptions.length, 0, "no observer without a real brand: " + String(brandName));
    assert.equal(harness.scope.owned.length, 0);
    assert.equal(harness.dom.document.title, "ChatGPT - x", "title must stay untouched");
    assert.equal(harness.scope.emits, 0);
  }
});

test("dispose unsubscribes the shared observer without restoring text", () => {
  const harness = createHarness("wdev");
  harness.dom.document.title = "Codex - 会话";
  harness.install();
  assert.equal(harness.dom.document.title, "wdev - 会话");
  assert.equal(harness.scope.owned.length, 1);

  harness.scope.owned[0]();
  assert.equal(harness.subscriptions.length, 0, "dispose must remove the host subscription");
  assert.equal(harness.window.__opencodexBrandTextInstalled, undefined);
  assert.equal(harness.dom.document.title, "wdev - 会话", "already rewritten text stays rewritten");

  harness.install();
  assert.equal(harness.subscriptions.length, 1, "a new page generation can reinstall");
});

test("the provider stays free of raw observers and timers", () => {
  // 边界约定：Observer 与定时器所有权归共享宿主，Provider 源码不得绕过。
  assert.ok(!/new\s+(?:w\.)?MutationObserver\b/.test(PROVIDER_SOURCE));
  assert.ok(!/\b(?:document|window|w)\.addEventListener\s*\(/.test(PROVIDER_SOURCE));
  assert.ok(!/(?<![.\w])(?:setTimeout|setInterval|requestAnimationFrame)\s*\(/.test(PROVIDER_SOURCE));
  assert.ok(PROVIDER_SOURCE.includes("adapterHost.dom.observe"));
  assert.ok(PROVIDER_SOURCE.includes("modificationScope?.own?.("));
  assert.ok(!PROVIDER_SOURCE.includes("OpenCodexRuntimeCompatibility"));
});

test("the gateway serves the provider and the point is cataloged, bound and localized", (t) => {
  const webviewDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-brand-"));
  t.after(() => fs.rmSync(webviewDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(webviewDir, "index.html"),
    "<html><head><title>Codex</title></head><body></body></html>"
  );
  const service = createStaticAssetService({
    compatibilityService: null,
    getI18nSnapshot: () => ({ locale: "en-US", messages: messagesForLocale("en-US") }),
    getOfficialBundle: () => ({ webviewDir }),
  });

  assert.equal(
    path.basename(service.staticFile(PROVIDER_URL_PATH)),
    "codex-brand-text.js"
  );

  const res = {
    body: Buffer.alloc(0),
    headers: {},
    status: 0,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(body) {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf-8");
    },
  };
  service.serveRuntimeBootstrap({ headers: {} }, res);
  assert.equal(res.status, 200);
  const bootstrap = res.body.toString("utf-8");

  const providerIndex = bootstrap.indexOf('providers.register("' + PROVIDER_KEY + '"');
  assert.ok(providerIndex > 0, "provider must be wrapped by the provider registry");

  // 修改点在目录里声明一次，在骨架里绑定一次，静态资源把文件映射到 provider key。
  const declaration = '"' + POINT_ID + '"';
  const catalogLines = CATALOG_SOURCE.split(NEWLINE).filter((line) => line.includes(declaration));
  assert.equal(catalogLines.length, 1, "the point must be declared exactly once");
  assert.ok(catalogLines[0].includes("G.rendererUi"));
  assert.ok(catalogLines[0].includes("A.semanticView"));
  const bindingLines = BROWSER_HOST_SOURCE.split(NEWLINE).filter((line) => line.includes(POINT_ID));
  assert.equal(bindingLines.length, 1, "the point must bind exactly one provider");
  assert.ok(STATIC_ASSETS_SOURCE.includes('[path.join(INTERNAL_PROVIDER_DIR, "codex-brand-text.js"), "brand-text"]'));
  assert.ok(STATIC_ASSETS_SOURCE.includes('const CODEX_BRAND_TEXT_PATH = "' + PROVIDER_URL_PATH + '"'));

  // 英文必须显式给描述；zh-CN 语言包按仓库约定不承载修改点文案。
  const localeDir = path.join(REPO_ROOT, "shared", "i18n", "locales");
  const enMessages = JSON.parse(
    fs.readFileSync(path.join(localeDir, "runtime-compatibility-en-US.json"), "utf8")
  );
  assert.ok(String(enMessages[I18N_KEY] || "").trim(), "missing " + I18N_KEY + " for en-US");
  const zhMessages = JSON.parse(
    fs.readFileSync(path.join(localeDir, "runtime-compatibility-zh-CN.json"), "utf8")
  );
  const zhPointKeys = Object.keys(zhMessages).filter((key) =>
    key.startsWith("web.runtimeCompatibility.point.")
  );
  assert.deepEqual(zhPointKeys, [], "zh-CN keeps point descriptions in catalog.ts only");
});
