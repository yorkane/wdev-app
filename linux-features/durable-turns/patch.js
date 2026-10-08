// durable-turns ASAR patch.
//
// Codex Desktop ties the lifetime of a turn to the lifetime of a UI client.
// Every automatic interrupt path in the upstream bundles encodes one
// assumption: "nobody is watching, so stop the work". That assumption is
// inverted for the OpenCodex web deployment, where many concurrent browser
// viewers plus background and headless sessions are the normal case and
// losing a viewer is routine rather than exceptional.
//
// The same source ships twice - once in the main-process bundle
// (.vite/build/main-*.js) and once in the webview entry bundle
// (webview/assets/app-initial-*.js) - with identical logic but different
// minified identifiers, so every edit carries a per-flavor anchor.
//
//   P0-a  interruptConversationSelf
//        A follower whose stream owner vanished used to interrupt the turn
//        locally for every mode, including system. It now only does so for an
//        explicit user stop; anything else marks needs_resume and rethrows.
//        The mark has to happen BEFORE the guard, not after it: the upstream
//        code marked and then fell through, so hoisting only the guard above
//        the mark would rethrow without marking. That left stream role still
//        pointing at the dead owner while resumeState stayed "resumed", and
//        needsResume() requires resumeState==='needs_resume' or a null stream
//        role - both gates shut, so the follower could not self-heal in
//        exactly the scenario this patch exists for.
//   P0-b  interruptConversation
//        The descendant cascade - every single interrupt nuking the whole
//        subagent tree - now fires only for user-stop. This is what turned one
//        lost viewer into a dozen dead sessions.
//   P1-a  inactive owner constants
//        Background and headless conversations are no longer auto-unsubscribed
//        (the 3h idle TTL and the 10-thread cap are effectively disabled).
//        The TTL is 2147483647, NOT Number.MAX_SAFE_INTEGER. Node clamps any
//        setTimeout delay above 2^31-1 to 1ms with a TimeoutOverflowWarning.
//        With MAX_SAFE_INTEGER the next-check delay overflowed to 1ms, the
//        check found no candidate and rescheduled, and the loop spun at
//        roughly 900 iterations per second, burning 11-13% of a core at three
//        idle conversations and 36% at a hundred. 2147483647 is a legal delay
//        (~24.8 days) and actually disables the timer.
//   P1-b  discardConversationFromCache
//        Evicting a cached conversation no longer interrupts it implicitly.
//
// ciPolicy is required-upstream on purpose: if a future Codex build renames
// any anchor, the build must fail rather than ship a half-applied fix. The
// two bundles are patched through separate descriptors, so drift in either
// one is caught.

"use strict";

const BT = String.fromCharCode(96);

const CASCADE_MARKER = "__dtCascadeUserStopOnly";
const DISCARD_MARKER = "__dtNoDiscardKill";
const MODE_ALIAS = "__dtMode";

function bq(s) {
  return BT + s + BT;
}

const CASCADE_FIND =
  "(t===" + bq("user-stop")
  + "?this.interruptSubagentDescendantsInBackground(e)"
  + ":await this.interruptSubagentDescendants(e))";

const CASCADE_REPLACE =
  "(t===" + bq("user-stop")
  + "?this.interruptSubagentDescendantsInBackground(e)"
  + ":(globalThis." + CASCADE_MARKER
  + "=(globalThis." + CASCADE_MARKER + "||0)+1,void 0))";

function discardReplace() {
  return "async discardConversationFromCache(e){"
    + "let t=this.getConversation(e);"
    + "if(t!=null&&(globalThis." + DISCARD_MARKER
    + "=(globalThis." + DISCARD_MARKER + "||0)+1,!1))"
    + "try{await this.interruptConversation(e)}";
}

const EDITS = {
  main: [
    {
      id: "P0-a-mode-alias",
      find: "async interruptConversationSelf(e,t,r){let i=this.getStreamRole(e);",
      replace:
        "async interruptConversationSelf(e,t,r){let " + MODE_ALIAS
        + "=t;let i=this.getStreamRole(e);",
    },
    {
      id: "P0-a-follower-guard",
      find: "if(i?.role!==" + bq("follower") + "||a==null)throw t;",
      replace:
        "if(i?.role===" + bq("follower") + "&&a!=null)"
        + "this.markConversationNeedsResumeForUnavailableOwner(e,i.ownerClientId);"
        + "if(" + MODE_ALIAS + "!==" + bq("user-stop")
        + "||i?.role!==" + bq("follower") + "||a==null)throw t;",
    },
    {
      id: "P0-b-cascade",
      find: CASCADE_FIND,
      replace: CASCADE_REPLACE,
    },
    {
      id: "P1-a-inactive-ttl",
      find: "var qC=10800*1e3,t_e=15e3,JC=10,",
      replace: "var qC=2147483647,t_e=15e3,JC=2147483647,",
    },
    {
      id: "P1-b-discard-cache",
      find:
        "async discardConversationFromCache(e){"
        + "let t=this.getConversation(e);"
        + "if(t!=null&&LC(t))try{await this.interruptConversation(e)}",
      replace: discardReplace(),
    },
  ],
  webview: [
    {
      id: "P0-a-mode-alias",
      find: "async interruptConversationSelf(e,t,n){let r=this.getStreamRole(e);",
      replace:
        "async interruptConversationSelf(e,t,n){let " + MODE_ALIAS
        + "=t;let r=this.getStreamRole(e);",
    },
    {
      id: "P0-a-follower-guard",
      find: "if(r?.role!==" + bq("follower") + "||i==null)throw t;",
      replace:
        "if(r?.role===" + bq("follower") + "&&i!=null)"
        + "this.markConversationNeedsResumeForUnavailableOwner(e,r.ownerClientId);"
        + "if(" + MODE_ALIAS + "!==" + bq("user-stop")
        + "||r?.role!==" + bq("follower") + "||i==null)throw t;",
    },
    {
      id: "P0-b-cascade",
      find: CASCADE_FIND,
      replace: CASCADE_REPLACE,
    },
    {
      id: "P1-a-inactive-ttl",
      find: "RGt=10800*1e3,zGt=15e3,BGt=10,",
      replace: "RGt=2147483647,zGt=15e3,BGt=2147483647,",
    },
    {
      id: "P1-b-discard-cache",
      find:
        "async discardConversationFromCache(e){"
        + "let t=this.getConversation(e);"
        + "if(t!=null&&ov(t))try{await this.interruptConversation(e)}",
      replace: discardReplace(),
    },
  ],
};

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// verifyEdits asserts the terminal state of a rewritten bundle instead of
// trusting per-edit bookkeeping.
//
// The per-edit `out.includes(edit.replace)` short circuit is content
// triggered, not state triggered: if the replacement text appears anywhere in
// the bundle - a comment, a string literal, upstream code that happens to look
// the same - the edit is silently skipped. That defeats the whole point of
// ciPolicy required-upstream, which promises a failed build rather than a
// half-applied patch. The worst observed case produced text referencing an
// undeclared `__dtMode` while still reporting "already patched, skipping",
// and node --check does not catch it because a syntax check does not resolve
// scope; it only explodes at runtime as a ReferenceError.
//
// Every anchor is verified unique (exactly one occurrence in the upstream
// bundle), so after a successful rewrite each `find` must be gone and each
// `replace` must be present. Asserting the end state directly catches both a
// skipped edit and a partially applied bundle, whatever caused it.
function verifyEdits(out, edits, patchName) {
  for (const edit of edits) {
    const stale = countOf(out, edit.find);
    if (stale > 0) {
      throw new Error(
        patchName + ": " + edit.id + " did not apply (anchor still present "
          + stale + " time(s) after rewrite); refusing to ship a partial patch",
      );
    }
    if (countOf(out, edit.replace) < 1) {
      throw new Error(
        patchName + ": " + edit.id + " replacement is absent after rewrite; "
          + "refusing to ship a partial patch",
      );
    }
  }
}

// applyEdits rewrites one bundle. It is idempotent: an edit whose replacement
// is already present is skipped, so re-running over an already patched bundle
// is a no-op. A missing or ambiguous anchor throws on purpose - the descriptor
// is registered as required-upstream, so drift breaks the build instead of
// quietly shipping a partial fix.
function applyEdits(source, flavor, patchName) {
  if (typeof source !== "string") return source;
  const edits = EDITS[flavor];
  if (edits == null) throw new Error(patchName + ": unknown bundle flavor " + flavor);
  let out = source;
  let applied = 0;
  for (const edit of edits) {
    if (out.includes(edit.replace)) continue;
    const hits = countOf(out, edit.find);
    if (hits === 0) {
      throw new Error(
        patchName + ": anchor missing for " + edit.id
          + " (upstream bundle drifted; refusing to ship a partial patch)",
      );
    }
    if (hits > 1) {
      throw new Error(
        patchName + ": anchor for " + edit.id + " is ambiguous (" + hits + " matches)",
      );
    }
    out = out.replace(edit.find, edit.replace);
    applied += 1;
  }
  if (applied > 0) {
    console.log("durable-turns: applied " + applied + "/" + edits.length + " edits to " + patchName);
  } else {
    console.log("durable-turns: " + patchName + " already patched, skipping");
  }
  // Always assert the end state, including on the no-op path.
  verifyEdits(out, edits, patchName);
  return out;
}

function bundleHasInterruptContract(source) {
  return typeof source === "string"
    && source.includes("interruptConversationSelf")
    && source.includes("discardConversationFromCache")
    && source.includes("interruptSubagentDescendantsInBackground");
}

const descriptors = [
  {
    id: "durable-turns-main-bundle",
    phase: "main-bundle",
    order: 20_700,
    ciPolicy: "required-upstream",
    missingDescription: "main bundle (interruptConversationSelf / discardConversationFromCache)",
    skipDescription: "durable-turns main-bundle turn lifetime patch",
    apply: (source) => applyEdits(source, "main", "durable-turns main-bundle"),
  },
  {
    id: "durable-turns-webview-entry",
    phase: "webview-asset",
    order: 20_701,
    ciPolicy: "required-upstream",
    pattern: /^app-initial-[^.]+\.js$/,
    assetMatch: bundleHasInterruptContract,
    missingDescription: "webview app-initial entry bundle (interruptConversationSelf contract)",
    skipDescription: "durable-turns webview turn lifetime patch",
    apply: (source) => applyEdits(source, "webview", "durable-turns webview entry"),
  },
];

module.exports = {
  CASCADE_MARKER,
  DISCARD_MARKER,
  EDITS,
  MODE_ALIAS,
  applyEdits,
  bundleHasInterruptContract,
  descriptors,
  verifyEdits,
};
