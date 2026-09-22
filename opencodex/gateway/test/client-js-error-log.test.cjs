const assert = require("node:assert/strict");
const test = require("node:test");
const { __test: serverTest } = require("../runtime/server.cjs");

test("shouldLogJsError accepts js-* events and rejects others", () => {
  const now = 1_700_000_000_000;
  assert.equal(serverTest.shouldLogJsError("js-error", { clientId: "c1", message: "m1", source: "s.js" }, now), true);
  assert.equal(serverTest.shouldLogJsError("js-unhandled-rejection", { clientId: "c1", reason: "r1" }, now + 1000), true);
  assert.equal(serverTest.shouldLogJsError("js-capability", { clientId: "c1" }, now + 2000), true);
  // 非 js-* 事件走 DEBUG_LOGS 原路径，这里一律不落盘。
  assert.equal(serverTest.shouldLogJsError("ipc-queue", { clientId: "c1" }, now), false);
  assert.equal(serverTest.shouldLogJsError("js-error-extra", { clientId: "c1" }, now), false);
});

test("same signature is rate limited to one log per 30s", () => {
  const base = 1_800_000_000_000;
  const data = { clientId: "ratelimit-c", message: "same message", source: "same.js", line: 5 };
  assert.equal(serverTest.shouldLogJsError("js-error", data, base), true);
  assert.equal(serverTest.shouldLogJsError("js-error", data, base + 5000), false, "30s 内同签名应被限流");
  assert.equal(serverTest.shouldLogJsError("js-error", data, base + 31_000), true, "30s 后应放行");
  // 不同 message 视为不同签名，不受上一条限制。
  assert.equal(
    serverTest.shouldLogJsError("js-error", { clientId: "ratelimit-c", message: "different", source: "same.js", line: 6 }, base + 31_500),
    true
  );
});

test("per client window caps logs at 10 per 60s", () => {
  const base = 1_900_000_000_000;
  let logged = 0;
  for (let i = 0; i < 15; i += 1) {
    // 每条签名不同，避开签名限流，只验证 clientId 窗口上限。
    if (serverTest.shouldLogJsError("js-error", { clientId: "cap-c", message: "m" + i, source: "s" + i + ".js", line: i }, base + i * 1000)) {
      logged += 1;
    }
  }
  assert.equal(logged, 10, "60s 窗口内单 clientId 最多落 10 条");
  // 窗口滚动后重新计数。
  assert.equal(
    serverTest.shouldLogJsError("js-error", { clientId: "cap-c", message: "after-window", source: "sw.js", line: 99 }, base + 61_000),
    true
  );
});

test("distinct clients do not share the window budget", () => {
  const base = 2_000_000_000_000;
  for (let i = 0; i < 10; i += 1) {
    serverTest.shouldLogJsError("js-error", { clientId: "client-a", message: "ma" + i, source: "a" + i + ".js", line: i }, base + i * 1000);
  }
  // client-a 已耗尽窗口；client-b 仍应放行。
  assert.equal(
    serverTest.shouldLogJsError("js-error", { clientId: "client-b", message: "mb", source: "b.js", line: 1 }, base + 10_000),
    true
  );
});
