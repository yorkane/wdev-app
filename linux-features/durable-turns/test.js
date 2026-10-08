"use strict";

// Regression tests for durable-turns.
//
// The cases that matter most came out of adversarial review. applyEdits used to
// skip an edit whenever its replacement text appeared anywhere in the bundle,
// which is content triggered rather than state triggered: a comment, a string
// literal, or upstream code that happened to look identical silently dropped
// the edit. The worst observed case produced a bundle whose guard referenced an
// undeclared __dtMode while still reporting "already patched, skipping", and
// node --check passed because a syntax check does not resolve scope - it only
// surfaced at runtime as a ReferenceError. That defeated the promise of
// ciPolicy required-upstream, which is to fail the build rather than ship a
// half-applied patch.
//
// The fixture below is synthetic and self-contained: it carries exactly one
// occurrence of every anchor, which is the invariant verifyEdits relies on.

const assert = require("node:assert/strict");
const test = require("node:test");

const { applyEdits, EDITS, verifyEdits } = require("./patch.js");

const BT = String.fromCharCode(96);
const MARKER = "use strict;";

function fixture() {
  const parts = [
    MARKER,
    "async interruptConversationSelf(e,t,r){let i=this.getStreamRole(e);",
    "if(i?.role!==" + BT + "follower" + BT + "||a==null)throw t;",
    "(t===" + BT + "user-stop" + BT
      + "?this.interruptSubagentDescendantsInBackground(e)"
      + ":await this.interruptSubagentDescendants(e))",
    "var qC=10800*1e3,t_e=15e3,JC=10,",
    "async discardConversationFromCache(e){"
      + "let t=this.getConversation(e);"
      + "if(t!=null&&LC(t))try{await this.interruptConversation(e)}",
  ];
  return parts.join("");
}

function editById(flavor, id) {
  const edit = EDITS[flavor].find((item) => item.id === id);
  assert.ok(edit, "missing edit " + id);
  return edit;
}

test("fixture carries each main anchor exactly once", () => {
  const src = fixture();
  for (const edit of EDITS.main) {
    assert.equal(src.split(edit.find).length - 1, 1, edit.id + " must be unique in the fixture");
    assert.equal(src.split(edit.replace).length - 1, 0, edit.id + " must not pre-exist");
  }
});

test("pristine fixture applies every edit and reaches the verified end state", () => {
  const out = applyEdits(fixture(), "main", "test");
  verifyEdits(out, EDITS.main, "test");
  for (const edit of EDITS.main) {
    assert.equal(out.split(edit.find).length - 1, 0, edit.id + " anchor must be gone");
    assert.ok(out.includes(edit.replace), edit.id + " replacement must be present");
  }
});

test("re-applying over a patched fixture is a byte-identical no-op", () => {
  const once = applyEdits(fixture(), "main", "test");
  const twice = applyEdits(once, "main", "test");
  assert.equal(twice, once);
});

test("the rewrite is reversible and round-trips", () => {
  const original = fixture();
  const patched = applyEdits(original, "main", "test");
  let reverted = patched;
  for (const edit of [...EDITS.main].reverse()) {
    reverted = reverted.replace(edit.replace, edit.find);
  }
  assert.equal(reverted, original);
  assert.equal(applyEdits(reverted, "main", "test"), patched);
});

test("an upstream rename fails the build instead of shipping a partial patch", () => {
  const edit = editById("main", "P0-a-mode-alias");
  const drifted = fixture().replace(edit.find, edit.find.replace("getStreamRole", "getStreamRoleX"));
  assert.throws(() => applyEdits(drifted, "main", "test"), /anchor missing for P0-a-mode-alias/);
});

// The short-circuit defects. Each injects a replacement literal somewhere else
// in the bundle so the per-edit includes() guard used to skip that edit.

test("an injected mode-alias literal does not silently drop the declaration", () => {
  const edit = editById("main", "P0-a-mode-alias");
  const injected = fixture().replace(MARKER, MARKER + "/*probe*/" + edit.replace);
  assert.throws(
    () => applyEdits(injected, "main", "test"),
    /P0-a-mode-alias did not apply/,
  );
});

test("an injected inactive-ttl literal does not silently skip the TTL change", () => {
  const edit = editById("main", "P1-a-inactive-ttl");
  const injected = fixture().replace(MARKER, MARKER + "/*probe*/" + edit.replace);
  assert.throws(
    () => applyEdits(injected, "main", "test"),
    /P1-a-inactive-ttl did not apply/,
  );
});

test("injecting every replacement literal at once is still rejected", () => {
  let injected = fixture();
  for (const edit of EDITS.main) {
    injected = injected.replace(MARKER, MARKER + "/*probe*/" + edit.replace);
  }
  assert.throws(() => applyEdits(injected, "main", "test"), /did not apply|did apply/);
});

test("webview flavor is verified independently", () => {
  const out = applyEdits(fixture().replace(
    "async interruptConversationSelf(e,t,r){let i=this.getStreamRole(e);",
    "async interruptConversationSelf(e,t,n){let r=this.getStreamRole(e);"
  ).replace("if(i?.role!==", "if(r?.role!==").replace("||a==null)throw t;", "||i==null)throw t;")
    .replace("var qC=10800*1e3,t_e=15e3,JC=10,", "RGt=10800*1e3,zGt=15e3,BGt=10,")
    .replace("LC(t)", "ov(t)"),
  "webview", "test");
  verifyEdits(out, EDITS.webview, "test");
});

// R1: the idle-TTL constant must stay a legal setTimeout delay. Node clamps
// anything above 2^31-1 down to 1ms, which turned "disable the TTL" into a 1ms
// busy loop rather than an actually-disabled timer.

test("the inactive TTL constant is a legal setTimeout delay", () => {
  const edit = editById("main", "P1-a-inactive-ttl");
  const ttl = /qC=(\d+)/.exec(edit.replace);
  assert.ok(ttl, "could not read the TTL constant out of the replacement");
  const value = Number(ttl[1]);
  assert.ok(
    value <= 2147483647,
    "TTL constant " + value + " exceeds the 32-bit signed setTimeout range; "
      + "Node clamps it to 1ms and the check reschedules forever",
  );
  assert.ok(!edit.replace.includes("Number.MAX_SAFE_INTEGER"));
  // A delay this large must not trip Node's overflow clamp.
  assert.doesNotThrow(() => {
    const timer = setTimeout(() => {}, value);
    if (typeof timer.unref === "function") timer.unref();
    clearTimeout(timer);
  });
});

// R2: the needs_resume mark has to precede the guard, otherwise a non
// user-stop rethrow leaves stream ownership and resumeState both stale.

test("the needs_resume mark precedes the rethrow guard", () => {
  const edit = editById("main", "P0-a-follower-guard");
  const markAt = edit.replace.indexOf("markConversationNeedsResumeForUnavailableOwner");
  const guardAt = edit.replace.indexOf("throw t;");
  assert.ok(markAt >= 0, "the follower guard must still mark needs_resume");
  assert.ok(guardAt >= 0, "the follower guard must still be able to rethrow");
  assert.ok(
    markAt < guardAt,
    "markConversationNeedsResumeForUnavailableOwner must run before the guard "
      + "rethrows, otherwise a non user-stop path throws without marking",
  );
});
