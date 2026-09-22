# codex-desktop 部署手册（单一 deb：桌面应用 + OpenCodex 网关）

> 面向：把本仓库产出的一个 deb 部署到一台 Linux 服务器并验证可用。
> 读者：人类运维 或 自动化 agent。每一步都给出可复制的命令与判据；判据不满足时按该节排查。
> 最后更新：2026-09-22（对应 dev 分支；实测环境 Ubuntu 22.04 amd64）

## 0. 交付物

`codex-desktop_<版本>_amd64.deb` 一个包同时交付两件事：

1. 桌面应用：把 OpenAI 官方 Linux `chatgpt` 包重打包成的 `codex-desktop`，装到 `/opt/codex-desktop`，
   并按 `linux-features/` 打上补丁（默认启用 `brand-network-overlay`：品牌替换、出站域名拦截、本地 Statsig 应答、
   菜单与宠物隐藏、浏览器 JS 错误采集）。
2. 浏览器网关：vendored 的 OpenCodex 网关（含自带 node v24，不依赖系统 nodejs），装到 `/opt/codex-desktop/gateway`，
   由 `codex-desktop-gateway.service` 常驻，让浏览器/手机访问这台机器上的桌面运行时。

两者共用一份站点配置 `/etc/codex-desktop/config.yaml`（品牌、出站域名策略）。

## 1. 前置条件

### 1.1 目标机

| 项 | 要求 |
|---|---|
| 发行版 | Debian/Ubuntu，实测 Ubuntu 22.04 amd64（arm64 亦可，需 Arm 包） |
| systemd | 需要（服务与虚拟显示均由 systemd 管理） |
| sudo | 需要 |
| 磁盘 | /opt 下预留 >= 2 GB |
| 端口 | 默认 127.0.0.1:3737（网关）；Xvfb 默认 :99 |
| 内存 | 建议 >= 4 GB（隐藏 Electron 运行时 + 网关 + node） |
| 网络 | 无需外网（运行时、node、依赖闭包都在包里） |

### 1.2 构建机

需要 bash、dpkg-deb/dpkg-dev、pnpm（corepack）、node >= 20、make、约 2 GB 空闲磁盘，
能访问 npmmirror（下载便携 node；国内可达）。不需要 Rust（见 §3.3）。

### 1.3 官方上游包（构建输入）

```bash
ls -la /nas2/tmp/chatgpt_*.deb /data/tmp/chatgpt_*.deb 2>/dev/null
```

> 仓库 `nix/upstream-linux-packages.json` pin 的版本可能与手上素材不同；显式传入时只做结构校验
> （包名/版本/架构），不做版本 pin 校验，因此较旧素材也能构建——但特性锚点是按新版本写的，
> 换版本前请先做 §7.3 的 --inspect 预检。

## 2. 端口与命名冲突（部署前务必确认）

1. 包名冲突：本包名为 `codex-desktop`，且没有声明 Replaces/Conflicts。若目标机已装社区版
   `codex-desktop`（例如 ilysenko 社区包），安装会原地升级并接管其文件——这是预期行为，
   但升级前建议备份 `/opt/codex-desktop`（见 §9.2）。
2. 端口/显示号冲突：若 3737 或 Xvfb :99 已被占用（例如旧的 ocx-stack 栈），
   先改配置再启动（§6.1），否则新网关启动失败或与旧服务抢端口。
3. 同名旧栈与本包可以并存，但同一时间只应由一个服务监听 3737。

## 3. 构建（构建机上执行）

### 3.1 准备仓库

```bash
cd /path/to/wdev-app
git checkout dev            # 交付分支（main 仅同步上游）
```

### 3.2 三步构建

```bash
export UPSTREAM_DEB=/nas2/tmp/chatgpt_26.908.40834_amd64.deb   # 换成你手上的官方包

make gateway-build                                   # 网关：pnpm install + tsc + 生产依赖 + 便携 node(v24)
UPSTREAM_DEB="$UPSTREAM_DEB" make build-app           # 解包官方 deb + 打 linux-features 补丁 -> codex-app/
PACKAGE_WITH_UPDATER=0 make deb                       # 打成单个 deb，产物在 dist/
```

说明：

- `make deb` 会自动检测网关构建树，缺失时自动跑 `make gateway-build`，所以也可只跑后两条。
- 耗时约 15 分钟，瓶颈是 `dpkg-deb` 单线程压缩（约 9 MB/s）。可用 `MAX_BUILD_THREADS=8` 传线程上限。
- 中间产物：`codex-app/`、`opencodex/.build/`（均在 .gitignore 中）。

### 3.3 关于更新器（PACKAGE_WITH_UPDATER）

- `PACKAGE_WITH_UPDATER=0`（推荐）：不含 Rust 更新器，无需 Rust 工具链，适合离线/受控环境。
- `PACKAGE_WITH_UPDATER=1`：打包前会 `cargo build --release -p codex-update-manager`，需要 Rust；
  并额外安装用户级更新服务与 polkit 动作。多数部署场景不需要。

### 3.4 构建判据

```bash
ls -la dist/codex-desktop_*_amd64.deb            # 应有一个约 450-470 MB 的 deb（忽略 1KB 残桩）
DEB=$(ls -t dist/codex-desktop_*_amd64.deb | head -1)
sha256sum "$DEB"                                  # 记录，目标机安装前比对
dpkg-deb -f "$DEB" Package Version Architecture   # codex-desktop / 时间戳版本 / amd64
```

构建日志里出现 `feature patch summary: applied=6` 表示 6 个桌面补丁全部命中；
小于 6 时先不要部署，用 §7.3 的 --inspect 预检。

## 4. 分发到目标机

```bash
DEB=$(ls -t /path/to/wdev-app/dist/codex-desktop_*_amd64.deb | head -1)
cat "$DEB" | ssh <目标机> "cat > /data/tmp/codex-desktop.deb"
sha256sum "$DEB"                                          # 两侧必须一致
ssh <目标机> "sha256sum /data/tmp/codex-desktop.deb"
```

> 458 MB 经 ssh 管道约 2 秒（局域网）。共享存储（如 /nas2）也可，但注意 NFS 目录属性缓存，
> 刚写入的目录可能短时间看不到；管道最稳。

## 5. 安装（目标机上执行）

### 5.1 安装命令

```bash
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  -o Dpkg::Options::="--force-confold" \
  /data/tmp/codex-desktop.deb
```

必须带 --force-confold：`/etc/codex-desktop/{config.yaml,gateway.env}` 是 conffile，升级时保留本机改动。
（代价：包模板新增的键/注释不会自动出现，见 §9.1。）

或用 dpkg 再补依赖：

```bash
sudo dpkg -i /data/tmp/codex-desktop.deb || sudo apt-get -f install -y
```

### 5.2 postinst 会自动做什么

- 创建系统账户 `codex-desktop`（除非 conffile 声明了 GATEWAY_SERVICE_USER，见 §6.3）；
- 创建 `/var/lib/codex-desktop{,/codexhome,/runtime,/reports,/official-bundle,/official-user-data}` 与 `/var/log/codex-desktop`；
- `systemctl daemon-reload` 并 enable 两个单元；首次安装立即启动，升级时仅在服务原本在运行时 try-restart；
- 若声明了自定义服务账户，生成 `/etc/systemd/system/codex-desktop-gateway.service.d/10-service-user.conf`；
- 重载 AppArmor、刷新桌面数据库。

> 重要：若 3737 或 :99 已被占用，请先按 §6.1 改好配置再安装，否则服务会反复重启。

### 5.3 安装判据

```bash
dpkg -l codex-desktop | tail -1                                  # ii  codex-desktop  <版本>
systemctl is-enabled codex-desktop-gateway codex-desktop-xvfb    # enabled enabled
systemctl is-active  codex-desktop-gateway codex-desktop-xvfb    # active active
systemctl show -p NRestarts --value codex-desktop-gateway         # 0
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3737/healthz   # 200
```

## 6. 配置

两个配置文件都是 conffile，位于 `/etc/codex-desktop/`。
改完：网关侧 `codex-desktop-gateway restart`；桌面侧下次启动生效。

### 6.1 gateway.env（进程环境）

```ini
HOST=127.0.0.1                      # 对外提供服务改 0.0.0.0，并前置认证反向代理
PORT=3737                           # 冲突就改，例如 13737
DISPLAY=:99                         # Xvfb 共用；被占用就改 :98
LANG=zh_CN.UTF-8
OPENCODEX_PREFERRED_LANGUAGES=zh-CN
CODEX_DESKTOP_LOCALE=zh-CN          # 界面语言（--lang/--accept-lang），改 en-US 切英文
# CODEX_DESKTOP_BRAND_NAME=wdev     # 品牌名；默认取 config.yaml 的 brand.name
# CODEX_DESKTOP_NETWORK_AUDIT_LOG=off   # 关闭出站拦截审计
OPENCODEX_HEADLESS_ELECTRON=1       # 无头服务器必须为 1（桌面机上删掉）
CODEX_DESKTOP_APP_PATH=/opt/codex-desktop/resources/app.asar
CODEX_DESKTOP_EXECUTABLE_PATH=/opt/codex-desktop/ChatGPT
CODEX_CLI_PATH=/opt/codex-desktop/resources/codex
CODEX_HOME=/var/lib/codex-desktop/codexhome
```

```bash
sudo sed -i "s/^PORT=3737/PORT=13737/"     /etc/codex-desktop/gateway.env
sudo sed -i "s/^DISPLAY=:99/DISPLAY=:98/"  /etc/codex-desktop/gateway.env
sudo codex-desktop-gateway restart
```

### 6.2 config.yaml（品牌 + 出站域名策略）

```yaml
auth:
  password: ""            # 可选访问口令；前置认证代理时留空
brand:
  name: "wdev"            # 界面产品名（也可用 CODEX_DESKTOP_BRAND_NAME 覆盖）
network:
  block:                  # 命中即本地拦截，不发真实请求
    - "*.chatgpt.com"
    - "chatgpt.com"
    - "*.openai.com"
    - "*.oaiusercontent.com"
    - "*.statsig.com"
    - "statsigapi.net"
  allow: []               # host 级放行
  allowPaths: []          # URL 级临时放行，优先于 block（见 §7.3）
```

### 6.3 服务账户（可选）

```ini
GATEWAY_SERVICE_USER=aigc
GATEWAY_SERVICE_GROUP=aigc
```

postinst 据此设定运行目录属主并生成等价 drop-in；只改这一处，别手工改 unit。
切换账户后要确保该账户对 `/var/lib/codex-desktop`、`/var/log/codex-desktop` 有写权限，
否则隐藏 Electron 会因 SingletonLock 不可写而反复重启（§10.3）。

### 6.4 模型/provider（可选，仅接自建模型时需要）

```bash
CODEX_HOME=$(sed -n "s/^CODEX_HOME=//p" /etc/codex-desktop/gateway.env | tail -1)
cat "$CODEX_HOME/config.toml"
```

把 `model` / `model_provider` / `openai_base_url` 指向自建代理（例如 http://127.0.0.1:10101/v1）。
属主注意：写 CODEX_HOME 必须用服务账户，root 写入变 root:root 会让 Electron 起不来（§10.3）。

## 7. 验证

### 7.1 最小可用判据（装完必跑）

```bash
# 1) 服务健康
systemctl is-active codex-desktop-gateway codex-desktop-xvfb     # active active
systemctl show -p NRestarts --value codex-desktop-gateway        # 0
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3737/healthz      # 200

# 2) 品牌与出站策略生效
curl -s http://127.0.0.1:3737/ | grep -oE "<title>[^<]*</title>"            # <title>wdev</title>
curl -s http://127.0.0.1:3737/codex-web-config.js | grep -oE "brand: \{[^}]*\}"
curl -s http://127.0.0.1:3737/codex-web-config.js | grep -oE "network: \{[^}]*\}"

# 3) 注入脚本可取
for f in codex-brand-text codex-network-guard codex-menu-item-guard codex-js-error-capture; do
  printf "%s -> " "$f"; curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3737/$f.js";   # 全 200
done
```

浏览器侧（可选）：打开页面应看到品牌名、界面为简体中文，账号菜单里没有「显示宠物」、设置侧栏没有「宠物」。

### 7.2 出站拦截自检（doctor）

```bash
codex-desktop-gateway doctor                  # 最近 1 小时
codex-desktop-gateway doctor --since 24h      # 升级后看一整天
codex-desktop-gateway doctor --json           # 机器可读（适合 agent 解析）
codex-desktop-gateway doctor --strict         # 有 FAIL 判据时退出码 2
```

报告四段：服务/健康、当前配置、拦截活动榜、升级自检判据 + 临时放行建议。
注意：`--strict` 只在判据 FAIL 时退 2；窗口内有拦截不算失败（拦截遥测是设计内行为）。
需要「有拦截就报错」时用 `--fail-on-block`。

### 7.3 官方包升级后的复核（重要）

官方 app 每次升级都可能新增必需端点；新端点若落在已拦截的域族里会被本地 200 顶掉，
表现为载入变慢、功能静默失效、甚至界面回退英文。标准动作：

1. 跑 `codex-desktop-gateway doctor --since 24h`；
2. 有可疑拦截项就按其建议在 `config.yaml` 的 `network.allowPaths` 加临时放行（形如 `host/path*`）；
3. `codex-desktop-gateway restart`；
4. 再跑一次 doctor，确认该 path 从 block 变成 allow-path、判据转 PASS；
5. 观察一个周期后把过宽的通配收窄回具体 path，确认无问题再删除。

审计来源：`/var/log/codex-desktop/network-audit.jsonl`（每行 JSON：ts/event/layer/host/path/method，
不写 query/cookie/body）；`codex-desktop-gateway audit 50` 可直接看尾部。

## 8. 日常运维

```bash
codex-desktop-gateway status      # 服务状态 + 访问地址
codex-desktop-gateway url         # 只打印地址
codex-desktop-gateway logs 200    # 最近 200 行日志
codex-desktop-gateway restart
codex-desktop-gateway stop        # / start
codex-desktop-gateway enable      # / disable 开机自启
codex-desktop-gateway config      # / env 编辑两个 conffile
codex-desktop-gateway audit 50    # 审计日志尾部
codex-desktop-gateway version
```

日志位置：

- 网关与隐藏运行时：`/var/log/codex-desktop/gateway.log`（append，长期运行会变大，必要时自行截断）；
- 单元日志：`journalctl -u codex-desktop-gateway -n 200 --no-pager`；
- 出站拦截审计：`/var/log/codex-desktop/network-audit.jsonl`（> 8 MiB 时启动自动轮转为 .1）。

## 9. 升级 / 回滚 / 卸载

### 9.1 升级

```bash
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::="--force-confold" /data/tmp/codex-desktop-new.deb
```

升级时 conffile 保留本机改动，同时 `/etc/codex-desktop/*.dpkg-dist` 会留下包内新版供对比：

```bash
diff /etc/codex-desktop/gateway.env /etc/codex-desktop/gateway.env.dpkg-dist
```

> 因为保留旧文件，新版本新增的配置键（例如新的 env 开关）不会自动出现在本机 conffile 里，
> 需要时按 §6 手工补。

### 9.2 回滚

包级回滚（最快）：

```bash
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::="--force-confold" /data/tmp/codex-desktop-上一版.deb
codex-desktop-gateway restart
```

首次安装前若目标机已有别的 `/opt/codex-desktop`（社区包/自研栈），建议先改名备份（瞬时、可逆）：

```bash
sudo mv /opt/codex-desktop /opt/codex-desktop.bak-$(date +%Y%m%d-%H%M%S)
```

回滚顺序：停本包服务 -> 移走本包装的目录 -> 把备份改回原名 -> 重装原包。

### 9.3 卸载

```bash
codex-desktop-gateway disable          # 先取消自启并停止
sudo dpkg -r codex-desktop             # 卸载，保留 /etc 配置与 /var/lib 状态
sudo dpkg -P codex-desktop             # 彻底清除（含 conffile 与服务账户）
```

## 10. 故障排查

### 10.1 服务反复重启（NRestarts 持续增长）

```bash
codex-desktop-gateway logs 200
systemctl status codex-desktop-gateway --no-pager --lines=30
sudo tail -100 /var/log/codex-desktop/gateway.log
```

常见原因：

1. 端口被占：`ss -ltnp | grep 3737` -> 改 `PORT`（§6.1）；
2. 显示号被占：`pgrep -a Xvfb` -> 改 `DISPLAY`；
3. 目录属主不对（服务账户与目录属主不一致）：见 §10.3；
4. 缺少捆绑 node：`ls /opt/codex-desktop/gateway/node/bin/node`。

### 10.2 页面打不开 / 白屏

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3737/     # 应 200
sudo grep -aE "install failed|Failed to parse Response|ERR_MODULE_NOT_FOUND" /var/log/codex-desktop/gateway.log | tail
```

若出现 `[brand-network-overlay] ... install failed`，说明桌面侧注入的运行时没装上，
这台机器的主进程出站拦截会失效（浏览器侧不受影响）。请记录完整行并回报——这属于需要改代码的问题。

### 10.3 Electron / 网关起不来的权限坑（真实案例）

隐藏 Electron 运行时会在 `CODEX_WEB_OFFICIAL_USER_DATA_DIR` 下写 profile。若目录属主与服务账户不一致
（例如服务以 aigc 跑、目录却是 root:root 或 codex-desktop），会出现：

```
Failed to create /var/lib/codex-desktop/official-user-data/SingletonLock: File exists (17)
Failed to create a ProcessSingleton for your profile directory. ... Aborting now to avoid profile corruption.
```

处理：

```bash
U=$(systemctl show -p User --value codex-desktop-gateway)
sudo chown -R "$U:$U" /var/lib/codex-desktop /var/log/codex-desktop
codex-desktop-gateway restart
```

> 本包 postinst 已经不会在升级时把已存在目录的属主夺回包内账户，但手工 chown 或换账户后仍可能不一致。

### 10.4 空闲一段时间后再对话报 no such export ID（已知问题）

现象：页面长时间不活动后再发消息，报 `no such export ID: 1`，刷新页面恢复。日志形如：

```
[electron-message-handler] sa_server_request_failed ... "message":"no such export ID: 1" ... rendererWindowVisible=false
```

已做的缓解（无需运维介入）：

- WS 瞬断时网关不再销毁 app-host 会话，而是保留并在重连时重挂（日志 `app_host_orphaned` -> `app_host_reattached`）；
  保留窗口 30 分钟（`OPENCODEX_APP_HOST_ORPHAN_TTL_MS`）；
- 超窗后重连会下发 `app-host-port-reset`，页面限流自动重载重建会话；
- 隐藏渲染页在无浏览器连接时会自动重载恢复（`OPENCODEX_APP_HOST_AUTORECOVER`，默认开）。

根因尚未修完（需后续代码改动，不在部署范围）：浏览器页的 app-host 会话会覆盖隐藏渲染页自己的
view 注册槽，因此「只要浏览器页连过，隐藏渲染页就可能持续报错」。
排查提示：连着浏览器页时该错误必然出现，不要据错误计数判定网关坏了；
`codex-desktop-gateway doctor` 的 app-host-view-slot 判据会给出窗口内计数。

临时规避：刷新浏览器页面（会重新注册并对齐），或重启网关服务。

### 10.5 手机浏览器（如 Kiki）部分 Markdown 渲染失败

现象：同一页面 Chrome 正常，某些内核较旧的手机浏览器里部分结果报错、Markdown 渲染中断。

包内已做：注入 `codex-js-error-capture` provider，做全局错误捕获、能力探测，并对可能缺失的 API
（toSorted / findLast / findLastIndex / URL.parse / at / replaceAll / Object.hasOwn / structuredClone 等）打最小 polyfill。

下次复现时取证（一条命令）：

```bash
sudo grep client-js-error /var/log/codex-desktop/gateway.log | tail
```

会得到 UA、message、source、line/col（markdown 相关错误带 `tag:"markdown"`）。把该行连同设备型号回报即可定案；
若命中的正是消息分段链路，polyfill 已直接修复渲染。

### 10.6 离线机器装不上（依赖不满足）

本包依赖继承官方包（约 30+ 个 GTK/X11 库）+ `xvfb` + `nodejs`。离线机器若缺依赖：
用 `apt install ./xxx.deb`（而不是裸 `dpkg -i`）让 apt 解析；仍缺则需在构建机把依赖 deb 放进 payload
（见 `doc/GATEWAY-PACKAGING.md`）。注意：网关自带 node，不依赖系统 nodejs 版本。

## 11. 附录

### 11.1 文件布局

```
/opt/codex-desktop/                          桌面应用（官方运行时重打包 + 已打补丁的 app.asar）
/opt/codex-desktop/gateway/                  网关树（gateway/ web-shell/ shared/ node/ node_modules/ run-gateway.sh VERSION）
/usr/bin/codex-desktop                       桌面启动器
/usr/bin/codex-desktop-gateway               网关管理 CLI（start stop restart status logs url config env doctor audit version）
/usr/share/applications/codex-desktop.desktop
/usr/share/icons/hicolor/256x256/apps/codex-desktop.png
/etc/apparmor.d/codex-desktop
/etc/codex-desktop/config.yaml               conffile（品牌 / 出站域名策略）
/etc/codex-desktop/gateway.env               conffile（端口 / 显示号 / 语言 / 数据目录 / 服务账户）
/lib/systemd/system/codex-desktop-gateway.service
/lib/systemd/system/codex-desktop-xvfb.service
/var/lib/codex-desktop/                      运行状态（codexhome runtime reports official-bundle official-user-data）
/var/log/codex-desktop/gateway.log           网关日志
/var/log/codex-desktop/network-audit.jsonl   出站拦截审计
```

### 11.2 关键环境变量速查

| 变量 | 默认 | 作用 |
|---|---|---|
| HOST / PORT | 127.0.0.1 / 3737 | 网关监听地址与端口 |
| DISPLAY | :99 | Xvfb 显示号，网关与 xvfb 单元共用 |
| CODEX_DESKTOP_LOCALE | zh-CN | 官方运行时界面语言（--lang/--accept-lang） |
| CODEX_DESKTOP_BRAND_NAME | 取 config.yaml | 品牌名（title/品牌位），优先级高于 config.yaml |
| CODEX_DESKTOP_NETWORK_AUDIT_LOG | /var/log/codex-desktop/network-audit.jsonl | 审计文件；off/0/none 关闭 |
| GATEWAY_SERVICE_USER / _GROUP | codex-desktop | 服务账户；声明后 postinst 生成 drop-in |
| CODEX_HOME | /var/lib/codex-desktop/codexhome | 模型/provider 配置目录 |
| OPENCODEX_HEADLESS_ELECTRON | 1 | 追加 --no-sandbox --headless --disable-gpu（桌面机删掉） |
| OPENCODEX_APP_HOST_ORPHAN_TTL_MS | 1800000（30 分钟） | app-host 会话孤儿保留窗口 |
| OPENCODEX_APP_HOST_AUTORECOVER | 1 | 无客户端连接时自动重载隐藏渲染页自愈 |
| PACKAGE_WITH_UPDATER（构建期） | 1 | 置 0 则不打包 Rust 更新器 |

### 11.3 一条命令跑完最小验收（可直接交给 agent）

```bash
codex-desktop-gateway status && \
codex-desktop-gateway url && \
systemctl is-active codex-desktop-gateway codex-desktop-xvfb && \
curl -s -o /dev/null -w "healthz=%{http_code}\n" http://127.0.0.1:3737/healthz && \
codex-desktop-gateway doctor --since 1h
```

全部通过即视为部署完成；doctor 的【4】升级自检判据若出现 FAIL，按 §7.3 处理。

### 11.4 相关文档

- `doc/MERGE-OPENCODEX.md`：两个项目合并为单一 deb 的设计与决策；
- `doc/GATEWAY-PACKAGING.md`：打包接线细节（runtree、systemd、conffiles、payload）；
- `doc/NETWORK-BLOCK-SELFCHECK.md`：出站拦截审计日志格式、allowPaths 语义与升级复核流程；
- `doc/SESSION-IDLE-AND-KIKI-DIAGNOSIS.md`：`no such export ID` 与 Kiki 渲染问题的完整取证与根因。

### 11.5 容器化（可选）

本包也可以装进 Docker 镜像运行，**已实测可用**（host 网络下与原生等价）。可运行产物在
`packaging/docker/{Dockerfile,container-entrypoint.sh,packages.txt}`，完整评估见 `doc/DOCKER-CONTAINER-EVAL.md`。

要点：

- 运行时**不依赖 systemd**（doctor 取不到 systemctl 时显示 UNKNOWN）；容器里由入口脚本直接拉起网关，
  不安装包内的 systemd 单元；
- **不需要 privileged、不需要 Xvfb**：官方 Electron 走 `--headless`，实测未起 Xvfb 也正常；
- **bridge 网络必须 `-e HOST=0.0.0.0`**，否则只绑容器内 loopback，`-p` 映射访问不到（实测 healthz=000）；
  host 网络则等价原生（默认 127.0.0.1）；
- 必须加 `--shm-size=1g`（Chromium 需要），并用 `--init` 回收子进程；
- `/var/lib/codex-desktop` 必须挂卷，否则重建容器即丢登录态与模型配置。

```bash
# 构建
docker build -f packaging/docker/Dockerfile \
  --build-arg DEB=dist/codex-desktop_<版本>_amd64.deb -t codex-desktop:<版本> .

# host 网络运行（等价原生）
docker run -d --name codex-desktop --network host --shm-size=1g --init \
  -v /srv/codex-desktop-state:/var/lib/codex-desktop codex-desktop:<版本>

# bridge 运行（注意 HOST）
docker run -d --name codex-desktop -p 3737:3737 -e HOST=0.0.0.0 --shm-size=1g --init \
  -v codex-desktop-state:/var/lib/codex-desktop codex-desktop:<版本>
```

容器里日志改用 `docker logs`（原生那套 `gateway.log` 是 systemd 的 StandardOutput 造成的）；
`network-audit.jsonl` 仍是网关自己写的文件，照常在容器内 `/var/log/codex-desktop/`。
