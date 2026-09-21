/*
 * brand-network-overlay webview runtime: Statsig local responder.
 * Ported from OpenCodex codex-bridge-polyfill.js (statsig hunks) +
 * codex-statsig-telemetry-guard.js, as one standalone IIFE (installed FIRST,
 * innermost layer). Exposes window.__bnovStatsigInitialize / __bnovStatsig
 * Evaluation for the network guard (installed after this one) to reuse, so
 * both layers emit identical payload shapes.
 */
;(function () {
  "use strict";
  if (typeof window === "undefined") return;
  const w = window;
  if (w.__bnovStatsigInstalled === true) return;
  w.__bnovStatsigInstalled = true;

  __STATSIG_FUNCTIONS__

  // The network guard (outer layer) reuses these so the XHR channel can serve
  // the full initialize payload / legal evaluation bodies.
  w.__bnovStatsigInitialize = buildStatsigInitializeResponse;
  w.__bnovStatsigEvaluation = buildStatsigEvaluationResponse;

  function jsonResponse(body) {
    return new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  }

  function dispatchSafe(target, type) {
    try {
      target.dispatchEvent(new Event(type));
    } catch (err) {}
  }

  // Channel: fetch. The Statsig SDK control plane and telemetry endpoints are
  // answered locally regardless of the block list (parity with the OpenCodex
  // bridge polyfill): initialize gets the full gate payload, other /v1/* get
  // the minimal has_updates:false body, telemetry gets "{}". The SDK
  // type-checks these bodies; a bare "{}" for initialize would spam
  // "[Statsig] Failed to parse Response".
  if (typeof w.fetch === "function") {
    const originalFetch = w.fetch.bind(w);
    w.fetch = function (input, init) {
      let url = "";
      if (typeof input === "string") url = input;
      else if (input && typeof input === "object" && typeof input.url === "string") url = input.url;
      if (url && isStatsigInitializeUrl(url, location.href)) {
        return Promise.resolve(jsonResponse(JSON.stringify(buildStatsigInitializeResponse())));
      }
      if (url && isStatsigEvaluationUrl(url, location.href)) {
        let pathname = "";
        try {
          pathname = new URL(url, location.href).pathname;
        } catch (err) {}
        return Promise.resolve(jsonResponse(JSON.stringify(buildStatsigEvaluationResponse(pathname))));
      }
      if (url && isStatsigTelemetryUrl(url, location.href)) {
        return Promise.resolve(jsonResponse("{}"));
      }
      return originalFetch(input, init);
    };
  }

  // Channel: XMLHttpRequest (telemetry only). The official SDK reports through
  // XHR and sendBeacon, not fetch; XHR status/statusText/response/
  // responseText/readyState are read-only IDL properties, so they must be
  // overwritten with Object.defineProperty on the instance and the events
  // dispatched asynchronously (the SDK registers load after send() returns).
  if (typeof w.XMLHttpRequest === "function") {
    const xhrPrototype = w.XMLHttpRequest.prototype;
    const originalOpen = xhrPrototype.open;
    const originalSend = xhrPrototype.send;

    xhrPrototype.open = function (method, url, rest) {
      this.__bnovStatsigUrl = typeof url === "string" ? url : "";
      return originalOpen.apply(this, arguments);
    };

    xhrPrototype.send = function (body) {
      const raw = String(this.__bnovStatsigUrl || "");
      if (!raw || !isStatsigTelemetryUrl(raw, location.href)) {
        return originalSend.call(this, body);
      }
      const xhr = this;
      function defineReadOnly(target, name, value) {
        try {
          Object.defineProperty(target, name, { configurable: true, enumerable: true, get: function () { return value; } });
        } catch (err) {}
      }
      dispatchSafe(xhr, "loadstart");
      setTimeout(function () {
        defineReadOnly(xhr, "status", 200);
        defineReadOnly(xhr, "statusText", "OK");
        defineReadOnly(xhr, "response", "{}");
        defineReadOnly(xhr, "responseText", "{}");
        defineReadOnly(xhr, "readyState", 4);
        dispatchSafe(xhr, "readystatechange");
        dispatchSafe(xhr, "load");
        dispatchSafe(xhr, "loadend");
      }, 0);
      return undefined;
    };
  }

  // Channel: sendBeacon (telemetry only). Returning true stops SDK retries.
  if (w.navigator && typeof w.navigator.sendBeacon === "function") {
    const originalSendBeacon = w.navigator.sendBeacon.bind(w.navigator);
    w.navigator.sendBeacon = function (url, data) {
      const raw = String(url || "");
      if (raw && isStatsigTelemetryUrl(raw, location.href)) return true;
      return originalSendBeacon.apply(w.navigator, arguments);
    };
  }
})();
