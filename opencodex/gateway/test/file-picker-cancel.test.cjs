"use strict";

/**
 * 回归测试：浏览器文件选择器的「取消」判定不得把「页面重新获得焦点」当成取消。
 *
 * 线上症状：用户选了文件但没上传成功。因为 openBrowserFilePicker 过去只要收到
 * window focus，就在 250ms 后检查 input.files —— 用户从其它窗口切回来点击上传时，
 * focus 会立刻到达（对话框才刚打开，files 必为空），于是 input 被丢弃；
 * 随后用户真正选好的文件通过 change 送达时已无处投递。
 *
 * 现修法：必须「先失焦（说明对话框真的打开过）再聚焦」才允许判定取消，且宽限期放宽。
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "web-shell", "internal", "providers", "codex-bridge-polyfill.js"),
  "utf8"
);

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

const ALLOWS_FN = extractFunction(SOURCE, "function pickFilesAllowsMultiple(params) {");
const ACCEPT_FN = extractFunction(SOURCE, "function pickFilesAccept(params) {");
const PICKER_FN = extractFunction(SOURCE, "function openBrowserFilePicker(params) {");
const SESSION_CONST = extractConst(SOURCE, "FILE_PICKER_SESSION_TIMEOUT_MS");
const GRACE_CONST = extractConst(SOURCE, "FILE_PICKER_CANCEL_GRACE_MS");

/** 搭建可手动推进时间的 fake 环境。 */
function makeEnv() {
  const windowListeners = new Map();
  const timers = [];
  let now = 0;
  const input = {
    type: "", multiple: false, accept: "", style: {}, files: null, removed: false, clicked: false,
    _ls: new Map(),
    addEventListener(type, fn) { const list = this._ls.get(type) || []; list.push(fn); this._ls.set(type, list); },
    removeEventListener() {},
    click() { this.clicked = true; },
    remove() { this.removed = true; },
    _fire(type, ev) { for (const fn of this._ls.get(type) || []) fn(ev || {}); },
  };
  const document = {
    createElement: () => input,
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
  };
  const scheduler = {
    setTimeout(fn, ms) { const id = { fn, at: now + (Number(ms) || 0) }; timers.push(id); return id; },
    clearTimeout(id) { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); },
  };
  const adapterHost = {
    events: {
      observe({ type, callback }) {
        const list = windowListeners.get(type) || [];
        list.push(callback);
        windowListeners.set(type, list);
        return () => { const l = windowListeners.get(type) || []; const i = l.indexOf(callback); if (i >= 0) l.splice(i, 1); };
      },
    },
  };
  const sandbox = {
    document, scheduler, adapterHost, modificationEffects: undefined,
    activeBrowserFilePickerCancel: null,
  };
  sandbox.window = sandbox;
  // provider 里用 w 指代 window（与 IIFE 顶部的 const w = window 一致）。
  sandbox.w = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    [SESSION_CONST, GRACE_CONST, ALLOWS_FN, ACCEPT_FN, PICKER_FN, "globalThis.__openPicker = openBrowserFilePicker;"].join("\n"),
    sandbox
  );
  return {
    sandbox, input,
    fireWindow(type) { for (const fn of windowListeners.get(type) || []) fn({}); },
    /** 推进到所有当前定时器都执行完（按到期时间排序）。 */
    advance(ms) {
      const deadline = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= deadline).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        now = due.at;
        due.fn();
      }
      now = deadline;
    },
    graceMs: Number(/=\s*([0-9_]+)/.exec(GRACE_CONST)[1].replace(/_/g, "")),
  };
}

function settle(promise) {
  const state = { settled: false, value: undefined };
  promise.then((v) => { state.settled = true; state.value = v; });
  return state;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("仅 window focus（没有先失焦）不得取消：随后到达的 change 仍要生效", async () => {
  const env = makeEnv();
  const state = settle(env.sandbox.__openPicker({}));
  env.fireWindow("focus");
  env.advance(env.graceMs * 3);
  await flush();
  assert.equal(state.settled, false, "没有失焦过就不该按取消处理");
  assert.equal(env.input.removed, false, "input 不得被提前丢弃");
  // 用户此时才选完文件。
  env.input.files = [{ name: "picked.txt", type: "text/plain", size: 3 }];
  env.input._fire("change");
  await flush();
  assert.equal(state.settled, true, "change 必须能兑现这次选择");
  assert.equal(state.value.length, 1);
  assert.equal(state.value[0].name, "picked.txt");
});

test("先失焦再聚焦且没有选中文件时，才按取消处理", async () => {
  const env = makeEnv();
  const state = settle(env.sandbox.__openPicker({}));
  env.fireWindow("blur");
  env.fireWindow("focus");
  await flush();
  assert.equal(state.settled, false, "宽限期内不得抢先判定");
  env.advance(env.graceMs + 10);
  await flush();
  assert.equal(state.settled, true);
  // 跨 vm 上下文取回的数组原型不同，用长度断言。
  assert.equal(state.value.length, 0, "确认取消应返回空列表");
});

test("先失焦再聚焦，但 change 已在宽限期内到达时不取消", async () => {
  const env = makeEnv();
  const state = settle(env.sandbox.__openPicker({}));
  env.fireWindow("blur");
  env.fireWindow("focus");
  env.input.files = [{ name: "fast.txt", type: "text/plain", size: 1 }];
  env.input._fire("change");
  env.advance(env.graceMs * 3);
  await flush();
  assert.equal(state.value.length, 1);
  assert.equal(state.value[0].name, "fast.txt");
});

test("宽限期必须显著大于旧的 250ms，以容忍 change 迟于 focus 到达", () => {
  const env = makeEnv();
  assert.ok(env.graceMs >= 1000, "宽限期过短会复现「选的慢就丢文件」，当前为 " + env.graceMs + "ms");
});
