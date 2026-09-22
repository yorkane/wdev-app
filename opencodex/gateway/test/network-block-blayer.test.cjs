
// B 层（renderer→main fetch IPC 中继）的 allowPaths 放行 / block 拦截 / 审计验证。
// 必须在 require official-runtime 之前注入 CODEX_WEB_CONFIG_PATH 与审计路径，
// 因为 site-config 的 AUTH_CONFIG_PATH 在 require config.cjs 时按 env 解析一次。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wdev-blayer-"));
const configFile = path.join(dir, "config.yaml");
const auditFile = path.join(dir, "network-audit.jsonl");
fs.writeFileSync(
  configFile,
  [
    "network:",
    "  block:",
    '    - "*.chatgpt.com"',
    '    - "chatgpt.com"',
    "  allow: []",
    "  allowPaths:",
    '    - "chatgpt.com/backend-api/*"',
  ].join("\n") + "\n"
);
process.env.CODEX_WEB_CONFIG_PATH = configFile;
process.env.CODEX_DESKTOP_NETWORK_AUDIT_LOG = auditFile;

const {
  __test,
  setWsHub,
} = require("/home/aigc/ChatGPT/wdev/wdev-app/opencodex/gateway/runtime/ipc/official-runtime.cjs");
const { clearSiteConfigCache, getSiteConfig } = require("/home/aigc/ChatGPT/wdev/wdev-app/opencodex/gateway/runtime/core/site-config.cjs");
const { MESSAGE_FROM_VIEW_CHANNEL } = require("/home/aigc/ChatGPT/wdev/wdev-app/opencodex/gateway/runtime/core/config.cjs");

function fetchArgs(url, method) {
  return [{ type: "fetch", url, method: method || "GET", requestId: "req-" + url }];
}

test("B 层：allowPaths 命中的 fetch 放行（返回 false 不本地应答），并记 allow-path 审计(layer=gateway-ipc)", () => {
  clearSiteConfigCache();
  const network = getSiteConfig().network;
  assert.deepEqual(network.allowedPaths, [{ host: "chatgpt.com", path: "backend-api/*" }]);
  assert.equal(network.configured, true);

  const handled = __test.maybeHandleConfiguredNetworkBlockNoop(MESSAGE_FROM_VIEW_CHANNEL, fetchArgs("https://chatgpt.com/backend-api/wham/usage?x=1"));
  assert.equal(handled, false, "allow-path 命中应放行，交由官方 handler 真实出网");

  const lines = fs.readFileSync(auditFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  const allowLine = lines.find((l) => l.event === "allow-path");
  assert.ok(allowLine, "应有 allow-path 审计");
  assert.equal(allowLine.layer, "gateway-ipc");
  assert.equal(allowLine.host, "chatgpt.com");
  assert.equal(allowLine.path, "/backend-api/wham/usage");
  assert.ok(!fs.readFileSync(auditFile, "utf-8").includes("x=1"), "审计不得含 query");
});

test("B 层：未放行的同域 path 仍被 block 拦截（返回 true 本地 noop 应答），并记 block 审计(layer=gateway-ipc)", () => {
  clearSiteConfigCache();
  // 无 wsHub 时 routeOfficialWebContentsSend 只告警返回 false，不会抛；
  // handler 仍返回 true 表示「已被本地处理」，这就是拦截语义。
  setWsHub(null);
  const handled = __test.maybeHandleConfiguredNetworkBlockNoop(MESSAGE_FROM_VIEW_CHANNEL, fetchArgs("https://chatgpt.com/other/path", "POST"));
  assert.equal(handled, true, "block 命中应本地应答，不放行");

  const lines = fs.readFileSync(auditFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  const blockLine = lines.find((l) => l.event === "block" && l.path === "/other/path");
  assert.ok(blockLine, "应有 block 审计");
  assert.equal(blockLine.layer, "gateway-ipc");
  assert.equal(blockLine.method, "POST");
  assert.ok(!fs.readFileSync(auditFile, "utf-8").includes("x=1"));
});

test("B 层：非清单域与私有协议一律放行（返回 false）", () => {
  clearSiteConfigCache();
  assert.equal(__test.maybeHandleConfiguredNetworkBlockNoop(MESSAGE_FROM_VIEW_CHANNEL, fetchArgs("https://example.com/x")), false);
  assert.equal(__test.maybeHandleConfiguredNetworkBlockNoop(MESSAGE_FROM_VIEW_CHANNEL, fetchArgs("sentry-ipc://logs")), false);
  // 错误 channel 直接放行。
  assert.equal(__test.maybeHandleConfiguredNetworkBlockNoop("wrong-channel", fetchArgs("https://chatgpt.com/other/path")), false);
});
