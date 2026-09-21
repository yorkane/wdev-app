/*
 * brand-network-overlay webview runtime: official menu item hiding.
 * Ported from OpenCodex codex-menu-item-guard.js. The official menu items
 * carry no stable attributes, so they are matched by exact visible text
 * (multilingual label set, trimmed + lower-cased) inside a menu-like
 * context (role=menu/menubar, Radix menu content, or a dropdown/menu/popover
 * class; dialog contexts are excluded). Matching is per text-node with exact
 * equality so "Help center" / "Keyboard shortcuts" are never touched. Items
 * are hidden (aria-hidden + tabindex=-1 + display:none !important +
 * disabled), never removed, to keep React/Radix reconciliation intact.
 * Installed unconditionally; a throttled MutationObserver covers dynamic
 * menus.
 */
;(function () {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const w = window;
  if (w.__bnovMenuInstalled === true) return;
  w.__bnovMenuInstalled = true;

  const HIDDEN_MENU_LABELS = new Set(__HIDDEN_MENU_LABELS_JSON__.map(function (text) {
    return text.trim().toLowerCase();
  }));

  function menuItemMatches(element) {
    try {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const value = String(node.nodeValue || "").trim().toLowerCase();
        if (value && HIDDEN_MENU_LABELS.has(value)) return true;
        node = walker.nextNode();
      }
    } catch (err) {}
    return false;
  }

  function isMenuLikeContext(element) {
    for (let node = element && element.parentElement; node && node !== document.body; node = node.parentElement) {
      const role = String(node.getAttribute ? node.getAttribute("role") : "") || "";
      if (role === "menu" || role === "menubar") return true;
      if (node.hasAttribute && (node.hasAttribute("data-radix-menu-content") || node.hasAttribute("data-radix-popper-content-wrapper"))) {
        return true;
      }
      const className = String(node.className || "");
      if (role === "dialog" || /\bcodex-dialog\b/i.test(className)) return false;
      if (/\b(dropdown|menu|popover)\b/i.test(className)) return true;
    }
    return false;
  }

  function isMenuItemElement(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.dataset && element.dataset.bnovMenuItemHidden === "true") return false;
    const tagName = String(element.tagName || "").toLowerCase();
    const role = String(element.getAttribute ? element.getAttribute("role") : "") || "";
    if (tagName !== "button" && tagName !== "a" && role !== "menuitem" && role !== "menuitemradio") return false;
    return true;
  }

  function hideMenuItem(element) {
    if (element.dataset) element.dataset.bnovMenuItemHidden = "true";
    element.hidden = true;
    element.setAttribute("aria-hidden", "true");
    element.setAttribute("tabindex", "-1");
    try {
      element.style.setProperty("display", "none", "important");
    } catch (err) {
      try { element.style.display = "none"; } catch (err2) {}
    }
    try {
      if ("disabled" in element) element.disabled = true;
    } catch (err) {}
  }

  function scanMenuItems(root) {
    const scope = root && root.nodeType === 1 ? root : document;
    let candidates = [];
    try {
      candidates = Array.from(scope.querySelectorAll ? scope.querySelectorAll("button,a,[role='menuitem'],[role='menuitemradio']") : []);
    } catch (err) {
      candidates = [];
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

  let scanPending = false;
  try {
    const observer = new MutationObserver(function (records) {
      if (scanPending) return;
      scanPending = true;
      setTimeout(function () {
        scanPending = false;
        try {
          for (const record of records) {
            for (const added of record.addedNodes) {
              if (added.nodeType === Node.ELEMENT_NODE) scanMenuItems(added);
            }
          }
        } catch (err) {}
      }, 100);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true });
  } catch (err) {}

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      if (document.documentElement) scanMenuItems(document.documentElement);
    }, { once: true });
  } else {
    if (document.documentElement) scanMenuItems(document.documentElement);
  }
})();
