const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const WebSocket = require("ws");

const { createWsHub } = require("../runtime/ipc/ws-hub.cjs");

function waitForMessage(socket, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw));
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
  });
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForClose(socket) {
  return new Promise((resolve) => socket.once("close", resolve));
}

function makeFakeRelay(options) {
  const relay = {
    nullCount: 0,
    closed: false,
    closeReason: "",
    messages: [],
    options,
    postMessageReturns: true,
    close(reason) {
      this.closed = true;
      if (!this.closeReason) this.closeReason = reason;
    },
    postMessage(message) {
      this.messages.push(message);
      if (message === null) this.nullCount += 1;
      return this.postMessageReturns;
    },
  };
  return relay;
}

async function openHelloClient(url, clientId, sockets) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await waitForOpen(socket);
  socket.send(JSON.stringify({ type: "hello", clientId }));
  await waitForMessage(socket, (message) => message.type === "hello-ack");
  return socket;
}

async function connectAppHost(socket, clientId, portId) {
  socket.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
  return waitForMessage(
    socket,
    (message) => message.type === "app-host-port-connected" && message.portId === portId
  );
}

test("orphans the relay on WS disconnect without nulling or closing the official port", async (t) => {
  const server = http.createServer();
  const relays = [];
  const sockets = [];
  createWsHub(server, {
    createAppHostRelay(options) {
      const relay = makeFakeRelay(options);
      relays.push(relay);
      return relay;
    },
    handleNotificationEvent() {},
    isAuthed: () => true,
    orphanTtlMs: 60_000,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const url = "ws://127.0.0.1:" + server.address().port + "/ws";
  const clientId = "orphan-client";
  const portId = "orphan-port-1";
  const first = await openHelloClient(url, clientId, sockets);
  await connectAppHost(first, clientId, portId);
  assert.equal(relays.length, 1);

  first.close();
  await waitForClose(first);
  // 断开后留一点时间给 close 回调；断言官方端完全没有被通知。
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(relays[0].nullCount, 0);
  assert.equal(relays[0].closed, false);
  assert.deepEqual(relays[0].messages, []);
});

test("reattaches the same relay on reconnect and sends the same ack as the fresh path", async (t) => {
  const server = http.createServer();
  const relays = [];
  const sockets = [];
  createWsHub(server, {
    createAppHostRelay(options) {
      const relay = makeFakeRelay(options);
      relays.push(relay);
      return relay;
    },
    handleNotificationEvent() {},
    isAuthed: () => true,
    orphanTtlMs: 60_000,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const url = "ws://127.0.0.1:" + server.address().port + "/ws";
  const clientId = "reattach-client";
  const portId = "reattach-port-1";
  const first = await openHelloClient(url, clientId, sockets);
  const freshAck = await connectAppHost(first, clientId, portId);
  assert.equal(freshAck.reattached, undefined);
  assert.deepEqual(
    { type: freshAck.type, portId: freshAck.portId },
    { type: "app-host-port-connected", portId }
  );

  first.close();
  await waitForClose(first);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const second = await openHelloClient(url, clientId, sockets);
  const reattachAck = await connectAppHost(second, clientId, portId);
  assert.equal(reattachAck.reattached, true);
  // 重挂与新建路径的 ack 对页面完全一致（页面只按 type+portId 匹配）。
  assert.equal(reattachAck.type, freshAck.type);
  assert.equal(reattachAck.portId, freshAck.portId);
  assert.equal(relays.length, 1, "reattach must reuse the existing official MessagePortMain");
  assert.equal(relays[0].closed, false);

  // 重挂后转发继续走同一条 relay。
  second.send(JSON.stringify({ type: "app-host-port-message", clientId, portId, data: "after-reattach" }));
  const deadline = Date.now() + 2_000;
  while (relays[0].messages.length < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(relays[0].messages[0], "after-reattach");
});

test("recycles the orphan after TTL with the legacy peer-close semantics", async (t) => {
  const server = http.createServer();
  const relays = [];
  const sockets = [];
  createWsHub(server, {
    createAppHostRelay(options) {
      const relay = makeFakeRelay(options);
      relays.push(relay);
      return relay;
    },
    handleNotificationEvent() {},
    isAuthed: () => true,
    orphanTtlMs: 120,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const url = "ws://127.0.0.1:" + server.address().port + "/ws";
  const clientId = "ttl-client";
  const portId = "ttl-port-1";
  const first = await openHelloClient(url, clientId, sockets);
  await connectAppHost(first, clientId, portId);
  first.close();
  await waitForClose(first);
  await new Promise((resolve) => setTimeout(resolve, 400));

  // 回收按旧语义释放官方 session：postMessage(null) 成功即优雅结束（不 close）。
  assert.equal(relays[0].nullCount, 1);
  assert.equal(relays[0].closed, false);
  assert.equal(relays[0].closeReason, "");
});

test("recycles the orphan with close() when the official port rejects null", async (t) => {
  const server = http.createServer();
  const relays = [];
  const sockets = [];
  createWsHub(server, {
    createAppHostRelay(options) {
      const relay = makeFakeRelay(options);
      relay.postMessageReturns = false; relays.push(relay);
      return relay;
    },
    handleNotificationEvent() {},
    isAuthed: () => true,
    orphanTtlMs: 120,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const url = "ws://127.0.0.1:" + server.address().port + "/ws";
  const clientId = "ttl-ugly-client";
  const portId = "ttl-port-2";
  const first = await openHelloClient(url, clientId, sockets);
  await connectAppHost(first, clientId, portId);
  first.close();
  await waitForClose(first);
  await new Promise((resolve) => setTimeout(resolve, 400));

  // postMessage(null) 失败时直接 close 官方端口，reason 标明回收来源。
  assert.equal(relays[0].nullCount, 1);
  assert.equal(relays[0].closed, true);
  assert.equal(relays[0].closeReason, "orphan_expired");
});

test("evicts the oldest orphan past the global relay cap", async (t) => {
  const server = http.createServer();
  const relays = [];
  const sockets = [];
  createWsHub(server, {
    createAppHostRelay(options) {
      const relay = makeFakeRelay(options);
      relays.push(relay);
      return relay;
    },
    handleNotificationEvent() {},
    isAuthed: () => true,
    orphanTtlMs: 60_000,
    maxAppHostRelays: 2,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const url = "ws://127.0.0.1:" + server.address().port + "/ws";
  const clientIds = ["cap-client-1", "cap-client-2", "cap-client-3"];
  for (const clientId of clientIds) {
    const socket = await openHelloClient(url, clientId, sockets);
    await connectAppHost(socket, clientId, "cap-port-" + clientId);
  }
  assert.equal(relays.length, 3);

  // 三个 socket 依次断开：第 3 个孤儿触发全局上限回收，最旧的第 1 条被释放。
  for (const socket of [...sockets]) {
    socket.close();
    await waitForClose(socket);
  }
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(relays[0].nullCount, 1);
  assert.equal(relays[1].nullCount, 0);
  assert.equal(relays[2].nullCount, 0);
  assert.equal(relays[1].closed, false);
  assert.equal(relays[2].closed, false);
});

test("buffers official-to-browser frames during the orphan window and flushes FIFO after reattach", async (t) => {
  const server = http.createServer();
  const relays = [];
  const sockets = [];
  createWsHub(server, {
    createAppHostRelay(options) {
      const relay = makeFakeRelay(options);
      relays.push(relay);
      return relay;
    },
    handleNotificationEvent() {},
    isAuthed: () => true,
    orphanTtlMs: 60_000,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const url = "ws://127.0.0.1:" + server.address().port + "/ws";
  const clientId = "buffer-client";
  const portId = "buffer-port-1";
  const first = await openHelloClient(url, clientId, sockets);
  await connectAppHost(first, clientId, portId);

  first.close();
  await waitForClose(first);
  await new Promise((resolve) => setTimeout(resolve, 30));

  // 断线窗口内官方 push 的帧必须被完整缓冲（RPC push 帧决定 export 表，丢帧即永久错位）。
  relays[0].options.onMessage("frame-a");
  relays[0].options.onMessage("frame-b");
  assert.equal(relays[0].nullCount, 0);

  const wireFrames = [];
  const reattachedSocket = await openHelloClient(url, clientId, sockets);
  reattachedSocket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === "app-host-port-message" && message.portId === portId) {
      wireFrames.push(message.data);
    }
    if (message.type === "app-host-port-connected" && message.portId === portId) {
      wireFrames.push("ACK");
    }
  });
  reattachedSocket.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
  await waitForMessage(
    reattachedSocket,
    (message) => message.type === "app-host-port-connected" && message.portId === portId
  );
  await new Promise((resolve) => setTimeout(resolve, 30));

  // 缓冲帧按 FIFO 冲刷，且都在 connected ack 之前送达。
  assert.deepEqual(wireFrames, ["frame-a", "frame-b", "ACK"]);
});

test("reconnect after TTL expiry requests a port reset instead of building a misaligned fresh relay", async (t) => {
  const server = http.createServer();
  const relays = [];
  const sockets = [];
  createWsHub(server, {
    createAppHostRelay(options) {
      const relay = makeFakeRelay(options);
      relays.push(relay);
      return relay;
    },
    handleNotificationEvent() {},
    isAuthed: () => true,
    orphanTtlMs: 120,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const url = "ws://127.0.0.1:" + server.address().port + "/ws";
  const clientId = "expiry-client";
  const portId = "expiry-port-1";
  const first = await openHelloClient(url, clientId, sockets);
  await connectAppHost(first, clientId, portId);
  first.close();
  await waitForClose(first);
  // 等孤儿 TTL 过期被回收。
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(relays[0].nullCount, 1);

  // 同一 clientId:portId 曾有过正常会话：重连不再新建错位 relay，而是发 reset 让页面重载自愈。
  const second = await openHelloClient(url, clientId, sockets);
  const received = [];
  second.on("message", (raw) => received.push(JSON.parse(String(raw))));
  second.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
  const reset = await waitForMessage(second, (message) => message.type === "app-host-port-reset");
  assert.equal(reset.portId, portId);
  assert.equal(reset.reason, "session-expired");
  // 给 connected ack 一个到达窗口：绝不能出现（没有官方 session 可挂）。
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(relays.length, 1, "post-expiry reconnect must NOT build a fresh official port");
  assert.equal(
    received.find((message) => message.type === "app-host-port-connected" && message.portId === portId),
    undefined
  );
});

test("never-lived port (first connect) still takes the fresh relay path", async (t) => {
  const server = http.createServer();
  const relays = [];
  const sockets = [];
  createWsHub(server, {
    createAppHostRelay(options) {
      const relay = makeFakeRelay(options);
      relays.push(relay);
      return relay;
    },
    handleNotificationEvent() {},
    isAuthed: () => true,
    orphanTtlMs: 60_000,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const url = "ws://127.0.0.1:" + server.address().port + "/ws";
  const clientId = "fresh-client";
  const portId = "fresh-port-1";
  const socket = await openHelloClient(url, clientId, sockets);
  // 首次连接不在 everLive 表里：正常新建，且收不到 reset 帧。
  const received = [];
  socket.on("message", (raw) => received.push(JSON.parse(String(raw))));
  const ack = await connectAppHost(socket, clientId, portId);
  assert.equal(ack.type, "app-host-port-connected");
  assert.equal(ack.reattached, undefined);
  assert.equal(relays.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    received.find((message) => message.type === "app-host-port-reset"),
    undefined,
    "first connect must never trigger a reset"
  );
});

test("orphan inside the window reattaches without any reset frame (reset must not preempt)", async (t) => {
  const server = http.createServer();
  const relays = [];
  const sockets = [];
  createWsHub(server, {
    createAppHostRelay(options) {
      const relay = makeFakeRelay(options);
      relays.push(relay);
      return relay;
    },
    handleNotificationEvent() {},
    isAuthed: () => true,
    orphanTtlMs: 60_000,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const url = "ws://127.0.0.1:" + server.address().port + "/ws";
  const clientId = "window-client";
  const portId = "window-port-1";
  const first = await openHelloClient(url, clientId, sockets);
  await connectAppHost(first, clientId, portId);
  first.close();
  await waitForClose(first);
  await new Promise((resolve) => setTimeout(resolve, 30));

  // 窗口内重连：everLive 表已命中且 orphan 仍在，重挂必须抢先于 reset 分支。
  const second = await openHelloClient(url, clientId, sockets);
  const received = [];
  second.on("message", (raw) => received.push(JSON.parse(String(raw))));
  const ack = await connectAppHost(second, clientId, portId);
  assert.equal(ack.reattached, true);
  assert.equal(relays.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    received.find((message) => message.type === "app-host-port-reset"),
    undefined,
    "reattach inside the orphan window must not emit a reset"
  );
});
