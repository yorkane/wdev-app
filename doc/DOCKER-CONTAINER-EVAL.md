# 容器化评估：codex-desktop（桌面运行时 + OpenCodex 网关）能否跑在 Docker 里

> 2026-09-22　结论：**可以**，且已实测通过。本文给出证据、必须的适配点、以及不能照搬的地方。
> 配套可运行产物：`packaging/docker/{Dockerfile,container-entrypoint.sh,packages.txt}`。

## 1. 结论摘要

| 问题 | 结论 |
|---|---|
| 能否打包成镜像 | **可以**。把现有 deb 载荷装进 `ubuntu:22.04` 即可，实测镜像约 **2.17 GB** |
| 能否 `--network host` 运行 | **可以**，且与原生部署等价（网关默认绑 127.0.0.1，host 网络下就是宿主 loopback） |
| 运行时是否依赖 systemd | **否**。只有 `doctor` 会调 `systemctl`，取不到就显示 UNKNOWN 不崩；服务由入口脚本直接拉起 |
| 是否需要 Xvfb | **容器里通常不需要**。官方 Electron 走 `--headless`/ozone headless；实测未起 Xvfb 也正常工作 |
| 是否需要特权 | **不需要** `--privileged`。Electron 已带 `--no-sandbox`（由 `OPENCODEX_HEADLESS_ELECTRON=1` 追加） |
| 需要挂卷 | `/var/lib/codex-desktop`（含 codexhome 与官方运行时 profile），否则重启即丢登录/模型配置 |

## 2. 实测证据

环境：235.t，Docker 29.3.0 / overlay2。做法：`dpkg-deb -x` 现有 deb 载荷 + apt 安装 deb 声明的依赖
（Ubuntu 22.04 镜像，`apt-get install` 266 个包）+ 容器入口脚本（替代 systemd 单元）。

### 2.1 host 网络（用户问的场景）

```bash
docker run -d --name cdxd-test --network host --shm-size=1g --init -e PORT=13738 cdxd-smoke:test
```

实测结果：

```
curl http://127.0.0.1:13738/healthz                  -> 200
curl http://127.0.0.1:13738/ | grep title            -> <title>wdev</title>
codex-web-config.js                                  -> brand: {"name":"wdev","source":"config","configured":true}
                                                       locale: "zh-CN"
codex-brand-text / network-guard / menu-item-guard / js-error-capture -> 全 200
容器内进程                                            -> uid=999(codex-desktop)，捆绑 node 起 run-gateway.cjs，
                                                       并 spawn 官方 Electron 运行时（--headless --no-sandbox --disable-gpu）
审计 /var/log/codex-desktop/network-audit.jsonl       -> 正常写入（layer=desktop-net-fetch 的 block 记录）
容器内 /run/systemd/system                            -> 不存在（无 systemd，服务照常运行）
```

真实浏览器（playwright 经 127.0.0.1:13738）：`document.title` = `wdev`、`htmlLang` = `zh-CN`、
5 个覆盖层标记（brand/network/menu/pets/js-error-capture）全部 `true`、UI 无英文串（新容器首次打开是中文登录页）。

### 2.2 bridge 网络 + 端口映射（有坑，必须改一个变量）

```bash
# 默认 HOST=127.0.0.1：宿主访问映射端口 —— 打不通
docker run -d --name cdxd-bridge -p 13739:3737 --shm-size=1g --init cdxd-smoke:test
curl http://127.0.0.1:13739/healthz                  -> 000

# 加 -e HOST=0.0.0.0：通了
docker run -d --name cdxd-bridge2 -p 13740:3737 -e HOST=0.0.0.0 --shm-size=1g --init cdxd-smoke:test
curl http://127.0.0.1:13740/healthz                  -> 200
curl http://127.0.0.1:13740/ | grep title            -> <title>wdev</title>
```

原因：网关默认只绑 `127.0.0.1`（有意为之，避免裸露）。`-p` 是把宿主端口转发到**容器 IP**，
而容器内进程只监听 loopback，因此转不进去。**用 bridge 就必须 `-e HOST=0.0.0.0`**，
否则只有 host 网络可用。

## 3. 必须做的适配（3 件事）

1. **不要用 systemd 单元**：改为容器入口脚本（先读 conffile，再拉起网关）。已在 `packaging/docker/container-entrypoint.sh` 实现。
2. **入口脚本的环境变量优先级**：conffile 是 `KEY=value`，但容器里 `docker -e` 应当能覆盖它。
   脚本逐行读 conffile 且**跳过已存在的环境变量**，因此 `-e PORT=...`/`-e HOST=...` 生效。
3. **补 `--shm-size`**：Chromium 需要更大的 `/dev/shm`（Docker 默认 64 MB）。实测用 `--shm-size=1g`。

## 4. 已验证的「不需要」

- **不需要 `--privileged`**：`--no-sandbox` 已足够；实测未加任何 cap 就能起。
- **不需要 Xvfb**：官方 Electron 用 `--headless --ozone-platform=headless` 运行。
  实测容器里 Xvfb 没起来（见 §5），网关与隐藏运行时照常工作。
- **不需要系统 nodejs**：网关用包内捆绑的 node（`/opt/codex-desktop/gateway/node`）。
  实测依赖清单里虽含 `nodejs`（deb 为更新器声明），但容器运行时并未用到。
- **不需要 dbus / AppArmor / 桌面项**：dbus 报错（`Failed to connect to the bus`）在原生部署里也存在且无害。

## 5. 踩到的坑（实测）

### 5.1 `--network host` 时 Xvfb 会与宿主冲突

入口脚本启动 Xvfb 失败：

```
_XSERVTransSocketUNIXCreateListener: ...SocketCreateListener() failed
_XSERVTransMakeAllCOTSServerListeners: server already running
Fatal server error: (EE) Cannot establish any listening sockets
```

原因是 `--network host` **共享网络命名空间**，Xvfb 的抽象 socket 也会撞上——宿主上若已有一个 Xvfb 占用同一
`DISPLAY`（例如 :99），容器里就起不来。**但这不影响可用性**（headless 路径不需要 X），
所以：容器里直接 `CONTAINER_SKIP_XVFB=1`，或给容器换一个 `DISPLAY`（如 :98）。

### 5.2 日志位置变了

原生的 `/var/log/codex-desktop/gateway.log` 是 **systemd 单元的 `StandardOutput=append:`** 造成的；
容器里没有 systemd，日志走 **stdout** → 用 `docker logs` 看。
但 `network-audit.jsonl` 是网关自己写的文件，容器里照常落在 `/var/log/codex-desktop/`。

### 5.3 首次启动要「有身份」

全新容器（空 `CODEX_HOME`）打开页面是**中文登录页**——因为没有账号/模型配置。
要跳过登录，就把一份已配置的 `CODEX_HOME`（含 `config.toml` 的 model/provider）挂进去。
这与原生部署一致：原生也是靠 `CODEX_HOME` 里的配置决定模型来源。

### 5.4 属主必须一致

原生安装由 postinst 建 `codex-desktop` 账户并 chown 运行目录；容器里由 Dockerfile 做同样的事，
并且**入口以该用户运行**。若挂卷的属主与之不一致，会出现原生同样的
`SingletonLock: File exists / Permission denied` 然后反复重启（原生侧的同类排查见 `deploy.md` §8）。
挂 named volume 时通常没问题；挂宿主目录时注意 `chown 999:999`。

## 6. 与原生部署的差异对照

| 维度 | 原生（deb + systemd） | 容器 |
|---|---|---|
| 启动方式 | `codex-desktop-gateway.service` + xvfb 单元 | 入口脚本直接 exec 网关（系统 systemd 不需要） |
| 网络 | 直接绑宿主 127.0.0.1:3737 | host 网络等价；bridge 需 `HOST=0.0.0.0` |
| 日志 | `/var/log/codex-desktop/gateway.log` | `docker logs`（审计文件仍在容器内路径） |
| 配置 | `/etc/codex-desktop/*` conffile | 镜像内置默认值，覆盖用 `-e` 或挂卷 |
| 状态 | `/var/lib/codex-desktop` | 必须挂卷，否则重建即丢 |
| 升级 | `apt install` 新 deb（conffile 保留） | 重建镜像 + 重建容器（状态在卷里） |
| 约束 | 与宿主机共享端口/显示号 | 隔离；但 host 网络下端口仍与宿主共享 |
| 打包产物 | 458 MB deb | 约 2.17 GB 镜像 |

## 7. 建议的落地方式

1. 镜像**直接从 deb 装载**（`packaging/docker/Dockerfile` 已实现）——保证与 deb 是同源代码，
   不额外维护一套安装逻辑；
2. 镜像内**不装 systemd、不装 systemd 单元**，入口脚本负责编排；
3. 只暴露网关（浏览器访问），桌面 GUI 在容器里没有意义（无真实显示）；
4. 生产用 **host 网络**（与现网一致、最少改动），需要端口隔离时用 bridge + `HOST=0.0.0.0`；
5. 挂卷 `/var/lib/codex-desktop`；如要复用现有账号，把现有 `CODEX_HOME` 挂进去；
6. 用 `--init`（或 tini）让 PID 1 正确回收僵尸进程（实测容器里 Xvfb 曾留下 defunct）。

### 运行示例

```bash
# 构建（仓库根目录；先产出 deb，构建流程见 doc/GATEWAY-PACKAGING.md）
docker build -f packaging/docker/Dockerfile \
  --build-arg DEB=dist/codex-desktop_2026.09.22.033811_amd64.deb \
  -t codex-desktop:2026.09.22 .

# 运行（host 网络，等价原生）
docker run -d --name codex-desktop --network host --shm-size=1g --init \
  -e PORT=3737 \
  -v /srv/codex-desktop-state:/var/lib/codex-desktop \
  codex-desktop:2026.09.22

# 验收（与原生同一套判据）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3737/healthz
docker logs --tail 50 codex-desktop
```

## 8. 尚未验证 / 限制

1. **本次是「已有 deb + 容器」的等价验证**，没有真的跑 `docker build`（Dockerfile 是据此写的，逻辑与实测步骤一致，
   但未逐字构建过；`xargs -a packages.txt apt-get install` 与 `dpkg-deb -x` 都是实测用过的命令）。
2. **未做 ARM64 验证**（需 arm64 官方包 + arm64 基础镜像）。
3. **未验证「多实例并存」**：host 网络下同一端口只能一个实例；多实例需 bridge + 各自端口 + `HOST=0.0.0.0`。
4. **未验证 GPU**：本方案不需要 GPU（headless + `--disable-gpu`）；若将来要让容器内的桌面端用 GPU，需额外 `--gpus`。
5. **升级语义变了**：容器重建会丢掉容器内 `/etc` 改动，配置要用 `-e` 或挂卷管理，不能依赖 conffile 保留。
6. 已知问题（与容器无关，原生同样存在）：空闲会话 `no such export ID`、Kiki 类内核的 markdown 渲染，
   见 `doc/SESSION-IDLE-AND-KIKI-DIAGNOSIS.md`。
