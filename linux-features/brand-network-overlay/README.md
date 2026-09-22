# Brand & Network Overlay

Local overlay for the official ChatGPT desktop app on Linux, ported from the
OpenCodex `codex/brand-network-overlay` branch into the wdev-app ASAR patch
pipeline. It ships six patch descriptors:

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
- `webview-asset` (pets surface hiding): hides every remaining pet surface -
  the settings-sidebar "Pets" tab, the Pets settings panel (heading +
  content container, so the "Pick a pet" list, size slider and custom-pet
  controls disappear even while the user sits on the Pets tab), and
  on-screen pet avatar elements (`data-codex-pet-id` / `data-codex-pet-state`
  sprite divs, e.g. the panel previews). Hiding is exact per-text-node label
  match (multilingual: Pets / Pet / 宠物 / 虚拟宠物, trimmed + lower-cased) so
  "Pet care" lookalikes are never touched; avatars match by the official
  `data-codex-pet-*` attributes.

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

### URL-level temporary allows (`network.allowPaths`)

Official upgrades can introduce newly required endpoints that fall inside a
blocked host family and get short-circuited to a local 200. `allowPaths`
opens URL-level holes for exactly those endpoints (temporary by design -
narrow them back down once the new version settles):

```yaml
network:
  block: [ "*.chatgpt.com", "chatgpt.com" ]
  allow: []
  allowPaths:            # URL-level allow, outranks block
    - "ab.chatgpt.com/v1/initialize"   # exact path
    - "chatgpt.com/backend-api/*"      # prefix glob
```

Rule semantics (kept word-for-word identical to the bundled OpenCodex
gateway `site-config.cjs`):

- one rule is `<hostPattern>/<pathGlob>`, split at the **first** `/`; an
  entry without `/` is host-only (equivalent to an `allow` entry);
- `hostPattern` uses the usual host semantics (case-insensitive, `*.x.com`
  matches subdomains only, never the bare domain);
- `pathGlob` matches the URL **pathname** only (query ignored),
  **case-sensitive**; `*` matches any run of characters including `/`,
  every other character is literal (escaped into a regex); a leading `/` is
  stripped on both sides, so `backend-api/*` and `/backend-api/*` are the
  same rule;
- invalid entries (illegal host, empty path) are dropped, duplicates
  deduped, original order kept - a broken config can never break the app;
- evaluation order: **allowPaths hit -> pass** (real request goes out); else
  `allow`(host) hit -> pass; else `block`(host) hit -> block. Non-http(s)
  or unparseable URLs are never blocked.

The config object exposes the normalized rules as
`network.allowedPaths`; `network.configured` is also true when *only*
allowPaths is set. All interception layers (main `net.fetch`, main
`webRequest`, renderer fetch/XHR/sendBeacon) share the same
`urlPolicy()`-style decision, so a hole opens at every layer at once.

## Audit log

Every interception layer appends one JSON line per event:

- path: env `CODEX_DESKTOP_NETWORK_AUDIT_LOG`, default
  `/var/log/codex-desktop/network-audit.jsonl`. Read **at write time**
  (never baked), so the app can be pointed at a new path (or disabled)
  without reinstalling.
- disabled: set the env value to `0` / `off` / `none` (case-insensitive).
- append-only; rotation (8 MiB -> `.1`) is the **gateway's** job, the
  desktop never truncates or deletes the file.

Line shape (fixed fields; **never** query/cookie/header/body - `path` is
the pathname without query):

```json
{"ts":"2026-09-21T17:00:00.000Z","event":"block","layer":"desktop-net-fetch","host":"chatgpt.com","path":"/ces/v1/rgstr","method":"POST"}
{"ts":"2026-09-21T17:00:01.000Z","event":"allow-path","layer":"desktop-net-fetch","host":"ab.chatgpt.com","path":"/v1/initialize","method":"GET"}
{"ts":"2026-09-21T17:00:02.000Z","event":"statsig-local","layer":"desktop-net-fetch","host":"ab.chatgpt.com","path":"/v1/initialize","method":"POST"}
{"ts":"2026-09-21T17:00:03.000Z","event":"config","layer":"desktop-net-fetch","version":"26.908.40834","blockedCount":6,"allowedCount":0,"allowedPathsCount":1,"blockedHosts":["chatgpt.com","*.chatgpt.com"],"allowedHosts":[],"allowedPathRules":["ab.chatgpt.com/v1/initialize"]}
```

- `event`: `block` (intercepted), `allow-path` (a blocked host passed
  through because of allowPaths - proof the temporary allow took effect),
  `statsig-local` (Statsig control plane answered locally), `config`
  (written once after a successful main-runtime install: the policy in
  effect at that (re)start, so every upgrade leaves a timestamped record).
- `layer`: `desktop-net-fetch` (main `net.fetch`), `desktop-webrequest`
  (main `webRequest` cancel), `desktop-webview` (renderer guard, see
  below). The gateway writes `gateway-net-fetch` / `gateway-ipc` into the
  same file; `codex-desktop-gateway doctor` aggregates all of them.
- best-effort: a write failure falls back to a deduped `console.warn`
  and never touches interception. The existing
  `"[brand-network-overlay] ... blocked by config: <host><path>"`
  `console.warn` lines stay in place (URL already query-stripped) so
  `gateway.log` remains grep-able.

### Renderer (webview guard) audit path

The renderer guard runs inside the Electron webview and **cannot write
files**. On every block / allow-path decision it emits one compact JSON
`console.info` line prefixed `[bnov-audit]`; the main runtime listens on
`webContents.on("console-message")` (hooked from the existing
`browser-window-created` path) and persists those lines as
`layer:"desktop-webview"` records. Limitations: if the console-message
bridge is unavailable (or a window loads a non-local entry the hook never
sees), the line is still visible in the app log / `gateway.log` but no
`desktop-webview` audit record is written for it.


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
  (statsig / network / brand / menu / pets), placeholders filled by
  `webview-runtime.js`.
- `runtime/webview-runtime.js` - assembles the five templates into the final
  webview runtime sources.
- `runtime/main-runtime.js` - builds the main-process runtime source appended
  to `.vite/build/main*.js`.
- `test.js` - `node --test` suite.

## Verification (upstream `chatgpt_26.908.40834_amd64.deb`)

- `node --test linux-features/brand-network-overlay/test.js` — 32/32 pass
  (host matching, YAML config parsing, Statsig numeric contract, webview
  runtimes in a vm sandbox with read-only-IDL FakeXHR, pets surface hiding
  incl. sidebar tab / panel / avatar / idempotency, patch idempotency, and
  all six descriptors applied against the real 26.908 asar extract).
- `UPSTREAM_DEB=/nas2/tmp/chatgpt_26.908.40834_amd64.deb
  CODEX_LINUX_FEATURES_CONFIG=<features.json enabling this feature>
  ./install.sh --inspect --report-dir /data/tmp/overlay-inspect/report <deb>`
  — patch-report: `applied=5`, all five descriptors `applied`:
  `net-fetch-overlay` (main-bundle), `statsig-local-responder`,
  `network-block-guard`, `brand-text-overlay`, `menu-item-hider`,
  `pets-surface-hider` (webview-asset, bundle `app-initial-74b69e67976a.js`).

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
