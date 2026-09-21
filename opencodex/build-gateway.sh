#!/bin/bash
# 构建 codex-desktop 包内捆绑的 OpenCodex 网关运行树。
#
# 产出（全部在 opencodex/ 下，已 gitignore，不入库）：
#   opencodex/gateway/dist/          tsc 编译产物（build:gateway）
#   opencodex/.build/node_modules/   生产依赖闭包（pnpm install --prod）
#   opencodex/.build/node/           便携版 Node 运行时（npmmirror 下载；自带进包，
#                                    目标机系统 node 版本无关，241.t 系统 node 仅 v12）
#
# 用法：make gateway-build（或 bash opencodex/build-gateway.sh）
# 可用环境变量：
#   GATEWAY_NODE_VERSION  便携 node 版本，默认 v24.20.0
#   GATEWAY_NODE_BASE_URL 下载基址，默认 https://registry.npmmirror.com/-/binary/node
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/.build"
GATEWAY_NODE_VERSION="${GATEWAY_NODE_VERSION:-v24.20.0}"
GATEWAY_NODE_BASE_URL="${GATEWAY_NODE_BASE_URL:-https://registry.npmmirror.com/-/binary/node}"

command -v pnpm >/dev/null 2>&1 || { echo "缺少 pnpm（corepack enable 或 npm i -g pnpm）" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "缺少 curl" >&2; exit 1; }

# ---- 版本一致性：shared/app-version.cjs 必须与 package.json 同步 ----
PKG_VERSION=$(node -p "require(process.argv[1]).version" "$SCRIPT_DIR/package.json")
SYNCED_VERSION=$(node -e "process.stdout.write((require(process.argv[1]).OPENCODEX_VERSION || '').trim())" "$SCRIPT_DIR/shared/app-version.cjs")
if [ "$SYNCED_VERSION" != "$PKG_VERSION" ]; then
    echo "shared/app-version.cjs 是 $SYNCED_VERSION，与 package.json 的 $PKG_VERSION 不一致" >&2
    exit 1
fi

echo "== OpenCodex 网关构建"
echo "   版本: $PKG_VERSION (opencodex vendored)"

# ---- 1. 开发依赖（供 tsc / esbuild 编译；--ignore-scripts 跳过 electron 二进制下载等构建脚本，
#        网关构建只需要 typescript + esbuild，不需要 electron 本体）----
if [ ! -d "$SCRIPT_DIR/node_modules/typescript" ] || [ ! -d "$SCRIPT_DIR/node_modules/esbuild" ]; then
    echo "   pnpm install（开发依赖，--frozen-lockfile --ignore-scripts）"
    ( cd "$SCRIPT_DIR" && pnpm install --frozen-lockfile --ignore-scripts >/dev/null )
else
    echo "   开发依赖已就位，跳过 pnpm install"
fi

# ---- 2. 编译 gateway/dist ----
echo "   pnpm run build（= build:gateway：skeleton typecheck + esbuild + tsc + 版本自检）"
( cd "$SCRIPT_DIR" && pnpm run build >/dev/null )
[ -f "$SCRIPT_DIR/gateway/dist/modification/catalog.js" ] || { echo "编译未产出 gateway/dist/modification/catalog.js" >&2; exit 1; }

# ---- 3. 生产依赖闭包 ----
# pnpm 把传递依赖放在 .pnpm 下并用符号链接暴露，顶层目录无法直接拷走
# （@electron/asar 需要 minimatch 等传递依赖），必须在独立目录里重装一遍。
PROD_STAGE="$BUILD_DIR/prod-stage"
mkdir -p "$BUILD_DIR"
rm -rf "$PROD_STAGE"
mkdir -p "$PROD_STAGE"
cp -a "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/pnpm-lock.yaml" "$PROD_STAGE/"
[ -f "$SCRIPT_DIR/pnpm-workspace.yaml" ] && cp -a "$SCRIPT_DIR/pnpm-workspace.yaml" "$PROD_STAGE/"
echo "   pnpm install --prod（生产依赖闭包）"
( cd "$PROD_STAGE" && pnpm install --prod --ignore-scripts --frozen-lockfile --config.verify-deps-before-run=false >/dev/null )
if [ -d "$BUILD_DIR/node_modules" ]; then
    mv "$BUILD_DIR/node_modules" "$BUILD_DIR/node_modules.old"
    rm -rf "$BUILD_DIR/node_modules.old"
fi
mv "$PROD_STAGE/node_modules" "$BUILD_DIR/node_modules"
rm -rf "$PROD_STAGE"

# ---- 4. 便携 node 运行时（下载产物 gitignore，不入库）----
case "$(dpkg --print-architecture 2>/dev/null || echo amd64)" in
    amd64)  NODE_ARCH="x64" ;;
    arm64)  NODE_ARCH="arm64" ;;
    *)      echo "不支持的架构: $(dpkg --print-architecture)" >&2; exit 1 ;;
esac
NODE_STAGE="$BUILD_DIR/node"
if [ ! -x "$NODE_STAGE/bin/node" ]; then
    NODE_TARBALL="$BUILD_DIR/node-${GATEWAY_NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
    echo "   下载便携 node ${GATEWAY_NODE_VERSION} linux-${NODE_ARCH}"
    curl -fSL --retry 3 -o "$NODE_TARBALL" \
        "$GATEWAY_NODE_BASE_URL/$GATEWAY_NODE_VERSION/node-${GATEWAY_NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
    [ -s "$NODE_TARBALL" ] || { echo "node 压缩包下载失败" >&2; exit 1; }
    mkdir -p "$BUILD_DIR/.node-extract"
    tar -xf "$NODE_TARBALL" -C "$BUILD_DIR/.node-extract"
    if [ -d "$NODE_STAGE" ]; then
        mv "$NODE_STAGE" "$NODE_STAGE.old"
        rm -rf "$NODE_STAGE.old"
    fi
    mv "$BUILD_DIR/.node-extract/node-${GATEWAY_NODE_VERSION}-linux-${NODE_ARCH}" "$NODE_STAGE"
    rm -rf "$BUILD_DIR/.node-extract" "$NODE_TARBALL"
fi
BUNDLED_NODE_VERSION=$("$NODE_STAGE/bin/node" --version)
echo "   便携 node: $BUNDLED_NODE_VERSION"

# ---- 5. 生产依赖自检：在包内依赖树上逐个 require，缺传递依赖要在构建时就暴露 ----
PROD_DEPS=$(node -e "process.stdout.write(Object.keys(require(process.argv[1]).dependencies).join(' '))" "$SCRIPT_DIR/package.json")
( cd "$SCRIPT_DIR" && NODE_PATH="$BUILD_DIR/node_modules" PROD_DEPS="$PROD_DEPS" \
    "$NODE_STAGE/bin/node" -e "for (const dep of (process.env.PROD_DEPS || '').split(' ').filter(Boolean)) { require(dep); } console.log('生产依赖自检通过: ' + (process.env.PROD_DEPS || '').trim());" )

echo "== 网关构建完成"
echo "   应用树: $SCRIPT_DIR（gateway/dist 已就绪）"
echo "   生产依赖: $(find "$BUILD_DIR/node_modules" -type f | wc -l) 个文件"
echo "   便携 node: $NODE_STAGE/bin/node ($BUNDLED_NODE_VERSION)"
