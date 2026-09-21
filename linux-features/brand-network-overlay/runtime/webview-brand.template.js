/*
 * brand-network-overlay webview runtime: brand text replacement.
 * Ported from OpenCodex codex-brand-text.js. Word-boundary replacement of
 * ChatGPT / OpenAI / Codex / openai (lowercase openai is covered because the
 * official account label renders lowercase; lowercase codex is NOT, to keep
 * user conversation titles intact). Only rendered text nodes and the
 * user-visible attributes alt/title/aria-label are touched; conversation and
 * code containers are excluded (whole subtree). document.title is part of
 * the shell and is rewritten. Continuous rewriting uses a self-contained,
 * throttled MutationObserver (mutations coalesced into one pass per 100ms).
 * Installed only when a non-default brand name is configured.
 */
;(function () {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const w = window;
  if (w.__bnovBrandInstalled === true) return;

  const BAKED_CONFIG = __BAKED_CONFIG_JSON__;
  const RT_CONFIG = typeof w.__bnovConfig === "object" && w.__bnovConfig !== null ? w.__bnovConfig : null;
  const DEFAULT_BRAND = "OpenCodex";
  const brandName = String(
    (RT_CONFIG && RT_CONFIG.brand && RT_CONFIG.brand.name) ||
      (BAKED_CONFIG.brand && BAKED_CONFIG.brand.name) ||
      "",
  ).trim();
  if (!brandName || brandName === DEFAULT_BRAND) return;

  w.__bnovBrandInstalled = true;
  const BRAND_WORD_RE = /\bChatGPT\b|\bOpenAI\b|\bCodex\b|\bopenai\b/g;
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
  const USER_VISIBLE_ATTRS = ["alt", "title", "aria-label"];

  function isContentExcluded(node) {
    let current = node;
    while (current && current.nodeType !== Node.ELEMENT_NODE) current = current.parentNode;
    if (!current) return false;
    try {
      return typeof current.closest === "function" && Boolean(current.closest(EXCLUDED_CONTENT_SELECTOR));
    } catch (err) {
      return false;
    }
  }

  function replaceBrandWords(value) {
    const text = String(value == null ? "" : value);
    if (!text) return text;
    BRAND_WORD_RE.lastIndex = 0;
    if (!BRAND_WORD_RE.test(text)) return text;
    BRAND_WORD_RE.lastIndex = 0;
    return text.replace(BRAND_WORD_RE, brandName);
  }

  function rewriteElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    if (isContentExcluded(el)) return;
    const walker = document.createTreeWalker(
      el,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return isContentExcluded(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    const nodes = [];
    let current;
    while ((current = walker.nextNode())) nodes.push(current);
    for (const node of nodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        for (const attr of USER_VISIBLE_ATTRS) {
          const original = node.getAttribute ? node.getAttribute(attr) : null;
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

  function rewriteTitle() {
    try {
      const title = document.title;
      if (!title) return;
      const next = replaceBrandWords(title);
      if (next !== title) document.title = next;
    } catch (err) {}
  }

  function scanDocument() {
    if (document.documentElement) rewriteElement(document.documentElement);
    rewriteTitle();
  }

  // Throttled observer: real mutation bursts coalesce into a single pass
  // every 100ms; steady state produces no work at all.
  let passPending = false;
  try {
    const observer = new MutationObserver(function (records) {
      if (passPending) return;
      passPending = true;
      setTimeout(function () {
        passPending = false;
        try {
          for (const record of records) {
            if (record.type === "childList") {
              for (const added of record.addedNodes) {
                if (added.nodeType === Node.ELEMENT_NODE) {
                  if (!isContentExcluded(added)) rewriteElement(added);
                } else if (added.nodeType === Node.TEXT_NODE) {
                  if (isContentExcluded(added)) continue;
                  const next = replaceBrandWords(added.nodeValue);
                  if (next !== added.nodeValue) added.nodeValue = next;
                }
              }
            } else if (record.type === "characterData") {
              const node = record.target;
              if (node && node.nodeType === Node.TEXT_NODE) {
                if (isContentExcluded(node)) continue;
                const next = replaceBrandWords(node.nodeValue);
                if (next !== node.nodeValue) node.nodeValue = next;
              }
            } else if (record.type === "attributes") {
              if (USER_VISIBLE_ATTRS.indexOf(record.attributeName) !== -1 && record.target) {
                if (!isContentExcluded(record.target)) rewriteElement(record.target);
              }
            }
          }
          rewriteTitle();
        } catch (err) {}
      }, 100);
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: USER_VISIBLE_ATTRS,
    });
  } catch (err) {}

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { scanDocument(); }, { once: true });
  } else {
    scanDocument();
  }
})();
