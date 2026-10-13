(function () {
  const w = window;
  const modificationScope = w.__OpenCodexCurrentProviderScope;
  const modificationEffects = modificationScope?.effects;
  const providerGeneration = modificationScope?.generation || document;
  if (w.__codexWorkspaceRootPickerInstalled === providerGeneration) return;
  const adapterHost = w.__OpenCodexAdapterHost;
  const scheduler = adapterHost?.scheduler?.capture?.() || w;
  if (!adapterHost?.events?.observe) return;
  w.__codexWorkspaceRootPickerInstalled = providerGeneration;

  // 这个模块只负责「远端浏览器选择目录」的交互，真正的 Electron/官方 IPC 仍由 bridge 转发。
  const WORKSPACE_ROOT_VALIDATE_CHANNEL = "opencodex:validate-workspace-root";
  const ADD_WORKSPACE_ROOT_MESSAGE = "electron-add-new-workspace-root-option";
  const PICK_WORKSPACE_ROOT_MESSAGE = "electron-pick-workspace-root-option";
  const WORKSPACE_ROOT_PICKED_MESSAGE = "workspace-root-option-picked";
  const MESSAGE_MODE_ADD = "add";
  const MESSAGE_MODE_PICK = "pick";
  // 目录枚举复用官方 app-server 的 fs/readDirectory：页面发 mcp-request，回包是 mcp-response。
  // 官方协议里没有 root/parent/truncated，浏览边界、上级目录和截断都由本模块自己算。
  const MCP_REQUEST_MESSAGE = "mcp-request";
  const MCP_RESPONSE_MESSAGE = "mcp-response";
  const READ_DIRECTORY_METHOD = "fs/readDirectory";
  const BROWSE_TIMEOUT_MS = 8000;
  const MAX_LISTED_ENTRIES = 2000;
  const dialogState = {
    focusInput: null,
    promise: null,
  };

  function bridgeHelpers() {
    // polyfill 先暴露最小 helper 面，picker 不直接复制 IPC、toast 和 i18n 的底层实现。
    return w.__codexWebBridgeHelpers && typeof w.__codexWebBridgeHelpers === "object"
      ? w.__codexWebBridgeHelpers
      : {};
  }

  function webConfig() {
    // 公开运行时配置由 gateway 注入；早于配置到达时返回空对象。
    return w.__CODEX_WEB_CONFIG__ && typeof w.__CODEX_WEB_CONFIG__ === "object" ? w.__CODEX_WEB_CONFIG__ : {};
  }

  function runtimeMessages() {
    // bridge 尚未准备好时仍可从公开运行时配置读取文案，保证弹窗不会裸露 key。
    const cfg = webConfig();
    return cfg.messages && typeof cfg.messages === "object" ? cfg.messages : {};
  }

  // 旧 gateway 进程里的 i18n 快照没有本轮新增 key，且文案缓存在启动时读入；
  // 这里内置一份中英兜底，保证弹窗在任何注入时序下都不裸露 web.workspaceRoot.* key。
  const FALLBACK_MESSAGES = {
    "zh-CN": {
      "web.workspaceRoot.dialog.browseRoot": "此电脑",
      "web.workspaceRoot.dialog.up": "上级",
      "web.workspaceRoot.dialog.showHidden": "显示隐藏文件夹",
      "web.workspaceRoot.dialog.pathMode": "路径输入",
      "web.workspaceRoot.dialog.browseMode": "浏览",
      "web.workspaceRoot.dialog.empty": "空文件夹",
      "web.workspaceRoot.dialog.loading": "正在读取目录...",
      "web.workspaceRoot.dialog.truncated": "目录内容过多，已截断；请用路径输入指定更深的目录。",
      "web.workspaceRoot.dialog.selectFolder": "选择此文件夹",
      "web.workspaceRoot.dialog.removeSelection": "移除该文件夹",
      "web.workspaceRoot.error.browseFailed": "无法列出该文件夹：{error}",
    },
    "en-US": {
      "web.workspaceRoot.dialog.browseRoot": "This computer",
      "web.workspaceRoot.dialog.up": "Up",
      "web.workspaceRoot.dialog.showHidden": "Show hidden folders",
      "web.workspaceRoot.dialog.pathMode": "Enter path",
      "web.workspaceRoot.dialog.browseMode": "Browse",
      "web.workspaceRoot.dialog.empty": "Empty folder",
      "web.workspaceRoot.dialog.loading": "Reading folder...",
      "web.workspaceRoot.dialog.truncated": "Too many entries to list; type a deeper path instead.",
      "web.workspaceRoot.dialog.selectFolder": "Select this folder",
      "web.workspaceRoot.dialog.removeSelection": "Remove this folder",
      "web.workspaceRoot.error.browseFailed": "Cannot list this folder: {error}",
    },
  };

  function fallbackLocale() {
    const cfg = webConfig();
    const tag = String(cfg.locale || (document.documentElement && document.documentElement.lang) || "").toLowerCase();
    return tag.startsWith("en") ? FALLBACK_MESSAGES["en-US"] : FALLBACK_MESSAGES["zh-CN"];
  }

  function messageTemplate(key) {
    const messages = runtimeMessages();
    const template = messages[key];
    // gateway 已注入的文案优先；只在该 key 缺失（旧 i18n 快照）时用内置兜底。
    if (typeof template === "string" && template) return template;
    const fallback = fallbackLocale()[key];
    return typeof fallback === "string" && fallback ? fallback : key;
  }

  function t(key, values) {
    const template = messageTemplate(key);
    const helper = bridgeHelpers().t;
    if (typeof helper === "function") {
      const translated = helper(key, values);
      // helper 回传 key 本身说明宿主也没有这条文案，此时用内置兜底而不是裸露 key。
      if (translated && translated !== key) return translated;
    }
    if (!values || typeof values !== "object") return template;
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
    );
  }

  function invoke(channel, ...args) {
    const helper = bridgeHelpers().invoke;
    if (typeof helper === "function") return helper(channel, ...args);
    return Promise.reject(new Error("OpenCodex bridge is not ready."));
  }

  function deliverLocalRendererMessage(channel, payload) {
    const helper = bridgeHelpers().deliverLocalRendererMessage;
    if (typeof helper === "function") return helper(channel, payload);
    throw new Error("OpenCodex renderer message bridge is not ready.");
  }

  function normalizeErrorMessage(error) {
    const helper = bridgeHelpers().normalizeErrorMessage;
    if (typeof helper === "function") return helper(error);
    if (!error) return "";
    if (typeof error === "string") return error;
    if (error instanceof Error && error.message) return error.message;
    if (error && typeof error === "object" && typeof error.error === "string") return error.error;
    return String(error);
  }

  function showToast(payload) {
    // 正常走 bridge 的官方 toast 兼容层；兜底只发 window message，避免这里再造 toast DOM。
    const helper = bridgeHelpers().showToast;
    if (typeof helper === "function") {
      helper(payload);
      return;
    }
    try {
      w.dispatchEvent(new MessageEvent("message", { data: { type: "codex-web:toast", ...payload } }));
    } catch {}
  }

  function usesNativeWorkspaceRootPicker() {
    // 这个 provider 只由 Web shell 注入，真 Electron 桌面壳根本不会加载它，
    // 所以页面里出现这两个协议时就一定要接管，判据与请求来源无关。
    // location.hostname 回答不了「谁看得见弹窗」：它是浏览器地址栏里的主机名，
    // 与网关那一侧的显示环境无关，两者可以任意组合（本机浏览器 / 远端浏览器 / 直连 / 经 authz）。
    // 而 Linux 网关上的 Electron 是 headless（--headless + Xvfb），目录框渲染进隐藏窗口，
    // 放行官方协议只会得到「点下去静默无反应」。
    return false;
  }

  function hasWorkspaceRootPayload(payload) {
    return !!payload && typeof payload === "object" && typeof payload.root === "string" && payload.root.trim();
  }

  function messageMode(payload) {
    if (!payload || typeof payload !== "object" || usesNativeWorkspaceRootPicker()) return "";
    // 旧协议带 root 的消息是适配器校验后的二次转发，不能再次接管形成循环。
    if (payload.type === ADD_WORKSPACE_ROOT_MESSAGE && !hasWorkspaceRootPayload(payload)) return MESSAGE_MODE_ADD;
    // 新协议是「只选择、不持久化」，官方 Main 会忽略 root 并打开原生目录框，所以远端必须完整接管。
    if (payload.type === PICK_WORKSPACE_ROOT_MESSAGE) return MESSAGE_MODE_PICK;
    return "";
  }

  function shouldHandleMessage(payload) {
    return !!messageMode(payload);
  }

  function allowsMultipleWorkspaceRoots(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (payload.allowMultiple === true) return true;
    return !!(payload.params && typeof payload.params === "object" && payload.params.allowMultiple === true);
  }

  function normalizeDirPath(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const withoutTrailing = raw.replace(/\/+$/, "");
    return withoutTrailing || "/";
  }

  function joinPath(dirPath, name) {
    const base = normalizeDirPath(dirPath);
    const child = String(name || "");
    if (!base || base === "/") return "/" + child;
    return base + "/" + child;
  }

  function parentPath(dirPath) {
    const normalized = normalizeDirPath(dirPath);
    if (!normalized || normalized === "/") return null;
    const index = normalized.lastIndexOf("/");
    if (index <= 0) return "/";
    return normalized.slice(0, index);
  }

  function basenameOf(dirPath) {
    const normalized = normalizeDirPath(dirPath);
    if (!normalized || normalized === "/") return "/";
    const index = normalized.lastIndexOf("/");
    return index < 0 ? normalized : normalized.slice(index + 1) || "/";
  }

  function isWithin(pathValue, rootValue) {
    const target = normalizeDirPath(pathValue);
    const root = normalizeDirPath(rootValue);
    if (!target || !root) return false;
    return target === root || target.startsWith(root + "/");
  }

  function allowedBrowseRoots() {
    // 浏览边界只跟服务端已注入的 workspace roots 对齐；未注入时不虚构边界，退化为 "/"。
    const cfg = webConfig();
    const roots = Array.isArray(cfg.workspaceRoots) ? cfg.workspaceRoots : [];
    const normalized = [];
    for (const raw of roots) {
      const root = normalizeDirPath(raw);
      if (root && !normalized.includes(root)) normalized.push(root);
    }
    return normalized;
  }

  function boundaryRootFor(dirPath) {
    let best = "/";
    for (const root of allowedBrowseRoots()) {
      if (!isWithin(dirPath, root)) continue;
      if (root.length > best.length) best = root;
    }
    return best;
  }

  function startPathCandidates(payload) {
    // 默认目录不写死 /data/wdev：机群目录规范里它只在部分机器存在。
    // 按 payload 提示、服务端注入根、常见数据盘逐个真实探测，第一个能列出内容的就是初始目录。
    const cfg = webConfig();
    const roots = Array.isArray(cfg.workspaceRoots) ? cfg.workspaceRoots : [];
    const candidates = [];
    const push = (value) => {
      const raw = normalizeDirPath(value);
      if (raw && !candidates.includes(raw)) candidates.push(raw);
    };
    const params = payload && typeof payload === "object" && payload.params ? payload.params : null;
    push(payload && typeof payload === "object" ? payload.path : "");
    push(params ? params.path : "");
    push(params ? params.cwd : "");
    push(roots[0]);
    push(cfg.homeDir);
    push("/data");
    push("/");
    return candidates;
  }

  function workspaceRootPaths(rawValue, allowMultiple) {
    const value = String(rawValue || "");
    if (!allowMultiple) return [value];
    // 原生 multiSelections 的等价 Web 输入是一行一个路径；去重时保留用户填写顺序。
    const uniquePaths = [];
    const seen = new Set();
    for (const line of value.split(/\r?\n/)) {
      const candidate = normalizeDirPath(line);
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      uniquePaths.push(candidate);
    }
    // 空输入仍交给 gateway 返回统一的本地化错误，避免前后端出现两套校验文案。
    return uniquePaths.length > 0 ? uniquePaths : [""];
  }

  function localizedError(error) {
    // gateway 优先返回 errorKey；未知错误才降级到原始 message，便于排查异常链路。
    const response = error && error.response && typeof error.response === "object" ? error.response : null;
    const responseKey = response && typeof response.errorKey === "string" ? response.errorKey : "";
    const fallbackKey =
      error && typeof error.workspaceRootErrorKey === "string"
        ? error.workspaceRootErrorKey
        : "web.workspaceRoot.error.unavailable";
    const fallbackMessage = normalizeErrorMessage((response && response.error) || error);
    const key = responseKey || fallbackKey;
    const message = t(key, { error: fallbackMessage });
    if (message && message !== key) return message;
    return fallbackMessage || t("web.workspaceRoot.error.unavailable");
  }

  function showErrorToast(error) {
    showToast({
      level: "danger",
      source: "codex-web-workspace-root",
      description: localizedError(error),
    });
  }

  function mcpFailureToError(message) {
    const detail = normalizeErrorMessage((message && message.error) || message) || "app-server request failed";
    const error = new Error(detail);
    // app-server 用 JSON-RPC 错误码，权限类没有稳定统一码，这里按文案兜底分类。
    const code = message && message.error && typeof message.error.code === "number" ? message.error.code : 0;
    const denial = /permission|denied|not allowed|unauthorized|eacces|eperm/i.test(detail);
    error.workspaceRootErrorKey =
      code === -32001 || denial ? "web.workspaceRoot.error.noAccess" : "web.workspaceRoot.error.browseFailed";
    return error;
  }

  function requestDirectoryListing(state, dirPath) {
    // mcp-response 在 Web 侧以 window message 投递，官方 renderer 会忽略它不认识的请求 id。
    const requestId = "opencodex-workspace-root-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const cancel = () => finish(new Error("cancelled"));
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        // 清理步骤必须逐段免疫：宿主 scheduler 或事件注销抛错时，promise 也要正常 settle，
        // 否则弹窗会永久卡住（表现为「点了没反应」）。
        if (timer !== null) {
          try {
            scheduler.clearTimeout(timer);
          } catch {}
        }
        try {
          disposeResponse();
        } catch {}
        state.pending.delete(cancel);
        if (error) reject(error);
        else resolve(value);
      };
      state.pending.add(cancel);
      const onMessage = (event) => {
        const data = event && event.data;
        if (!data || data.type !== MCP_RESPONSE_MESSAGE) return;
        const message = data.message && typeof data.message === "object" ? data.message : data;
        if (!message || message.id !== requestId) return;
        if (message.error) finish(mcpFailureToError(message));
        else finish(null, message.result);
      };
      const disposeResponse = adapterHost.events.observe({
        key: {},
        target: w,
        type: "message",
        callback: onMessage,
      });
      try {
        timer = scheduler.setTimeout(() => finish(new Error("timeout")), BROWSE_TIMEOUT_MS);
      } catch (error) {
        finish(error);
      }
      try {
        Promise.resolve(
          invoke("codex_desktop:message-from-view", {
            type: MCP_REQUEST_MESSAGE,
            hostId: "local",
            priority: "interactive",
            source: "filesystem",
            request: { id: requestId, method: READ_DIRECTORY_METHOD, params: { path: dirPath } },
          })
        ).catch((error) => finish(error));
      } catch (error) {
        finish(error);
      }
    });
  }

  async function readDirectory(state, dirPath) {
    const raw = normalizeDirPath(dirPath);
    if (!raw) throw new Error("path required");
    const result = await requestDirectoryListing(state, raw);
    const entries = Array.isArray(result && result.entries) ? result.entries : [];
    const directories = [];
    const files = [];
    for (const entry of entries) {
      const name = entry && typeof entry.fileName === "string" ? entry.fileName : "";
      if (!name || name === "." || name === "..") continue;
      // 默认过滤点开头条目（.git/.ssh 等），既避免噪音，也降低误选敏感目录的概率。
      if (!state.showHidden && name.startsWith(".")) continue;
      const isDirectory = entry.isDirectory === true;
      const item = { name, path: joinPath(raw, name), isDirectory };
      if (isDirectory) directories.push(item);
      else files.push(item);
    }
    const byName = (left, right) => left.name.localeCompare(right.name, "en");
    directories.sort(byName);
    files.sort(byName);
    const merged = [...directories, ...files];
    return {
      path: raw,
      root: boundaryRootFor(raw),
      parent: parentPath(raw),
      entries: merged.slice(0, MAX_LISTED_ENTRIES),
      truncated: merged.length > MAX_LISTED_ENTRIES,
    };
  }

  async function probeReadableDirectory(state, payload) {
    let lastError = null;
    for (const candidate of startPathCandidates(payload)) {
      try {
        return await readDirectory(state, candidate);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("no browsable directory");
  }

  function showDialog(options) {
    const allowMultiple = !!(options && options.allowMultiple);
    const onSubmit = options && options.onSubmit;
    const payload = options && options.payload;
    if (dialogState.promise) {
      // 同一时刻只允许一个目录弹窗，重复点击只把焦点拉回弹窗。
      if (typeof dialogState.focusInput === "function") dialogState.focusInput();
      return dialogState.promise;
    }

    // 原生 top-layer 只改变绘制层级，并不会把 DOM 事件归入官方 Radix 对话框。
    // 挂在触发它的对话框内，避免目录选择被父层误当成 outside interaction 后关闭创建表单。
    const trigger = document.activeElement;
    let ownerDialog = typeof trigger?.closest === "function" ? trigger.closest('[role="dialog"]') : null;
    if (!ownerDialog && typeof document.querySelector === "function") {
      ownerDialog = document.querySelector('[role="dialog"][data-state="open"]');
    }
    const mount = ownerDialog || document.body;

    const state = {
      allowMultiple,
      mode: "browse",
      showHidden: false,
      dir: "",
      root: "/",
      parent: null,
      entries: [],
      truncated: false,
      loading: true,
      statusKey: "",
      statusText: "",
      cache: new Map(),
      selections: [],
      pending: new Set(),
      sequence: 0,
      closed: false,
      toastedBrowseFailure: false,
    };
    const key = {};

    dialogState.promise = new Promise((resolve) => {
      // 原生 <dialog>.showModal() 进入浏览器 top layer，并让底层内容 inert；
      // 官方「新建项目」弹窗是模态的，普通 body 子节点会被它的 focus trap 和遮罩挡住。
      const backdrop = document.createElement("dialog");
      backdrop.className = "codex-web-workspace-root-backdrop codex-web-workspace-root-dialog";
      backdrop.setAttribute("aria-modal", "true");
      backdrop.setAttribute("aria-labelledby", "codex-web-workspace-root-title");

      const panel = document.createElement("form");
      panel.className = "codex-web-workspace-root-panel";
      panel.setAttribute("role", "document");

      // DOM 结构刻意贴近官方 compact dialog：标题、说明、目录浏览、底部操作按钮。
      const header = document.createElement("div");
      header.className = "codex-web-workspace-root-header";

      const title = document.createElement("h2");
      title.id = "codex-web-workspace-root-title";
      title.className = "codex-web-workspace-root-title";
      title.textContent = t("web.workspaceRoot.dialog.title");
      header.appendChild(title);

      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "codex-web-workspace-root-close";
      closeButton.setAttribute("aria-label", t("web.workspaceRoot.dialog.close"));
      closeButton.textContent = "x";
      header.appendChild(closeButton);
      panel.appendChild(header);

      const description = document.createElement("p");
      description.className = "codex-web-workspace-root-description";
      description.textContent = t(
        allowMultiple ? "web.workspaceRoot.dialog.multipleDescription" : "web.workspaceRoot.dialog.description"
      );
      panel.appendChild(description);

      const toolbar = document.createElement("div");
      toolbar.className = "codex-web-workspace-root-toolbar";

      const upButton = document.createElement("button");
      upButton.type = "button";
      upButton.className = "codex-web-workspace-root-tool";
      upButton.setAttribute("aria-label", t("web.workspaceRoot.dialog.up"));
      upButton.textContent = "↑";
      toolbar.appendChild(upButton);

      const breadcrumb = document.createElement("nav");
      breadcrumb.className = "codex-web-workspace-root-breadcrumb";
      breadcrumb.setAttribute("aria-label", t("web.workspaceRoot.dialog.pathLabel"));
      toolbar.appendChild(breadcrumb);

      const hiddenButton = document.createElement("button");
      hiddenButton.type = "button";
      hiddenButton.className = "codex-web-workspace-root-tool";
      hiddenButton.setAttribute("aria-label", t("web.workspaceRoot.dialog.showHidden"));
      hiddenButton.setAttribute("aria-pressed", "false");
      hiddenButton.textContent = "···";
      toolbar.appendChild(hiddenButton);

      const modeButton = document.createElement("button");
      modeButton.type = "button";
      modeButton.className = "codex-web-workspace-root-tool";
      modeButton.setAttribute("aria-label", t("web.workspaceRoot.dialog.pathMode"));
      modeButton.textContent = t("web.workspaceRoot.dialog.pathMode");
      toolbar.appendChild(modeButton);
      panel.appendChild(toolbar);

      const content = document.createElement("div");
      content.className = "codex-web-workspace-root-content";
      panel.appendChild(content);

      const selectionRow = document.createElement("div");
      selectionRow.className = "codex-web-workspace-root-selections";
      selectionRow.setAttribute("aria-live", "polite");
      panel.appendChild(selectionRow);

      const input = document.createElement(allowMultiple ? "textarea" : "input");
      input.className = "codex-web-workspace-root-input";
      if (allowMultiple) input.className += " codex-web-workspace-root-input-multiple";
      if (!allowMultiple) input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = t(
        allowMultiple ? "web.workspaceRoot.dialog.multiplePlaceholder" : "web.workspaceRoot.dialog.placeholder"
      );
      input.setAttribute(
        "aria-label",
        t(allowMultiple ? "web.workspaceRoot.dialog.multiplePathLabel" : "web.workspaceRoot.dialog.pathLabel")
      );
      panel.appendChild(input);

      const actions = document.createElement("div");
      actions.className = "codex-web-workspace-root-actions";

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "codex-web-workspace-root-button";
      cancelButton.textContent = t("common.cancel");
      actions.appendChild(cancelButton);

      const submitButton = document.createElement("button");
      submitButton.type = "submit";
      submitButton.className = "codex-web-workspace-root-button codex-web-workspace-root-button-primary";
      submitButton.textContent = t("web.workspaceRoot.dialog.confirm");
      actions.appendChild(submitButton);
      panel.appendChild(actions);

      function setBusy(busy) {
        // 提交期间锁住控件，避免重复发起校验或重复添加同一个项目。
        input.disabled = busy;
        cancelButton.disabled = busy;
        closeButton.disabled = busy;
        submitButton.disabled = busy;
        hiddenButton.disabled = busy;
        modeButton.disabled = busy;
        upButton.disabled = busy || state.mode !== "browse" || !canGoUp();
        submitButton.textContent = busy
          ? t("web.workspaceRoot.dialog.confirming")
          : t("web.workspaceRoot.dialog.confirm");
      }

      function close(result) {
        // 弹窗关闭时必须清掉在途请求、全局 keydown 监听和单例状态，避免晚到回包污染下一次交互。
        if (state.closed) return;
        state.closed = true;
        state.sequence += 1;
        for (const cancelRequest of [...state.pending]) cancelRequest();
        dialogState.focusInput = null;
        dialogState.promise = null;
        try {
          disposeKeydown?.();
        } catch {}
        try {
          backdrop.remove();
        } catch {}
        if (trigger && trigger.isConnected !== false && typeof trigger.focus === "function") {
          scheduler.requestAnimationFrame(() => trigger.focus());
        }
        resolve(result);
      }

      function cancel() {
        close(true);
      }

      function onKeyDown(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation?.();
          cancel();
        }
      }

      function canGoUp() {
        return !!state.parent && state.parent === state.root ? true : !!state.parent && state.dir !== state.root;
      }

      function selectedPaths() {
        if (state.selections.length > 0) return state.selections.slice();
        const current = normalizeDirPath(state.dir);
        return current ? [current] : [];
      }

      function syncInput() {
        const paths = selectedPaths();
        if (!allowMultiple) {
          input.value = paths[0] || "";
          return;
        }
        input.value = paths.length > 0 ? "\n" + paths.join("\n") + "\n" : "\n";
      }

      function toggleSelection(dirPath, selected) {
        const normalized = normalizeDirPath(dirPath);
        if (!normalized) return;
        const exists = state.selections.includes(normalized);
        if (selected && !exists) state.selections.push(normalized);
        if (!selected && exists) state.selections.splice(state.selections.indexOf(normalized), 1);
        syncInput();
        renderSelections();
        renderList();
        updateSubmitState();
      }

      function renderSelections() {
        selectionRow.replaceChildren();
        if (!allowMultiple) return;
        for (const root of state.selections) {
          const chip = document.createElement("span");
          chip.className = "codex-web-workspace-root-selection";
          const label = document.createElement("span");
          label.className = "codex-web-workspace-root-selection-label";
          label.textContent = root;
          chip.appendChild(label);
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "codex-web-workspace-root-selection-remove";
          remove.setAttribute("aria-label", t("web.workspaceRoot.dialog.removeSelection"));
          remove.textContent = "x";
          remove.addEventListener("click", () => toggleSelection(root, false));
          chip.appendChild(remove);
          selectionRow.appendChild(chip);
        }
      }

      function renderBreadcrumb() {
        breadcrumb.replaceChildren();
        const trail = [];
        let cursor = state.dir;
        while (cursor && cursor !== state.root) {
          trail.unshift(cursor);
          const next = parentPath(cursor);
          if (!next || next === cursor) break;
          cursor = next;
        }
        const rootButton = document.createElement("button");
        rootButton.type = "button";
        rootButton.className = "codex-web-workspace-root-breadcrumb-item";
        if (trail.length === 0) rootButton.className += " codex-web-workspace-root-breadcrumb-current";
        rootButton.textContent =
          normalizeDirPath(state.root) === "/" ? t("web.workspaceRoot.dialog.browseRoot") : basenameOf(state.root);
        rootButton.addEventListener("click", () => navigate(state.root));
        breadcrumb.appendChild(rootButton);
        trail.forEach((segment, index) => {
          const separator = document.createElement("span");
          separator.className = "codex-web-workspace-root-breadcrumb-separator";
          separator.textContent = "/";
          breadcrumb.appendChild(separator);
          const item = document.createElement("button");
          item.type = "button";
          item.className = "codex-web-workspace-root-breadcrumb-item";
          if (index === trail.length - 1) item.className += " codex-web-workspace-root-breadcrumb-current";
          item.textContent = basenameOf(segment);
          item.addEventListener("click", () => navigate(segment));
          breadcrumb.appendChild(item);
        });
      }

      function renderList() {
        content.replaceChildren();
        if (state.mode !== "browse") return;
        if (state.loading) {
          const status = document.createElement("p");
          status.className = "codex-web-workspace-root-browse-status";
          status.textContent = t("web.workspaceRoot.dialog.loading");
          content.appendChild(status);
          return;
        }
        if (state.statusKey) {
          const status = document.createElement("p");
          status.className = "codex-web-workspace-root-browse-status";
          status.textContent = state.statusText || t(state.statusKey);
          content.appendChild(status);
          return;
        }
        if (state.entries.length === 0) {
          const empty = document.createElement("p");
          empty.className = "codex-web-workspace-root-browse-empty";
          empty.textContent = t("web.workspaceRoot.dialog.empty");
          content.appendChild(empty);
          return;
        }
        const list = document.createElement("ul");
        list.className = "codex-web-workspace-root-list";
        list.setAttribute("role", "listbox");
        content.appendChild(list);
        for (const entry of state.entries) {
          const row = document.createElement("li");
          row.className = "codex-web-workspace-root-row";
          const label = document.createElement("span");
          label.className = "codex-web-workspace-root-row-label";
          label.textContent = entry.name;
          row.appendChild(label);
          if (!entry.isDirectory) {
            // 文件列出来说明目录内容，但不能选中；原生目录框同样只让目录可进入。
            row.className += " codex-web-workspace-root-row-file";
            row.setAttribute("aria-disabled", "true");
            list.appendChild(row);
            continue;
          }
          if (allowMultiple) {
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.className = "codex-web-workspace-root-select";
            checkbox.checked = state.selections.includes(entry.path);
            checkbox.setAttribute("aria-label", t("web.workspaceRoot.dialog.selectFolder"));
            checkbox.addEventListener("click", (event) => {
              event.stopPropagation();
              toggleSelection(entry.path, checkbox.checked === true);
            });
            row.appendChild(checkbox);
          }
          row.addEventListener("click", () => selectDirectory(entry.path));
          list.appendChild(row);
        }
        if (state.truncated) {
          const hint = document.createElement("p");
          hint.className = "codex-web-workspace-root-browse-truncated";
          hint.textContent = t("web.workspaceRoot.dialog.truncated");
          content.appendChild(hint);
        }
      }

      function updateSubmitState() {
        syncInput();
        const hasSelection = selectedPaths().length > 0;
        submitButton.disabled = state.loading || (state.mode === "browse" && !hasSelection);
        upButton.disabled = state.mode !== "browse" || !canGoUp();
        renderBreadcrumb();
      }

      function applyListing(listing) {
        state.dir = listing.path;
        state.root = listing.root;
        state.parent = listing.parent;
        state.entries = listing.entries;
        state.truncated = listing.truncated;
        state.loading = false;
        state.statusKey = "";
        state.statusText = "";
      }

      async function load(dirPath) {
        const requested = normalizeDirPath(dirPath);
        const sequence = ++state.sequence;
        const cacheKey = requested + "\0" + (state.showHidden ? "1" : "0");
        const cached = state.cache.get(cacheKey);
        if (cached) {
          applyListing(cached);
          renderSelections();
          renderList();
          updateSubmitState();
          return;
        }
        state.loading = true;
        state.statusKey = "";
        renderList();
        updateSubmitState();
        try {
          const listing = await readDirectory(state, requested);
          if (state.closed || sequence !== state.sequence) return;
          state.cache.set(cacheKey, listing);
          applyListing(listing);
          renderSelections();
          renderList();
          updateSubmitState();
        } catch (error) {
          if (state.closed || sequence !== state.sequence) return;
          state.loading = false;
          throw error;
        }
      }

      async function navigate(dirPath) {
        try {
          await load(dirPath);
        } catch (error) {
          fallBackToPathMode(error);
        }
      }

      function selectDirectory(dirPath) {
        if (allowMultiple) {
          navigate(dirPath);
          return;
        }
        // 单选语义等价原生「进入并选中」：确认按钮使用刚进入的目录。
        state.selections = [normalizeDirPath(dirPath)];
        navigate(dirPath);
      }

      function fallBackToPathMode(error) {
        // 列目录失败不能锁死弹窗：退回手输路径形态，用户仍可提交已知绝对路径。
        state.mode = "path";
        state.statusKey = "web.workspaceRoot.error.browseFailed";
        state.statusText = localizedError(error);
        modeButton.setAttribute("aria-label", t("web.workspaceRoot.dialog.browseMode"));
        modeButton.textContent = t("web.workspaceRoot.dialog.browseMode");
        renderList();
        updateSubmitState();
        if (state.toastedBrowseFailure) return;
        state.toastedBrowseFailure = true;
        showErrorToast(error);
        scheduler.requestAnimationFrame(() => {
          input.focus();
          if (typeof input.select === "function") input.select();
        });
      }

      let disposeKeydown = null;

      panel.addEventListener("submit", async (event) => {
        event.preventDefault();
        // 只确认目录，不把内层 submit 传给官方父表单的“创建项目”处理器。
        event.stopPropagation?.();
        setBusy(true);
        try {
          // 路径选择结果成功交给官方 Renderer/Main 后才关闭；失败只吐司并保留输入内容。
          await onSubmit(input.value, { cancelled: () => state.closed });
          close(true);
        } catch (error) {
          // 弹窗已被用户关闭：迟到的失败不再吐司，也不重新解锁已销毁的控件。
          if (state.closed) return;
          showErrorToast(error);
          setBusy(false);
          scheduler.requestAnimationFrame(() => {
            input.focus();
            if (typeof input.select === "function") input.select();
          });
        }
      });
      closeButton.addEventListener("click", cancel);
      cancelButton.addEventListener("click", cancel);
      backdrop.addEventListener("click", (event) => {
        if (event && event.target === backdrop) cancel();
      });
      // 原生 dialog 的 Esc 走 cancel 事件；这里统一收敛到 close，保证 promise 一定 settle。
      backdrop.addEventListener("cancel", (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        cancel();
      });
      backdrop.addEventListener("close", () => cancel());
      upButton.addEventListener("click", () => {
        if (canGoUp() && state.parent) navigate(state.parent);
      });
      hiddenButton.addEventListener("click", async () => {
        state.showHidden = !state.showHidden;
        hiddenButton.setAttribute("aria-pressed", state.showHidden ? "true" : "false");
        await navigate(state.dir);
      });
      modeButton.addEventListener("click", async () => {
        if (state.mode === "browse") {
          state.mode = "path";
          modeButton.setAttribute("aria-label", t("web.workspaceRoot.dialog.browseMode"));
          modeButton.textContent = t("web.workspaceRoot.dialog.browseMode");
          renderList();
          updateSubmitState();
          input.focus();
          return;
        }
        state.mode = "browse";
        modeButton.setAttribute("aria-label", t("web.workspaceRoot.dialog.pathMode"));
        modeButton.textContent = t("web.workspaceRoot.dialog.pathMode");
        if (state.dir) await navigate(state.dir);
        else {
          renderList();
          updateSubmitState();
        }
      });
      input.addEventListener("input", () => {
        const parsed = workspaceRootPaths(input.value, allowMultiple);
        state.selections = allowMultiple ? parsed : parsed[0] ? [parsed[0]] : [];
        renderSelections();
        renderList();
        updateSubmitState();
      });

      backdrop.appendChild(panel);
      mount.appendChild(backdrop);
      try {
        backdrop.showModal();
      } catch {
        // 老 WebView 没有 showModal 时保持弹窗可用；现代 Chromium 都走 top layer 路径。
        backdrop.setAttribute("open", "");
      }
      dialogState.focusInput = () => {
        if (typeof backdrop.focus === "function") backdrop.focus();
      };
      disposeKeydown = adapterHost.events.observe({ key, target: w, type: "keydown", capture: true, callback: onKeyDown });
      renderList();
      updateSubmitState();

      (async () => {
        try {
          const listing = await probeReadableDirectory(state, payload);
          if (state.closed) return;
          state.cache.set(listing.path + "\00", listing);
          applyListing(listing);
          renderSelections();
          renderList();
          updateSubmitState();
        } catch (error) {
          if (state.closed) return;
          fallBackToPathMode(error);
        }
      })();
    });

    return dialogState.promise;
  }

  async function validateRemoteWorkspaceRoot(rawPath) {
    // 所有目录都先由运行 OpenCodex 的机器校验并注册到本地文件访问白名单。
    const validation = await invoke(WORKSPACE_ROOT_VALIDATE_CHANNEL, { path: rawPath });
    const root = validation && typeof validation.root === "string" ? validation.root : "";
    if (!root) {
      const error = new Error("Workspace root validation returned no path.");
      error.workspaceRootErrorKey = "web.workspaceRoot.error.unavailable";
      throw error;
    }
    return root;
  }

  async function submitRemoteWorkspaceRoots(payload, rawValue, mode, allowMultiple, signal) {
    const cancelled = signal && typeof signal.cancelled === "function" ? signal.cancelled : () => false;
    const paths = workspaceRootPaths(rawValue, allowMultiple);
    const roots = [];
    // 全部校验成功后才通知官方 Renderer，避免多选中途失败造成半完成的工程表单状态。
    for (const rawPath of paths) {
      // 弹窗已关闭时不再发起校验，也不再补投递：用户取消不能被迟到的结果覆盖。
      if (cancelled()) throw new Error("Workspace root selection cancelled.");
      roots.push(await validateRemoteWorkspaceRoot(rawPath));
    }

    if (mode === MESSAGE_MODE_PICK) {
      try {
        // 新协议由官方 Renderer 自己维护工程表单；逐条模拟 Main 的选择结果即可。
        for (const root of roots) {
          if (cancelled()) throw new Error("Workspace root selection cancelled.");
          deliverLocalRendererMessage(WORKSPACE_ROOT_PICKED_MESSAGE, { root });
        }
        return;
      } catch (error) {
        error.workspaceRootErrorKey = "web.workspaceRoot.error.addFailed";
        throw error;
      }
    }

    try {
      if (cancelled()) throw new Error("Workspace root selection cancelled.");
      // 旧协议仍交给官方 Main 持久化、刷新项目列表和切换选中状态。
      await invoke("codex_desktop:message-from-view", { ...payload, root: roots[0] });
    } catch (error) {
      error.workspaceRootErrorKey = "web.workspaceRoot.error.addFailed";
      throw error;
    }
  }

  function handleMessage(payload) {
    const mode = messageMode(payload);
    if (!mode) return null;
    const allowMultiple = mode === MESSAGE_MODE_PICK && allowsMultipleWorkspaceRoots(payload);
    return showDialog({
      allowMultiple,
      payload,
      onSubmit: (rawValue, signal) => submitRemoteWorkspaceRoots(payload, rawValue, mode, allowMultiple, signal),
    });
  }

  w.OpenCodexWorkspaceRootPicker = {
    // polyfill 只调用这个公开入口，降低后续拆迁或替换 UI 实现的耦合。
    handleMessage,
    shouldHandleMessage,
  };
})();
