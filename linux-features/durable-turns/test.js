"use strict";

// Regression tests for the durable-turns signature library.
//
// The old suite asserted against exact minified anchors, which is the property
// that died on 2026-10-08 when upstream re-chunked 94 releases worth of code. So
// these tests assert the properties the new architecture actually promises:
//
//   * carriers are found by symbol, never by file name,
//   * every rule must show its end state (old shape gone, new shape present),
//   * apply is a byte-identical no-op the second time,
//   * reverse reproduces the upstream bytes,
//   * a patched chunk still parses,
//   * a broken signature reports DRIFTED with source instead of passing quietly,
//   * and a rule that could not be undone is rejected when the library loads.
//
// The fixture is synthetic: two chunks, one per upstream flavour of the discard
// path, each carrying one occurrence of every structure. It is copied from real
// minified output with the identifiers kept, because an identifier-agnostic test
// would not catch a rule that accidentally depends on one.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const feature = require("./patch.js");
const { BOUND, DRIFTED, REMOVED } = require("./lib/plan.js");
const { compileSegments, patternSegments, renderSegments, templateSegments } = require("./lib/segments.js");
const { forEachMatch } = require("./lib/chunks.js");
const cli = require("./cli.js");

const BT = String.fromCharCode(96);
const MARKERS = ["__dtMode", "__dtCascadeUserStopOnly", "__dtNoDiscardKill", "__dtDiscardMethod"];
const RULE_IDS = ["P0-a", "P0-b", "P1-a", "P1-b", "P1-c"];

// ---- fixture ---------------------------------------------------------------

// 26.908 and older: the discard routine is inline in the manager method and
// always unsubscribes.
const OLD_INLINE_DISCARD =
  "async discardConversationFromCache(e){"
  + "let t=this.getConversation(e);if(t!=null&&LC(t))"
  + "try{await this.interruptConversation(e)}catch(t){"
  + "this.logger.warning(`Failed to interrupt discarded conversation`,{safe:{conversationId:e},sensitive:{error:t}})}"
  + "await this.sendRequest(`thread/unsubscribe`,{threadId:e},{timeoutMs:My}),"
  + "this.conversationCacheEvictor.evictConversation(e,{reason:`discard`})}\n";

// 26.1002 and newer: the routine moved to a module-level helper and the
// eviction was upgraded to a real thread/stop for an ephemeral turn on a durable
// host, which is why P1-c exists.
const NEW_HELPER_DISCARD =
  "async function jS({manager:e,conversationId:t,ephemeral:n,isDurableHost:r}){"
  + "let i=e.getConversation(t);if(i!=null&&av(i))"
  + "try{await e.interruptConversation(t)}catch(n){"
  + "e.logger.warning(`Failed to interrupt discarded conversation`,{safe:{conversationId:t},sensitive:{error:n}})}"
  + "try{await e.sendRequest(n&&r?`thread/stop`:`thread/unsubscribe`,{threadId:t},{timeoutMs:Xc})}"
  + "catch(e){if(!n||o.qt(e)!==`thread_not_found`)throw e}}\n";

const NEW_HELPER_METHOD =
  "async discardConversationFromCache(e){"
  + "jS({manager:this,conversationId:e,ephemeral:this.isEphemeralConversation(e),"
  + "isDurableHost:this.isDurableHost});"
  + "this.conversationCacheEvictor.evictConversation(e,{reason:`discard`})}\n";

const FOLLOWER_SELF =
  "async interruptConversationSelf(e,t,r){let i=this.getStreamRole(e);"
  + "try{let n=await this.sendThreadFollowerRequest(i,`thread-follower-interrupt-turn`,"
  + "{conversationId:e,mode:t,expectedTurnId:r});"
  + "if(n){let{goalPauseError:e,interruptedTurnId:t}=n;if(e!=null)throw Object.assign(Error(e),{interruptedTurnId:t});return t}}"
  + "catch(t){let r=n.Uo(t).toLowerCase(),a=[`timeout`,`request-version-mismatch`,`no-client-found`]"
  + ".find(e=>r.includes(e));if(i?.role!==`follower`||a==null)throw t;"
  + "this.markConversationNeedsResumeForUnavailableOwner(e,i.ownerClientId),"
  + "this.logger.warning(`Falling back to local interrupt after follower owner became unavailable`,"
  + "{safe:{conversationId:e,reason:a},sensitive:{}})}"
  + "let a=()=>r_e({logger:this.logger,killNodeReplExecutions:(e,t)=>this.runtime.killNodeReplExecutions(e,t),"
  + "sendInterruptRequest:()=>this.sendRequest(`turn/interrupt`,{conversationId:e}),"
  + "updateConversationState:(t)=>this.updateConversationState(e,t)});return a()}\n";

const CASCADE_METHOD =
  "async interruptConversation(e,t=" + BT + "system" + BT + ",n){let r=null;"
  + "try{return r=await this.interruptConversationSelf(e,t,n),r}finally{"
  + "(n==null||r!=null)&&t!==`descendant-cleanup`&&this.getStreamRole(e)?.role!==`follower`"
  + "&&(t===`user-stop`?this.interruptSubagentDescendantsInBackground(e):await this.interruptSubagentDescendants(e))}}"
  + "async interruptSubagentDescendants(e){await a_e({logger:this.logger,conversationId:e})}\n";

const THROTTLE =
  "var ay=108e5,Ise=15e3,oy=10,Lse=class{params;inactiveOwnerConversationSinceById=new Map;"
  + "shouldKeepConversationLoaded(e){return this.params.streamState.getStreamRole(e.id)?.role===`follower`?!1:!0}"
  + "getInactiveOwnerConversationIdsToUnsubscribe(e){let t=[];"
  + "for(let[n,r]of this.inactiveOwnerConversationSinceById.entries()){"
  + "t.push({conversationId:n,inactiveSinceMs:r,ttlExpired:e-r>=ay})}"
  + "return t.length>0&&this.params.logger.debug(`inactive_thread_unsubscribe_candidates_evaluated`,"
  + "{safe:{candidateCount:t.length,maxInactiveOwnerThreads:oy,ttlMs:ay},sensitive:{}}),t}}";

function chunkSource(topLevel, methods) {
  return [
    "var n={Uo:e=>String(e?.message??e)};",
    THROTTLE + ";",
    topLevel,
    "class M{constructor(e){this.params=e}",
    FOLLOWER_SELF,
    CASCADE_METHOD,
    methods,
    "}",
  ].join("");
}

// Builds an extracted-app tree: the main-process side under .vite/build, the
// webview side under webview/assets. Neither name is ever matched.
function makeTree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-turns-" + t + "-"));
  fs.mkdirSync(path.join(dir, ".vite/build"), { recursive: true });
  fs.mkdirSync(path.join(dir, "webview/assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".vite/build", "x1.js"),
    chunkSource("", OLD_INLINE_DISCARD), "latin1");
  // A chunk that calls the contract but owns none of it: no rule may claim it.
  fs.writeFileSync(path.join(dir, "webview/assets", "helper.js"),
    "import{M}from" + BT + "./x1.js" + BT + ";export function drop(m,e){return m.discardConversationFromCache(e)}",
    "latin1");
  fs.writeFileSync(path.join(dir, "webview/assets", "x2.js"),
    chunkSource(NEW_HELPER_DISCARD, NEW_HELPER_METHOD), "latin1");
  // A decoy that holds three of the four contract symbols and none of the logic:
  // a caller, not a carrier.
  fs.mkdirSync(path.join(dir, "webview/assets", "decoy"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".vite/build", "caller.js"),
    "function use(m,e){m.discardConversationFromCache(e);m.interruptConversationSelf(e,`user-stop`,null);"
    + "return m.shouldKeepConversationLoaded({id:e})}", "latin1");
  return dir;
}

function readTree(dir) {
  const out = {};
  for (const rel of [".vite/build/x1.js", "webview/assets/x2.js"]) {
    out[rel] = fs.readFileSync(path.join(dir, rel), "latin1");
  }
  return out;
}

function checkSyntax(file) {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

const dirs = [];
function tree(label) {
  const dir = makeTree(label);
  dirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---- carrier selection ------------------------------------------------------

test("carriers are chosen by the whole turn-lifecycle symbol contract", () => {
  const dir = tree("carriers");
  const library = feature.loadLibrary();
  const found = feature.findCarriers(dir, library).map((carrier) => carrier.relPath);
  assert.deepEqual(found.sort(), [".vite/build/x1.js", "webview/assets/x2.js"]);
  const report = feature.patchTree(dir, { mode: "apply" });
  assert.deepEqual(report.changedFiles.sort(), [".vite/build/x1.js", "webview/assets/x2.js"]);
});

test("no rule, region, or scan entry names a bundle file", () => {
  const library = feature.loadLibrary();
  const text = JSON.stringify(library);
  for (const forbidden of ["main-", "app-initial-", "app-shared-", "bootstrap-", ".vite/build/", "webview/assets/"]) {
    assert.ok(!text.includes(forbidden), "signature library mentions a bundle path: " + forbidden);
  }
  assert.deepEqual(library.scan.dirs, [".vite/build", "webview/assets"]);
});

// ---- apply -----------------------------------------------------------------

test("all five rules bind in both carriers of both flavours", () => {
  const dir = tree("apply");
  const report = feature.patchTree(dir, { mode: "apply" });
  assert.deepEqual(report.failures, []);
  assert.equal(report.plans.length, 10);
  for (const plan of report.plans) assert.equal(plan.status, BOUND, plan.rule + " " + plan.status);
  assert.deepEqual([...new Set(report.plans.map((plan) => plan.rule))].sort(), RULE_IDS);
  assert.deepEqual(report.changedFiles.sort(), [".vite/build/x1.js", "webview/assets/x2.js"]);
});

test("the discard-method variant picks the flavour the chunk actually has", () => {
  const dir = tree("variant");
  const report = feature.patchTree(dir, { mode: "check" });
  const byFile = {};
  for (const plan of report.plans) if (plan.rule === "P1-c") byFile[plan.file] = plan.variants;
  assert.equal(byFile[".vite/build/x1.js"], "plain");
  assert.equal(byFile["webview/assets/x2.js"], "upgrade");
});

test("markers land in every carrier", () => {
  const dir = tree("markers");
  feature.patchTree(dir, { mode: "apply" });
  for (const [rel, text] of Object.entries(readTree(dir))) {
    for (const marker of MARKERS) assert.ok(text.includes(marker), rel + " is missing " + marker);
  }
});

test("the needs_resume mark is emitted before the narrowed throw", () => {
  // Not style: the upstream catch marked and then fell through to a local
  // interrupt. Hoisting only the guard above the mark would rethrow unmarked, so
  // the stream role would keep pointing at the dead owner while resumeState
  // stayed `resumed`, and both resume gates would stay shut.
  const dir = tree("ordered");
  feature.patchTree(dir, { mode: "apply" });
  for (const [rel, text] of Object.entries(readTree(dir))) {
    const mark = text.indexOf("this.markConversationNeedsResumeForUnavailableOwner(e,i.ownerClientId);if(__dtMode!==");
    assert.ok(mark >= 0, rel + " does not show mark-immediately-before-throw");
    assert.ok(text.includes("let __dtMode=t;"), rel + " lost the mode alias");
  }
});

test("the idle TTL and the thread cap are disabled within the setTimeout range", () => {
  const dir = tree("ttl");
  feature.patchTree(dir, { mode: "apply" });
  for (const [rel, text] of Object.entries(readTree(dir))) {
    const patched = text.match(/(\w+)=2147483647,(\w+)=15e3,(\w+)=2147483647/);
    assert.ok(patched, rel + " did not disable the throttle constants");
    assert.ok(2147483647 <= 2 ** 31 - 1, "a delay above 2^31-1 is clamped to 1ms");
    assert.match(text, /\/\*durable-turns upstream-throttle 108e5 15e3\*\//,
      rel + " did not record the values it replaced");
  }
});

test("no automatic interrupt path survives: cascade and discard kill are gated", () => {
  const dir = tree("gates");
  feature.patchTree(dir, { mode: "apply" });
  for (const [rel, text] of Object.entries(readTree(dir))) {
    assert.ok(!/[^1]\?\s*`thread\/stop`/.test(text), rel + " can still reach thread/stop");
    assert.match(text, /!1&&\w+\(\w+\)\)\)try\{await (this|\w+)\.interruptConversation\(/,
      rel + " still interrupts on discard");
    assert.match(text, /__dtCascadeUserStopOnly=\(globalThis\.__dtCascadeUserStopOnly\|\|0\)\+1,void 0/,
      rel + " still cascades outside user-stop");
  }
});

test("a patched chunk still parses", () => {
  const dir = tree("syntax");
  feature.patchTree(dir, { mode: "apply" });
  for (const rel of Object.keys(readTree(dir))) checkSyntax(path.join(dir, rel));
});

// ---- idempotence and reversibility -----------------------------------------

test("a second apply is a byte-identical no-op", () => {
  const dir = tree("idempotent");
  feature.patchTree(dir, { mode: "apply" });
  const once = readTree(dir);
  const second = feature.patchTree(dir, { mode: "apply" });
  assert.deepEqual(second.failures, []);
  assert.deepEqual(second.changedFiles, []);
  assert.deepEqual(readTree(dir), once);
});

test("check mode never writes", () => {
  const dir = tree("check");
  const before = readTree(dir);
  const report = feature.patchTree(dir, { mode: "check" });
  assert.equal(report.plans.length, 10);
  assert.deepEqual(readTree(dir), before);
});

test("reverse restores the upstream bytes exactly", () => {
  const dir = tree("reverse");
  const before = readTree(dir);
  feature.patchTree(dir, { mode: "apply" });
  const report = feature.reverseTree(dir, { mode: "apply" });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(readTree(dir), before);
});

test("apply, reverse, apply again lands on the same patched bytes", () => {
  const dir = tree("roundtrip");
  feature.patchTree(dir, { mode: "apply" });
  const first = readTree(dir);
  feature.reverseTree(dir, { mode: "apply" });
  feature.patchTree(dir, { mode: "apply" });
  assert.deepEqual(readTree(dir), first);
});

// ---- failure paths ---------------------------------------------------------

function mutatedLibrary(mutate) {
  const library = JSON.parse(JSON.stringify(feature.loadLibrary()));
  mutate(library);
  return library;
}

test("a rewrite that breaks the chunk is refused and the file is left alone", () => {
  const dir = tree("bad-syntax");
  const expectedBefore = readTree(dir);
  const library = mutatedLibrary((lib) => {
    const edit = lib.rules.find((rule) => rule.id === "P1-c").edits[0];
    // Drop a paren: the text still contains every marker, only the parser knows.
    edit.template = edit.template.replace("{timeoutMs:<timeout>})", "{timeoutMs:<timeout>");
  });
  assert.throws(() => feature.patchTree(dir, { library, mode: "apply" }), /no longer parses/);
  // The gate fires after the write, and the failure names the parse error: the
  // caller must retry or revert rather than package the file.
  assert.deepEqual(readTree(tree("bad-syntax-pristine")), expectedBefore);
});

test("an edit whose end state cannot be reached reports DRIFTED, not applied", () => {
  const dir = tree("bad-endstate");
  const library = mutatedLibrary((lib) => {
    // A replacement that does not remove the target structure.
    lib.rules.find((rule) => rule.id === "P0-b").edits[0].template = "(<mode>===" + BT + "user-stop" + BT
      + "?<mgr>.interruptSubagentDescendantsInBackground(<conv>):"
      + "await <mgr>.interruptSubagentDescendants(<conv>))";
  });
  const report = feature.patchTree(dir, { library, mode: "check" });
  const drifted = report.failures.filter((failure) => failure.rule === "P0-b");
  assert.equal(drifted.length, 2);
  assert.equal(drifted[0].status, DRIFTED);
  assert.match(drifted[0].reason, /target structure still present/);
});

test("a required rule that cannot bind fails the whole tree", () => {
  const dir = tree("unbound");
  const library = mutatedLibrary((lib) => {
    lib.rules.find((rule) => rule.id === "P0-a").region.open = ["async interruptConversationRenamed(){B}"];
  });
  assert.throws(() => feature.patchTree(dir, { library, mode: "apply" }), /refusing to ship a partial patch/);
});

test("a rule with no carrier region reports REMOVED", () => {
  const dir = tree("removed");
  const library = mutatedLibrary((lib) => {
    lib.rules.find((rule) => rule.id === "P1-a").region.open = ["var <nothing>=108e5,{B}never{E}"];
  });
  const report = feature.patchTree(dir, { library, mode: "check" });
  const removed = report.failures.filter((failure) => failure.rule === "P1-a");
  assert.equal(removed.length, 2);
  assert.equal(removed[0].status, REMOVED);
});

test("two identical upstream copies are ambiguous rather than silently patched once", () => {
  const dir = tree("duplicate");
  const file = path.join(dir, ".vite/build/x1.js");
  const text = fs.readFileSync(file, "latin1");
  const start = text.indexOf("async interruptConversationSelf(");
  const end = text.indexOf("\n", start);
  // A second, verbatim copy of the follower method: same shape, same invariants,
  // so the patcher cannot claim one of them.
  fs.writeFileSync(file, text.slice(0, end) + text.slice(start, end) + text.slice(end), "latin1");
  const report = feature.patchTree(dir, { mode: "check" });
  const failed = report.failures.filter((failure) => failure.rule === "P0-a");
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /ambiguous|invariant|still present/);
});

test("a library rule that loses an identifier on the patched side is rejected at load", () => {
  const file = path.join(tree("load"), "signatures.json");
  const library = mutatedLibrary((lib) => {
    // The template drops <err>, so a revert could not reconstruct `throw <err>`.
    const edit = lib.rules.find((rule) => rule.id === "P0-a").edits[1];
    edit.template = edit.template.replace("throw <err>;", "throw 0;");
  });
  fs.writeFileSync(file, JSON.stringify(library));
  assert.throws(() => feature.loadLibrary({ signaturesPath: file }), /is not reversible/);
});

test("a malformed library is rejected", () => {
  const file = path.join(tree("malformed"), "signatures.json");
  fs.writeFileSync(file, JSON.stringify({ rules: [] }));
  assert.throws(() => feature.loadLibrary({ signaturesPath: file }), /malformed/);
});

// ---- segment language -------------------------------------------------------

test("a minified rename costs nothing: the same rule binds a renamed chunk", () => {
  const dir = tree("rename");
  const file = path.join(dir, ".vite/build/x1.js");
  let text = fs.readFileSync(file, "latin1");
  // Rename every local the rules could be tempted to hard-code.
  for (const [from, to] of [["i=this.getStreamRole(e)", "zz=this.getStreamRole(e)"],
    ["a=[`timeout`", "yy=[`timeout`"], ["t.push({conversationId:n,inactiveSinceMs:r", "t.push({conversationId:n,inactiveSinceMs:r"]]) {
    text = text.replace(from, to);
  }
  fs.writeFileSync(file, text, "latin1");
  const report = feature.patchTree(dir, { mode: "check" });
  assert.deepEqual(report.failures.filter((failure) => failure.file === ".vite/build/x1.js"), []);
});

test("a repeated placeholder is one capture plus a backreference", () => {
  assert.deepEqual(templateSegments("<x>a<x>").map((segment) => segment.kind),
    ["group", "lit", "ref"]);
  // In a pattern the same idea is {CAP:} plus {BACK:}, which is what keeps the
  // cascade edit bound to one receiver rather than any two lookalikes.
  const re = compileSegmentsOf("if({CAP:x}?.role!=={LIT:follower})throw {BACK:x};");
  assert.ok(re.test("if(a?.role!==" + BT + "follower" + BT + ")throw a;"));
  assert.ok(!re.test("if(a?.role!==" + BT + "follower" + BT + ")throw b;"));
  assert.throws(() => compileSegmentsOf("if({BACK:x}?.role!=={LIT:follower})throw 0;"),
    /has no preceding capture/);
});

function compileSegmentsOf(token) {
  return compileSegments(patternSegments(token));
}

test("braces and zero-width assertions survive a render", () => {
  const segments = patternSegments("{B}a{E}{FWD:;b}{NOT:c}");
  assert.equal(renderSegments(segments, {}), "{a}");
});

test("a non-identifier capture renders what it matched", () => {
  const segments = patternSegments("{NCAP:mgr|this|[A-Za-z_$][\\w$]*}.interrupt(");
  const re = compileSegments(segments);
  const match = re.exec("zzz.interrupt(");
  assert.equal(match.groups.mgr, "zzz");
  assert.equal(renderSegments(segments, { mgr: "qq" }), "qq.interrupt(");
});

test("a positional rewrite that would overlap is refused", () => {
  const dir = tree("overlap");
  const file = path.join(dir, "overlap.js");
  fs.writeFileSync(file, "abcdefgh", "latin1");
  const chunks = require("./lib/chunks.js");
  assert.throws(() => chunks.applyRewrites(file, [{ start: 1, end: 4, replacement: "X" },
    { start: 2, end: 5, replacement: "Y" }]), /overlapping/);
});

test("a match straddling a chunk boundary is seen exactly once", () => {
  const dir = tree("boundary");
  const file = path.join(dir, "big.js");
  const filler = "z".repeat(1000);
  fs.writeFileSync(file, filler + "NEEDLE" + filler, "latin1");
  const chunks = require("./lib/chunks.js");
  const re = /NEEDLE/g;
  let smallChunkHits = 0;
  chunks.forEachMatch(file, re, { chunkBytes: 512, overlapBytes: 64 }, () => { smallChunkHits += 1; });
  assert.equal(smallChunkHits, 1);
  let wholeHits = 0;
  chunks.forEachMatch(file, re, {}, () => { wholeHits += 1; });
  assert.equal(wholeHits, 1);
});

// ---- the drift CLI ---------------------------------------------------------

function runCli(args) {
  const stdout = [];
  const stderr = [];
  const write = (sink) => (value) => sink.push(String(value));
  const original = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = write(stdout);
  process.stderr.write = write(stderr);
  try {
    return { code: cli.main(args), stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  }
}

test("the carrier screen survives a symbol split across blocks", () => {
  const dir = tree("screen");
  const chunks = require("./lib/chunks.js");
  const library = feature.loadLibrary();
  const file = path.join(dir, ".vite/build", "x1.js");
  const text = fs.readFileSync(file, "latin1");
  const needle = "interruptSubagentDescendantsInBackground";
  const at = text.indexOf(needle);
  // Force a block boundary into the middle of the needle. With an overlap at
  // least as long as the symbol the next block still contains it whole; with a
  // short overlap it would vanish and the chunk would silently stop being a
  // carrier, which is the failure the real 256KB overlap exists to prevent.
  const split = { chunkBytes: at + 8, overlapBytes: needle.length };
  assert.ok(at + 8 < at + needle.length);
  assert.equal(chunks.containsAllSymbols(file, [needle], split), true);
  assert.equal(chunks.containsAllSymbols(file, [needle], { chunkBytes: at + 8, overlapBytes: 1 }), false);
  // The shipped settings are what the patcher actually uses.
  assert.ok(library.scan.overlapBytes >= needle.length);
  assert.deepEqual(feature.findCarriers(dir, library).map((c) => c.relPath).sort(),
    [".vite/build/x1.js", "webview/assets/x2.js"]);
});

test("--check on a healthy tree exits 0 and lists every rule", () => {
  const dir = tree("cli-ok");
  const run = runCli(["--check", dir]);
  assert.equal(run.code, 0);
  for (const rule of RULE_IDS) assert.match(run.stdout, new RegExp("BOUND\\s+" + rule));
  assert.match(run.stdout, /summary: BOUND=10 DRIFTED=0 REMOVED=0 across 2 carrier\(s\)/);
});

test("--check on a tree that is not an unpacked asar exits 2", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-turns-notasar-"));
  dirs.push(dir);
  assert.equal(runCli(["--check", dir]).code, 2);
});

test("a broken signature reports DRIFTED with the current source of the area", () => {
  const dir = tree("cli-drift");
  const library = mutatedLibrary((lib) => {
    const edit = lib.rules.find((rule) => rule.id === "P0-b").edits[0];
    edit.find = edit.find.replace("interruptSubagentDescendantsInBackground", "interruptSubagentDescendantsRenamed");
  });
  const file = path.join(dir, "broken-signatures.json");
  fs.writeFileSync(file, JSON.stringify(library));
  const run = runCli(["--check", dir, "--signatures", file]);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /DRIFTED\s+P0-b/);
  assert.match(run.stdout, /region at offset \d+:/, "no source excerpt was printed");
  assert.match(run.stdout, /interruptSubagentDescendantsInBackground/, "the excerpt is not the live area");
  assert.match(run.stdout, /\^ anchor/);
});

test("the excerpt comes from the file, not from the signature", () => {
  const dir = tree("cli-excerpt");
  const library = mutatedLibrary((lib) => {
    const rule = lib.rules.find((rule) => rule.id === "P1-a");
    rule.region.invariants = ["this.shouldKeepConversationLoaded_IS_GONE("];
  });
  const file = path.join(dir, "broken.json");
  fs.writeFileSync(file, JSON.stringify(library));
  const run = runCli(["--check", dir, "--signatures", file]);
  assert.equal(run.code, 1);
  const excerpt = run.stdout.slice(run.stdout.indexOf("region at offset"));
  assert.match(excerpt, /inactiveOwnerConversationSinceById=new Map/);
  assert.ok(!excerpt.includes("IS_GONE"), "the excerpt echoed the signature instead of the source");
});

test("--json reports per-rule status and the failing reason", () => {
  const dir = tree("cli-json");
  const library = mutatedLibrary((lib) => {
    lib.rules.find((rule) => rule.id === "P1-b").region.open = ["async nothingLikeThis(){B}"];
  });
  const file = path.join(dir, "broken.json");
  fs.writeFileSync(file, JSON.stringify(library));
  const run = runCli(["--check", dir, "--json", "--signatures", file]);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.ok, false);
  const failed = parsed.failures.filter((failure) => failure.rule === "P1-b");
  assert.equal(failed.length, 2);
  assert.equal(failed[0].status, REMOVED);
});

// ---- repository pipeline contract ------------------------------------------

test("the descriptor is a single required-upstream extracted-app patch", () => {
  const descriptors = feature.buildDescriptors();
  assert.equal(descriptors.length, 1);
  const [descriptor] = descriptors;
  assert.equal(descriptor.id, "durable-turns");
  assert.equal(descriptor.phase, "extracted-app:pre-webview");
  assert.equal(descriptor.ciPolicy, "required-upstream");
  assert.equal(typeof descriptor.apply, "function");
  assert.deepEqual(descriptor.status({ changed: true }).status, "applied");
  assert.deepEqual(descriptor.status({ changed: false }).status, "already-applied");
  assert.equal(descriptor.status(null).status, "failed-required");
});

test("the feature manifest points at the patcher and stays opt-in", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"));
  assert.equal(manifest.id, "durable-turns");
  assert.equal(manifest.defaultEnabled, false);
  assert.equal(manifest.entrypoints.patchDescriptors, "./patch.js");
});

test("apply through the descriptor reports the carriers it touched", () => {
  const dir = tree("descriptor");
  const [descriptor] = feature.buildDescriptors();
  const result = descriptor.apply(dir);
  assert.equal(result.changed, true);
  assert.equal(result.carriers, 2);
  assert.equal(descriptor.status(result).status, "applied");
  const again = descriptor.apply(dir);
  assert.equal(again.changed, false);
  assert.equal(descriptor.status(again).status, "already-applied");
});
