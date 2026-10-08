# durable-turns

Stop tying the lifetime of a turn to the lifetime of a UI client.

## Why

Every automatic interrupt path in the upstream Codex bundles encodes one
assumption: when nobody is watching, stop the work. For the OpenCodex web
deployment that assumption is inverted. Many concurrent browser viewers plus
background and headless sessions are the normal case, so losing a viewer is
routine rather than exceptional. Measured on the 235.t production box, the
gateway logged 888 orphaned app-host relays against only 470 reattachments,
and a single lost viewer could take down a whole subagent tree: on
2026-10-06 15 threads were interrupted inside a single second.

The turn itself is executed by the long-lived app-server process, not by the
page. A viewer going away is therefore not a reason to stop working.

## What it changes

The same source ships twice, in the main-process bundle
(.vite/build/main-*.js) and the webview entry bundle
(webview/assets/app-initial-*.js), with identical logic but different minified
identifiers, so each edit carries a per-flavor anchor.

| id | site | change |
|---|---|---|
| P0-a | AppServerManager.interruptConversationSelf | A follower whose stream owner vanished only interrupts locally for an explicit user stop. Every other mode marks needs_resume and rethrows. |
| P0-b | AppServerManager.interruptConversation | The descendant cascade fires only for user-stop. Previously any interrupt nuked the whole subagent tree. |
| P1-a | inactive owner constants | The 3h idle TTL and the 10-thread cap are disabled, so background and headless conversations are not auto-unsubscribed. |
| P1-b | discardConversationFromCache | Evicting a cached conversation no longer interrupts it implicitly. |

P0-b and P1-b bump a global counter when they suppress an interrupt
(globalThis.__dtCascadeUserStopOnly, globalThis.__dtNoDiscardKill), which makes
the suppression observable at runtime instead of only inferable from logs.

## Safety

ciPolicy is required-upstream. A missing or ambiguous anchor throws, so an
upstream rename fails the build rather than shipping a partial fix. Each edit
is idempotent: re-running over an already patched bundle is a no-op.

There is no ASAR integrity work to do by hand - @electron/asar recomputes the
per-file SHA-256 entries when repacking. Editing the archive in place without
repacking would trip the in-header integrity check and exit(1).

## Enabling

Committed configuration keeps this feature disabled, per AGENTS.md. Enable it
on the target box only:

    linux-features/features.json  ->  "enabled": ["brand-network-overlay", "durable-turns"]

## Verification

1. Build the deb and confirm the patch report lists all four edits as applied
   for both bundles.
2. Confirm the running bundle carries the markers, not just the built one:
   grep -c __dtMode <bundle>. The gateway materializes
   CODEX_WEB_OFFICIAL_BUNDLE_DIR from the asar, keyed by asar size and mtime,
   so replacing the asar makes it re-materialize on the next start.
3. Compare interrupt counters on a patched and an unpatched box over the same
   window: "interrupt received" in the client log database, plus
   app_host_port_reset_requested and turn/interrupt in gateway.log.
