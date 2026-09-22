const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const POLYFILL_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "web-shell", "internal", "providers", "codex-bridge-polyfill.js"),
  "utf8"
);

/** 从 polyfill 源码里按花括号配对提取完整函数文本（真实代码，不做重写）。 */
function extractConst(source, name) {
  const anchor = "const " + name + " =";
  const start = source.indexOf(anchor);
  if (start === -1) throw new Error("const not found: " + name);
  const end = source.indexOf(";", start);
  return source.slice(start, end + 1);
}

function extractFunction(source, anchor) {
  const start = source.indexOf(anchor);
  if (start === -1) throw new Error("anchor not found: " + anchor);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces for: " + anchor);
}

/** 装配沙箱：执行真实的 handleAppHostGatewayMessage + maybeReloadForAppHostPortReset，
 * 注入假 sessionStorage / location.reload / clientDiagnostic。 */
function createResetHarness(options = {}) {
  const diagnostics = [];
  const storage = new Map();
  let reloadCount = 0;
  const makeStorage = () => ({
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => {
      storage.set(key, String(value));
    },
  });
  const sandbox = {
    w: {
      sessionStorage: options.sessionStorage === "throwing"
        ? {
            getItem: () => {
              throw new Error("storage denied");
            },
            setItem: () => {
              throw new Error("storage denied");
            },
          }
        : makeStorage(),
    },
    location: {
      reload: () => {
        reloadCount += 1;
      },
    },
    clientDiagnostic: (event, data) => diagnostics.push({ event, data }),
    // reset 分支在执行到 appHostPortRelays 之前就已 return；其余分支用桩兜住。
    appHostPortRelays: new Map(),
    closeAppHostRelay() {},
    flushAppHostRelayMessages() {},
    decodeAppHostMessageData() {
      throw new Error("decode should not run for control frames");
    },
    publishAppHostData: (data) => data,
    Date,
    Number,
    console,
  };
  vm.createContext(sandbox);
  // maybeReload 依赖的两个模块级常量随函数一起进沙箱（与源码同一份文本，非重写）。
  vm.runInContext(extractConst(POLYFILL_SOURCE, "APP_HOST_RESET_RELOAD_COOLDOWN_MS"), sandbox);
  vm.runInContext(extractConst(POLYFILL_SOURCE, "APP_HOST_RESET_RELOAD_STORAGE_KEY"), sandbox);
  vm.runInContext(
    extractFunction(POLYFILL_SOURCE, "function handleAppHostGatewayMessage("),
    sandbox
  );
  vm.runInContext(
    extractFunction(POLYFILL_SOURCE, "function maybeReloadForAppHostPortReset("),
    sandbox
  );
  sandbox.handleAppHostGatewayMessage = sandbox.handleAppHostGatewayMessage;
  return {
    diagnostics,
    storage,
    reloadCount: () => reloadCount,
    dispatch: (message) => sandbox.handleAppHostGatewayMessage(message),
  };
}

test("reset frame triggers a page reload and records the timestamp", (t) => {
  const harness = createResetHarness();
  const handled = harness.dispatch({
    type: "app-host-port-reset",
    portId: "app-host-client-1",
    reason: "session-expired",
  });
  assert.equal(handled, true, "reset frame must be consumed by the app-host dispatcher");
  assert.equal(harness.reloadCount(), 1, "first reset reloads the page");
  const diagnostic = harness.diagnostics.find((item) => item.event === "app-host-port-reset");
  assert.ok(diagnostic, "reset frame must be recorded as a client diagnostic");
  assert.equal(diagnostic.data.portId, "app-host-client-1");
  assert.equal(diagnostic.data.reason, "session-expired");
  assert.ok(harness.storage.get("codex_app_host_port_reset_at"), "reload cooldown timestamp must be persisted");
});

test("a second reset inside the 30s cooldown window does not reload again", (t) => {
  const harness = createResetHarness();
  harness.dispatch({ type: "app-host-port-reset", portId: "p", reason: "session-expired" });
  assert.equal(harness.reloadCount(), 1);
  harness.dispatch({ type: "app-host-port-reset", portId: "p", reason: "session-expired" });
  assert.equal(harness.reloadCount(), 1, "reload storm must be suppressed inside the cooldown window");
  const suppressed = harness.diagnostics.find(
    (item) => item.event === "app-host-port-reset-reload-suppressed"
  );
  assert.ok(suppressed, "suppressed reload must be diagnosable");
  assert.ok(suppressed.data.sinceLastMs >= 0 && suppressed.data.sinceLastMs < 30_000);
});

test("a reset after the cooldown window reloads again", (t) => {
  const harness = createResetHarness();
  harness.storage.set("codex_app_host_port_reset_at", String(Date.now() - 31_000));
  harness.dispatch({ type: "app-host-port-reset", portId: "p", reason: "session-expired" });
  assert.equal(harness.reloadCount(), 1, "cooldown expired: reload is allowed again");
});

test("when sessionStorage is unavailable the page does not reload (diagnostic only)", (t) => {
  const harness = createResetHarness({ sessionStorage: "throwing" });
  const handled = harness.dispatch({
    type: "app-host-port-reset",
    portId: "p",
    reason: "session-expired",
  });
  assert.equal(handled, true);
  assert.equal(harness.reloadCount(), 0, "no storage: never reload, avoid unbounded loops");
  assert.ok(
    harness.diagnostics.find((item) => item.event === "app-host-port-reset-reload-skipped"),
    "skipped reload must be diagnosable"
  );
});

test("unknown app-host control frames are still rejected by the whitelist", (t) => {
  const harness = createResetHarness();
  assert.equal(harness.dispatch({ type: "app-host-port-unknown", portId: "p" }), false);
  assert.equal(harness.dispatch(null), false);
  assert.equal(harness.reloadCount(), 0);
});
