const fs = require("fs");
const net = require("net");
const { diagnosticLog, diagnosticWarn } = require("../core/diagnostics.cjs");
const { markGatewaySilentQuit } = require("./quit-confirmation-suppressor.cjs");

const FORCE_EXIT_TIMEOUT_MS = 2000;

function lifecycleFdFromEnv() {
  const rawFd = process.env.OPENCODEX_GATEWAY_LIFECYCLE_FD;
  if (!rawFd) return null;
  const fd = Number(rawFd);
  return Number.isInteger(fd) && fd >= 0 ? fd : null;
}

function openLifecycleStream(lifecycleFd) {
  /**
   * macOS 打包后的 Electron/Node 会把 child_process 的 stdio pipe 暴露成 unix socket。
   * 用 fs.createReadStream 读取普通 PIPE 没问题，但对 socket fd 可能收不到 EOF；
   * 因此优先用 net.Socket 包装 fd，失败时再退回普通文件流，兼容不同平台实现。
   */
  try {
    return {
      type: "socket",
      stream: new net.Socket({
        fd: lifecycleFd,
        readable: true,
        writable: false,
        allowHalfOpen: false,
      }),
    };
  } catch (socketError) {
    try {
      return {
        type: "stream",
        stream: fs.createReadStream(null, { fd: lifecycleFd, autoClose: false }),
      };
    } catch (streamError) {
      const socketMessage = socketError instanceof Error ? socketError.message : String(socketError);
      const streamMessage = streamError instanceof Error ? streamError.message : String(streamError);
      const error = new Error(`open lifecycle fd failed: socket=${socketMessage}; stream=${streamMessage}`);
      error.cause = streamError;
      throw error;
    }
  }
}

function installLauncherLifecycleWatchdog({ app }) {
  /**
   * launcher 给 gateway 传一个专用生命周期 fd。
   * 这条线不承载业务数据，也不参与官方 IPC；launcher 退出后写端关闭，
   * gateway 只依赖系统 fd 的 EOF/close 事件结束自己，避免引入轮询。
   */
  const lifecycleFd = lifecycleFdFromEnv();

  let shuttingDown = false;
  let lifecycleStream = null;

  function shutdownForLostLauncher(reason, extra = {}) {
    if (shuttingDown) return;
    shuttingDown = true;

    diagnosticWarn("launcher-watchdog", "launcher_lost", {
      reason,
      ...extra,
    });
    try {
      markGatewaySilentQuit(reason);
      app.quit();
    } catch (error) {
      diagnosticWarn("launcher-watchdog", "app_quit_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(0);
      return;
    }

    const timer = setTimeout(() => {
      // Electron 隐藏窗口或官方 runtime 清理异常时不能无限等待，超时后直接结束 gateway。
      diagnosticWarn("launcher-watchdog", "force_exit_after_lifecycle_fd_close", {
        timeoutMs: FORCE_EXIT_TIMEOUT_MS,
      });
      process.exit(0);
    }, FORCE_EXIT_TIMEOUT_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  let fdWatchInstalled = false;
  if (lifecycleFd != null) {
    try {
      const opened = openLifecycleStream(lifecycleFd);
      lifecycleStream = opened.stream;
      fdWatchInstalled = true;

      lifecycleStream.once("end", () => shutdownForLostLauncher("lifecycle_fd_end", { fd: lifecycleFd }));
      lifecycleStream.once("close", () => shutdownForLostLauncher("lifecycle_fd_close", { fd: lifecycleFd }));
      lifecycleStream.once("error", (error) => {
        /**
         * 启动期 fd 缺失通常说明 gateway 不是 launcher 拉起的；这类路径不应自杀。
         * 已成功挂上监听后再报错，则按生命周期线断开处理。
         */
        if (error && (error.code === "EBADF" || error.code === "EINVAL")) {
          diagnosticWarn("launcher-watchdog", "disabled_lifecycle_fd_unavailable", {
            fd: lifecycleFd,
            error: error.message,
          });
          return;
        }
        diagnosticWarn("launcher-watchdog", "lifecycle_fd_error", {
          fd: lifecycleFd,
          error: error instanceof Error ? error.message : String(error),
        });
        shutdownForLostLauncher("lifecycle_fd_error", { fd: lifecycleFd });
      });

      // ReadStream/Socket 默认可能处于 paused 状态；必须 resume 才能收到 EOF/close。
      lifecycleStream.resume();
      diagnosticLog("launcher-watchdog", "lifecycle_fd_started", {
        fd: lifecycleFd,
        type: opened.type,
      });
    } catch (error) {
      diagnosticWarn("launcher-watchdog", "disabled_open_lifecycle_fd_failed", {
        fd: lifecycleFd,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    diagnosticLog("launcher-watchdog", "disabled_no_lifecycle_fd");
  }

  const installed = fdWatchInstalled;
  diagnosticLog("launcher-watchdog", installed ? "started" : "disabled", {
    lifecycleFd,
    fdWatchInstalled,
  });
  return { installed };
}

module.exports = {
  installLauncherLifecycleWatchdog,
};
