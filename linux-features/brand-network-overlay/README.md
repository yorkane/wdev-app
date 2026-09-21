# Brand & Network Overlay

Local overlay for the official ChatGPT desktop app on Linux, ported from the
OpenCodex `codex/brand-network-overlay` branch into the wdev-app ASAR patch
pipeline. It ships five patch descriptors:

- `main-bundle`: wraps Electron `net.fetch` and the main session
  `webRequest.onBeforeRequest` so blocked outbound hosts get a local 200
  response and Statsig control-plane URLs get legal synthetic payloads
  (initialize paced by the official 400ms init-race delay).
- `webview-asset` (network + Statsig): takes over `window.fetch`,
  `XMLHttpRequest` and `navigator.sendBeacon` in the main webview bundle;
  blocked hosts get local 200 responses, Statsig endpoints get the official
  numeric contract (feature gates 3903742690/505458/artifacts, i18n layer
  72216192).
- `webview-asset` (brand text): word-boundary replacement of ChatGPT / OpenAI
  / Codex / openai in rendered text nodes and alt/title/aria-label, with the
  official conversation/code exclusion list, driven by a throttled
  MutationObserver.
- `webview-asset` (menu hiding): hides the official help "What's new / Help"
  and account "Show/Hide pet" menu items by multilingual label match (hide,
  never remove).

## Configuration

Baked-in defaults live in `feature.json` (`brandNetworkOverlay` block, brand
name + six-host block list) and are overridable per build through the usual
`features.json` `settings`. At runtime the main process re-reads
`/etc/codex-desktop/config.yaml` (override path via `CODEX_DESKTOP_CONFIG`,
brand via `CODEX_DESKTOP_BRAND_NAME`, Statsig initialize delay via
`CODEX_DESKTOP_STATSIG_INITIALIZE_DELAY_MS`), parses the same
`brand:` / `network:` YAML subset as the OpenCodex gateway, and injects the
result into the webview at document start. Parse/read failures fall back to
the baked defaults. Matching semantics: `*.example.com` matches subdomains
only, allow wins over block, only http(s) URLs are ever blocked.

## Files

- `feature.json` - feature manifest + baked defaults.
- `patch.js` - the five ASAR patch descriptors (see `doc/` for the
  descriptor map).
- `lib/host-match.js` - pure host-matching functions (shared by tests and the
  injected runtimes).
- `lib/site-config.js` - hand-rolled YAML subset reader + config priority
  chain (pure, injectable for tests).
- `lib/statsig.js` - Statsig URL classification + synthetic payload builders
  (numeric contract, pure).
- `runtime/webview-*.template.js` - the four appended webview IIFE templates
  (statsig / network / brand / menu), placeholders filled by
  `webview-runtime.js`.
- `runtime/webview-runtime.js` - assembles the four templates into the final
  webview runtime sources.
- `runtime/main-runtime.js` - builds the main-process runtime source appended
  to `.vite/build/main*.js`.
- `test.js` - `node --test` suite.

## Verification (upstream `chatgpt_26.908.40834_amd64.deb`)

- `node --test linux-features/brand-network-overlay/test.js` — 26/26 pass
  (host matching, YAML config parsing, Statsig numeric contract, webview
  runtimes in a vm sandbox with read-only-IDL FakeXHR, patch idempotency,
  and all five descriptors applied against the real 26.908 asar extract).
- `UPSTREAM_DEB=/nas2/tmp/chatgpt_26.908.40834_amd64.deb
  CODEX_LINUX_FEATURES_CONFIG=<features.json enabling this feature>
  ./install.sh --inspect --report-dir /data/tmp/overlay-inspect/report <deb>`
  — patch-report: `applied=5`, all five descriptors `applied`:
  `net-fetch-overlay` (main-bundle), `statsig-local-responder`,
  `network-block-guard`, `brand-text-overlay`, `menu-item-hider`
  (webview-asset, bundle `app-initial-74b69e67976a.js`).

Anchors: webview descriptors gate on the three unique markers
(`ab.chatgpt.com`, `/ces/v1/rgstr`, `sidebarProjectRow`) plus the
`app-initial-*.js` filename pattern; the main-bundle descriptor gates on
`exports.runMainAppStartup` in `.vite/build/main*.js`.

## Known limitations

- The renderer-side guards (webview IIFEs) are the primary interception
  layer and serve the local 200s; the main-process `webRequest` hook is a
  cancel-only safety net (main cannot fabricate a response body through
  `webRequest`).
- `net.fetch` wrapping patches the `electron.net` property at module load;
  official code that captured `net.fetch` by reference before the IIFE ran
  is unaffected (none observed in the 26.908 main bundle — it reads
  `l.net.fetch` lazily).
- The webview config injection matches the webview `index.html` file URL;
  when the window loads a different entry (e.g. remote), the runtime falls
  back to the baked defaults.
