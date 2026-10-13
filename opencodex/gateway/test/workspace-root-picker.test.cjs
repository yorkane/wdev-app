"use strict";

/**
 * 远端浏览器「选择文件夹」弹窗的回归测试。
 *
 * 三层契约：
 *   1. 两个官方协议只在 Web 页面接管；服务端声明「有用户看得见的原生目录框」且页面走回环时才放行；
 *   2. 目录浏览走官方 app-server 的 fs/readDirectory（mcp-request → mcp-response）：
 *      进入/上级/面包屑/隐藏目录开关/缓存/选择面板/空目录/失败降级手输路径；
 *   3. 提交后的校验与投递语义（单/多选、部分失败不产生半完成投递）。
 *
 * 用 node:vm + 手写假 DOM，只实现 picker 实际使用的子集，不引入浏览器依赖。
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PICKER_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "web-shell", "internal", "providers", "codex-workspace-root-picker.js"),
  "utf-8"
);

const VALIDATE_CHANNEL = "opencodex:validate-workspace-root";
const MESSAGE_FROM_VIEW = "codex_desktop:message-from-view";
const ADD_MESSAGE = "electron-add-new-workspace-root-option";
const PICK_MESSAGE = "electron-pick-workspace-root-option";
const PICKED_MESSAGE = "workspace-root-option-picked";
const LIST_CLASS = "codex-web-workspace-root-list";
const DIALOG_CLASS = "codex-web-workspace-root-dialog";
const BACKDROP_CLASS = "codex-web-workspace-root-backdrop";

// 每个 harness 登记自己创建的定时器，用例结束后统一清掉：
// 浏览超时是真实行为，不能让未触发的定时器拖住测试进程退出。
const pendingTimers = [];
test.after(() => {
  for (const timers of pendingTimers) for (const timer of timers) clearTimeout(timer);
  pendingTimers.length = 0;
});

function passthroughMessages() {
  // Proxy 让任意 web.workspaceRoot.* key 都返回自身，等价于「宿主有完整文案」的场景。
  return new Proxy(
    {},
    {
      get: (target, key) => (typeof key === "string" ? key : undefined),
      has: () => true,
    }
  );
}

function basename(dirPath) {
  return path.basename(dirPath);
}

function serializable(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function matchesAttributeSelector(element, selector) {
  const conditions = [...String(selector).matchAll(/\[([a-zA-Z-]+)="([^"]*)"\]/g)];
  return conditions.length > 0 && conditions.every(([, name, value]) => String(element.attributes?.[name] ?? "") === value);
}

function createFakeElement(tagName, elements) {
  // 测试只实现 picker 实际使用的 DOM 子集：类名、属性、子节点和按类型注册的监听器。
  const element = {
    attributes: {},
    children: [],
    checked: false,
    className: "",
    disabled: false,
    listeners: new Map(),
    parentNode: null,
    removed: false,
    tagName: String(tagName || "").toUpperCase(),
    textContent: "",
    type: "",
    value: "",
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    close() {
      this.open = false;
      const handler = this.listeners.get("close");
      if (handler) handler({});
    },
    closest(selector) {
      let node = this;
      while (node) {
        if (matchesAttributeSelector(node, selector)) return node;
        node = node.parentNode;
      }
      return null;
    },
    focus() {
      this.focused = true;
    },
    remove() {
      this.removed = true;
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    },
    removeEventListener(type, handler) {
      if (this.listeners.get(type) === handler) this.listeners.delete(type);
    },
    replaceChildren(...children) {
      // 递归标记整棵旧子树：真实浏览器里这些节点一起脱离文档，类名查询不能再命中。
      for (const child of this.children) {
        for (const node of descendants(child)) node.removed = true;
        child.removed = true;
      }
      this.children = [];
      for (const child of children) this.appendChild(child);
    },
    select() {
      this.selected = true;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    showModal() {
      this.open = true;
    },
  };
  elements.push(element);
  return element;
}

function descendants(element) {
  const out = [];
  for (const child of element.children || []) {
    if (child.removed) continue;
    out.push(child, ...descendants(child));
  }
  return out;
}

function makeFsReadDirectoryService(rootDir) {
  // 用真实临时目录树跑 fs/readDirectory，避免在测试里复制一份官方目录语义。
  const root = fs.realpathSync(rootDir);
  return function readDirectory(dirPath) {
    const resolved = fs.realpathSync(path.resolve(String(dirPath || ".")));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      const error = new Error("permission denied: " + resolved);
      error.jsonRpcCode = -32001;
      throw error;
    }
    const entries = [];
    for (const name of fs.readdirSync(resolved)) {
      const entryPath = path.join(resolved, name);
      let stats = null;
      try {
        stats = fs.statSync(entryPath);
      } catch {
        continue;
      }
      entries.push({
        fileName: name,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
      });
    }
    return { entries };
  };
}

function createTree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ocx-picker-")));
  fs.mkdirSync(path.join(root, ".hidden"));
  fs.mkdirSync(path.join(root, "alpha", "beta"), { recursive: true });
  fs.mkdirSync(path.join(root, "gamma"));
  fs.mkdirSync(path.join(root, "my docs"));
  fs.writeFileSync(path.join(root, "readme.md"), "x");
  fs.writeFileSync(path.join(root, "alpha", "note.txt"), "x");
  return root;
}

function createPickerHarness(options = {}) {
  const {
    hostname = "remote.example.com",
    nativeFolderPicker,
    resolvePath,
    browseRoot,
    readDirectory,
    mcpFails = false,
    mcpErrorMessage = "app-server is busy",
    messages = "passthrough",
  } = options;
  const treeRoot = browseRoot || createTree();
  const listingService = typeof readDirectory === "function" ? readDirectory : makeFsReadDirectoryService(treeRoot);
  const delivered = [];
  const elements = [];
  const invokes = [];
  const readDirectoryCalls = [];
  const toasts = [];
  const windowListeners = new Map();
  const timers = [];
  pendingTimers.push(timers);
  const body = createFakeElement("body", elements);
  const document = {
    body,
    activeElement: null,
    createElement(tagName) {
      return createFakeElement(tagName, elements);
    },
    querySelector(selector) {
      return elements.find((element) => !element.removed && matchesAttributeSelector(element, selector)) || null;
    },
  };
  const dispatchWindowMessage = (data) => {
    const handler = windowListeners.get("message");
    if (typeof handler === "function") handler({ data });
  };
  const window = {
    __CODEX_WEB_CONFIG__: {
      // 服务端注入的浏览边界：picker 用它做面包屑根与「上级」禁用判定，不虚构边界。
      workspaceRoots: [treeRoot],
      nativeFolderPicker: nativeFolderPicker === true,
      // 假 i18n：按 key 透传，让断言能直接比对文案 key；
      // picker 的内置兜底只在真实文案缺失时生效，由单独用例覆盖。
      messages: messages === "passthrough" ? passthroughMessages() : messages,
    },
    __OpenCodexAdapterHost: {
      events: {
        observe({ target, type, callback, capture = false }) {
          target.addEventListener(type, callback, capture);
          return () => target.removeEventListener(type, callback, capture);
        },
      },
    },
    __codexWebBridgeHelpers: {
      deliverLocalRendererMessage(channel, payload) {
        delivered.push({ channel, payload: serializable(payload) });
        return 1;
      },
      async invoke(channel, payload) {
        const normalizedPayload = serializable(payload);
        invokes.push({ channel, payload: normalizedPayload });
        if (channel === VALIDATE_CHANNEL) {
          const raw = normalizedPayload.path;
          // resolvePath 允许返回 promise，用来模拟校验挂起。
          const root = typeof resolvePath === "function" ? await resolvePath(raw) : fs.realpathSync(path.resolve(raw));
          return { root };
        }
        const request = normalizedPayload && normalizedPayload.request;
        if (
          channel === MESSAGE_FROM_VIEW &&
          normalizedPayload.type === "mcp-request" &&
          request &&
          request.method === "fs/readDirectory"
        ) {
          readDirectoryCalls.push(request.params.path);
          Promise.resolve().then(() => {
            if (mcpFails) {
              dispatchWindowMessage({
                type: "mcp-response",
                message: { id: request.id, error: { code: -32603, message: mcpErrorMessage } },
              });
              return;
            }
            try {
              dispatchWindowMessage({
                type: "mcp-response",
                message: { id: request.id, result: listingService(request.params.path) },
              });
            } catch (error) {
              dispatchWindowMessage({
                type: "mcp-response",
                message: { id: request.id, error: { code: -32001, message: error.message } },
              });
            }
          });
          return true;
        }
        return true;
      },
      normalizeErrorMessage(error) {
        return error && error.message ? error.message : String(error || "");
      },
      showToast(payload) {
        toasts.push(serializable(payload));
      },
      t(key) {
        return key;
      },
    },
    addEventListener(type, handler) {
      windowListeners.set(type, handler);
    },
    dispatchEvent() {},
    location: { hostname },
    removeEventListener(type, handler) {
      if (windowListeners.get(type) === handler) windowListeners.delete(type);
    },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    // picker 经 adapterHost.scheduler 缺省回退到 window，因此假 window 必须提供定时器，
    // 否则在途请求的超时清理会抛 TypeError，弹窗 promise 永不 settle。
    setTimeout(callback, delay) {
      const timer = setTimeout(callback, delay);
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      clearTimeout(timer);
    },
  };

  vm.runInNewContext(PICKER_SOURCE, { console, document, window });
  return {
    api: window.OpenCodexWorkspaceRootPicker,
    body,
    document,
    delivered,
    elements,
    invokes,
    readDirectoryCalls,
    toasts,
    treeRoot,
    window,
    windowListeners,
    timers,
  };
}

function settle() {
  // mcp 回包经过 Promise 链与 rAF，多轮宏任务flush 让 DOM 收敛到稳定状态。
  return new Promise((resolve) => setImmediate(() => setImmediate(() => setImmediate(resolve))));
}

function byClass(harness, className) {
  return harness.elements.filter((element) => !element.removed && element.className.split(/\s+/).includes(className));
}

function textByClass(harness, className) {
  return byClass(harness, className).map((element) => element.textContent);
}

function ancestorWithClass(element, className) {
  let node = element;
  while (node) {
    if (node.className && node.className.split(/\s+/).includes(className)) return node;
    node = node.parentNode;
  }
  return null;
}

function fire(element, type, event = {}) {
  const handler = element.listeners.get(type);
  assert.equal(typeof handler, "function", `missing ${type} handler on ${element.tagName} ${element.className}`);
  return handler({ preventDefault() {}, stopPropagation() {}, target: element, ...event });
}

function makeTrackedEvent(extra = {}) {
  // fire() 会把事件对象并入一个新对象，所以标记必须写在闭包变量上而不是 `this`。
  const state = { defaultPrevented: false, propagationStopped: false };
  return {
    ...extra,
    get defaultPrevented() {
      return state.defaultPrevented;
    },
    get propagationStopped() {
      return state.propagationStopped;
    },
    preventDefault() {
      state.defaultPrevented = true;
    },
    stopPropagation() {
      state.propagationStopped = true;
    },
  };
}

function dialog(harness) {
  return byClass(harness, DIALOG_CLASS)[0];
}

function backdrop(harness) {
  return byClass(harness, BACKDROP_CLASS)[0];
}

function form(harness) {
  return byClass(harness, "codex-web-workspace-root-panel")[0];
}

function primaryButton(harness) {
  return byClass(harness, "codex-web-workspace-root-button-primary")[0];
}

function toolButton(harness, ariaLabel) {
  const button = byClass(harness, "codex-web-workspace-root-tool").find(
    (element) => element.attributes["aria-label"] === ariaLabel
  );
  assert.ok(button, `toolbar button ${ariaLabel} should exist`);
  return button;
}

function rowFor(harness, label) {
  const labelNode = byClass(harness, "codex-web-workspace-root-row-label").find(
    (element) => element.textContent === label
  );
  assert.ok(
    labelNode,
    `row ${label} should exist, have ${JSON.stringify(textByClass(harness, "codex-web-workspace-root-row-label"))}`
  );
  return ancestorWithClass(labelNode, "codex-web-workspace-root-row");
}

function checkboxIn(element) {
  return descendants(element).find((node) => node.tagName === "INPUT" && node.type === "checkbox");
}

function pathInput(harness) {
  const input = byClass(harness, "codex-web-workspace-root-input")[0];
  assert.ok(input, "path input should exist");
  return input;
}

function openDialog(harness, payload) {
  const handled = harness.api.handleMessage(payload);
  assert.equal(typeof handled.then, "function", "picker should open a modal and return a promise");
  // promise 只在弹窗关闭时 settle，所以不能由“打开弹窗”这一步 await；
  // 它挂在 harness 上，供用例在提交/取消之后显式 await。
  harness.handled = handled;
  return handled;
}

async function openAndSettle(harness, payload) {
  openDialog(harness, payload);
  await settle();
}

async function clickRow(harness, label) {
  fire(rowFor(harness, label), "click");
  await settle();
}

async function clickCheckbox(harness, label) {
  const row = rowFor(harness, label);
  const checkbox = checkboxIn(row);
  assert.ok(checkbox, `checkbox for ${label} should exist`);
  checkbox.checked = !checkbox.checked;
  fire(checkbox, "click");
  await settle();
}

async function submitForm(harness, value) {
  const input = pathInput(harness);
  input.value = value;
  await fire(form(harness), "submit");
  await settle();
}

function mountParentDialog(harness, options = {}) {
  // 模拟官方「新建项目」的 Radix 对话框：picker 必须挂进它内部，并在取消时原样返回。
  const parent = createFakeElement("div", harness.elements);
  parent.className = "codex-official-project-dialog";
  parent.setAttribute("role", "dialog");
  parent.setAttribute("data-state", "open");
  const trigger = createFakeElement("button", harness.elements);
  trigger.textContent = "Browse";
  parent.appendChild(trigger);
  harness.body.appendChild(parent);
  harness.window.__CODEX_WEB_CONFIG__.nativeFolderPicker = options.nativeFolderPicker === true;
  harness.document.activeElement = trigger;
  return { parent, trigger };
}

test("workspace root picker intercepts both official protocols only in the web page", () => {
  const remote = createPickerHarness();
  assert.equal(remote.api.shouldHandleMessage({ type: ADD_MESSAGE }), true);
  // 带 root 的旧协议消息是适配器校验后的二次转发，放行才不成环。
  assert.equal(remote.api.shouldHandleMessage({ type: PICK_MESSAGE }), true);
  assert.equal(remote.api.shouldHandleMessage({ type: "unrelated-message" }), false);

  // 回环访问（含 authz simulate_local 改写 Host）同样接管：放行官方协议只会让
  // headless 网关的目录框渲染进隐藏窗口，表现为点击静默无反应。
  const loopback = createPickerHarness({ hostname: "127.0.0.1" });
  assert.equal(loopback.api.shouldHandleMessage({ type: ADD_MESSAGE }), true);
  assert.equal(loopback.api.shouldHandleMessage({ type: PICK_MESSAGE }), true);

  const desktopClaim = createPickerHarness({ hostname: "localhost", nativeFolderPicker: true });
  assert.equal(
    desktopClaim.api.shouldHandleMessage({ type: PICK_MESSAGE }),
    true,
    "服务端标志也不能放行：这个 provider 只在浏览器里运行"
  );
});

test("legacy add protocol browses the served tree and forwards the picked root to official Main", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  await openAndSettle(harness, { type: ADD_MESSAGE, source: "menu", path: root });

  assert.deepEqual(textByClass(harness, "codex-web-workspace-root-row-label"), [
    "alpha",
    "gamma",
    "my docs",
    "readme.md",
  ]);
  assert.deepEqual(textByClass(harness, "codex-web-workspace-root-breadcrumb-current"), [
    basename(root),
  ]);
  assert.equal(checkboxIn(rowFor(harness, "alpha")), undefined, "单选协议不显示复选框");

  await fire(form(harness), "submit");
  await harness.handled;

  const forwards = harness.invokes.filter(
    (entry) => entry.channel === MESSAGE_FROM_VIEW && entry.payload.type === ADD_MESSAGE
  );
  assert.deepEqual(harness.invokes.filter((entry) => entry.channel === VALIDATE_CHANNEL).map((e) => e.payload.path), [
    root,
  ]);
  assert.deepEqual(forwards, [
    { channel: MESSAGE_FROM_VIEW, payload: { type: ADD_MESSAGE, source: "menu", path: root, root } },
  ]);
  assert.deepEqual(harness.delivered, []);
  assert.deepEqual(harness.toasts, []);
  assert.equal(dialog(harness), undefined, "提交成功后弹窗关闭");
});

test("new pick protocol returns the browsed directory directly to official Renderer", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  await openAndSettle(harness, { type: PICK_MESSAGE, allowMultiple: false, path: root });

  assert.equal(pathInput(harness).value, root);
  await clickRow(harness, "alpha");
  assert.equal(pathInput(harness).value, path.join(root, "alpha"));

  await fire(form(harness), "submit");
  await harness.handled;

  assert.deepEqual(harness.readDirectoryCalls, [root, path.join(root, "alpha")]);
  assert.deepEqual(harness.delivered, [{ channel: PICKED_MESSAGE, payload: { root: path.join(root, "alpha") } }]);
  assert.deepEqual(harness.toasts, []);
});

test("multi-pick protocol validates, deduplicates, and returns checked roots in click order", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  await openAndSettle(harness, { type: PICK_MESSAGE, params: { allowMultiple: true }, path: root });

  const textarea = pathInput(harness);
  assert.equal(textarea.tagName, "TEXTAREA");
  assert.equal(textarea.value, `\n${root}\n`);

  await clickCheckbox(harness, "gamma");
  await clickCheckbox(harness, "alpha");
  await clickCheckbox(harness, "alpha");
  assert.deepEqual(harness.toasts, []);
  // 复选框重复点击是取消勾选，不会留下重复条目。
  assert.deepEqual(textByClass(harness, "codex-web-workspace-root-selection-label"), [path.join(root, "gamma")]);

  await clickCheckbox(harness, "alpha");
  // 粘贴多行路径时按行去重并保持输入顺序。
  textarea.value = `\n${path.join(root, "gamma")}\n${path.join(root, "alpha")}\n${path.join(root, "gamma")}\n`;
  fire(textarea, "input");
  await settle();
  assert.equal(textarea.value, `\n${path.join(root, "gamma")}\n${path.join(root, "alpha")}\n`);
  assert.deepEqual(textByClass(harness, "codex-web-workspace-root-selection-label"), [
    path.join(root, "gamma"),
    path.join(root, "alpha"),
  ]);

  await fire(form(harness), "submit");
  await harness.handled;

  assert.deepEqual(
    harness.invokes.filter((entry) => entry.channel === VALIDATE_CHANNEL).map((entry) => entry.payload.path),
    [path.join(root, "gamma"), path.join(root, "alpha")]
  );
  assert.deepEqual(harness.delivered, [
    { channel: PICKED_MESSAGE, payload: { root: path.join(root, "gamma") } },
    { channel: PICKED_MESSAGE, payload: { root: path.join(root, "alpha") } },
  ]);
  assert.deepEqual(harness.toasts, []);
  assert.equal(dialog(harness), undefined);
});

test("multi-pick protocol delivers no partial selection when validation fails", async () => {
  const root = createTree();
  const harness = createPickerHarness({
    browseRoot: root,
    resolvePath(rawPath) {
      if (rawPath === path.join(root, "alpha")) throw new Error("not found");
      return rawPath;
    },
  });
  await openAndSettle(harness, { type: PICK_MESSAGE, allowMultiple: true, path: root });
  await clickCheckbox(harness, "alpha");
  await clickCheckbox(harness, "gamma");

  await fire(form(harness), "submit");
  await settle();

  // 两个路径先全部校验，任一失败都保留弹窗且不污染官方工程表单。
  assert.deepEqual(harness.delivered, []);
  assert.equal(harness.toasts.length, 1);
  assert.ok(dialog(harness), "校验失败时弹窗保留");
  const textarea = pathInput(harness);
  assert.equal(textarea.disabled, false);
  assert.equal(textarea.value, `\n${path.join(root, "alpha")}\n${path.join(root, "gamma")}\n`);
});

test("directory browser navigates into, up, and disables the parent control at the boundary", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  await openAndSettle(harness, { type: PICK_MESSAGE, path: root });
  const upButton = toolButton(harness, "web.workspaceRoot.dialog.up");

  assert.equal(upButton.disabled, true, "浏览边界目录时上级按钮禁用");
  await clickRow(harness, "alpha");
  assert.deepEqual(textByClass(harness, "codex-web-workspace-root-row-label"), ["beta", "note.txt"]);
  assert.deepEqual(textByClass(harness, "codex-web-workspace-root-breadcrumb-current"), ["alpha"]);
  assert.deepEqual(textByClass(harness, "codex-web-workspace-root-breadcrumb-item"), [basename(root), "alpha"]);
  assert.equal(upButton.disabled, false);

  fire(upButton, "click");
  await settle();
  assert.deepEqual(textByClass(harness, "codex-web-workspace-root-breadcrumb-current"), [
    basename(root),
  ]);
  assert.equal(upButton.disabled, true);
});

test("breadcrumb jumps to an ancestor and hidden toggle refetches without refetching cached listings", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  await openAndSettle(harness, { type: PICK_MESSAGE, path: root });
  const hiddenButton = toolButton(harness, "web.workspaceRoot.dialog.showHidden");

  assert.equal(harness.readDirectoryCalls.length, 1);
  assert.equal(hiddenButton.attributes["aria-pressed"], "false");
  await clickRow(harness, "alpha");
  assert.equal(harness.readDirectoryCalls.length, 2);

  fire(hiddenButton, "click");
  await settle();
  assert.equal(hiddenButton.attributes["aria-pressed"], "true");
  assert.deepEqual(textByClass(harness, "codex-web-workspace-root-row-label"), ["beta", "note.txt"]);
  assert.equal(harness.readDirectoryCalls.length, 3, "隐藏目录开关需要新的清单");

  const firstCrumb = byClass(harness, "codex-web-workspace-root-breadcrumb-item")[0];
  fire(firstCrumb, "click");
  await settle();
  assert.deepEqual(textByClass(harness, "codex-web-workspace-root-row-label"), [
    ".hidden",
    "alpha",
    "gamma",
    "my docs",
    "readme.md",
  ]);
  assert.equal(harness.readDirectoryCalls.length, 4, "根目录按当前显示隐藏设置复用缓存");
});

test("empty directory listing shows the empty state and keeps the current folder selectable", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  await openAndSettle(harness, { type: PICK_MESSAGE, path: root });

  await clickRow(harness, "alpha");
  await clickRow(harness, "beta");
  assert.deepEqual(textByClass(harness, "codex-web-workspace-root-breadcrumb-current"), ["beta"]);
  assert.deepEqual(textByClass(harness, "codex-web-workspace-root-breadcrumb-item"), [
    basename(root),
    "alpha",
    "beta",
  ]);
  assert.deepEqual(textByClass(harness, "codex-web-workspace-root-browse-empty"), ["web.workspaceRoot.dialog.empty"]);
  assert.equal(byClass(harness, "codex-web-workspace-root-row").length, 0);
  assert.equal(primaryButton(harness).disabled, false, "空目录仍是合法选择");
  assert.equal(pathInput(harness).value, path.join(root, "alpha", "beta"));

  await fire(form(harness), "submit");
  await harness.handled;
  assert.deepEqual(harness.delivered, [
    { channel: PICKED_MESSAGE, payload: { root: path.join(root, "alpha", "beta") } },
  ]);
});

test("mcp failures toast once, fall back to manual path input, and keep the dialog usable", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root, mcpFails: true });
  await openAndSettle(harness, { type: PICK_MESSAGE, path: root });

  const input = pathInput(harness);
  assert.equal(input.tagName, "INPUT");
  assert.equal(input.focused, true);
  assert.equal(byClass(harness, LIST_CLASS).length, 0, "浏览失败后不再渲染目录列表");
  assert.equal(harness.toasts.length, 1);
  assert.match(harness.toasts[0].description, /app-server is busy/);
  assert.deepEqual(harness.readDirectoryCalls, [root, "/data", "/"]);
  assert.equal(toolButton(harness, "web.workspaceRoot.dialog.browseMode").textContent, "web.workspaceRoot.dialog.browseMode");

  await submitForm(harness, path.join(root, "alpha"));
  assert.deepEqual(harness.delivered, [{ channel: PICKED_MESSAGE, payload: { root: path.join(root, "alpha") } }]);
});

test("permission-denied start path silently falls back to the configured root", async () => {
  const root = createTree();
  const harness = createPickerHarness({
    browseRoot: root,
    readDirectory(dirPath) {
      if (dirPath === "/denied") {
        const error = new Error("permission denied");
        error.jsonRpcCode = -32001;
        throw error;
      }
      return makeFsReadDirectoryService(root)(dirPath);
    },
  });
  // 首选路径不可读时继续尝试配置根：能恢复就静默恢复，不打扰用户。
  await openAndSettle(harness, { type: PICK_MESSAGE, allowMultiple: true, path: "/denied" });

  assert.deepEqual(harness.toasts, []);
  assert.ok(dialog(harness), "回落到可读根后弹窗保留");
  assert.equal(byClass(harness, LIST_CLASS).length, 1, "回落到配置根后仍可浏览");
  assert.equal(harness.readDirectoryCalls[0], "/denied");
  assert.equal(harness.readDirectoryCalls[1], root);
  assert.equal(checkboxIn(rowFor(harness, "alpha")).checked, false);
});

test("manual path mode can be opened explicitly, keeps checked selections, and returns to browsing", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  await openAndSettle(harness, { type: PICK_MESSAGE, allowMultiple: true, path: root });
  await clickCheckbox(harness, "alpha");

  fire(toolButton(harness, "web.workspaceRoot.dialog.pathMode"), "click");
  await settle();
  const textarea = pathInput(harness);
  assert.equal(textarea.value, `\n${path.join(root, "alpha")}\n`);
  assert.equal(byClass(harness, LIST_CLASS).length, 0);
  assert.equal(textByClass(harness, "codex-web-workspace-root-selection-label").length, 1);

  fire(toolButton(harness, "web.workspaceRoot.dialog.browseMode"), "click");
  await settle();
  assert.equal(byClass(harness, LIST_CLASS).length, 1);
  assert.equal(checkboxIn(rowFor(harness, "alpha")).checked, true, "回到浏览模式后勾选状态保留");
});

test("selection chips can be removed and mirror the textarea used by submit", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  await openAndSettle(harness, { type: PICK_MESSAGE, allowMultiple: true, path: root });
  await clickCheckbox(harness, "alpha");
  await clickCheckbox(harness, "gamma");

  const chips = byClass(harness, "codex-web-workspace-root-selection-remove");
  assert.deepEqual(textByClass(harness, "codex-web-workspace-root-selection-label"), [
    path.join(root, "alpha"),
    path.join(root, "gamma"),
  ]);
  fire(chips[0], "click");
  await settle();
  assert.equal(pathInput(harness).value, `\n${path.join(root, "gamma")}\n`);
  assert.equal(checkboxIn(rowFor(harness, "alpha")).checked, false);
  assert.equal(checkboxIn(rowFor(harness, "gamma")).checked, true);
});

test("Escape closes the modal, settles the promise, and removes the global listeners", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  await openAndSettle(harness, { type: PICK_MESSAGE, path: root });

  assert.equal(typeof harness.windowListeners.get("keydown"), "function");
  assert.equal(harness.windowListeners.get("message"), undefined, "目录读取回包后即时注销消息监听");
  harness.windowListeners.get("keydown")({ key: "Escape", preventDefault() {} });
  await harness.handled;

  assert.equal(dialog(harness), undefined);
  assert.equal(harness.windowListeners.size, 0, "关闭后不留任何 window 监听");
  assert.deepEqual(harness.delivered, []);
  assert.deepEqual(harness.toasts, []);
});

test("backdrop click cancels the modal without submitting", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  await openAndSettle(harness, { type: PICK_MESSAGE, path: root });

  fire(backdrop(harness), "click", { target: backdrop(harness) });
  await harness.handled;
  assert.equal(dialog(harness), undefined);
  assert.deepEqual(harness.delivered, []);
});

test("repeat requests reuse the open dialog instead of stacking a second one", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  await openAndSettle(harness, { type: PICK_MESSAGE, path: root });
  const first = dialog(harness);
  await clickRow(harness, "alpha");
  const handled = harness.api.handleMessage({ type: PICK_MESSAGE, path: root });
  await settle();

  assert.equal(dialog(harness), first, "同一时刻只允许一个目录弹窗");
  assert.equal(first.focused, true, "重复点击只把焦点拉回弹窗");
  assert.equal(harness.readDirectoryCalls.length, 2, "复用弹窗不会重新拉取目录");
  assert.equal(byClass(harness, LIST_CLASS).length, 1);

  await fire(form(harness), "submit");
  await harness.handled;
  assert.deepEqual(harness.delivered, [{ channel: PICKED_MESSAGE, payload: { root: path.join(root, "alpha") } }]);
});

test("missing i18n keys fall back to built-in copy instead of leaking raw keys", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root, messages: {} });
  await openAndSettle(harness, { type: PICK_MESSAGE, path: root });

  // 边界就是本次浏览的临时目录根，所以根节点显示目录名；重点是新增控件不得裸露 key。
  const crumbs = textByClass(harness, "codex-web-workspace-root-breadcrumb-current");
  assert.deepEqual(crumbs, [path.basename(root)]);
  const buttons = byClass(harness, "codex-web-workspace-root-tool");
  const labels = buttons.map((button) => button.attributes["aria-label"]);
  assert.ok(labels.includes("上级"), labels.join(","));
  assert.ok(labels.includes("路径输入"), labels.join(","));
  assert.equal(harness.toasts.length, 0);
  // 本轮新增的 key 必须有内置文案；老 key 由 gateway 注入，缺失时保持原有降级行为。
  const NEW_KEYS = [
    "browseRoot",
    "up",
    "showHidden",
    "pathMode",
    "browseMode",
    "empty",
    "loading",
    "truncated",
    "selectFolder",
    "removeSelection",
  ].map((name) => "web.workspaceRoot.dialog." + name);
  for (const element of harness.elements) {
    if (element.removed) continue;
    const text = String(element.textContent || "");
    const aria = String(element.attributes["aria-label"] || "");
    assert.ok(!NEW_KEYS.includes(text), "裸露新增 key: " + text);
    assert.ok(!NEW_KEYS.includes(aria), "裸露新增 aria key: " + aria);
  }
});

test("file entries are listed for context but cannot be selected", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  await openAndSettle(harness, { type: PICK_MESSAGE, allowMultiple: true, path: root });
  const fileRow = rowFor(harness, "readme.md");

  assert.equal(checkboxIn(fileRow), undefined);
  assert.equal(fileRow.attributes["aria-disabled"], "true");
  assert.equal(fileRow.listeners.get("click"), undefined, "文件行不挂点击处理器");
  await settle();
  assert.equal(pathInput(harness).value, `\n${root}\n`);
  assert.deepEqual(textByClass(harness, "codex-web-workspace-root-selection-label"), []);
});

test("cancelling while validation hangs ignores the late validation result", async () => {
  const root = createTree();
  let releaseValidation = null;
  const harness = createPickerHarness({
    browseRoot: root,
    resolvePath(rawPath) {
      // 校验挂起：模拟 gateway 迟迟不返回，用户在此期间关闭弹窗。
      return new Promise((resolve) => {
        releaseValidation = () => resolve(rawPath);
      });
    },
  });
  await openAndSettle(harness, { type: PICK_MESSAGE, path: root });

  // 校验挂起中，submit 监听器返回的 promise 不会结束：这里只触发不等待。
  fire(form(harness), "submit");
  await settle();
  assert.ok(releaseValidation, "提交应已发起校验");
  assert.deepEqual(harness.delivered, []);

  harness.windowListeners.get("keydown")({ key: "Escape", preventDefault() {} });
  await harness.handled;
  assert.equal(dialog(harness), undefined);

  // 校验迟到的结果必须被丢弃：弹窗已关闭，不能污染官方工程表单。
  releaseValidation();
  await settle();
  await settle();
  assert.deepEqual(harness.delivered, []);
  assert.equal(harness.toasts.length, 0);
});

test("cancel settles the promise and ignores a late mcp response", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  const handled = harness.api.handleMessage({ type: PICK_MESSAGE, path: root });
  await settle();

  fire(byClass(harness, "codex-web-workspace-root-close")[0], "click");
  await handled;
  assert.equal(dialog(harness), undefined);

  // 关闭后到达的回包必须被丢弃：不抛未处理拒绝，也不产生投递。
  const listener = harness.windowListeners.get("message");
  assert.equal(listener, undefined, "关闭时消息监听已注销");
  assert.deepEqual(harness.delivered, []);
});

test("dialog is mounted inside the triggering parent dialog so it is not an outside interaction", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  const { parent, trigger } = mountParentDialog(harness);
  await openAndSettle(harness, { type: PICK_MESSAGE, path: root });

  const panel = dialog(harness);
  assert.equal(panel.parentNode, parent, "目录弹窗必须挂进触发它的官方对话框");
  assert.equal(byClass(harness, DIALOG_CLASS)[0], panel);
  assert.ok(
    !harness.body.children.includes(panel),
    "不能落到 body：官方模态层会把 body 子节点判成 outside interaction 后关掉创建表单"
  );
  assert.equal(parent.attributes["data-state"], "open", "父对话框在目录选择期间保持打开");
  assert.equal(trigger.focused, undefined, "打开期间焦点留在目录弹窗，不提前还给触发按钮");
});

test("native cancel closes the picker and leaves the parent dialog open", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  const { parent, trigger } = mountParentDialog(harness);
  const handled = harness.api.handleMessage({ type: PICK_MESSAGE, path: root });
  await settle();
  const panel = dialog(harness);

  // 原生 <dialog> 的 Esc 走 cancel 事件，不会经过 window keydown 的兜底路径。
  const cancelEvent = makeTrackedEvent();
  fire(panel, "cancel", cancelEvent);
  await handled;

  assert.equal(cancelEvent.defaultPrevented, true, "cancel 必须 preventDefault，否则父层可能跟着关");
  assert.equal(dialog(harness), undefined, "目录弹窗已关闭");
  assert.equal(panel.removed, true);
  assert.ok(!parent.children.includes(panel), "目录弹窗从父对话框子树里摘干净");
  assert.equal(parent.attributes["data-state"], "open", "父对话框状态不受取消影响");
  assert.equal(parent.removed, false, "父对话框不能被一起关掉");
  assert.deepEqual(harness.delivered, [], "取消不产生任何投递");

  await settle();
  assert.equal(trigger.focused, true, "关闭后焦点交还触发按钮");
});

test("submit stops propagating so the parent form does not create a project", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  const { parent, trigger } = mountParentDialog(harness);
  let parentSubmitted = 0;
  parent.addEventListener("submit", (event) => {
    parentSubmitted += 1;
  });
  await openAndSettle(harness, { type: PICK_MESSAGE, path: root });

  const event = makeTrackedEvent({ target: form(harness) });
  await fire(form(harness), "submit", event);
  await harness.handled;

  assert.equal(event.defaultPrevented, true, "目录表单不能触发原生跳转");
  assert.equal(event.propagationStopped, true, "内层 submit 不能冒泡到官方父表单");
  assert.equal(parentSubmitted, 0, "选择目录不能被当成点击「创建项目」");
  assert.deepEqual(harness.delivered, [{ channel: PICKED_MESSAGE, payload: { root } }]);
  assert.equal(dialog(harness), undefined, "选择成功后目录弹窗关闭");
  assert.equal(parent.attributes["data-state"], "open", "官方对话框保持打开");
  assert.equal(parent.removed, false);
  assert.ok(harness.body.children.includes(parent), "父对话框仍在 body 的原有位置");
  assert.equal(trigger.parentNode, parent);
});

test("a parent dialog without a focused trigger is found by its open state", async () => {
  const root = createTree();
  const harness = createPickerHarness({ browseRoot: root });
  const parent = createFakeElement("div", harness.elements);
  parent.setAttribute("role", "dialog");
  parent.setAttribute("data-state", "open");
  harness.body.appendChild(parent);
  // 触发按钮失焦（例如用户点了弹窗空白处）时，仍要按打开状态定位宿主对话框。
  harness.document.activeElement = harness.body;
  await openAndSettle(harness, { type: PICK_MESSAGE, path: root });

  assert.equal(dialog(harness).parentNode, parent);
});
