#!/bin/sh
# 容器入口：替代包内 systemd 单元（codex-desktop-gateway + codex-desktop-xvfb）。
#
# 运行时本身不依赖 systemd（doctor 缺 systemctl 时显示 UNKNOWN，属预期），
# 所以容器只需：读 conffile -> (可选)起虚拟显示 -> 拉起网关。
#
# 实测（Ubuntu 22.04 镜像 + 本包载荷，host 网络）：healthz 200、品牌/中文生效、
# 5 个覆盖层标记全部装上；且官方 Electron 用 --headless/ozone 运行，
# 因此默认**不需要** Xvfb（留作兼容，可 CONTAINER_SKIP_XVFB=1 跳过）。
set -eu

ENV_FILE="${CODEX_DESKTOP_ENV_FILE:-/etc/codex-desktop/gateway.env}"
if [ -f "$ENV_FILE" ]; then
  # conffile 是 KEY=value。逐行生效，但**已存在的环境变量优先**，
  # 这样 `docker run -e PORT=...` 能覆盖 conffile，符合容器直觉。
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ""|"#"*) continue ;;
    esac
    key=${line%%=*}
    case "$key" in
      *" "*) continue ;;
    esac
    if [ -n "$key" ] && printenv "$key" >/dev/null 2>&1; then
      continue
    fi
    export "$line"
  done < "$ENV_FILE"
fi

: "${HOST:=127.0.0.1}"
: "${PORT:=3737}"
: "${DISPLAY:=:99}"
: "${CODEX_HOME:=/var/lib/codex-desktop/codexhome}"
: "${CODEX_WEB_RUNTIME_DIR:=/var/lib/codex-desktop/runtime}"
: "${CODEX_WEB_REPORTS_DIR:=/var/lib/codex-desktop/reports}"
: "${CODEX_WEB_OFFICIAL_BUNDLE_DIR:=/var/lib/codex-desktop/official-bundle}"
: "${CODEX_WEB_OFFICIAL_USER_DATA_DIR:=/var/lib/codex-desktop/official-user-data}"
export HOST PORT DISPLAY CODEX_HOME CODEX_WEB_RUNTIME_DIR CODEX_WEB_REPORTS_DIR \
  CODEX_WEB_OFFICIAL_BUNDLE_DIR CODEX_WEB_OFFICIAL_USER_DATA_DIR

echo "[container] HOST=$HOST PORT=$PORT DISPLAY=$DISPLAY CODEX_HOME=$CODEX_HOME"

# 运行目录兜底创建（容器里通常挂卷；属主由挂卷或镜像决定）。
mkdir -p "$CODEX_HOME" "$CODEX_WEB_RUNTIME_DIR" "$CODEX_WEB_REPORTS_DIR" \
  "$CODEX_WEB_OFFICIAL_BUNDLE_DIR" "$CODEX_WEB_OFFICIAL_USER_DATA_DIR" 2>/dev/null || true

# 可选虚拟显示。注意：`--network host` 时容器与宿主共享网络命名空间，
# Xvfb 的抽象 socket 也会冲突——若宿主已有 Xvfb 占用同一 DISPLAY，
# 这里会启动失败（实测报 "server already running"）；官方 Electron 走
# ozone headless，不依赖它，因此可直接 CONTAINER_SKIP_XVFB=1。
if [ "${CONTAINER_SKIP_XVFB:-0}" != "1" ]; then
  if command -v Xvfb >/dev/null 2>&1; then
    if ! pgrep -f "Xvfb $DISPLAY" >/dev/null 2>&1; then
      Xvfb "$DISPLAY" -screen 0 1920x1080x24 -ac +extension GLX +render -noreset \
        >/tmp/xvfb.log 2>&1 &
    fi
  else
    echo "[container] 警告：未安装 Xvfb，依赖 ozone headless 运行" >&2
  fi
fi

# 交给包内启动器（使用捆绑 node，不依赖系统 nodejs）。
exec /opt/codex-desktop/gateway/run-gateway.sh
