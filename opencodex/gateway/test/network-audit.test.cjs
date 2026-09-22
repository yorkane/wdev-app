const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const audit = require("../runtime/core/network-audit.cjs");

/** 每个用例独立的临时审计文件路径；返回 [dir, file]。 */
function tempAuditFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-network-audit-"));
  return [dir, path.join(dir, "network-audit.jsonl")];
}

test("resolveAuditLogPath honors off/0/none and defaults to the standard path", () => {
  assert.equal(audit.resolveAuditLogPath(undefined), audit.DEFAULT_AUDIT_LOG);
  assert.equal(audit.resolveAuditLogPath(""), audit.DEFAULT_AUDIT_LOG);
  assert.equal(audit.resolveAuditLogPath("off"), null);
  assert.equal(audit.resolveAuditLogPath("0"), null);
  assert.equal(audit.resolveAuditLogPath("none"), null);
  assert.equal(audit.resolveAuditLogPath("/data/tmp/x.jsonl"), "/data/tmp/x.jsonl");
});

test("appendAuditEvent writes one JSON line per event with a strict field whitelist", () => {
  const [, file] = tempAuditFile();
  process.env.CODEX_DESKTOP_NETWORK_AUDIT_LOG = file;
  try {
    assert.equal(
      audit.appendAuditEvent("block", "gateway-net-fetch", {
        host: "chatgpt.com",
        path: "/backend-api/wham/usage",
        method: "post",
        cookie: "session=SECRET",
        body: "should not be written",
      }),
      true
    );
    const line = fs.readFileSync(file, "utf-8").trim();
    const record = JSON.parse(line);
    assert.equal(record.event, "block");
    assert.equal(record.layer, "gateway-net-fetch");
    assert.equal(record.host, "chatgpt.com");
    assert.equal(record.path, "/backend-api/wham/usage");
    assert.equal(record.method, "POST");
    assert.ok(typeof record.ts === "string" && !Number.isNaN(Date.parse(record.ts)));
    // 白名单之外一律不落盘：绝不写 cookie/header/body/query。
    assert.equal(record.cookie, undefined);
    assert.equal(record.body, undefined);
    assert.ok(!line.includes("SECRET"));
  } finally {
    delete process.env.CODEX_DESKTOP_NETWORK_AUDIT_LOG;
  }
});

test("sanitizePath strips query and fragment so audit never stores them", () => {
  const t = audit.__test;
  assert.equal(t.sanitizePath("/a/b?token=SECRET#frag"), "/a/b");
  assert.equal(t.sanitizePath("?only=1"), "");
  assert.equal(t.sanitizePath("/x?y=z"), "/x");
  assert.equal(t.sanitizeMethod("get"), "GET");
  assert.equal(t.sanitizeHost("ChatGPT.com"), "chatgpt.com");
  assert.equal(t.sanitizeHost("bad host?x=1"), "");
});

test("path field with embedded query is stored without the query part", () => {
  const [, file] = tempAuditFile();
  process.env.CODEX_DESKTOP_NETWORK_AUDIT_LOG = file;
  try {
    audit.appendAuditEvent("allow-path", "gateway-ipc", {
      host: "chatgpt.com",
      path: "/backend-api/wham/usage?token=SECRET",
      method: "POST",
    });
    const record = JSON.parse(fs.readFileSync(file, "utf-8").trim());
    assert.equal(record.path, "/backend-api/wham/usage");
    assert.ok(!fs.readFileSync(file, "utf-8").includes("SECRET"));
  } finally {
    delete process.env.CODEX_DESKTOP_NETWORK_AUDIT_LOG;
  }
});

test("appendAuditEvent with audit disabled is a no-op returning true", () => {
  process.env.CODEX_DESKTOP_NETWORK_AUDIT_LOG = "off";
  try {
    assert.equal(audit.appendAuditEvent("block", "gateway-ipc", { host: "x.com", path: "/y" }), true);
  } finally {
    delete process.env.CODEX_DESKTOP_NETWORK_AUDIT_LOG;
  }
});

test("appendAuditEvent failure falls back to console.warn once per signature, never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-network-audit-"));
  // 指向一个目录而不是文件：appendFileSync 必然失败，但绝不能抛。
  const badPath = path.join(dir, "nested", "impossible.jsonl");
  process.env.CODEX_DESKTOP_NETWORK_AUDIT_LOG = badPath;
  audit.__test.resetFallbackWarned();
  const originalWarn = console.warn;
  let warnCount = 0;
  console.warn = () => {
    warnCount += 1;
  };
  try {
    assert.equal(audit.appendAuditEvent("block", "gateway-ipc", { host: "a.com", path: "/p" }), false);
    assert.equal(audit.appendAuditEvent("block", "gateway-ipc", { host: "a.com", path: "/p" }), false);
    assert.equal(warnCount, 1, "同一组合只回落提示一次，不刷屏");
    // 不同组合可以再次提示。
    audit.appendAuditEvent("block", "gateway-ipc", { host: "b.com", path: "/q" });
    assert.equal(warnCount, 2);
  } finally {
    console.warn = originalWarn;
    delete process.env.CODEX_DESKTOP_NETWORK_AUDIT_LOG;
  }
});

test("unknown event or layer is dropped without touching the file", () => {
  const [, file] = tempAuditFile();
  process.env.CODEX_DESKTOP_NETWORK_AUDIT_LOG = file;
  try {
    assert.equal(audit.appendAuditEvent("weird", "gateway-ipc", { host: "a.com" }), false);
    assert.equal(audit.appendAuditEvent("block", "not-a-layer", { host: "a.com" }), false);
    assert.ok(!fs.existsSync(file) || fs.readFileSync(file, "utf-8").trim() === "");
  } finally {
    delete process.env.CODEX_DESKTOP_NETWORK_AUDIT_LOG;
  }
});

test("config event records the effective policy counts", () => {
  const [, file] = tempAuditFile();
  process.env.CODEX_DESKTOP_NETWORK_AUDIT_LOG = file;
  try {
    audit.appendAuditEvent("config", "gateway-net-fetch", { blocked: 6, allowed: 1, allowedPaths: 2 });
    const record = JSON.parse(fs.readFileSync(file, "utf-8").trim());
    assert.equal(record.event, "config");
    assert.equal(record.blocked, 6);
    assert.equal(record.allowed, 1);
    assert.equal(record.allowedPaths, 2);
  } finally {
    delete process.env.CODEX_DESKTOP_NETWORK_AUDIT_LOG;
  }
});

test("rotateAuditLog renames oversized files to .1 and keeps small ones", () => {
  const [dir, file] = tempAuditFile();
  // 小文件不动。
  fs.writeFileSync(file, "line1\n");
  audit.rotateAuditLog(file);
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(file + ".1"));
  // 超过 8 MiB 时轮转：当前文件被移走，.1 存在（旧 .1 被覆盖）。
  const big = Buffer.alloc(audit.ROTATE_SIZE_BYTES + 16, 0x61);
  fs.writeFileSync(file, big);
  fs.writeFileSync(file + ".1", "old-rotation");
  audit.rotateAuditLog(file);
  assert.ok(!fs.existsSync(file), "轮转后当前文件应被移走");
  assert.equal(fs.readFileSync(file + ".1", "latin1").length, big.length);
  // 不存在的文件 / 不存在的目录：静默跳过不抛。
  assert.doesNotThrow(() => audit.rotateAuditLog(path.join(dir, "missing.jsonl")));
  assert.doesNotThrow(() => audit.rotateAuditLog(""));
});
