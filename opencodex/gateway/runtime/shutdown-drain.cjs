"use strict";

const fs = require("fs");

// SIGTERM 优雅排空：网关收到停止信号后，先等运行中的 turn 收尾再退出。
// 背景（2026-10-07 取证）：installShutdownHandlers 原先 1.5s 强退、零排空，
// systemctl restart 会连带 SIGTERM app-server 整棵进程树，杀死所有运行中的
// 子智能体回合（235 历史 25 次、241 当日多次）。排空判据复用 ws-hub 回收日志
// 的 getActiveWorkSnapshot（turnRouteStatus.snapshot），降到 0 或窗口超时才继续退出。

const DEFAULT_DRAIN_MS = 25_000;
const MIN_DRAIN_MS = 0;
const MAX_DRAIN_MS = 120_000;
const DEFAULT_POLL_MS = 1_000;
const LOGGED_THREAD_LIMIT = 8;

function resolveDrainMs(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return DEFAULT_DRAIN_MS;
  return Math.min(MAX_DRAIN_MS, Math.max(MIN_DRAIN_MS, Math.round(parsed)));
}

function createShutdownDrain({
  getActiveWorkSnapshot,
  log = () => {},
  // 默认落在网关运行时目录（服务用户可写；/var/log/codex-desktop 由 systemd 持有，服务用户建不了新文件）。
  syncLogPath = process.env.CODEX_WEB_RUNTIME_DIR
    ? process.env.CODEX_WEB_RUNTIME_DIR.replace(/\/+$/, "") + "/shutdown-drain.log"
    : "/tmp/codex-shutdown-drain.log",
  drainMs = resolveDrainMs(process.env.OPENCODEX_SHUTDOWN_DRAIN_MS),
  pollMs = DEFAULT_POLL_MS,
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  now = () => Date.now(),
} = {}) {
  const counters = {
    started: 0,
    polls: 0,
    progress: 0,
    cleared: 0,
    timeouts: 0,
    disabledRuns: 0,
  };

  function readSnapshot() {
    try {
      const snapshot = typeof getActiveWorkSnapshot === "function" ? getActiveWorkSnapshot() : null;
      if (!snapshot) return null;
      return {
        count: Number(snapshot.activeTurnCount) || 0,
        threadIds: Array.isArray(snapshot.activeThreadIds) ? snapshot.activeThreadIds : [],
      };
    } catch {
      // 快照读取失败按"无快照"处理，绝不影响关停路径。
      return null;
    }
  }

  // 关停期 stdout 管道缓冲可能随快速退出被截断（2026-10-07 v4 实证：三次重启仅最慢一次留下日志）。
  // 排空事件必须同步落盘，宁可重复不可丢失。
  function emit(event, details) {
    // 两路输出彼此独立：diagnosticLog 在关停期可能因底层流已关闭而抛错，
    // 绝不允许它中断同步落盘（2026-10-07 13:21 实证：零输出即此路径）。
    try {
      log(event, details);
    } catch {}
    if (!syncLogPath) return;
    try {
      fs.appendFileSync(
        syncLogPath,
        JSON.stringify({ ts: new Date().toISOString(), event, ...details }) + "\n"
      );
    } catch {
      // 同步落盘失败不影响排空流程。
    }
  }

  async function run(label = "shutdown") {
    if (!(drainMs > 0)) {
      counters.disabledRuns += 1;
      return;
    }
    const initial = readSnapshot();
    if (!initial) {
      // 没有可用快照（未注入/异常）：按旧行为直接放行，不新增故障面。
      emit("shutdown_drain_started", { label, activeTurnCount: null, skipped: "no-snapshot" });
      return;
    }
    counters.started += 1;
    const deadline = now() + drainMs;
    let last = initial;
    emit("shutdown_drain_started", { label, activeTurnCount: last.count, drainMs });
    while (last.count > 0 && now() < deadline) {
      await new Promise((resolve) => {
        const timer = setTimeoutFn(resolve, pollMs);
        if (timer && typeof timer.unref === "function") timer.unref();
      });
      counters.polls += 1;
      const next = readSnapshot();
      if (!next) {
        // 排空中途失去快照：保守按已清零处理，避免误判卡死。
        last = { count: 0, threadIds: [] };
        break;
      }
      if (next.count !== last.count) {
        counters.progress += 1;
        emit("shutdown_drain_progress", {
          label,
          activeTurnCount: next.count,
          previousCount: last.count,
          threadIds: next.threadIds.slice(0, LOGGED_THREAD_LIMIT),
        });
      }
      last = next;
    }
    if (last.count === 0) {
      counters.cleared += 1;
      emit("shutdown_drain_clear", { label });
      return;
    }
    counters.timeouts += 1;
    emit("shutdown_drain_timeout", {
      label,
      activeTurnCount: last.count,
      threadIds: last.threadIds.slice(0, LOGGED_THREAD_LIMIT),
      drainMs,
    });
  }

  return { run, snapshot: () => ({ ...counters }) };
}

module.exports = {
  createShutdownDrain,
  resolveDrainMs,
  DEFAULT_DRAIN_MS,
  MAX_DRAIN_MS,
};
