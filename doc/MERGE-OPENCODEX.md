# 合并 OpenCodex 网关进 wdev-app（单一 deb 交付）

> 2026-09-21　目标机器：241.t　承载分支：wdev-app `dev`

## 0. 背景

两个项目打的是同一个官方 Linux `chatgpt` 包，只是交付形态不同：

- **wdev-app**（yorkane/wdev-app，上游 ilysenko/codex-desktop-linux）：把官方 deb 重打包成
  `codex-desktop`，装到 `/opt/codex-desktop`，带 ASAR 补丁引擎（`linux-features/`）、Rust 更新器，
  产出 deb/rpm/AppImage。
- **OpenCodex**（RyensX/OpenCodex 的 fork，分支 `codex/brand-network-overlay`）：Web 网关，
  用浏览器访问同一台机器上的官方 Codex Desktop 运行时，带「品牌替换 + 出站域名拦截」覆盖层。

本次要把 `codex/brand-network-overlay` 的补丁逻辑合并进 wdev-app，并把两个项目合并成**一个 deb**。

## 1. 交付目标

1. wdev-app 的 `dev` 分支上，新增 **linux-feature `brand-network-overlay`**，把品牌替换 +
   出站域名拦截 + Statsig 本地应答 + 菜单隐藏落到**桌面应用 ASAR**（直接改 wdev-app 项目）。
2. 把 OpenCodex 网关源码 vendored 进 wdev-app，构建时产出运行树，**打进同一个 deb**。
3. 单一 deb `codex-desktop` 同时提供：桌面应用 + 浏览器网关，共用一份配置。
4. 在 241.t 上安装并验证两个面（桌面 ASAR 面 + 网关 web 面）都生效。

## 2. 关键决策

- **分支**：全部改动进 `dev`；`main` 只保留与 `upstream/ilysenko/codex-desktop-linux` 同步的干净状态。
- **桌面覆盖层用 ASAR 补丁**（不是运行时代理）：官方桌面端无中间代理，file:// 直读，只有 ASAR 注入
  才能在 renderer/main 内生效。补丁走 wdev-app 既有 descriptor 管线（`main-bundle` + `webview-asset`）。
- **网关源码 vendored 到 `opencodex/`**：保留 `gateway/`、`web-shell/`、`launcher/`、`shared/`、
  `package.json`、`pnpm-lock.yaml`；构建时 `pnpm install && pnpm run build` 产出 `gateway/dist`。
- **单一 deb `codex-desktop`**（沿用现有包名，便于在 241.t 原地升级社区包）：

  | 落地位置 | 内容 |
  |---|---|
  | `/opt/codex-desktop` | 桌面应用（含品牌/域名 ASAR 补丁） |
  | `/opt/codex-desktop/gateway` | OpenCodex 网关运行树 |
  | `/usr/bin/codex-desktop` | 桌面启动器（既有） |
  | `/usr/bin/codex-desktop-gateway` | 网关启动器（新增） |
  | `/lib/systemd/system/codex-desktop-gateway.service` | 网关服务 |
  | `/lib/systemd/system/codex-desktop-xvfb.service` | 虚拟显示 |
  | `/etc/codex-desktop/config.yaml` | conffile：brand / network（桌面 + 网关共用） |
  | `/etc/codex-desktop/gateway.env` | conffile：网关环境 |
  | `/var/lib/codex-desktop` `/var/log/codex-desktop` | 运行时数据与日志 |

- **Depends 追加** `nodejs (>= 22)`、`xvfb`。
- **配置单源** `/etc/codex-desktop/config.yaml`：网关运行时读取；桌面由 `start.sh` 读取后经环境变量/主进程
  注入，缺省回落到打包时 baked 的默认值（brand=`wdev`，block 清单见打包默认 config）。
- **网关侧保留既有 provider**：网关访问浏览器时仍由 web-shell provider 生效；桌面 ASAR 补丁是同一套规则的
  第二个执行面。两边规则同源、幂等守卫互不干扰。

## 3. 工作流

| 工作流 | 产物 | 负责 |
|---|---|---|
| A 覆盖层特性 | `linux-features/brand-network-overlay/`（feature.json/README.md/patch.js/lib/test.js） | 子智能体 |
| B 网关集成 | `opencodex/` vendored 源码 + `make gateway-build` + 打包接线 | 子智能体 |
| C 打包合并 | control/package-common/build-deb/Makefile/systemd/conffiles/postinst | 子智能体 |
| D 集成构建 | 单 deb 产物 | 主智能体 |
| E 241.t 部署验证 | 安装 + 双面判据 | 主智能体 |

## 4. 验证判据

**本地（235.t）**

- `make gateway-build` 产出 `opencodex/gateway/dist/modification/catalog.js`。
- `make inspect-upstream` 的 patch-report 显示 `brand-network-overlay` 的 descriptor 全部 applied。
- `make deb` 产出单 deb；`dpkg-deb -c` 含 `/opt/codex-desktop/gateway`、两个 systemd 单元、两个 conffile；
  `dpkg-deb -f Depends` 含 `nodejs`、`xvfb`。

**241.t（安装后）**

- 桌面面：`/opt/codex-desktop/resources/app.asar` 的 patch-report 含 brand/network 补丁；
  启动桌面端后界面品牌词为 `wdev`、对被拦截域名不发真实请求。
- 网关面：`systemctl is-active codex-desktop-gateway.service` = active、`NRestarts` = 0；
  `curl -s localhost:PORT/healthz` = 200；`<title>wdev</title>`；
  `codex-web-config.js` 的 brand/network 字段正确；浏览器内 `ab.chatgpt.com` 被本地拦截。
- 不破坏既有：tomcat:8080、code-server、10101 fork 代理保持原状。

## 5. 已知风险

- 241.t 已有 `ocx-stack`（/opt/ocx-stack，3737）与社区 `codex-desktop`（/opt/codex-desktop）两包；
  合并 deb 用 `codex-desktop` 包名会原地升级社区包，网关端口 3737 与 ocx-stack 冲突 → 部署时走 A/B 端口，
  先不碰 live 服务，验证后再切换。
- 官方运行时版本：仓库 pin 26.915.31945，本机素材 26.908.40834 / 241.t 为 26.908.31748；
  ASAR 锚点必须用目标版本预检（`make inspect-upstream`）。
- 属性：`/opt/codex-desktop` 下写用户数据必须用安装用户，避免 Electron 因 root 属主 SIGTRAP。

## 6. 241.t 部署方式（A/B，不碰 live 服务）

241.t 上原本并存两个包：社区 `codex-desktop`（/opt/codex-desktop）与自研 `ocx-stack`
（/opt/ocx-stack，网关监听 127.0.0.1:3737）。合并 deb 用 `codex-desktop` 包名会原地升级社区包，
且其网关默认端口 3737 会与 ocx-stack 冲突。

安全部署步骤（已在 2026-09-21 实测）：

1. 备份：`mv /opt/codex-desktop /opt/codex-desktop.community-bak-<ts>`（瞬时、可回滚），并记录
   `dpkg -L codex-desktop` 基线。
2. 预置 conffile `/etc/codex-desktop/gateway.env`，把 `PORT` 改为空闲的 `13737`、`DISPLAY` 改为
   `:98`（`:99` 已被 `xvfb-99.service` 占用）。
3. `apt-get install -y -o Dpkg::Options::="--force-confold" /data/tmp/cdxd-new.deb`（保留自写 conffile）。
4. 只启本包的 `codex-desktop-xvfb.service` + `codex-desktop-gateway.service`；**不动** ocx-stack 双服务。

回滚：`systemctl disable --now codex-desktop-gateway codex-desktop-xvfb`，
`mv /opt/codex-desktop.community-bak-<ts> /opt/codex-desktop`，再重装社区 deb。

## 7. 241.t 验证结果（2026-09-21 实测）

**网关面**（`http://127.0.0.1:13737`）

- `healthz` = 200；`systemctl is-active codex-desktop-gateway codex-desktop-xvfb` = active；
  `NRestarts` = 0。
- `<title>wdev</title>`、`<meta name=application-name content=wdev>`、
  `manifest.webmanifest` 的 name/short_name = wdev。
- `/codex-web-config.js` → `brand:{"name":"wdev","source":"config","configured":true}`、
  `network:{"blockedHosts":[...6 条...],"allowedHosts":[],"configured":true}`。
- 三个 Provider（`codex-brand-text` / `codex-network-guard` / `codex-menu-item-guard`）均 200。
- 网关日志出现 `[network-guard] net_fetch_blocked_by_config {"url":"https://chatgpt.com/..."}`。

**桌面面**（安装后的 /opt/codex-desktop）

- `patch-report.json` 5 条全部 applied（1 main-bundle + 4 webview-asset）；
  `build-info.json` 的 `linuxFeatures.enabled` = [brand-network-overlay]；
  安装后 `resources/app.asar` 的 sha256 与构建机产物一致。
- 覆盖层标记（`__bnovMainRuntimeInstalled` / `__bnovConfig` / `__bnovNetworkInstalled` 等）
  在安装后的 asar 内部存在。

**真实浏览器端到端**（playwright 经 SSH 隧道访问 13737）

- `document.title` = `wdev`；`__bnovBrandInstalled / __bnovNetworkInstalled / __bnovMenuInstalled /
  __bnovStatsigInstalled` 全为 true。
- `fetch('https://chatgpt.com/ces/v1/rgstr')` → **200, application/json, body "{}"**（本地合成）；
  同一环境对未拦截域名 `https://api.github.com/` 为 `Failed to fetch`（该环境无外网）——
  说明被拦截域名返回的 200 只可能来自本地拦截层。
- XHR `ab.chatgpt.com/v1/initialize` → 200，长度 786（合法 Statsig 初始化 payload，
  证明只读 IDL 属性覆写生效）。

**live 未受影响**：ocx-stack-gateway(:3737) healthz = 200，ocx-stack-proxy(:10101) healthz ok，
tomcat(:8080)、code-server 未动。

### 7.1 部署中发现并修复的缺陷

首轮安装后网关日志出现：

```
[brand-network-overlay] main runtime install failed: BRAND_NAME_MAX_LENGTH is not defined
```

桌面侧 main-bundle 注入的运行时引用了 `lib/site-config.js` 的模块级常量 `BRAND_NAME_MAX_LENGTH`，
但 `runtime/main-runtime.js` 的「内联声明清单」漏了它，导致整个 main 运行时在安装时抛
ReferenceError 并被自身的 try/catch 吞掉——**主进程 net.fetch 拦截静默失效**（浏览器侧不受影响）。

修复：在 main 运行时的内联常量块补上 `BRAND_NAME_MAX_LENGTH` 与 `DEFAULT_BRAND_NAME`；
并在 `test.js` 增加「在 vm 沙箱里执行生成的 main 运行时」回归测试（沙箱需注入 `URL`，
否则 `isBlockedUrl` 会因缺少 URL 解析器而静默透传，掩盖拦截逻辑）。
