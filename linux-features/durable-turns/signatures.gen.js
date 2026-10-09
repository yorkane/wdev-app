"use strict";

// Emits signatures.json:  node signatures.gen.js > signatures.json
//
// The library is data, not code. Each rule states which upstream symbols carry
// it, the structural shape that identifies the region, and the template that
// replaces the anchor. Shapes are macro token strings (see lib/anchor.js):
// plain JavaScript text plus {CAP:} groups for minified locals, so a rename is
// free and no rule can depend on a bundle file name or a minified identifier.

const CB = String.fromCharCode(96);
const T = (name) => "{CAP:" + name + "}";

// ---- shared fragments -------------------------------------------------------

// if (<role>?.role !== `follower` || <reason> == null) throw <err>;
const FOLLOWER_GATE =
  "if(" + T("role") + "?.role!=={LIT:follower}||" + T("reason") + "==null)throw " + T("err") + ";";

// (<mode> === `user-stop`
//    ? <mgr>.interruptSubagentDescendantsInBackground(<conv>)
//    : await <mgr>.interruptSubagentDescendants(<conv>))
const CASCADE =
  "(" + T("mode") + "==={LIT:user-stop}?" + T("mgr")
  + ".interruptSubagentDescendantsInBackground(" + T("conv") + ")"
  + ":await {BACK:mgr}.interruptSubagentDescendants({BACK:conv}))";

// if (<cand> != null && <pred>(<cand>)) try { await <mgr>.interruptConversation(<id>) }
// The receiver is `this` in the inline form and a minified parameter in the
// module-level helper, so it is captured rather than matched loosely: the
// template has to re-emit exactly what was there.
const IMPLICIT_INTERRUPT =
  "if(" + T("cand") + "!=null&&" + T("pred") + "({BACK:cand}))try{await "
  + "{NCAP:mgr|this|[A-Za-z_$][\\w$]*}.interruptConversation(" + T("id") + ")";

// <ttl>=108e5,<check>=15e3,<cap>=10, with a lookahead onto the class that
// consumes them, so a coincidental 108e5/10 pair somewhere in a 19k-file
// bundle can never be the one that gets rewritten.
//
// Both numeric spellings are captured rather than matched opaquely, because a
// revert renders the upstream shape out of the patched bytes and an opaque
// alternation holds no text to render: the patched side would say 2147483647 and
// the original spelling (108e5 versus 10800*1e3) would be unrecoverable. The
// patched form therefore carries the values it replaced in a trailing block
// comment, which sits between the constant and the `,VGt=class{` that the
// lookahead consumes. The comment has no `=` and the cap is no longer 10, so the
// patched text can never re-satisfy the upstream shape it records.
const THROTTLE_CONSTANTS =
  "{CAP:ttl}={NCAP:ttlVal|108e5|10800\\*1e3},{CAP:check}={NCAP:checkVal|15e3|15\\d{3}},{CAP:cap}=10"
  + "{FWD:,{ID}=class{B}params;inactiveOwnerConversationSinceById=new Map}";

const THROTTLE_CONSTANTS_DISABLED =
  "{CAP:ttl}=2147483647,{CAP:check}=15e3,{CAP:cap}=2147483647"
  + "/*durable-turns upstream-throttle {RAW:[^/]*}*/"
  + "{FWD:,{ID}=class{B}params;inactiveOwnerConversationSinceById=new Map}";

// The discard routine lives either in a module-level helper (26.1002 and
// newer) or inline in the method (26.908); both open the same region.
const DISCARD_HELPER_OPEN =
  "async function " + T("helper") + "({manager:" + T("mgr") + ",conversationId:" + T("id")
  + ",ephemeral:" + T("eph") + ",isDurableHost:" + T("durable") + "}){B}";
const DISCARD_INLINE_OPEN =
  "async discardConversationFromCache(" + T("id") + "){B}";

// Both candidates are patch-neutral, so the region resolves the same before
// and after an apply: the helper ends at its thread_not_found catch, the
// inline form ends at evictConversation(id, {reason: `discard`}).
const DISCARD_CLOSES = [
  "{LIT:thread_not_found}",
  "{B}reason:{LIT:discard}",
];

const library = {
  schemaVersion: 1,
  featureId: "durable-turns",

  // Every .js chunk under these directories is a candidate carrier. No bundle
  // file name is matched anywhere: that is exactly what died on 2026-10-08 when
  // upstream re-chunked 94 releases worth of code.
  scan: {
    dirs: [".vite/build", "webview/assets"],
    fileSuffix: ".js",
    chunkBytes: 4194304,
    overlapBytes: 262144,
  },

  // The turn-lifecycle contract, which separates the chunk that owns the logic
  // from one that merely calls a method of it.
  carrierSymbols: [
    "interruptConversationSelf",
    "discardConversationFromCache",
    "interruptSubagentDescendantsInBackground",
    "shouldKeepConversationLoaded",
  ],

  rules: [
    {
      id: "P0-a",
      title: "a follower whose stream owner vanished interrupts the turn locally only for an explicit user stop",
      markers: ["__dtMode"],
      region: {
        // Both the upstream header and this patcher's own output open the
        // region, which is what makes a second apply a byte-identical no-op.
        open: [
          "async interruptConversationSelf({CAP:conv},{CAP:mode},{CAP:expected}){B}",
          "async interruptConversationSelf({CAP:conv},{CAP:mode},{CAP:expected}){B}let __dtMode={ID};",
        ],
        // The local interrupt helper that follows the catch names this argument
        // and no edit touches it, so it bounds the region. The span has to reach
        // past sendInterruptRequest so the turn/interrupt invariant below sits
        // inside: that literal is the fall-through target whose presence proves
        // the catch still drains into a local interrupt.
        close: ["updateConversationState:"],
        span: 4200,
        excerptBefore: 240,
        invariants: [
          "this.sendThreadFollowerRequest({ID},{LIT:thread-follower-interrupt-turn}",
          "{LIT:timeout},{LIT:request-version-mismatch},{LIT:no-client-found}",
          "{B}conversationId:",
          "{LIT:turn/interrupt}",
        ],
      },
      edits: [
        {
          id: "P0-a-mode-alias",
          find: "async interruptConversationSelf({CAP:conv},{CAP:mode},{CAP:expected}){B}"
            + "{NOT:let __dtMode=}",
          // A template is emitted verbatim; macro tokens belong to patterns
          // only. The opening brace is re-emitted because the header match
          // consumed it.
          template: "async interruptConversationSelf(<conv>,<mode>,<expected>){" + "let __dtMode=<mode>;",
        },
        {
          id: "P0-a-follower-guard",
          find: FOLLOWER_GATE,
          // The needs_resume mark is emitted BEFORE the narrowed throw. The
          // upstream catch marked and then fell through into a local interrupt,
          // so hoisting only the guard above the mark would rethrow without
          // marking: the stream role keeps pointing at the dead owner while
          // resumeState stays "resumed", and needsResume() requires
          // resumeState === "needs_resume" or a null stream role, so both resume
          // gates stay shut in exactly the scenario this rule exists for.
          template:
            "if(<role>?.role===" + CB + "follower" + CB + "&&<reason>!=null)"
            + "this.markConversationNeedsResumeForUnavailableOwner(<conv>,<role>.ownerClientId);"
            + "if(__dtMode!==" + CB + "user-stop" + CB + "||<role>?.role!==" + CB + "follower" + CB
            + "||<reason>==null)throw <err>;",
        },
      ],
      assertions: {
        gone: [FOLLOWER_GATE],
        present: [
          "{B}let __dtMode={ID};",
          "if({ID}?.role==={LIT:follower}&&{ID}!=null)this.markConversationNeedsResumeForUnavailableOwner(",
          "if(__dtMode!=={LIT:user-stop}||{ID}?.role!=={LIT:follower}||{ID}==null)throw ",
        ],
        // Load-bearing order, not style: mark, then rethrow.
        ordered: [
          ".ownerClientId);",
          "if(__dtMode!=={LIT:user-stop}",
        ],
      },
    },

    {
      id: "P0-b",
      title: "the subagent descendant cascade fires only for an explicit user stop",
      markers: ["__dtCascadeUserStopOnly"],
      region: {
        open: ["async interruptConversation({CAP:conv},{CAP:mode}={LIT:system},{CAP:expected}){B}"],
        // The cascade sits in the finally block of interruptConversation; the
        // sibling method that follows it is patch-neutral and bounds the region.
        close: ["async interruptSubagentDescendants({ID}){B}"],
        span: 1600,
        excerptBefore: 160,
        invariants: [
          // No {BACK:} here: an invariant is matched over the region body
          // independently of the opener, so a backreference to an opener group
          // would degrade to literal text and silently never match.
          "this.interruptConversationSelf(",
          "!=={LIT:descendant-cleanup}",
          "?.role!=={LIT:follower}",
          "{LIT:user-stop}",
        ],
      },
      edits: [
        {
          id: "P0-b-cascade",
          find: CASCADE,
          // The counter makes the suppression observable at runtime instead of
          // only inferable from logs.
          template:
            "(<mode>===" + CB + "user-stop" + CB + "?<mgr>.interruptSubagentDescendantsInBackground(<conv>)"
            + ":(globalThis.__dtCascadeUserStopOnly=(globalThis.__dtCascadeUserStopOnly||0)+1,void 0))",
        },
      ],
      assertions: {
        gone: [CASCADE],
        present: [
          "globalThis.__dtCascadeUserStopOnly=(globalThis.__dtCascadeUserStopOnly||0)+1,void 0",
        ],
        ordered: [],
      },
    },

    {
      id: "P1-a",
      title: "the inactive-owner idle TTL and thread cap no longer recycle background conversations",
      markers: [],
      region: {
        open: [THROTTLE_CONSTANTS, THROTTLE_CONSTANTS_DISABLED],
        // The throttle constants and the log payload that names them both live
        // inside getInactiveOwnerConversationIdsToUnsubscribe, so the log key
        // closes the region and no edit ever touches it.
        // A property name inside the class, not a quoted literal: the debug
        // payload logs it bare.
        close: ["maxInactiveOwnerThreads:"],
        span: 8000,
        excerptBefore: 160,
        invariants: [
          "=class{B}{ID};inactiveOwnerConversationSinceById=new Map",
          "ttlExpired:",
        ],
      },
      edits: [
        {
          id: "P1-a-throttle-constants",
          find: THROTTLE_CONSTANTS,
          // 2147483647, not Number.MAX_SAFE_INTEGER: Node clamps a setTimeout
          // delay above 2^31-1 down to 1ms with a TimeoutOverflowWarning, which
          // turned a disabled TTL into a ~900 Hz busy loop that burned 11-13% of
          // a core at three idle conversations and 36% at a hundred. This value
          // is a legal ~24.8 day delay, so the timer genuinely stops firing. The
          // check interval is left alone: it is only re-armed from that timer.
          template: "<ttl>=2147483647,<check>=15e3,<cap>=2147483647"
            + "/*durable-turns upstream-throttle {NCAP:ttlVal|[^/\\s]+} {NCAP:checkVal|[^/\\s]+}*/",
        },
      ],
      assertions: {
        gone: [THROTTLE_CONSTANTS],
        present: [THROTTLE_CONSTANTS_DISABLED],
        ordered: [],
      },
    },

    {
      id: "P1-b",
      title: "discarding a cached conversation no longer interrupts an in-progress turn",
      markers: ["__dtNoDiscardKill"],
      region: {
        open: [DISCARD_HELPER_OPEN, DISCARD_INLINE_OPEN],
        close: DISCARD_CLOSES,
        span: 1600,
        excerptBefore: 240,
        invariants: [
          "{LIT:Failed to interrupt discarded conversation}",
          "{LIT:thread/unsubscribe}",
        ],
      },
      edits: [
        {
          id: "P1-b-implicit-interrupt",
          find: IMPLICIT_INTERRUPT,
          // The in-progress predicate call is kept but ANDed with !1, so the
          // "is this turn still running" evaluation survives and is counted
          // while the interrupt itself becomes statically unreachable.
          template:
            "if(<cand>!=null&&(globalThis.__dtNoDiscardKill=(globalThis.__dtNoDiscardKill||0)+1,"
            + "!1&&<pred>(<cand>)))try{await <mgr>.interruptConversation(<id>)",
        },
      ],
      assertions: {
        gone: [IMPLICIT_INTERRUPT],
        present: [
          "globalThis.__dtNoDiscardKill=(globalThis.__dtNoDiscardKill||0)+1,!1&&",
        ],
        ordered: [],
      },
    },

    {
      id: "P1-c",
      title: "the discard path never sends thread/stop, so losing a view cannot really stop a durable turn",
      markers: ["__dtDiscardMethod"],
      variantGroup: "discard-method",
      region: {
        open: [DISCARD_HELPER_OPEN, DISCARD_INLINE_OPEN],
        close: DISCARD_CLOSES,
        span: 1600,
        excerptBefore: 240,
        invariants: [
          "{LIT:Failed to interrupt discarded conversation}",
          "{LIT:thread/unsubscribe}",
        ],
      },
      // Exactly one variant binds. 26.1002 and newer upgraded the eviction to a
      // real server-side stop behind ephemeral && isDurableHost, which for a
      // durable host deployment is harsher than the older unsubscribe; 26.908
      // and older always unsubscribe and have no upgrade to neutralise yet. Both
      // shapes land on one verified end state: the thread/stop arm is reachable
      // only through !1, so the eviction method is provably thread/unsubscribe.
      edits: [
        {
          id: "P1-c-discard-ternary",
          variant: "discard-method",
          variantKey: "upgrade",
          find:
            // The minifier emits the conditional without grouping parens, so the
            // condition is matched in its bare form and re-emitted grouped. The two
            // method names are quoted literals: their text is fixed by the protocol,
            // only the quote character rotates, and a quoted segment captures the
            // quote it matched so the revert writes back the byte that was there.
            "try{await {CAP:sendMgr}.sendRequest({CAP:eph}&&{CAP:durable}?"
            + "{LIT:thread/stop}:{LIT:thread/unsubscribe},{threadId:{CAP:id}},{timeoutMs:{CAP:timeout}})",
          template:
            "try{await <sendMgr>.sendRequest((globalThis.__dtDiscardMethod="
            + "(globalThis.__dtDiscardMethod||0)+1,(<eph>&&<durable>)&&!1?"
            + CB + "thread/stop" + CB + ":" + CB + "thread/unsubscribe" + CB
            + "),{threadId:<id>},{timeoutMs:<timeout>})",
        },
        {
          id: "P1-c-discard-unsubscribe",
          variant: "discard-method",
          variantKey: "plain",
          find:
          // {BACK:id} is resolved against the region opener's capture, so the
          // send belongs to the very conversation the region was accepted for.
            // The catch block closes with a paren and a brace, so a single
            // leading brace is what abuts the await. {BACK:id} resolves against
            // the region opener's capture, so the send is tied to the very
            // conversation the region was accepted for.
            "}await {CAP:sendMgr}.sendRequest({LIT:thread/unsubscribe},"
            + "{B}threadId:{BACK:id}{E},{B}timeoutMs:{CAP:timeout}{E})",
          template:
            "}await <sendMgr>.sendRequest((globalThis.__dtDiscardMethod="
            + "(globalThis.__dtDiscardMethod||0)+1,!1?" + CB + "thread/stop" + CB + ":"
            + CB + "thread/unsubscribe" + CB + "),{threadId:<id>},{timeoutMs:<timeout>})",
        },
      ],
      assertions: {
        // The reachable upgrade form must be gone; the !1 arm is the patcher's
        // own output and is what `present` requires.
        gone: ["{ID}&&{ID}?{LIT:thread/stop}"],
        present: [
          "globalThis.__dtDiscardMethod=(globalThis.__dtDiscardMethod||0)+1,",
          "!1?{LIT:thread/stop}:{LIT:thread/unsubscribe}",
        ],
        ordered: [],
      },
    },
  ],
};

if (require.main === module) {
  process.stdout.write(JSON.stringify(library, null, 2) + "\n");
}

module.exports = { library };
