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
//   P0-b  interruptConversation
//        The descendant cascade - every single interrupt nuking the whole
//        subagent tree - now fires only for user-stop. This is what turned one
//        lost viewer into a dozen dead sessions.
//   P1-a  inactive owner constants
//        Background and headless conversations are no longer auto-unsubscribed
//        (the 3h idle TTL and the 10-thread cap are effectively disabled).
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
        "if(" + MODE_ALIAS + "!==" + bq("user-stop")
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
      replace: "var qC=Number.MAX_SAFE_INTEGER,t_e=15e3,JC=2147483647,",
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
        "if(" + MODE_ALIAS + "!==" + bq("user-stop")
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
      replace: "RGt=Number.MAX_SAFE_INTEGER,zGt=15e3,BGt=2147483647,",
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
};
