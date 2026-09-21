/**
 * 品牌文字替换 Provider。
 *
 * 把浏览器端已经渲染到 DOM 上的官方品牌词（ChatGPT / OpenAI / Codex）替换成
 * 站点配置里的品牌名（__CODEX_WEB_CONFIG__.brand.name，来自 config.yaml 的 brand.name，
 * 默认 OpenCodex）。未配置或品牌名等于默认 OpenCodex 时不安装，避免无谓开销。
 *
 * 只处理「用户可见的文本」，规则刻意写窄，避免误伤：
 *   - 只改文本节点内容，且只在词边界上做替换，
 *     因此 --codex-* CSS 变量名、data-codex-* 属性名、class 名、codex-sandbox:// 协议、
 *     i18n key、驼峰标识符（codex2 / CodexApp）都不会被改动；
 *   - 属性只碰 alt / title / aria-label 这三个用户可见属性，且同样按词边界替换；
 *   - 绝不改其它任何属性值、节点名或标签名。
 *
 * 替换范围只限「壳层/框架文案」（侧栏标题、菜单项、按钮、设置页、空状态、对话框标题），
 * 必须排除会话内容与代码：用户在消息里输入/模型输出的正文只要含品牌词都是用户内容，
 * 改写即内容损坏。排除容器（命中即整棵子树跳过）：
 *   [data-markdown-text-style] / [data-markdown-copy-text] / [data-wide-markdown-block]
 *     消息 markdown 正文；[data-user-message-bubble] 用户消息气泡；
 *   [data-composer-markdown] / [data-composer-code-block] / [data-composer-attachment-pill]
 *     输入框内容；[data-thread-user-message-navigation-content] 用户消息导航内容；
 *   pre / code 代码块；[contenteditable="true"] / [contenteditable="plaintext-only"]
 *     可编辑正文；script / style / template 是代码不是文案。
 * document.title 属于壳层，保留替换。
 *
 * 官方是 SPA，document.title 和正文都会频繁变化，因此通过宿主共享 DOM Observer
 * （adapterHost.dom.observe）挂一个文档级订阅：
 *   - 正文动态插入走 childList，标题 <title> 文本改写走 characterData；
 *   - 官方用赋值式改 document.title 时通常也会替换 <title> 子节点，同样能到达。
 * 宿主对同一 root 复用同一个真实 Observer，Provider 内禁止自建 MutationObserver
 * 或裸定时器（check-modification-boundaries 边界），统一走 adapterHost 能力。
 * 换页或 dispose 时只停止 observer；已替换的文本不还原（页面重载即恢复官方原文）。
 */
(function () {
  const w = window;
  const modificationScope = w.__OpenCodexCurrentProviderScope;
  const modificationEffects = modificationScope?.effects;
  const providerGeneration = modificationScope?.generation || document;
  if (w.__opencodexBrandTextInstalled === providerGeneration) return;

  const config = w.__CODEX_WEB_CONFIG__ || {};
  const brandName = String(config.brand?.name || "").trim();
  // 未配置或等于默认品牌名 OpenCodex 时不安装：默认值下替换没有任何可见效果。
  const DEFAULT_BRAND_NAME = "OpenCodex";
  if (!brandName || brandName === DEFAULT_BRAND_NAME) return;

  const adapterHost = w.__OpenCodexAdapterHost;
  // 共享 DOM Observer 与受限调度器都来自宿主：Provider 内禁止自建 MutationObserver/
  // 定时器，只能走 adapterHost 暴露的能力；宿主没给时静默不安装。
  if (!adapterHost || typeof adapterHost.dom?.observe !== "function") return;
  const scheduler = adapterHost.scheduler?.capture?.() || w;
  if (!scheduler || typeof scheduler.setTimeout !== "function") return;
  w.__opencodexBrandTextInstalled = providerGeneration;

  // 品牌词替换规则：只在词边界替换，大小写敏感（codex / CodexApp / codex2 都不命中）。
  /**
   * 品牌词替换规则，只在词边界替换。
   *
   * 官方账号名渲染成小写 openai（左下角与账号菜单标题都是纯文字），必须覆盖；
   * 而小写 codex 常见于用户自己写的会话标题（例如「重启本机的codex 和 codex app」），
   * 因此只对 OpenAI 放宽大小写，ChatGPT / Codex 仍保持大小写敏感，避免改坏用户内容。
   */
  const BRAND_WORD_RE = /\bChatGPT\b|\bOpenAI\b|\bCodex\b|\bopenai\b/g;

  // 会话内容与代码容器：命中任一即整棵子树不参与替换（含 script/style/template）。
  const EXCLUDED_CONTENT_SELECTOR = [
    "[data-markdown-text-style]",
    "[data-markdown-copy-text]",
    "[data-wide-markdown-block]",
    "[data-user-message-bubble]",
    "[data-composer-markdown]",
    "[data-composer-code-block]",
    "[data-composer-attachment-pill]",
    "[data-thread-user-message-navigation-content]",
    "pre",
    "code",
    "script",
    "style",
    "template",
    "[contenteditable=\"true\"]",
    "[contenteditable=\"plaintext-only\"]",
  ].join(", ");

  /** 节点自身或任一祖先命中排除容器时返回 true；closest 从自身算起，一次调用即可。 */
  function isContentExcluded(node) {
    let current = node;
    while (current && current.nodeType !== Node.ELEMENT_NODE) current = current.parentNode;
    if (!current) return false;
    try {
      return typeof current.closest === "function" && Boolean(current.closest(EXCLUDED_CONTENT_SELECTOR));
    } catch {
      return false;
    }
  }

  /** 文本内容里的品牌词替换；没有品牌词时返回原串，避免无谓重赋值。 */
  function replaceBrandWords(value) {
    const text = String(value == null ? "" : value);
    if (!text || !BRAND_WORD_RE.test(text)) return text;
    BRAND_WORD_RE.lastIndex = 0;
    return text.replace(BRAND_WORD_RE, brandName);
  }

  /** 仅处理用户可见的三个属性；其余属性一律不动。 */
  const USER_VISIBLE_ATTRS = ["alt", "title", "aria-label"];

  /**
   * 对子树做品牌替换：每个后代元素的用户可见属性 + 每个后代文本节点。
   * 初始全文档扫描与动态插入的子树都走这里，保证嵌套元素的属性不漏处理。
   */
  function rewriteElement(el) {
    if (!(el instanceof Element)) return;
    // 子树整体处于会话内容/代码容器内时直接跳过（含 script/style/template）。
    if (isContentExcluded(el)) return;
    const walker = document.createTreeWalker(
      el,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
      acceptNode(node) {
        // REJECT 会连子树一起跳过：命中排除容器的元素整棵不处理。
        if (isContentExcluded(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
      }
    );
    const textNodes = [];
    let current;
    while ((current = walker.nextNode())) textNodes.push(current);
    for (const node of textNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        // 只碰用户可见的三个属性；其余属性一律不动。
        for (const attr of USER_VISIBLE_ATTRS) {
          const original = node.getAttribute && node.getAttribute(attr);
          if (original == null) continue;
          const next = replaceBrandWords(original);
          if (next !== original) node.setAttribute(attr, next);
        }
      } else {
        const next = replaceBrandWords(node.nodeValue);
        if (next !== node.nodeValue) node.nodeValue = next;
      }
    }
  }

  /** 处理 document.title：官方标题形如 ChatGPT - <会话名>，按词边界替换即可。 */
  function rewriteTitle() {
    try {
      const title = document.title;
      if (!title) return;
      const next = replaceBrandWords(title);
      if (next !== title) document.title = next;
    } catch {}
  }

  // 初始全文档扫描一次：SPA 首屏已渲染的文案在这里被替换掉。
  rewriteElement(document.documentElement);
  rewriteTitle();

  // 动态内容：SPA 路由切换会整棵替换子树，一个文档级共享订阅足够覆盖。
  // key 用每实例唯一的对象：它既是订阅身份，也是宿主缓存复用的判定键。
  const observeKey = {};
  let disposeDom = () => {};
  try {
    disposeDom = adapterHost.dom.observe({
      key: observeKey,
      root: document.documentElement,
      // 属性也观察：官方偶尔把品牌词写进 title/aria-label/alt 属性，
      // 动态插入的元素则通过 childList 到达，两条路都覆盖。
      options: {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: USER_VISIBLE_ATTRS,
      },
      callback: (records) => {
        let sawText = false;
        for (const record of records) {
          if (record.type === "childList") {
            for (const added of record.addedNodes) {
              // 动态插入的会话内容/代码同样要过滤，避免被改写。
              if (added.nodeType === Node.ELEMENT_NODE) {
                if (!isContentExcluded(added)) rewriteElement(added);
              } else if (added.nodeType === Node.TEXT_NODE) {
                if (isContentExcluded(added)) continue;
                sawText = true;
                const next = replaceBrandWords(added.nodeValue);
                if (next !== added.nodeValue) added.nodeValue = next;
              }
            }
          } else if (record.type === "characterData") {
            const node = record.target;
            if (node && node.nodeType === Node.TEXT_NODE) {
              if (isContentExcluded(node)) continue;
              sawText = true;
              const next = replaceBrandWords(node.nodeValue);
              if (next !== node.nodeValue) node.nodeValue = next;
            }
          } else if (record.type === "attributes") {
            if (USER_VISIBLE_ATTRS.includes(record.attributeName)) {
              if (!isContentExcluded(record.target)) rewriteElement(record.target);
            }
          }
        }
        // 文本有变化时统一兜底重检标题：<title> 改写会到达这条 records 流。
        if (sawText) rewriteTitle();
      },
    });
  } catch {
    // documentElement 不可用时静默放弃：品牌替换是锦上添花，不能影响页面功能。
  }

  // 替换属于持续生效的视图改写，安装完成即 ready；首个真实替换发生时上报一次命中，
  // 与「安装只算 ready，命中才算 active」的骨架约定一致。
  let reportedHit = false;
  const reportHit = () => {
    if (reportedHit) return;
    reportedHit = true;
    modificationEffects?.primary?.emit();
  };
  // 初始扫描已同步执行完，用宿主调度器在下一轮检查是否有实际替换发生；
  // 标题是最廉价的探针：首屏有品牌词时它必然已被改写。
  scheduler.setTimeout(() => {
    try {
      if (String(document.title || "").includes(brandName)) reportHit();
      else if (document.body && document.body.textContent && document.body.textContent.includes(brandName)) {
        reportHit();
      }
    } catch {}
  }, 0);

  // dispose：宿主逆序执行 own 登记的清理函数，只停止 observer，
  // 已改文本不还原（页面重载即恢复官方原文）。
  modificationScope?.own?.(() => {
    try {
      disposeDom();
    } catch {}
    if (w.__opencodexBrandTextInstalled === providerGeneration) {
      w.__opencodexBrandTextInstalled = undefined;
    }
  });
})();
