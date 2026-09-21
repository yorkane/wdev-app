# 单一 deb：桌面应用 + 浏览器网关（OpenCodex 集成）

> 2026-09-21　分支 `dev`　设计见 [MERGE-OPENCODEX.md](./MERGE-OPENCODEX.md)

本包在既有 `codex-desktop` 重打包链路上叠加了 OpenCodex 网关（vendored 于 `opencodex/`，
分支 `codex/brand-network-overlay` 的运行时子集），使**一个 deb** 同时交付：

| 组件 | 安装位置 | 说明 |
|---|---|---|
| 桌面应用 | `/opt/codex-desktop/` | 既有链路（官方运行时 + app.asar + start.sh），不变 |
| 网关运行树 | `/opt/codex-desktop/gateway/` | gateway/dist（tsc）+ web-shell + launcher + shared + 生产 node_modules + 捆绑 node |
| 网关服务 | `/lib/systemd/system/codex-desktop-gateway.service` | User=codex-desktop、EnvironmentFile=/etc/codex-desktop/gateway.env、Restart=on-failure |
| 虚拟显示 | `/lib/systemd/system/codex-desktop-xvfb.service` | Xvfb，DISPLAY 与 gateway.env 共用 |
| 启动器 | `/usr/bin/codex-desktop-gateway` | start/stop/restart/status/enable/logs/url/open/config/env/version |
| 配置（conffile） | `/etc/codex-desktop/config.yaml` | brand.name + network.block/allow，桌面与网关同一规则源 |
| 环境（conffile） | `/etc/codex-desktop/gateway.env` | 端口/DISPLAY/官方运行时路径/数据目录；默认指向**本包**的 `/opt/codex-desktop/...` |
| 运行时数据 | `/var/lib/codex-desktop/{codexhome,runtime,reports,official-bundle,official-user-data}` | postinst 创建，属主 codex-desktop |
| 日志 | `/var/log/codex-desktop/gateway.log` | systemd append |

## 构建链路

```
make gateway-build          # 1) pnpm install --frozen-lockfile --ignore-scripts（开发依赖）
                             # 2) pnpm run build（= build:gateway：skeleton + tsc → gateway/dist）
                             # 3) pnpm install --prod（生产依赖闭包 → opencodex/.build/node_modules）
                             # 4) 下载便携 node v24.20.0（npmmirror → opencodex/.build/node）
                             # 5) 包内依赖树逐个 require 自检

make deb                    # 自动检测网关构建树，缺失时先跑 make gateway-build
                             # stage_gateway_package_files() 把运行树装进 /opt/codex-desktop/gateway
                             # 追加依赖：仅 xvfb（nodejs 不加版本下限，见下）
```

完整验证命令（本机素材 26.908.40834）：

```sh
UPSTREAM_DEB=/nas2/tmp/chatgpt_26.908.40834_amd64.deb make build-app
PACKAGE_WITH_UPDATER=0 make deb
```

## 关键决策

- **不加 `nodejs (>= 22)` 依赖**：241.t 系统 node 为 v12 且无外网装 NodeSource，`>=22` 会让 dpkg
  依赖解析失败、包装不上。网关改为**自带便携 node**：构建期从 npmmirror 下载 v24.20.0 解进
  `opencodex/.build/node`，打包进 `/opt/codex-desktop/gateway/node/`，`run-gateway.sh` 直接用
  捆绑 node 的绝对路径启动，与系统 nodejs 版本完全解耦。updater 路径的既有 `nodejs` 依赖保持不动
  （v12 即可满足）；no-updater 路径为网关补一个无版本下限的 `nodejs`（桌面链路 node 工具仍需要）。
- **conffiles**：wdev-app 原先没有 conffiles 机制，本次新增 `DEBIAN/conffiles`（两行：
  gateway.env / config.yaml），升级时 dpkg 不再静默覆盖用户改过的配置。
- **维护脚本叠加**：网关段（postinst 建系统账户 codex-desktop + 运行目录 + daemon-reload + enable
  两单元；prerm remove/deconfigure/purge 停服务；postrm disable + purge 清状态目录/账户）以「删末行
  exit 0 → 追加段 → 补 exit 0」的方式叠加在既有更新器脚本之上，升级路径（with-updater 的
  `upgrade` 早退）语义不变；no-updater 路径同样覆盖（postrm 按需生成）。
- **依赖树拷贝**：pnpm 把传递依赖放在 `.pnpm` 下、顶层用符号链接暴露，打包必须 `cp -a` 整棵树
  （@electron/asar 依赖 minimatch 等传递依赖）；构建期在包内树上逐个 `require` 自检，缺依赖
  在构建时就暴露而不是装到目标机上才炸。
- **降级行为**：网关模板缺失 → 打包报错；网关构建树缺失 → 告警并产出**不带网关**的包（桌面功能
  不受影响），但 `make deb` 目标会自动先跑 `make gateway-build`，正常流程不会触发降级。

## 目录与文件清单（本工作流新增/改动）

```
opencodex/                          # vendored 网关源码（gateway/web-shell/launcher/shared +
                                     #   package.json/pnpm-lock.yaml/pnpm-workspace.yaml/config.example.yaml/LICENSE
                                     #   + scripts/sync-app-version.cjs、scripts/check-modification-boundaries.cjs
                                     #   + examples/plugin-v2-hello（tsconfig 类型检查需要））
opencodex/build-gateway.sh          # 构建脚本（见上）
opencodex/{node_modules,gateway/dist,.build}/   # 构建产物，gitignore
packaging/linux/gateway/            # 网关打包模板：两个 systemd 单元、conffiles、gateway.env、
                                    #   config.yaml、/usr/bin 启动器、postinst/prerm/postrm 网关段
packaging/linux/run-gateway.sh      # ExecStart 包装（捆绑 node 绝对路径）
scripts/lib/package-common.sh       # + stage_gateway_package_files / restore_gateway_payload_permissions /
                                    #   append_gateway_deb_maintainer_scripts / write_no_updater_deb_postrm / _gateway_last_exit_line
scripts/build-deb.sh                # + 模板预检、stage 调用、conffiles、xvfb 依赖注入、维护脚本叠加
Makefile                            # + gateway-build 目标；deb 目标自动补构建网关
gitignore                           # + opencodex 构建产物
```

## 目标机安装判据（241.t 部署时）

```sh
systemctl is-active codex-desktop-gateway.service      # active；NRestarts=0
curl -s -o /dev/null -w '%{http_code}' localhost:3737/healthz   # 200
/opt/codex-desktop/gateway/node/bin/node -v             # v24.20.0（不依赖系统 node）
curl -s localhost:3737/ | grep -o '<title>[^<]*</title>'     # <title>wdev</title>
```

注意：241.t 已有 ocx-stack 的 3737 监听，合并包部署前需先按部署计划处理端口/停服（见 recon_241t.md）；
conffile 安装建议带 `--force-confold` 以保留用户已改配置。
