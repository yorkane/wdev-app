/**
 * 官方菜单项隐藏 Provider。
 *
 * 官方侧栏底部有两个我们不希望暴露的入口：
 *   - 帮助菜单里的「新功能」(sidebarHelp.whatsNew) 与「帮助」(sidebarHelp.help) 都是外部链接；
 *   - 账号菜单里的「显示宠物 / 隐藏宠物」(codex.profileFooter.showPet|hidePet)。
 * 这三项会让用户在无外网环境点到外站，或打开与站点无关的官方功能，因此直接隐藏。
 *
 * 官方菜单项没有任何可用的稳定属性（结构完全一致，只靠文案区分），
 * 因此沿用仓库既有的做法：在菜单上下文里按可见文案精确匹配，再把整项隐藏。
 * 只隐藏、不移除 DOM，避免破坏 React/Radix 的协调过程；菜单关闭后节点本身会被卸载。
 *
 * 本文件由骨架装配层按 provider key 自动注册，不需要改动上游 polyfill。
 */
(function () {
  const w = window;
  const modificationScope = w.__OpenCodexCurrentProviderScope;
  const modificationEffects = modificationScope?.effects;
  const providerGeneration = modificationScope?.generation || document;
  if (w.__opencodexMenuItemGuardInstalled === providerGeneration) return;
  const adapterHost = w.__OpenCodexAdapterHost;
  if (!adapterHost?.dom?.observe) return;
  w.__opencodexMenuItemGuardInstalled = providerGeneration;

  /** 需要隐藏的菜单项文案；覆盖主流语言，匹配时忽略首尾空白与大小写。 */
  const HIDDEN_MENU_LABELS = new Set([
  "Afficher la mascotte",
  "Afișează mascota",
  "Aide",
  "Aiuto",
  "Ajuda",
  "Ajutor",
  "Ascunde mascota",
  "Ayuda",
  "Bantuan",
  "Co je nového",
  "Co nowego",
  "Có gì mới",
  "Dölj husdjur",
  "Help",
  "Hide pet",
  "Hilfe",
  "Hiển thị thú cưng",
  "Hjelp",
  "Hjälp",
  "Hjælp",
  "Huisdier tonen",
  "Huisdier verbergen",
  "Hva er nytt",
  "Kisállat elrejtése",
  "Kisállat megjelenítése",
  "Maskotu gizle",
  "Maskotu göster",
  "Masquer la mascotte",
  "Mostra mascotte",
  "Mostrar mascota",
  "Mostrar mascote",
  "Nascondi mascotte",
  "Neuigkeiten",
  "Noutăți",
  "Novedades",
  "Novidades",
  "Novità",
  "Nyheder",
  "Nyheter",
  "Näytä lemmikki",
  "Ocultar mascota",
  "Ocultar mascote",
  "Ohje",
  "Pet anzeigen",
  "Pet ausblenden",
  "Piilota lemmikki",
  "Pokaż zwierzaka",
  "Pomoc",
  "Quoi de neuf",
  "Sembunyikan pet",
  "Show pet",
  "Skjul kjæledyret",
  "Skjul kæledyr",
  "Skrýt domácího mazlíčka",
  "Súgó",
  "Tampilkan pet",
  "Trợ giúp",
  "Ukryj zwierzaka",
  "Uutta",
  "Vis kjæledyret",
  "Vis kæledyr",
  "Visa husdjur",
  "Wat is er nieuw",
  "What's new",
  "Yang baru",
  "Yardım",
  "Yenilikler",
  "Zobrazit domácího mazlíčka",
  "Újdonságok",
  "Απόκρυψη κατοικιδίου",
  "Βοήθεια",
  "Εμφάνιση κατοικίδιου",
  "Τι νέο υπάρχει",
  "Довідка",
  "Показати улюбленця",
  "Показать питомца",
  "Приховати улюбленця",
  "Скрыть питомца",
  "Справка",
  "Что нового",
  "Що нового",
  "नया क्या है",
  "पेट छिपाएँ",
  "पेट दिखाएँ",
  "हेल्प",
  "ซ่อนสัตว์เลี้ยง",
  "มีอะไรใหม่",
  "วิธีใช้",
  "แสดงสัตว์เลี้ยง",
  "Ẩn thú cưng",
  "ヘルプ",
  "ペットを表示",
  "ペットを非表示",
  "帮助",
  "新功能",
  "新着情報",
  "显示宠物",
  "最新消息",
  "說明",
  "隐藏宠物",
  "隱藏寵物",
  "隱藏智能拍檔",
  "顯示寵物",
  "顯示智能拍檔",
  "도움말",
  "새로운 기능",
  "펫 보이기",
  "펫 숨기기"
].map((text) => text.trim().toLowerCase()));

  /** 菜单项文本：取该元素下所有文本节点，去掉快捷键提示后再比较。 */
  /**
   * 该菜单项是否命中隐藏清单。
   *
   * 官方把一个菜单项拆成多个相邻文本节点（标签与快捷键各一个，中间没有任何分隔符），
   * 直接拼接会得到 `Show petAlt+Super+P` 这种串。因此这里逐个文本节点比较：
   * 任一节点去掉首尾空白后与清单完全相等，才算命中。
   * 用精确相等而不是前缀匹配，是为了避免把 `Help center` 这类真实存在的其它菜单项误伤。
   */
  function menuItemMatches(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const value = String(node.nodeValue || "").trim().toLowerCase();
      if (value && HIDDEN_MENU_LABELS.has(value)) return true;
      node = walker.nextNode();
    }
    return false;
  }

  /** 只在菜单上下文里动手，避免误伤正文或对话框里恰好同名的文字。 */
  function isMenuLikeContext(element) {
    for (let node = element && element.parentElement; node && node !== document.body; node = node.parentElement) {
      const role = String(node.getAttribute?.("role") || "").toLowerCase();
      if (role === "menu" || role === "menubar") return true;
      if (node.hasAttribute?.("data-radix-menu-content") || node.hasAttribute?.("data-radix-popper-content-wrapper")) {
        return true;
      }
      const className = String(node.className || "");
      if (role === "dialog" || /codex-dialog/i.test(className)) return false;
      if (/(dropdown|menu|popover)/i.test(className)) return true;
    }
    return false;
  }

  function isMenuItemElement(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.dataset?.opencodexMenuItemHidden === "true") return false;
    const tagName = String(element.tagName || "").toLowerCase();
    const role = String(element.getAttribute?.("role") || "").toLowerCase();
    if (tagName !== "button" && tagName !== "a" && role !== "menuitem" && role !== "menuitemradio") return false;
    return true;
  }

  function hideMenuItem(element) {
    element.dataset.opencodexMenuItemHidden = "true";
    // hidden 会同时从可访问性树和键盘 Tab 序列里移除，display:none 兜底模板类样式覆盖。
    element.hidden = true;
    element.setAttribute("aria-hidden", "true");
    element.setAttribute("tabindex", "-1");
    try {
      element.style.setProperty("display", "none", "important");
    } catch {
      element.style.display = "none";
    }
    try {
      if ("disabled" in element) element.disabled = true;
    } catch {}
  }

  function scanMenuItems(root) {
    const scope = root && root.nodeType === 1 ? root : document;
    const candidates = [];
    if (isMenuItemElement(scope)) candidates.push(scope);
    for (const element of scope.querySelectorAll?.("button,a,[role='menuitem'],[role='menuitemradio']") || []) {
      candidates.push(element);
    }
    let hidden = 0;
    for (const element of candidates) {
      if (!isMenuItemElement(element)) continue;
      if (!isMenuLikeContext(element)) continue;
      if (!menuItemMatches(element)) continue;
      hideMenuItem(element);
      hidden += 1;
    }
    return hidden;
  }

  const observeKey = {};
  let disposeObservation = () => {};
  try {
    disposeObservation = adapterHost.dom.observe({
      key: observeKey,
      root: document.documentElement,
      options: { subtree: true, childList: true },
      callback: (records) => {
        let total = 0;
        for (const record of records) {
          for (const added of record.addedNodes) {
            if (added.nodeType === Node.ELEMENT_NODE) total += scanMenuItems(added);
          }
        }
        // 只有真实隐藏了菜单项才算命中，安装完成本身不算。
        if (total > 0) modificationEffects?.primary?.emit(total);
      },
    });
  } catch {
    // 品牌与菜单隐藏属于锦上添花，宿主不支持时静默放弃。
  }

  // 首屏已存在的菜单（官方偶尔会预挂载）先扫一遍。
  const initial = scanMenuItems(document.documentElement);
  if (initial > 0) modificationEffects?.primary?.emit(initial);

  modificationScope?.own?.(() => {
    try {
      disposeObservation();
    } catch {}
    if (w.__opencodexMenuItemGuardInstalled === providerGeneration) {
      w.__opencodexMenuItemGuardInstalled = undefined;
    }
  });
})();
