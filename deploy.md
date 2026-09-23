# codex-desktop 部署与配置指南

> 前提：已构建好安装包 `wdev_<版本>_amd64.deb`（当前版本 `wdev_2026.09.22.061341_amd64.deb`）。
> 发布件由 CI 构建并附在 GitHub Release 上（tag 形如 `deb-<版本>`），也可以自己在构建机上打包。
> 本文只讲在该机器上安装与配置；构建输入是 OpenAI 官方 Linux 包
> https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_amd64.deb
>
> 注意：发布文件名是 `wdev_*`，但**包内部身份仍是 `codex-desktop`**——安装路径为 `/opt/codex-desktop`，
> `dpkg -l` / `systemctl` 里看到的也是 `codex-desktop`。因此可以直接覆盖升级，无需先卸载旧版本。

## 1. 安装

```bash
sudo apt-get install -y ./wdev_2026.09.22.061341_amd64.deb
```

把文件名换成你手上的版本即可。如果这台机器装过旧版本，加一个参数保留本机已有配置：

```bash
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  -o Dpkg::Options::="--force-confold" ./wdev_2026.09.22.061341_amd64.deb
```

安装会创建服务账户 `codex-desktop` 与运行目录，并注册两个 systemd 服务：
`codex-desktop-gateway.service`（网关）、`codex-desktop-xvfb.service`（虚拟显示）。
**首次安装即启动，且已设为开机自启**。

若默认端口 `3737` 或显示号 `:99` 已被占用，先按 §2 改配置再启动。

## 2. 配置

两个配置文件都是 conffile（升级不会覆盖本机改动）：

| 文件 | 内容 |
|---|---|
| `/etc/codex-desktop/gateway.env` | 端口、显示号、界面语言、服务账户、数据目录 |
| `/etc/codex-desktop/config.yaml` | 品牌名、出站域名策略 |

**改完任一文件后执行重启命令生效：`codex-desktop-gateway restart`**

### 2.1 端口与显示号

默认监听 `127.0.0.1:3737`，虚拟显示 `:99`。冲突时：

```bash
sudo sed -i "s/^PORT=3737/PORT=13800/"    /etc/codex-desktop/gateway.env
sudo sed -i "s/^DISPLAY=:99/DISPLAY=:98/" /etc/codex-desktop/gateway.env
codex-desktop-gateway restart
```

需要局域网/公网访问时把监听地址放开（并在前面加一层带认证的反向代理）：

```bash
sudo sed -i "s/^HOST=127.0.0.1/HOST=0.0.0.0/" /etc/codex-desktop/gateway.env
codex-desktop-gateway restart
```

### 2.2 品牌名与界面语言

```bash
# 品牌名（界面 title 与品牌位），默认 wdev
sudo sed -i "s/^  name: .*/  name: \"wdev\"/" /etc/codex-desktop/config.yaml

# 界面语言（默认 zh-CN；改 en-US 切英文）
sudo sed -i "s/^CODEX_DESKTOP_LOCALE=.*/CODEX_DESKTOP_LOCALE=zh-CN/" /etc/codex-desktop/gateway.env
codex-desktop-gateway restart
```

### 2.3 服务账户（可选）

默认用包内创建的系统账户 `codex-desktop`。要与主机上其它服务共用账户时，在 `gateway.env` 里声明：

```ini
GATEWAY_SERVICE_USER=aigc
GATEWAY_SERVICE_GROUP=aigc
```

只改这一处即可（安装脚本会据此设定运行目录属主并生成 systemd drop-in）。
需要确认该账户对 `/var/lib/codex-desktop`、`/var/log/codex-desktop` 有写权限。

### 2.4 模型与 provider（可选，仅接自建模型时需要）

```bash
CODEX_HOME=$(sed -n "s/^CODEX_HOME=//p" /etc/codex-desktop/gateway.env | tail -1)
echo "$CODEX_HOME"          # 默认 /var/lib/codex-desktop/codexhome
```

在该目录的 `config.toml` 里把 `model` / `model_provider` / `openai_base_url` 指向自建代理
（例如 `http://127.0.0.1:10101/v1`）。**写入时要用服务账户**，否则文件属主不对会导致服务起不来：

```bash
sudo -u codex-desktop vi "$CODEX_HOME/config.toml"
```

## 3. 服务管理

安装时已注册为开机自启。确认与操作：

```bash
# 开机自启状态
systemctl is-enabled codex-desktop-gateway codex-desktop-xvfb      # enabled enabled

# 重启（改完配置用这个）
codex-desktop-gateway restart

# 启停与状态
codex-desktop-gateway start
codex-desktop-gateway stop
codex-desktop-gateway status

# 取消 / 恢复开机自启
codex-desktop-gateway disable
codex-desktop-gateway enable
```

## 4. 验证

```bash
# 服务在跑且没有反复重启
systemctl is-active codex-desktop-gateway codex-desktop-xvfb       # active active
systemctl show -p NRestarts --value codex-desktop-gateway          # 0

# 健康检查
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3737/healthz   # 200

# 品牌与语言生效
curl -s http://127.0.0.1:3737/ | grep -oE "<title>[^<]*</title>"          # <title>wdev</title>
```

浏览器打开 `http://<机器地址>:3737/`，应看到品牌名与配置的界面语言。

## 5. 常用命令一览

| 命令 | 作用 |
|---|---|
| `codex-desktop-gateway status` | 服务状态与访问地址 |
| `codex-desktop-gateway restart` | 重启网关（改配置后执行） |
| `codex-desktop-gateway logs 200` | 查看最近 200 行日志 |
| `codex-desktop-gateway url` | 打印访问地址 |
| `codex-desktop-gateway config` / `env` | 编辑两个配置文件 |
| `codex-desktop-gateway doctor` | 出站拦截自检（配置、活动榜、放行建议） |
| `codex-desktop-gateway audit 50` | 查看出站拦截审计尾部 |
| `codex-desktop-gateway version` | 查看已安装版本 |

日志位置：

- 网关日志：`/var/log/codex-desktop/gateway.log`
- 服务单元日志：`journalctl -u codex-desktop-gateway -n 200 --no-pager`
- 出站拦截审计：`/var/log/codex-desktop/network-audit.jsonl`

## 6. 出站域名拦截的临时放行

如果升级官方包后出现某些端点被拦截（表现为载入变慢、功能静默失效、界面回退英文），按下面步骤临时放行：

```bash
# 1) 看建议：doctor 会列出被拦截最多的 host+path 并给出可粘贴的放行片段
codex-desktop-gateway doctor --since 24h
```

```yaml
# 2) 把建议加进 /etc/codex-desktop/config.yaml 的 network 段
network:
  allowPaths:
    - "chatgpt.com/backend-api/*"      # 形如 <host>/<path* >，优先于 block
```

```bash
# 3) 重启并复核
codex-desktop-gateway restart
codex-desktop-gateway doctor --since 1h
```

确认恢复后，建议把过宽的通配收窄回实际用到的路径。

## 7. 升级与卸载

```bash
# 升级（保留本机配置）
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  -o Dpkg::Options::="--force-confold" ./wdev_<新版本>_amd64.deb
codex-desktop-gateway restart

# 卸载（保留配置与数据）
sudo dpkg -r codex-desktop

# 彻底清除（含配置与服务账户）
sudo dpkg -P codex-desktop
```

> 升级保留 conffile 的代价：新版本新增的配置项不会自动出现在本机文件里，
> 包内新版会留在同目录的 `*.dpkg-dist`，可用 `diff` 对比后手工补齐。

## 8. 常见问题

- **服务反复重启**：多为端口或显示号被占（`ss -ltnp | grep 3737`、`pgrep -a Xvfb`），按 §2.1 改配置。
- **起不来且日志提到 SingletonLock / Permission denied**：运行目录属主与服务账户不一致，
  执行 `U=$(systemctl show -p User --value codex-desktop-gateway); sudo chown -R "$U:$U" /var/lib/codex-desktop /var/log/codex-desktop` 后重启。
- **页面能打开但拿不到模型**：检查 `CODEX_HOME/config.toml` 的 `openai_base_url` 是否指向可用的模型服务。
