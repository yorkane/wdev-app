# 出站域名拦截：升级自检、审计日志与按 path 临时放行

> 2026-09-21　适用：codex-desktop（官方 Linux 包重打包）+ 内置 OpenCodex 网关

## 0. 要解决的问题

覆盖层默认会拦截一批官方域名（`*.chatgpt.com`、`*.openai.com`、`*.statsig.com` …），
命中即本地短路成 200，不发真实请求。这是刻意设计：无外网机器上让这些请求真发出去会
TCP 黑洞挂起，反而把官方 UI 卡住。

但**官方 app 每个版本可能新增必需端点**。新增端点若落在已拦截的域族里就会被本地 200 顶掉，表现为：

- 载入变慢（官方代码在等一个永远不会来的响应形状，反复重试）；
- 部分功能静默失效（功能开关读不到、某次初始化失败）；
- 界面语言回退英文（`ab.chatgpt.com/v1/initialize` 被顶掉时 i18n 层整段不加载 —— 已实际发生过一次）。

因此需要三件东西：**看得见的日志**、**可临时放行的配置**、**一条自检命令**。

## 1. 按 URL path 临时放行（允许名单）

在 `/etc/codex-desktop/config.yaml` 的 `network` 段新增 `allowPaths`：

```yaml
network:
  block:
    - "*.chatgpt.com"
    - "chatgpt.com"
    - "*.openai.com"
    - "*.oaiusercontent.com"
    - "*.statsig.com"
    - "statsigapi.net"
  allow: []            # host 级放行（既有）
  allowPaths:          # URL 级放行：命中即放行，优先于 block
    - "ab.chatgpt.com/v1/initialize"      # 精确 path
    - "chatgpt.com/backend-api/*"         # 前缀通配（* 匹配任意字符，含 /）
```

规则语义：

- 一条规则是 `<hostPattern>/<pathGlob>`，按**第一个** `/` 切分；没有 `/` 的条目等价于 `allow`（host 级）。
- `hostPattern` 与 `allow`/`block` 同语义：大小写不敏感，`*.x.com` 只匹配子域、不匹配裸域。
- `pathGlob` 匹配 URL 的 **pathname**（不含 query），**大小写敏感**；`*` 匹配任意长度字符（含 `/`），其余按字面量。
- 判定顺序：**allowPaths 命中 → 放行**；否则 `allow` 命中 → 放行；否则 `block` 命中 → 拦截。
- 非法条目（host 不合法、path 为空）会被丢弃，不会让服务起不来。

放行是**临时**手段：它只说明「这个端点这次需要放过去」，不改变「尽量不出网」的总体策略。
升级后应复核（见 §4），能收窄就收窄回具体 path。

生效方式：桌面侧下次启动读取；网关侧 `codex-desktop-gateway restart`。

## 2. 审计日志

各拦截层会把每次「拦截 / 放行 / Statsig 本地应答 / 启动配置」写成一行 JSON：

- 路径：环境变量 `CODEX_DESKTOP_NETWORK_AUDIT_LOG`，默认 `/var/log/codex-desktop/network-audit.jsonl`。
- 关闭：把该变量设为 `off`（或 `0`/`none`）。

```json
{"ts":"2026-09-21T17:00:00.000Z","event":"block","layer":"desktop-net-fetch","host":"chatgpt.com","path":"/backend-api/wham/usage","method":"POST"}
{"ts":"2026-09-21T17:00:01.000Z","event":"allow-path","layer":"gateway-net-fetch","host":"chatgpt.com","path":"/backend-api/wham/usage","method":"POST"}
{"ts":"2026-09-21T17:00:02.000Z","event":"statsig-local","layer":"gateway-net-fetch","host":"ab.chatgpt.com","path":"/v1/initialize","method":"POST"}
{"ts":"2026-09-21T17:00:03.000Z","event":"config","layer":"desktop-net-fetch","blocked":6,"allowed":0,"allowedPaths":0}
```

- `event`：`block` 被拦；`allow-path` 因 allowPaths 放行；`statsig-local` Statsig 控制面本地应答；`config` 启动时记录当时生效的策略。
- `layer`：`gateway-net-fetch` / `gateway-ipc`（网关侧）、`desktop-net-fetch` / `desktop-webrequest` / `desktop-webview`（桌面侧）。
- **绝不写 query、cookie、header、body** —— 只留定位所需的 host + pathname。
- 写文件是 best-effort：写不进去只影响审计，不影响拦截行为。

网关每次启动会检查审计文件，超过 8 MiB 时轮转为 `network-audit.jsonl.1`。

渲染层（Electron 内的 webview guard）写不了文件，它输出 `[bnov-audit]` 前缀的控制台行，
由主进程捕获后落成 `layer:"desktop-webview"` 的审计记录。若该捕获链路未生效，
记录仍可从 `/var/log/codex-desktop/gateway.log` 里的同名诊断行追溯。

## 3. 自检命令

```bash
codex-desktop-gateway doctor                 # 默认看最近 1 小时
codex-desktop-gateway doctor --since 24h     # 升级后看一整天
codex-desktop-gateway doctor --json          # 机器可读
codex-desktop-gateway doctor --strict        # 有可疑项时退出码 2（可进巡检/CI）
```

> `--strict` 只对「判据 FAIL」报警（例如 `initialize` 被判成 block）。窗口内出现拦截**不算失败** ——
> 拦截遥测本来就是设计内行为，否则健康机器会永远退出 2。需要「只要有拦截就报错」时用 `--fail-on-block`。

> 日志判据按统计窗口取：从日志尾部倒扫，遇到第一条早于窗口的行即停，因此修复前的历史条目
> （例如老版本那条 `main runtime install failed`）不会让判据永久 FAIL，只在证据里注明「窗口外还有 N 处」。

输出四段：

1. **服务/健康**：unit 状态、重启次数、端口、`/api/health`（网关健康路由）、安装版本。
2. **配置**：品牌名与来源、语言、block/allow/allowPaths 各多少条并列出。
3. **拦截活动榜**：按 `host+path` 聚合的次数与最后出现时间，倒序 top N。
4. **升级自检判据**（逐项 PASS/FAIL/UNKNOWN）：
   - `ab.chatgpt.com/v1/initialize` 必须是**本地应答**、不能被判 block；
   - `/codex-web-config.js` 可取且 brand/network 正确；
   - 版本化资源命名空间与 `/api/health` 正常；
   - 日志里没有 `install failed` / `Failed to parse Response` / `ERR_MODULE_NOT_FOUND`。

最后给出**可直接粘贴的放行建议**（被拦次数 ≥ 阈值的 path 收敛成前缀 glob）：

```yaml
network:
  allowPaths:
    - "chatgpt.com/backend-api/*"
```

## 4. 升级后复核流程（建议固定动作）

1. 装完新包、服务起来后执行 `codex-desktop-gateway doctor --since 24h`。
2. 若有可疑拦截项 → 按其建议在 `config.yaml` 加 `allowPaths` → `codex-desktop-gateway restart`。
3. 再跑一次 `doctor`：应看到该 path 出现 `allow-path` 事件、不再是 `block`，且第 4 段判据转 PASS。
4. 观察一个使用周期后，把过宽的 `chatgpt.com/backend-api/*` 收窄回实际用到的具体 path。
5. 确认无问题后删除临时放行，回到最小放行集。

回滚：`allowPaths` 是纯配置项，删掉对应行并重启即可；审计文件可直接清空/删除（会自动重建）。

## 5. 为什么没有做「升级后自动跑 doctor」

postinst 重启服务后 gateway 需要若干秒才 healthy，此时自动自检容易得到假 FAIL；
而且失败的自检不应影响安装事务。因此采用：**postinst 只在日志里提示跑 doctor**，
审计日志则天然记录了每次升级后生效的策略（`event:"config"`），足以回溯。
