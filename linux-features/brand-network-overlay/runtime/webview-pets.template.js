/*
 * brand-network-overlay webview runtime: pets surface hiding.
 * Companion to webview-menu.template.js (which keeps the account-menu
 * "Show pet / Hide pet" items hidden). This guard hides the remaining pet
 * surfaces, still hide-not-remove:
 *   1. the settings-sidebar "Pets" tab button: BUTTON whose label text node
 *      exactly equals a pet label (trimmed, lower-cased), inside the settings
 *      sidebar nav (nav.sidebar-navigation / aria-label "Settings");
 *   2. the Pets settings panel: the H1-H4 heading whose text exactly equals a
 *      pet label, plus its scroll-container ancestor (so the panel content -
 *      "Pick a pet" list, size slider, custom-pet controls - is hidden even
 *      while the user is sitting on the Pets tab);
 *   3. on-screen pet avatars: elements carrying data-codex-pet-id (the
 *      official pet overlay / preview sprite divs, e.g. inside the panel).
 * Exact per-text-node equality keeps "Pet care" / "Keyboard shortcuts" /
 * "Pets tracker" untouched. Nodes are hidden (aria-hidden + tabindex=-1 +
 * display:none !important + disabled), never removed, to keep React/Radix
 * reconciliation intact. Installed once; a throttled MutationObserver covers
 * dynamically mounted nav/panel/overlay nodes.
 */
;(function () {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const w = window;
  if (w.__bnovPetsInstalled === true) return;
  w.__bnovPetsInstalled = true;

  const PET_LABELS = new Set(__PETS_LABELS_JSON__.map(function (text) {
    return String(text).trim().toLowerCase();
  }).filter(Boolean));

  function norm(value) {
    return String(value == null ? "" : value).trim().toLowerCase();
  }

  function isPetLabel(value) {
    const text = norm(value);
    return text !== "" && PET_LABELS.has(text);
  }

  function hasExactPetLabel(element) {
    try {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if (isPetLabel(node.nodeValue)) return true;
        node = walker.nextNode();
      }
    } catch (err) {}
    return false;
  }

  function isSettingsSidebarContext(element) {
    for (let node = element && element.parentElement; node && node !== document.body; node = node.parentElement) {
      const tagName = String(node.tagName || "").toLowerCase();
      const className = String(node.className || "");
      if (tagName === "nav" && (className.indexOf("sidebar-navigation") !== -1 || norm(node.getAttribute("aria-label")) === "settings")) {
        return true;
      }
    }
    return false;
  }

  function hideElement(element) {
    if (!element || element.nodeType !== 1) return;
    if (element.dataset && element.dataset.bnovPetsHidden === "true") return;
    if (element.dataset) element.dataset.bnovPetsHidden = "true";
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

  function petsPanelRootOf(heading) {
    // The Pets page content (heading, pick-a-pet list, size slider) lives in
    // one panel-root block (div with the "mx-auto" width class) inside the
    // settings page scroll container. Walk up from the heading to that block
    // so the whole panel can be hidden at once.
    let node = heading && heading.parentElement;
    while (node && node.nodeType === 1) {
      if (node.tagName === "DIV" && /\bmx-auto\b/.test(String(node.className || ""))) return node;
      if (node.tagName === "BODY") break;
      node = node.parentElement;
    }
    return heading && heading.parentElement;
  }

  function scanElement(element) {
    if (!element || element.nodeType !== 1) return;
      // 3. pet avatar / sprite elements (semantic attribute anchor).
      if (element.hasAttribute && (element.hasAttribute("data-codex-pet-id") || element.hasAttribute("data-codex-pet-state"))) {
        hideElement(element);
        return;
      }
      // 2. the Pets settings panel heading -> hide heading + its content
      //    panel root (heading, pet list, size slider), so the whole panel
      //    disappears even while the user sits on the Pets tab.
      const tagName = String(element.tagName || "").toLowerCase();
      if (tagName === "h1" || tagName === "h2" || tagName === "h3" || tagName === "h4") {
        if (hasExactPetLabel(element)) {
          hideElement(element);
          const root = petsPanelRootOf(element);
          if (root) hideElement(root);
        }
        return;
      }
      // 1. the settings-sidebar Pets tab button.
      if (tagName === "button" || tagName === "a") {
        if (!isSettingsSidebarContext(element)) return;
        if (isPetLabel(element.getAttribute("aria-label"))) {
          hideElement(element);
          return;
        }
        if (hasExactPetLabel(element)) hideElement(element);
      }
  }

  function scanRoot(root) {
    const scope = root && root.nodeType === 1 ? root : document;
    // The added node itself may BE the pet element (React commits the H1 /
    // the sprite div as their own addedNodes), so check it, then its
    // descendants.
    scanElement(scope);
    let all = [];
    try {
      all = Array.from(scope.querySelectorAll ? scope.querySelectorAll("*") : []);
    } catch (err) {
      return;
    }
    for (const element of all) scanElement(element);
  }

  let scanPending = false;
  const pendingAdded = [];
  let petsObserver = null;
  try {
    petsObserver = new MutationObserver(function (records) {
      for (const record of records) {
        for (const added of record.addedNodes) {
          if (added.nodeType === Node.ELEMENT_NODE) pendingAdded.push(added);
        }
      }
      // Records arriving while a scan is queued are accumulated (never
      // dropped) and flushed together.
      if (scanPending) return;
      scanPending = true;
      setTimeout(function () {
        scanPending = false;
        const batch = pendingAdded.splice(0);
        try {
          for (const node of batch) scanRoot(node);
        } catch (err) {}
      }, 100);
    });
    // Test hook: lets the vm-sandbox suite distinguish this observer from
    // the other bnov runtimes' observers (no-op on a real DOM).
    try { petsObserver.__bnovPetsObserver = true; } catch (err) {}
    petsObserver.observe(document.documentElement, { subtree: true, childList: true });
  } catch (err) {}

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      if (document.documentElement) scanRoot(document.documentElement);
    }, { once: true });
  } else {
    if (document.documentElement) scanRoot(document.documentElement);
  }
})();
