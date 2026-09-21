const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PROVIDER_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "web-shell", "internal", "providers", "codex-menu-item-guard.js"),
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

const POINT_ID = "web.runtime.dom.menu-item-guard";
const PROVIDER_KEY = "menu-item-guard";
const PROVIDER_URL_PATH = "/codex-menu-item-guard.js";
const I18N_KEY = "web.runtimeCompatibility.point." + POINT_ID + ".description";
const NEWLINE = String.fromCharCode(10);

/** camelCase 转 data-* 属性键（dataset.opencodexMenuItemHidden -> data-opencodex-menu-item-hidden）。 */
function toDataKey(key) {
  return "data-" + String(key).replace(/([A-Z])/g, (part) => "-" + part.toLowerCase());
}

/**
 * 最小假 DOM：只实现 Provider 用到的面（TreeWalker 文本遍历、属性/dataset/style
 * 读写、parentElement、querySelectorAll），足够证明「只在菜单上下文里按可见文案
 * 精确匹配隐藏」的窄规则。结构对齐 brand-text.test.cjs 的 harness。
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
      this.className = "";
      this.hidden = false;
      this.disabled = false;
      this.style = {
        display: "",
        // Provider 通过 setProperty(name, value, "important") 写兜底样式。
        setProperty(name, value, priority) {
          this[name] = priority ? String(value) + " " + priority : String(value);
        },
      };
    }
    /** parentElement：Provider 沿它向上找菜单上下文，走到 body 为止。 */
    get parentElement() {
      return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }
    /** dataset：以 camelCase 读写 data-* 属性，隐藏标记就存在这里。 */
    get dataset() {
      const attributes = this.attributes;
      return new Proxy({}, {
        get: (_target, prop) => {
          if (typeof prop !== "string") return undefined;
          return attributes.get(toDataKey(prop));
      },
      set: (_target, prop, value) => {
        attributes.set(toDataKey(prop), String(value));
        return true;
      },
      });
    }
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }
    hasAttribute(name) {
      return this.attributes.has(name);
    }
    append(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    }
    /**
     * 最小 querySelectorAll：只支持 Provider 使用的那一条选择器串
     * （button,a,[role='menuitem'],[role='menuitemradio']，逗号分隔取或）。
     */
    querySelectorAll(selector) {
      const parts = String(selector).split(",").map((part) => part.trim()).filter(Boolean);
      const result = [];
      const visit = (node) => {
        for (const child of node.children || []) {
          if (child.nodeType !== 1) continue;
          if (
            parts.some((part) => {
              const tagMatch = part.match(/^([a-zA-Z][a-zA-Z0-9-]*)$/);
              if (tagMatch) return child.tagName === tagMatch[1].toUpperCase();
              const attrMatch = part.match(/^\[([a-zA-Z-]+)=['\"]?([^'\"]\]]*)['\"]?\]$/);
              if (attrMatch) return child.getAttribute(attrMatch[1]) === attrMatch[2];
              return false;
            })
          ) {
            result.push(child);
          }
          visit(child);
        }
      };
      visit(this);
      return result;
    }
    /** 收集后代文本节点（与真实 TreeWalker SHOW_TEXT 语义一致）。 */
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
  const body = documentElement.append(new FakeElement("body"));

  const document = {
    documentElement,
    head,
    body,
    createTreeWalker(root, whatToShow, filter) {
      let cursor = 0;
      // 与真实 TreeWalker 一致：按 whatToShow 位收集节点（前序遍历）。
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

  return { FakeElement, FakeTextNode, document, documentElement, body };
}

/** 装配假浏览器环境并安装 Provider；observer 桩支持手动 fire 记录。 */
function createHarness() {
  const dom = createFakeDom();
  const subscriptions = [];
  const scope = {
    generation: 5,
    // Provider 每次上报的是本次真实隐藏的项数，按数量累加。
    emits: 0,
    owned: [],
    effects: { primary: { emit: (count) => { scope.emits += Number(count) || 0; } } },
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
  window.__OpenCodexAdapterHost = {
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

/** 建一个菜单上下文容器（role=menu）：Provider 从菜单项向上走到它才认定菜单上下文。 */
function createMenuContext(harness) {
  const menu = new harness.dom.FakeElement("div");
  menu.setAttribute("role", "menu");
  harness.dom.body.append(menu);
  return menu;
}

/** 在菜单上下文里建一个菜单项（button + role=menuitem + 单个文本节点）。 */
function createMenuItem(harness, menu, labelText) {
  const item = new harness.dom.FakeElement("button");
  item.setAttribute("role", "menuitem");
  item.append(new harness.dom.FakeTextNode(labelText));
  menu.append(item);
  return item;
}

/** 断言 Provider 已把整项隐藏：可访问性、Tab 序列、模板样式兜底、disabled 与幂等标记齐全。 */
function assertHidden(element) {
  assert.equal(element.hidden, true, "hidden attribute");
  assert.equal(element.getAttribute("aria-hidden"), "true");
  assert.equal(element.getAttribute("tabindex"), "-1");
  // 假 DOM 的 setProperty 把优先级直接拼进值；真实 DOM 会单独存 priority 位。
  assert.equal(element.style.display, "none important");
  assert.equal(element.disabled, true);
  assert.equal(element.dataset.opencodexMenuItemHidden, "true");
}

/** 断言该节点没有被 Provider 动过。 */
function assertVisible(element) {
  assert.equal(element.hidden, false);
  assert.equal(element.getAttribute("aria-hidden"), null);
  assert.equal(element.dataset.opencodexMenuItemHidden, undefined);
}

test("help and pet menu items are hidden with full accessibility effects", () => {
  const harness = createHarness();
  const menu = createMenuContext(harness);
  const whatsNew = createMenuItem(harness, menu, "What's new");
  const help = createMenuItem(harness, menu, "Help");
  const showPet = createMenuItem(harness, menu, "显示宠物");
  const hidePet = createMenuItem(harness, menu, "Hide pet");

  harness.install();

  assertHidden(whatsNew);
  assertHidden(help);
  assertHidden(showPet);
  assertHidden(hidePet);
  // 首屏真实隐藏 4 项，命中数按数量上报。
  assert.equal(harness.scope.emits, 4);
});

test("multilingual labels all match the hidden list", () => {
  const harness = createHarness();
  const menu = createMenuContext(harness);
  const labels = ["新功能", "帮助", "显示宠物", "隐藏宠物", "Neuigkeiten", "Quoi de neuf"];
  const items = labels.map((label) => createMenuItem(harness, menu, label));

  harness.install();

  for (const item of items) assertHidden(item);
  assert.equal(harness.scope.emits, labels.length);
});

test("identical wording outside a menu context is never touched", () => {
  const harness = createHarness();
  // 正文里一个同名按钮：body 不是菜单上下文，不能隐藏。
  const plain = new harness.dom.FakeElement("button");
  plain.append(new harness.dom.FakeTextNode("Help"));
  harness.dom.body.append(plain);

  harness.install();

  assertVisible(plain);
  assert.equal(harness.scope.emits, 0);
});

test("menu items outside the list, including same-prefix non-brand text, are never touched", () => {
  const harness = createHarness();
  const menu = createMenuContext(harness);
  const shortcuts = createMenuItem(harness, menu, "Keyboard shortcuts");
  // "Help center" 以 Help 为前缀：Provider 按文本节点精确相等匹配，必须不把它误伤。
  const helpCenter = createMenuItem(harness, menu, "Help center");

  harness.install();

  assertVisible(shortcuts);
  assertVisible(helpCenter);
  assert.equal(harness.scope.emits, 0, "no real hit means no report");
});

test("label plus shortcut rendered as separate text nodes still matches", () => {
  const harness = createHarness();
  const menu = createMenuContext(harness);
  // 官方菜单项把标签与快捷键拆成相邻的两个文本节点，标签节点单独精确命中。
  const showPet = new harness.dom.FakeElement("button");
  showPet.setAttribute("role", "menuitem");
  showPet.append(new harness.dom.FakeTextNode("Show pet"));
  showPet.append(new harness.dom.FakeTextNode("Alt+Super+P"));
  menu.append(showPet);
  const showPetCn = new harness.dom.FakeElement("button");
  showPetCn.setAttribute("role", "menuitem");
  showPetCn.append(new harness.dom.FakeTextNode("显示宠物"));
  showPetCn.append(new harness.dom.FakeTextNode("Alt+Super+P"));
  menu.append(showPetCn);

  harness.install();

  assertHidden(showPet);
  assertHidden(showPetCn);
  assert.equal(harness.scope.emits, 2);
});

test("hits are counted once per item and the marker prevents double counting", () => {
  const harness = createHarness();
  const menu = createMenuContext(harness);
  const first = createMenuItem(harness, menu, "What's new");
  const second = createMenuItem(harness, menu, "帮助");

  harness.install();
  assertHidden(first);
  assertHidden(second);
  assert.equal(harness.scope.emits, 2);

  // 宿主把同一容器再次派发（菜单重渲染等场景）：标记生效，不重复隐藏也不重复计数。
  harness.fire([{ type: "childList", addedNodes: [menu] }]);
  assert.equal(harness.scope.emits, 2, "rescanning already marked items must not report again");
  assertHidden(first);
  assertHidden(second);
});

test("dynamically inserted menus are hidden by the shared observer", () => {
  const harness = createHarness();
  harness.install();
  assert.equal(harness.subscriptions.length, 1, "provider must use the host dom.observe");
  assert.equal(harness.window.__opencodexMenuItemGuardInstalled, 5, "installed flag binds the page generation");

  // 菜单是官方点开时才挂载的：childList 到达时同样要扫描并隐藏。
  const menu = createMenuContext(harness);
  const item = createMenuItem(harness, menu, "新功能");
  harness.fire([{ type: "childList", addedNodes: [menu] }]);

  assertHidden(item);
  assert.equal(harness.scope.emits, 1);
});

test("dispose unsubscribes the shared observer and clears the installed flag", () => {
  const harness = createHarness();
  const menu = createMenuContext(harness);
  const item = createMenuItem(harness, menu, "Help");
  harness.install();
  assertHidden(item);
  assert.equal(harness.scope.owned.length, 1);

  harness.scope.owned[0]();
  assert.equal(harness.subscriptions.length, 0, "dispose must remove the host subscription");
  assert.equal(harness.window.__opencodexMenuItemGuardInstalled, undefined);

  // dispose 后没有任何存活订阅，新插入的菜单项不再被扫描、不再被隐藏。
  const later = createMenuItem(harness, menu, "显示宠物");
  assertVisible(later);

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
  const webviewDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-menu-guard-"));
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
    "codex-menu-item-guard.js"
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
  assert.ok(bindingLines[0].includes('key: "' + PROVIDER_KEY + '"'));
  assert.ok(
    STATIC_ASSETS_SOURCE.includes('[path.join(INTERNAL_PROVIDER_DIR, "codex-menu-item-guard.js"), "' + PROVIDER_KEY + '"]')
  );
  assert.ok(STATIC_ASSETS_SOURCE.includes('const CODEX_MENU_ITEM_GUARD_PATH = "' + PROVIDER_URL_PATH + '"'));
  assert.ok(
    STATIC_ASSETS_SOURCE.includes('[CODEX_MENU_ITEM_GUARD_PATH, path.join(INTERNAL_PROVIDER_DIR, "codex-menu-item-guard.js")]')
  );
  assert.ok(STATIC_ASSETS_SOURCE.includes("runtimeScript(CODEX_MENU_ITEM_GUARD_PATH)"));

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
