#!/bin/sh
# systemd ExecStart 包装脚本。
# 环境变量由 EnvironmentFile=/etc/codex-desktop/gateway.env 注入，这里只负责启动。
# 网关进程统一使用包内捆绑的 node（/opt/codex-desktop/gateway/node/bin/node），
# 不依赖系统 nodejs 版本（目标机系统 node 可能远旧于网关要求的 v22+）。
set -eu

APP_DIR=/opt/codex-desktop/gateway
BUNDLED_NODE="$APP_DIR/node/bin/node"

if [ ! -x "$BUNDLED_NODE" ]; then
  echo "codex-desktop-gateway: 找不到捆绑 node ($BUNDLED_NODE)" >&2
  exit 1
fi

cd "$APP_DIR"
exec "$BUNDLED_NODE" "$APP_DIR/gateway/dev/run-gateway.cjs"
