# 桥接服务设计（Bridge Service Design）

> 决策状态：**已裁决并完成实施评审（v2，2026-10-06，含协议实测修订）**，可进入 Phase 1
> 作者：arch_doc（依据 root 架构裁决落笔）｜ 本文档为新建文件，无历史版本

## TL;DR

现网网关（opencodex gateway）用 28 个适配层把"一个官方 Electron 桌面客户端"拆成两半——renderer 搬进浏览器、main 留在服务器——再逐层缝合裂缝。export-ID 风暴（6,415 行）、孤儿 relay（orphaned 575 / recycled 266）、epoch 接管重放风暴（3,066 次/小时）、轮询放大（峰值 325 次/分钟）、session 失效与 25 次 app-server SIGTERM 连坐，全部是同一个根因的衍生品：**网关从未以合法 client 身份接入 app-server**（e6 §3 总结论）。

本设计裁决的路线：新建一个**桥接服务（Bridge）进程**，用官方给的两条合法通道接入——`codex app-server --listen unix://PATH` socket 传输（e6 C8）与 IpcRouter/`thread-follower-*` 命令族（e6 C7）——模拟并**独占**"官方客户端的响应与状态"。浏览器只通过新 topic 协议与桥通讯，不再在浏览器侧模拟 Electron renderer。L01–L07 七层"须保留"能力整体迁入桥进程，L08–L18 十一层"可消失"层随浏览器不再加载官方 bundle 而蒸发，L19–L28 十层功能保留、协议重设计。迁移分 5 个 Phase，每阶段有可观测验收指标。

输入材料：
- e6：`/data/tmp/aq_analysis/e6_deb/report.md`（官方 deb chatgpt_26.930.61225 客户端契约剖析，下称 "e6 §n / Cn"）
- e7：`/data/tmp/aq_analysis/e7_bridge/report.md`（28 适配层全量盘点，下称 "e7 §n / L## / S##"，行号指 e7 报告文件行）
- 事故底座：`/home/aigc/ChatGPT/wdev/doc/subagent-interruption-analysis-20261006.md`（下称 "取证报告 §n"）

---

## 1. 定性：28 层适配都是在补"没有合法 client 身份"这一个洞

e6 §3 的错位点表给出了逐条对应关系（`/data/tmp/aq_analysis/e6_deb/report.md:147-163`）：

| 错位 | 官方契约 | 网关现状 | 衍生症状 |
|---|---|---|---|
| 1 | C8：官方提供 `--listen unix://` 与 `app-server proxy` 多客户端传输 | 劫持官方 main 的 stdio 子进程字节流（official-runtime.cjs:553/588/628 + transport.cjs:438-653 覆写 stdin/stdout） | C1 slow-connection 判定变成不可观测事件；被迫自建帧分类、背压、tombstone |
| 2 | C2：server→client 反向请求必须有权威应答方 | 把浏览器页伪装成隐藏 renderer 让官方 renderer 去答（createOfficialIpcEvent 伪造 event.sender/ports，official-runtime.cjs:2613-2634） | `no such export ID:` 6,415 行（e7 L16，report.md:40）、once("destroyed") 监听器泄漏 |
| 3 | C3：订阅是 per-connection，官方有 optOutNotificationMethods | 网关自建 requestId→clientId 路由 + 反向 query-cache-invalidate | 在网关里重做一遍官方 subscription table，用 TTL 缓存兜底 |
| 4 | C4：initialize 是唯一合法会话起点 | 隐藏 renderer 是唯一 initialize 客户端，router 只能造 `opencodex.router:` 前缀 + internalThreadIds 吃响应 | 字节层伪装整层（e7 L23）；桥以合法 connection 接入后此层可退役 |
| 5 | C6：就绪以 `type:"ready"` 为准；实时流是 owner/follower 协议 | 就绪降级为"任意 IPC handler 注册过"（waitForOfficialBridgeReady 20s）；实时流靠只读 observer 伪装 follower | 首屏竞态与永久 spinner；官方 thread-follower-* 没被当接口用 |

e7 用另一条判据把 28 层归位（e7 §⓪，report.md:8-12）：每一层要么在治"renderer 在浏览器、main 在服务器"的裂缝，要么在治"官方客户端在无人值守服务器上活不下去"。桥接独占客户端角色后，第一类（L08–L18）整体蒸发，第二类（L01–L07）必须原样迁入桥进程，中间传输/折叠/鉴权层（L19–L28）功能保留、协议重设计。

**结论（root 裁决 1）**：这不是一堆独立 bug，而是一个架构缺陷的 28 种表现。任何继续在字节层/伪装层打补丁的方案都会持续产生新的适配层。

## 2. 核心原则（用户裁决，本文档的第一公理）

> 本项目服务浏览器，官方栈是客户端形态。由**桥接服务模拟并独占"客户端的响应与状态"**，所有对 app-server / 官方后端的访问与通讯**通过桥接服务**，不再在浏览器侧模拟 Electron renderer。

推论三条：

1. 浏览器页面不再是任何 Electron 角色：不是 renderer、不是 follower、不是 reporter。凡是以"页面在线"为输入的协议状态（S10 autorecover defer、S11 epoch 接管、activeBrowserClientCount）都要重新定义或删除。
2. 一个 CODEX_HOME 同时只允许一个桥实例 + 一个 observer clientId（e7 §④ 风险 2，report.md:114：灰度期双实例必然复现 export-ID 互踩与 epoch 抖动，把双实例当故障而非未支持形态）。
3. 桥与 app-server 之间必须 socket 化（§3.1），桥重启不再连坐 app-server——这是对 25 次 SIGTERM 事故（取证报告 §④ R-d、§A）的结构性解法的一部分（另一半是 §8 重启准入）。

## 3. 接入方式：官方合法入口替代 stdio 劫持

### 3.1 主通道：`codex app-server --listen unix://PATH`（e6 C8）

官方 clap 帮助（e6 C8，report.md:90-97，新二进制 offset 235484745）：`--listen` 支持 `stdio://`（默认）、`unix://`、`unix://PATH`、`ws://IP:PORT`、`off`；传输模块 `app-server-transport/src/transport/{stdio,unix_socket,websocket,remote_control/*}.rs`；另有官方 `app-server proxy --sock PATH` 子命令供第二客户端接同一 authority。wdev 的 `linux-features/shared-app-server-socket/README.md` 特性已经走通这条路（e6 C8 尾引："Desktop owns one selected Codex CLI child running app-server --listen unix://PATH"），本设计把它从特性升级为一等公民：**桥以 `--listen unix://` 接入，stdio 劫持链（e7 L22 spawn hook 的重定向部分）退役**。

为什么 socket 是硬要求：e6 C10（report.md:115-124）证实 **stdio 传输无重连**（`supportsReconnect()` 仅 websocket 为 true，src-CCXHtyvY.js:45590-45592），进程退出即终态（`Codex CLI process exited`，54578-54600）。今天网关与 app-server 的 stdio 耦合意味着任何一方死亡都连坐另一方；socket 化后桥重启只需重新连接 + 重新 initialize，app-server 不受牵连。

### 3.2 会话起点：官方 `initialize` 能力协商（e6 C4）

桥必须发 `{ id: "__codex_initialize__", method: "initialize", params: { clientInfo, capabilities } }`，capabilities 含 `experimentalApi: true`、extensions、mcpServerOpenaiFormElicitation、requestAttestation、optOutNotificationMethods（e6 C4，引 work/pretty_old/src-CCXHtyvY.js:49947-49963）。未 initialize 前其它方法一律 `not-initialized`（clientId 初值 initializing-client，src:76822）；clientInfo.name 会被当 HTTP header 校验（新 offset 233710063）；方法级开关 `requires experimentalApi capability`（新 offset 233759793）。握手超时 30s（EY=3e4，e6 C10）。

### 3.3 同机第二通道：IpcRouter（e6 C7）

官方跨进程多客户端总线（e6 C7，report.md:77-88，src-CCXHtyvY.js:76337-77127 区段）：socket 路径 `join(userData,"ipc","ipc.sock")`（目录 mode 0700 且必须属当前 uid，否则抛 `Codex IPC directory is not owned by the current user`），4 字节 LE 长度前缀 + JSON 帧，信封 `request/response/broadcast/client-discovery-request/-response`，注册用 randomUUID 生成 clientId，能力协商 schema `{ canHandle }`，请求超时 5s（Pme）、重连节拍 1s（Nme）。网关的 official-live-observer.cjs 已在只读使用它（:102 clientType、:188 订阅 thread-stream-following-changed、:366 params {clientType}）。桥把它作为同机第二通道与观测面，不再伪装身份——桥以**真实 clientType 注册**。

### 3.4 多浏览器 fan-out：官方 `thread-follower-*` 命令族语义（e6 C7）

官方 main 侧命令表（e6 C7 尾段，scripts/bus_old.txt）：`command-approval-decision`、`compact-thread`、`edit-last-user-turn`、`file-approval-decision`、`interrupt-turn`、`load-complete-history`、`set-queued-follow-ups-state`、`start-turn`、`steer-turn`、`submit-mcp-server-elicitation-response`、`submit-user-input`、`update-thread-settings` 等——e6 原文："官方协议本身就按「owner 执行、follower 下命令」设计，这正是桥接服务该复用的骨架"。桥是 owner（唯一 initialize/live attachment 持有者），N 个浏览器页面是逻辑 follower：页面上的审批点击、steer、interrupt 全部翻译成对应 follower 命令经桥代发。这替代了今天"伪造 event.sender 让隐藏 renderer 代答"的路径（e6 §3 错位 2）。

### 3.5 单 live attachment 约束（e6 C5）

`This thread is open elsewhere. Close it there and retry resume to continue.`（新 offset 235293549，两版都有）+ `cannot resume running thread X with stale path`（新 offset 233649811）。e6 C5 推论原文："多客户端不能各自打开同一线程；桥必须是唯一持有者，页面侧的打开要降级成订阅。"

## 4. 客户端契约义务（桥必须逐条实现，对应 e6 §1）

| # | 契约 | 桥的义务 | 后果（不做） |
|---|---|---|---|
| 1 | C1 持续排空出站流 | 桥对 app-server 的每一条连接永远保持读泵在线；转发路径不允许无界阻塞（慢消费者在浏览器侧降级，不在桥侧憋住） | `disconnecting slow connection after outbound queue filled:`（新 offset 233734559 / 旧 211383193，app-server/src/transport.rs）——服务端主动掐线；e6 原文："任何「读了但没及时转发」的中间层都会把自己变成 slow connection" |
| 2 | C2 应答 7 个反向请求 | 桥实现全部 7 个 handler：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request`、`item/tool/call`、`account/chatgptAuthTokens/refresh`、`attestation/generate`（名单与 offset 见 e6 C2，report.md:32-42，新 236427028）。其中 **approval×2、userInput、elicitation、tool/call 转发为浏览器 topic 等用户**；**chatgptAuthTokens/refresh 由桥自动办**（调 auth 模块刷新）；attestation 桥自答 | 不应答则该 turn 卡住；token refresh 不实现则登录态在服务端等待中僵死（e6 C2 原文）；新版 gatewayOAuth/userVerification 族扩张后僵死面更大（e6 §4 影响 3） |
| 3 | C3 显式订阅 | 桥按连接维护 thread/subscribe / unsubscribe，断线重连后重新订阅；用 optOutNotificationMethods 降噪（官方客户端就退订 turn/diff/updated，e6 C3 引 src:49947-49963） | `connection is not subscribed to thread`（新 offset 233709708）→ 页面拿不到任何通知 |
| 4 | C4 initialize 握手 | 见 §3.2；30s 超时与在途请求全拒的语义由桥的对等实现承担：桥在未完成 initialize 前拒绝一切浏览器请求帧 | 连接被判死 `Codex app-server initialize handshake timed out`（src:54915-54930）且 failPendingClientRequests 一次性 reject 全部在途（54975-54990） |
| 5 | C5 单 live attachment | 见 §3.5 | 桥被 thread/resume 拒绝，用户卡"open elsewhere" |

保活补充（e6 §3 错位 6）：官方**没有** client→app-server 心跳（bundle 里的 heartbeat 是 automation 语义，src-CCXHtyvY.js:16925-16978/59144），加 WS 心跳对 C1 无效。真正防线只有两条：桥的读流永不堵塞 + 重启前排空活跃 turn（官方 graceful restart drain 已提供语义，见 §8）。

## 5. 组件划分

### 5.1 Bridge 进程（新）

吸收 e7 判"须保留"的 7 层（e7 §① 须保留组，report.md:16-26）+ 全部 16 条状态所有权（§6）：

| 迁入层 | 名称 | 依据（e7 原文判定 + 关键锚点） |
|---|---|---|
| L01 | 隐藏 Electron 宿主（BrowserWindow 劫持 + 运行期强隐） | e7："桥接进程要么就是这扇隐藏 Electron 的宿主，要么继续依赖它；只要官方 app-server 仍由官方 main 的 bootstrap 拉起，这层不可撤"（official-runtime.cjs:2550-2589 等） |
| L02 | headless Chromium 启动参数 + GCM/push 隔离 | hidden-runtime-command-line.cjs:152-177；日志 hidden_gcm_checkin_held 14 次与 8 次冷启动配对，缺它官方启动被 push 注册链路卡住 |
| L03 | official-bundle asar 解包与缓存 | LocalCodexBundleProvider.js/AsarWebviewExtractor.js；桥仍要在服务器侧加载官方 main/renderer，仅"向浏览器分发 webview"一半随 L08 消失 |
| L04 | Electron 模块替身（Tray/Notification/单例锁/dock） | 官方 main 无条件创建托盘与桌面 Notification；服务器无桌面会话（official-tray-hook.cjs:16-45 等） |
| L05 | CODEX_HOME 与 profile 隔离 + 通道常量 | e7："这是「桥接即唯一合法客户端」的凭据与数据根。~/.codex 凭据由宿主自持，网关代码从不读写官方凭据"（config.cjs:22-24/:164-207） |
| L06 | Statsig/net.fetch 本地短路 + 出站策略与审计 | 桥侧官方 main 仍出站；审计层是"证明流量确实被改"的证据来源（net.fetch blocked 75,323 行、占全日志 20%） |
| L07 | 官方 live-bus 只读 follower 冒充 | e7："保留，且必须收归桥接独占……桥接成为唯一合法客户端后应与宿主合并，只允许一个 observer 身份"（official-live-observer.cjs 全文件） |

以及 e7 §④"永不可拔"（report.md:107-110）补充项：**L22** spawn hook 保留可接管的 spawn/execFile 点（降级为"只定位不重定向"，取决于官方是否还从别的路径 execFile 出 app-server）、**L23** transport 装饰即使瘦身也必须保留"桥持有 app-server stdin/stdout 写权 + 内部会话隔离（tombstone 与 -32001 拒绝）"两条不变式。

### 5.2 浏览器接入层

- **保留**：现有 /ws 传输与鉴权层。e7 §③.1（report.md:85）已论证传输层不需要重做（ws-hub noServer + permessage-deflate + maxPayload 100MB / maxClients 128；authz 反代已正确透传 Upgrade，proxy.lua:224-229；生产实测单条 /ws 传过 27.95MB）。
- **替换**：应用层协议换 7 个 topic（e7 §③.4 最小集，report.md:88）：

| topic | 方向 | 语义 | 替代物 |
|---|---|---|---|
| `thread.list.invalidated` | 桥→页 | 列表失效广播 | 收编 query-cache-invalidate（recent_conversations_meta_invalidation_broadcast 5,164 次，e7 §③.3 称其为"全链路唯一真正在工作的服务端推送"） |
| `turn.status` | 桥→页 | turn 生命周期 + 活跃 turn 数 | 顺带满足 S05 唯一真源与 §8 重启准入判据 |
| `turn.item.delta` | 桥→页 | 流式正文增量 | 替代 e5 实测活跃会话约 1Hz 的 thread/items/list + thread/turns/list 轮询 |
| `client.stale` | 桥→页 | 会话失效信号，页面原地重订阅恢复 | 替代 app-host-port-reset → location.reload() 整页打断式自愈（e7 L12，polyfill :2423-2451） |
| `approval.request` | 桥→页 / 页→桥 | 审批与反向请求转发（含 Computer Use / 官方 remoteControl 与 approveGuardianDeniedAction 语义） | 承接 §4 之 2 的 approval×2 / userInput / elicitation / tool-call |
| `notification` | 桥→页 | 桌面通知语义 | 替代 opencodex:notification-event 帧族与官方 Notification 转发（ws-hub.cjs:1262-1264 → official-notification-hook.cjs） |
| `presence` | 双向 | 桥自身健康 + 在线页面数 | 替代 activeBrowserClientCount 这种"页面在线≠客户端健康"的间接判据（S10 重定义的输入） |

- **硬性协议要求（从事故里读出来的，e7 §③.6，report.md:90）**：
  1. 每帧强制单调 `seq` + 断线游标续传（今天全仓无 ws ping/pong 心跳，e4 §1.1 与 §7(c) grep 证实）；
  2. `cancel` 是一等帧且能真正中断在途请求（今天 opencodex:ipc-invoke 无 cancel，只有 65s 超时 + 断线统一 reject，pick-files 甚至挂 10 分钟）；
  3. 自愈不得以整页 reload 为代价（client.stale 语义）；
  4. 缺 `requestId` 直接拒收，不静默丢弃（e7 L13：四处拦截均无 `if(!requestId)` 保护 → wait 悬空的真实来源之一）；
  5. 写操作幂等或明确禁重试（今天 retryDelays.length===1 + 前端白名单双护栏，白名单 :2068 仍混着 set-global-state 等四个写语义）。
- **浏览器→桥保留的调用语义**（e7 §③.5）：提交 turn / 追加输入、只读查询（走桥侧只读缓存，而非伪装 mcp-response 回包）、本地文件上传（带真 cancel 与 `{canceled}` 语义，补 L13 缺口）、workspace 根授权（带 owner + 断开回收，补 S12）、审批应答、token 用量查询、退出登录。
- **废弃帧族**：`opencodex:ipc-invoke` / `ipc-result` / `notification-event` 与 `app-host-connect` / `-port-message` / `-connected` / `-error` / `-close` / `-reset` 整族作废（e7 §③.2：它们的存在只为"把浏览器伪装成 Electron renderer"）。
- **实现范式迁入**：e7 §④"需同时改"7——hello-ack 就绪门、按连接归属 reject pending、指数退避 + hidden 退避三件事必须在桥接协议里重写，"否则会把已解决过的 bug 再解一遍"。

## 6. 状态所有权：16 条全部归桥（e7 §②，report.md:59-81）

| # | 状态 | 今天的散落位置（e7 行引） | 桥接管后形态 |
|---|---|---|---|
| S01 | 官方客户端凭据与登录态（ChatGPT 登录 / API key / CODEX_HOME） | config.cjs:22-24 声明共享 CODEX_HOME；实际隐藏 Electron+app-server 自持（e7:63） | 桥是唯一持凭据者；"双进程共享同一份凭据目录会互相覆盖 token 刷新"（e7 原文），对应 e6 C9 守卫文案族 |
| S02 | 网关 Web 壳访问会话（token Map + 滑动续期） | http/auth.cjs:180 内存 Map，:173 注释"重启后 token 自然失效"（e7:64） | 与 S01 分离、可持久化：**桥重启不带走浏览器会话**；同时消灭 L26 的"重启即全员掉登录" |
| S03 | 浏览器客户端身份与路由表（clientId→socket、clientsById） | ws-hub.cjs:1305-1345（e7:65） | 桥自维"谁在看哪条会话"；浏览器不再持有官方路由身份 |
| S04 | thread 订阅集（follower following 水位） | official-live-observer.cjs:120-123/:225-239/:388-406（e7:66） | 官方 live-bus 是 socket 级共享资源，"两个实例各持一个 follower 会互抢身份/丢 revision 连续性；单 owner 才有可验证增量" |
| S05 | turn 流状态（活跃 turn / turnId / 路由决策） | turn-route-status.cjs:131-138 + transport.cjs:218/:369/:684 + ws-hub 日志各一份（e7:67） | 桥是 turn 唯一发起者与终态权威（e7："今天这份状态无单一真源"）；同时供 §8 准入判据 |
| S06 | AppView RPC / app-host session 与 export 表对齐 | ws-hub.cjs:165-181 + official-runtime.cjs:2802-2922/:2699-2784（e7:68） | 收敛为"进程内唯一 session"；6,415 行 export-ID 风暴的注册槽互踩前提消失，页面级 TTL/孤儿表不再存在 |
| S07 | requestId→clientId 路由表 | official-runtime.cjs:57-60，REQUEST_ROUTE_MAX_ENTRIES=4096、无 TTL（e7:69） | 由桥 topic 广播取代（send_to_missing_client 1,860 次归零的路径） |
| S08 | 幂等读缓存条目 + pending 登记（clientId+request.id、hostId 归属、弃用态） | idempotent-read-cache.cjs:20-28/:48-83 + ws-hub.cjs:833-847（e7:70） | 必须单写者（e7：impl_review 实测复现过 A 响应存进 B 键的串位）；白名单与失效集清单可继承 |
| S09 | 官方 IPC handler/listener 注册表 | official-runtime.cjs:98-104/:1100-1198（e7:71） | 桥成为唯一调用方后注册表才稳定（今天受页面生命周期与隐藏页 reload 影响） |
| S10 | 隐藏 renderer 自愈状态机（60s 窗口/阈值 3/10min 冷却/defer） | official-runtime.cjs:702-830 appHostAutoRecover（e7:72） | "页面在线"不再是客户端健康代理 → 语义重定义（presence topic 输入）或整体删除；生产 autorecover_reload 0 次（e7 L16），本就未生效 |
| S11 | runtime-compatibility reporter 代际与序列（reportEpoch/sequence/generation） | compatibility/service.cjs:59-240 + 前端 codex-runtime-compatibility.js（e7:73） | 不再有"接管"事件，代际只描述桥进程自身（epoch 抖动 3,066 次/小时归零的路径） |
| S12 | 本地授权与文件态（dynamicRoots、local-file token、picked 目录、workspace-root 嗅探表） | workspace-roots.cjs:86 / local-files.cjs:155 / picked-files.cjs 等（e7:74） | 全是无 owner 的共享状态；桥接后按桥接会话分配 owner 并在断开时回收（今天只有 picked-files 有 TTL） |
| S13 | 进程/实例生命周期状态（GATEWAY_INSTANCE_ID、restartScheduled、launcher fd、silent-quit） | config.cjs:36 / service-control.cjs:26-32 / server.cjs:487-495 / launcher-lifecycle-watchdog.cjs（e7:75） | watchdog 对端换成桥（"桥接死了不能让网关僵尸常驻"）；"重启前是否排空活跃 turn"准入判据建在此层 |
| S14 | 网络策略与审计态（站点配置单例、审计落盘、Statsig 合成 gate 白名单） | site-config.cjs:331（首读后不重读盘→热改不生效）/ network-audit.cjs:22 / 两份硬编码 gate 白名单（e7:76） | 单点拥有 + 纳入升级校验（"官方新增 gate 不在白名单→功能静默消失"必须变红灯） |
| S15 | 首屏快照/桌面态（persisted atom 袋、prompt 历史、composer 权限模式、sidebar bootstrap） | desktop-state.cjs:6-64 + official-runtime.cjs:3140-3175（e7:77） | 桥前端自管状态；今天这份只读不回写，独占后才能双向 |
| S16 | 与 app-server 的 NDJSON 会话状态（connectionGeneration、pendingRequests、notificationWaiters、帧队列与背压、内部三张表） | model-router/transport.cjs:210-226/:438-449/:464-583/:684-706（e7:79） | 今天"由 model-router 代管、写权却靠 spawn hook 从官方 main 手里借"；桥独占后必须与桥的 turn 状态机同源，消灭两个写者争抢 stdin |

## 7. 版本升级策略（e6 §4，report.md:165-190）

26.930.61225 起官方换 **rolldown** 打包，chunk 全面改名：新版出现 rolldown-runtime、bootstrap、application-network-startup 等新 chunk，`window-all-closed-BxbCP6YG.js` 与 worker.js 消失，`main-DaMR-wdT.js` 不复存在——对照 `/opt/codex-desktop/.codex-linux/patch-report.json` 的 mainBundle（main-DaMR-wdT.js）与 assetName（app-initial-74b69e67976a.js）两个锚点在新版均已失效（e6 §4 "Electron main 侧"）。生产日志 `patch skipped: current bundle shape did not match` 24 条、`patch applied` 类 0 条（e7 L08，report.md:32），证明文件名锚定 patch 在官方 22 天的版本跨度内已静默全灭。

同时，桥的恢复语义依赖的新能力**只在 26.930+ 存在**（e6 §4）：`daemon_thread_recovery.rs`、`connection_rpc_gate.rs`、`connection_cleanup.rs`、`request_processors/{daemon_continuation,daemon_snapshot}.rs`，以及 shutdown grace 文案 `received shutdown signal; entering graceful restart drain (connections=N, runningAssistantTurns=M, new client turns rejected)`（新 offset 233753614；e6 §2 表，旧版有 drain 文案但无 shutdown grace）。e6 §4 影响 1 原话："把桥做成第二个合法 connection（或以 owner 身份独占）在新版才有完整的断连/恢复与优雅重启语义可依赖。"

升级纪律（root 裁决 7）：**锁版本 → 符号锚定 → 跟进新版**。

1. **锁版本**：wdev-app 构建锁定上游 deb 版本（现网基线 26.908.40834，目标 26.930.61225，sha256 b90a80f9353bc12a5a5b8469502a8e5794a3c54a371c8880e094d500de695bb8，见 e6 §0 素材表），升级走显式变更，不允许静默跟随 apt 渠道。
2. **符号锚定**：所有 overlay/patch 锚点从 chunk 文件名/asset 名改为**函数名/字符串字面量/行为探针**；`bundle shape did not match` 从"只进日志"升级为**构建期与启动期双门禁**（e7 §④ 风险 4）。e6 §4 影响 2 原话：install.sh 要求启用的 overlay 特性必须命中，漂移即构建失败——"必须先改成按符号锚定再谈升级官方包"。
3. **跟进新版**：桥的行为对齐新版独有模块与新增方法族（e6 §4 方法清单：thread/queue/*、thread/search*、turn/steer、remoteControl/*、experimentalFeature/*、environment/*、mcpServer/event/stream/*），每版对照 e6 的 scripts/reg_{old,new}_req.txt 方法差集与新增通知（thread/attachment/updated、account/gatewayOAuth/changed）做回归。

## 8. 服务管理与重启准入

分层生命周期：**网关（无状态前端）→ 桥（唯一客户端宿主）→ app-server（权威后端）**，三者可独立重启，依赖方向只向下。

1. **重启前置检查 = activeTurnCount=0**。ws-hub 的 recycleOrphan 日志已在本轮加上 activeTurnCount/activeThreadIds 字段（取证报告 §⑤ 表落地物 1，注入 getActiveWorkSnapshot；e7 L09 记为 be_impl 追加 ws-hub.cjs:299-328），可直接做准入判据。任何对桥/app-server/网关的重启与部署，准入不满足则等待或拒绝，不允许"延迟 N 秒硬重启"绕过（10-04 13:18:50 systemd-run 延迟 8s 重启掐死 01a04e5f 活跃 turn 的事故，取证报告 §③ / §④ R-d）。
2. **桥↔app-server socket 化后**（§3.1），桥重启不再连坐 app-server；app-server 侧的重启则依赖 26.930+ 的官方 graceful restart drain 语义（§7）与 `--managed-daemon`（保存 loaded threads，e6 C8 clap 帮助）。
3. **结构性收益**：桥接化后"网关重启 = 子智能体全体连坐"不再成立——取证报告 §A 定性"真正的杀手与唯一防线：网关整体重启的 SIGTERM 连坐。处置=重启准入"。浏览器会话在桥的 S02 里，turn 状态在桥的 S05/S16 里，网关重启只断 /ws 传输层，页面带 seq 游标重连续传即可。e7 §④ 风险 1 明确了反向条件：**若桥成为唯一客户端而没有"重启前排空活跃 turn"的准入，故障面从"部分页面"升级为"所有用户的所有 turn"**——所以准入检查是本设计的强制组成，不是可选项。
4. 落点在服务管理层（e7 §④ 风险 1 原文"落点在服务管理层……**不在 ws-hub**"，e4 §7(c) 已论证在 ws-hub 做心跳或"有 turn 就跳过回收"是无的放矢）。子代理对宿主下刀由纪律层（SKILL.md 防线 5）与准入检查共同兜住。

## 9. 迁移路线（引用 e7 §④ 批次，report.md:93-118）

顺序纪律引用 e7 原文的两条约束：L09 与 L10"必须一起下线……但别提前拔"——L15 的 epoch 接管与 L16 的 autorecover 都以"浏览器页面在线数"为输入（official-runtime.cjs:725/:787-796），须同批处理，否则出现"隐藏页不再被 reload、但浏览器仍直连"的空窗（e7 §④"可先拔"2）；L21 塌缩必须在"桥接 topic 协议"落地**之后**（反序会把 send_to_missing_client 从 1,860 次放大到全量，e7 §④"需同时改"5）。

### Phase 0 — 锁 26.930 + 符号锚定改造
- 内容：官方基线锁 chatgpt_26.930.61225；全部文件名锚定 patch 改符号锚定；bundle-shape 升级为构建/启动双门禁（§7）。
- 依据：e6 §4 影响 2（overlay 补丁锚点在新版全失效，漂移即构建失败）。
- 验收：新版本包冷启动 `patch skipped: current bundle shape did not match` = 0、`patch applied` 全量命中；启动期 shape 门禁可用故障注入触发红灯。

### Phase 1 — 拔浏览器侧模拟层（L13/L14/L18 → L15）
- 内容：先确保 L06/桥侧覆盖拦截与黑洞防护，再删 L14 浏览器出站拦截、L13 本地 fetch 合成、L18 UI 补丁簇（e7 §④"可先拔"1："三者只服务官方 bundle，桥接换 UI 后直接删"）；随后处理 L15 runtime-compatibility 浏览器上报——fe_impl 反馈环补丁已把 51/min 压到 <1/min，短期留作桥接健康度观测数据源，"桥接有等价上报后删除"（e7 §④"可先拔"3）。
- 顺序前提：e7 §④"可先拔"1 原话"否则先删 L14 会把「官方直连 chatgpt.com」的泄露面放出来"。
- 验收：runtime-compatibility 请求速率（authz 侧计数，基线 3,066 次/小时）→ 0；浏览器侧 client-js-error（基线 3,167）不升；Statsig/telemetry 拦截证据由桥侧审计产生（net.fetch blocked 基线 75,323 行的等价证据）。

### Phase 2 — app-server socket 化 + 桥进程落地（L22/L23 简化）
- 内容：桥进程上线，承载 L01–L07 与 S01–S16（§5.1/§6）；`--listen unix://` 一等公民化（shared-app-server-socket 特性转正，§3.1）；L22 spawn hook 降级为"只定位不重定向"（前提：核实官方是否还从别的路径 execFile 出 app-server，e7 §④"永不可拔"10）；L23 保留"stdin/stdout 写权 + 内部会话隔离"两条不变式、删 clientFramesConflict 与"官方并发只读放行"前提（e7 §④"永不可拔"11）。
- 同期硬约束（e7 §④"需同时改"8）：L26 鉴权 + S01/S02 凭据与会话分离**必须在桥接上线前完成**——"当前无密码模式（auth.cjs:277）+ token 只在内存（:173/:180）的组合，在「桥接独占、浏览器只连桥接」的暴露面下不可接受"。
- 灰度约束：同一 CODEX_HOME 只允许一个桥实例 + 一个 observer clientId（e7 §④ 风险 2）。
- 验收：export-ID 错误数（基线 6,415）新增为 0；`Codex CLI process exited ... signal=SIGTERM`（基线 25 次、全部 classifiedAsExpected=false）中"桥/网关重启连坐"类目 → 0；桥重启演练中 app-server 存活可证（socket 未断）。

### Phase 3 — relay/孤儿/epoch 层整体退役（L09/L10 + L15/L16 同批）
- 内容：浏览器不再直连官方 MessagePort 后，L09（TTL 30min、4000 帧/16MiB 缓冲、64 条孤儿上限、everLive 表、port-reset→reload 整套状态机）与 L10（结构化克隆编解码）整层删除（e7 §④"可先拔"2："本盘点中收益最大的一层"）；L16 autorecover 连同 60s 窗口/阈值/冷却/defer 全套状态机一并作废（e7 L16）。正确结局是**整层删除，而不是再调一次 TTL**（e7 §④ 风险 6 + e4 教训：recycleOrphan 本身无罪、不该被当成杀手来修）。
- 验收：orphan 家族计数（基线 app_host_orphaned 575 / reattached 306 / orphan_recycled 266 / port_reset_requested 56 / missing_relay 4,210）全部归零；location.reload() 自愈路径无触发；epoch 接管事件不再产生。

### Phase 4 — topic 协议全面接管（L21 塌缩）
- 内容：7 topic 上线后，L21 的 requestId→clientId 1:N 多路复用 + 分块 ACK 塌缩为 1:1，目录压缩/广播去重/定向推送的**需求**保留但实现换成桥 topic 订阅模型（e7 §④"需同时改"5）；L24 幂等读继承经取证与评审两轮的方法白名单与失效集（idempotent-read-cache.cjs:48-83），删"伪装 mcp-response 按 request id 合成回包"（同节 6）；L25 双路失效同步收编为 thread.list.invalidated 单路 + 与 presentation 定向推送合并成一套 topic 协议（e7 L25）；最后拔 L08 静态资产 patch 层——"只要还有一个页面加载官方 bundle 就不能拔，但它自身没有下游依赖，拔除零风险"（e7 §④"可先拔"4）。
- 验收：轮询 QPS（活跃会话 thread/items/list + thread/turns/list，基线约 1Hz/会话、日内 p50=31 / p90=105 / 峰值 325 次/分钟）由 turn.item.delta 替代后，app-server 读请求速率降一个量级；中断恢复时长（断线 → 内容续现）p95 < 3s 且不整页刷新。

### 验收指标总表（五项进入桥的常驻 dashboard，Phase 前后对比即验收）

| 指标 | 基线 | 出处 |
|---|---|---|
| export-ID 错误数 | 6,415（其中 6,155 行 rendererWindowVisible=false） | e7 §附 / L16 |
| orphan / recycled 数 | 575 / 306 / 266 / 56 / 4,210 | e7 L09 |
| runtime-compatibility 请求速率 | 3,066 次/小时（≈51/min） | e7 L15 |
| 轮询 QPS | p50=31、p90=105、峰值 325 次/分钟 app-server 调用 | e7 L12（引 e5 实测） |
| 中断恢复时长 | 今天靠 65s 超时 + port-reset→整页 reload | e7 §③.6 |

## 10. 风险与开放问题

1. **桥自身成为单点**。整个 fleet 的 turn 都挂在桥上（e7 §④ 风险 1）。缓解：§8 重启准入（activeTurnCount=0）+ §3.1 socket 化（桥重启不连坐 app-server）+ S02 会话持久化（浏览器会话不陪葬）。未决：桥 crash-loop 时的降级形态（只读快照？禁止新 turn？）留实施评审。
2. **官方 proxy / IpcRouter 能力边界待核实**（e6 §5 复现与局限 + §4"待核实"节）：`account/sessions/{add,logout,switch}`、`thread/environmentReady`、`turn/addUserMessage` 在两个二进制里都 0 hits，e6 判定为 JS 侧包装名或扫描噪声、不作为协议事实引用；e6 §5 承认 Electron main 五组子问题只完成到关键路径 + 行号证据（notes/electron_main.md 分节仍留占位）。桥落地前需对 `app-server proxy --sock` 的多 authority 行为与 IpcRouter 的 canHandle/client-discovery 路由做一轮真机验证。
3. **auth 面扩张的适配评估**：26.930 新增 gatewayOAuth 整族（旧 0 hits / 新 13 hits）与 `userVerification/{status,enroll,delete,verify,cancel}`（e6 §4"新增鉴权面"）。e6 §4 影响 3 原话："桥必须实现服务端反向请求的应答方，否则新版的登录/校验流程会在桥里僵死。"需要一份"桥 × 官方鉴权面"支持矩阵并在每次版本跟进时 diff（含既有 `account/chatgptAuthTokens/refresh` 与刷新失败家族 token_invalidated / refresh_token_reused 等，e6 C9）。
4. **灰度期双实例**：新老路径并存必然复现 export-ID 互踩（6,415 行级别）与 epoch 抖动（3,066 次/小时级别），且现象会和今天一样难归因（e7 §④ 风险 2）。纪律：单 CODEX_HOME 单桥实例 + 单 observer clientId，双实例当故障而非未支持形态。
5. **Statsig gate 白名单静默失效**：官方升级只改 feature id 而不报错（e7 §④ 风险 3；codex-bridge-polyfill.js:474-479 与 official-net-fetch-statsig-hook.cjs:14-22 两份硬编码必须保持一致）。迁移动作：变成启动期可校验清单，缺失即红而不是静默 false。
6. **L23 装饰瘦身的边界条件**：smart-router 的分类流量（`opencodex.router:` 前缀直写 stdin，transport.cjs:208/:269-294）在桥接管后是否仍需要 tombstone / -32001 内部会话隔离，取决于 smart-router 是否继续寄生 app-server 会话；若拆独立会话则此块可再减一层——实施评审定（e7 §④"永不可拔"11 的两条不变式是底线）。
7. **取证遗留**：turn/started 793 对 turn/completed 101 的不对称可能受日志截断影响，不能单独作为 wait 悬空证据（e7 §附 不确定项①）。迁移验收的"中断恢复时长"需独立埋点，不复用该计数。官方 vscode-api 对重复 requestId 是否严格匹配、input.click() 无用户激活时是否被内核放行，需真机回归（e7 §附 不确定项③）。

---

## 附录 A：与现有 28 层的对照总表（压缩自 e7 §①，report.md:16-58）

| 层 | 名称 | 桥接后命运 | 依据 |
|---|---|---|---|
| L01 | 隐藏 Electron 宿主 | 保留 → 迁入桥 | e7：官方 main bootstrap 拉 app-server 的前提不可撤；本文 §5.1 |
| L02 | headless 参数 + GCM 隔离 | 保留 → 迁入桥 | 14 次 held 配对 8 次冷启动；§5.1 |
| L03 | asar 解包与缓存 | 保留 → 迁入桥 | 分发 webview 一半随 L08 消失；§5.1 |
| L04 | Electron 模块替身 | 保留 → 迁入桥 | 官方 main 无条件调用桌面 API；§5.1 |
| L05 | CODEX_HOME/profile 隔离 + 通道常量 | 保留 → 迁入桥 | 唯一合法客户端的凭据与数据根；§5.1 / S01 |
| L06 | Statsig/net.fetch 短路 + 出站审计 | 保留 → 迁入桥 | blocked 75,323 行=日志 20%；流量证据来源；§5.1 |
| L07 | live-bus follower 冒充 | 保留 → 桥接独占 | 与浏览器 multiplex 正交；§3.3 / S04 |
| L08 | 静态资产 patch 与浏览器分发 | 消失（Phase 4 最后拔） | official-patched-v8 25,313 次、skip 24 条；§9 Phase 4 |
| L09 | app-host relay 孤儿化/重挂/port-reset | 消失（Phase 3，收益最大） | orphaned 575 / recycled 266 / missing_relay 4,210；§6 S06 |
| L10 | app-host 结构化克隆编解码 | 消失（与 L09 同批） | relay 不复存在；§9 Phase 3 |
| L11 | polyfill：Electron 环境门面 | 消失（登出/toast 按新协议重写） | 官方改菜单文案即静默失效；§5.2 |
| L12 | polyfill：WS/HTTP IPC 传输与重连 | 消失（三件套迁入桥作实现范式） | 断线重连语义进 §5.2 硬性要求 1 |
| L13 | polyfill：本地 fetch 拦截与响应合成 | 消失（Phase 1） | requestId 空无保护 = wait 悬空来源；§9 Phase 1 |
| L14 | 浏览器出站拦截三通道 | 消失（Phase 1，前提 L06 覆盖） | 与 L06 同源 75,323 行；§9 Phase 1 |
| L15 | runtime-compatibility 上报 + epoch 接管 | 消失（Phase 1，桥健康上报替代） | 3,066 次/小时自持环；§6 S11 |
| L16 | 隐藏页自愈 autorecover | 消失（Phase 3 与 L09 同批） | export-ID 6,415 / 生产 reload 0 次；§6 S10 |
| L17 | 首屏状态快照注入 | 消失 | 无官方 renderer 即无 atom 消费方；§6 S15 |
| L18 | 浏览器 UI 补丁簇 | 消失（Phase 1，按需重写） | 贴官方 DOM 猜 class/文案；§9 Phase 1 |
| L19 | ipcMain handler 注册表劫持 | 简化 | 桥仍需 handler 表，删多页并发语义；§6 S09 |
| L20 | InvokeEvent 伪造 + 注册槽单键 | 简化 | 伪造 event 永久保留，sender 唯一化后 L16 不必存在；§3.4 |
| L21 | webContents.send→WS 桥 + 路由/分块/去重 | 简化（Phase 4 塌缩 1:1） | response_routed 81,628 / send_to_missing 1,860；§9 Phase 4 |
| L22 | app-server spawn hook | 保留 → 简化（只定位不重定向） | 25 次 SIGTERM 全连坐；§3.1 / §9 Phase 2 |
| L23 | transport 装饰（stdio 多路复用） | 保留但显著瘦身 | 不变式=写权 + 内部隔离；§5.1 / §10 之 6 |
| L24 | 幂等读缓存 + query-cache 联动 | 功能保留、机制消失 | 白名单/失效集继承，删 mcp-response 伪装；§9 Phase 4 |
| L25 | query-cache-invalidate 双路失效 | 简化 → 并入 thread.list.invalidated | 5,164 次，唯一真推送；§5.2 |
| L26 | 网关 Web 壳鉴权与会话 | 简化（桥会话校验，重启不带走） | token 仅内存=重启即全员掉登录；无密码模式须禁；§6 S02 / §9 Phase 2 |
| L27 | 本地文件/对话框/工作区根伪造 | 简化（loopback 分流 + owner 回收） | dynamicRoots 只增不减不绑 clientId=间接扩权；§6 S12 |
| L28 | token 用量离线重放与嗅探 | 简化（桥同机读 JSONL 或直推） | wham/usage 被拦 24,945 次重试；§5.2 调用语义 |

## 附录 B：官方契约与生命周期常量速查（桥实现 checklist，均出自 e6 §1）

- 时序常量（e6 C10，src-CCXHtyvY.js:52482-52491）：initialize 握手超时 30s（EY=3e4）；初始 reconnectDelayMs 1s（SY）；wY=5e3；TY=2e3；DY=3e4；OY/kY=9e4；ephemeralThreadIds TTL 10min（xY=10*6e4）。IpcRouter：请求超时 Pme=5e3、重连节拍 Nme=1e3（e6 C7 :76820-76822）。
- IpcRouter 帧格式（e6 C7 :76476-76484）：4 字节 LE 长度前缀 + JSON；帧上限 256MiB、method 长度上限 1024、读缓冲 1e4。
- stdio 无重连（e6 C10 :45590-45592）：`supportsReconnect()` 仅 kind==="websocket"；`isStoppingConnection || isAppQuitting || disposed` 时直接 `Skipping reconnect after app-server close`（54560-54575）——桥的 socket 实现不得复刻 stdio 假设。
- 断连批量失败语义（e6 C10 :54975-54990）：failPendingClientRequests 清 requestScheduler / catalogRequests / clientRequestQueue / streamTracing / ephemeralThreadIds / fullFidelityEphemeralThreadIds / prewarmedThreads——桥的对应实现要在 client.stale 帧里可观测。
- daemon/websocket 模式 8 个启用条件全与（e6 C10 :45600-45625）：非 win32、无 config override、hostConfig.kind==="local"、`CODEX_APP_SERVER_USE_LOCAL_DAEMON==="1"`、`CODEX_APP_SERVER_FORCE_CLI!=="1"`、无 CODEX_CLI_PATH、hostConfig.codex_cli_command==null、EU(resourcesPath)==null，且 `codex app-server daemon version` 在 2500ms 内答对版本。桥的部署形态需明确落在这 8 条件的哪一侧。
- 官方 spawn env 基线（e6 C10 :45640-45680 / :45834）：args `[app-server, ...overrides.flatMap(a=>["-c",a]), --analytics-default-enabled]`，env LOG_FORMAT=json、RUST_LOG=warn、CODEX_INTERNAL_ORIGINATOR_OVERRIDE、CODEX_MCP_NODE_PATH、PATH 追加——桥拉起 app-server 时对齐，避免被官方后端流量指纹识破（e7 L05：401 Unauthorized 17 条全部落在 featured-plugin 预热，"伪装流量被官方后端识破"）。

（完）

---

## 实施评审结论与修订（v2，2026-10-06 协议实测后裁决）

> 状态更新：已裁决并完成实施评审（协议实测证据：/data/tmp/aq_analysis/bridge_probe/report.md，
> 含帧日志/脚本/服务端日志/全量 JSON Schema）。本节修订正文 §3/§4/§9 的四处假设，并关闭 §10 的 Q1/Q2/Q3。

### 实测修正（四条，均以隔离实例往返帧为证）

1. **§3.1 修订：unix socket 线上是 WebSocket，不是裸 NDJSON**。`--listen unix://PATH` 的线上协议
  为 HTTP Upgrade + RFC6455 帧；裸 NDJSON 被 httparse 拒绝。桥的官方通道实现按 WS 客户端写
  （参照实现 bridge_probe/scripts/wsclient.js）。initialize 的响应即就绪信号（无 type:ready 帧）；
  未 initialize 前一切方法回 -32600。ws:// 模式自带 /readyz /healthz；非 loopback 绑定强制 --ws-auth。
2. **§3.3/§3.4 修订：IpcRouter 与 thread-follower-* 都是 Desktop-main 的能力，不是 app-server 的**。
  独立 app-server 不创建 ipc.sock；服务端方法表约 190 项无任何 follower 方法。桥替代 main 后必须
  **自建 IpcRouter 等价总线并自实现 follower 语义**（把浏览器的 follow/steer/intent 翻译成
  turn/interrupt、turn/steer 等真实方法）。§3.4"官方 thread-follower-* 命令族"表述作废。
3. **§3.1 补充：app-server proxy 子命令整体绕开**。实测它是裸字节 stdio 中继，与 WS 化的 control
  socket 协议失配（两种 socket 下均 Broken pipe）。多客户端统一走"同 socket 多 WS 连接"——
  实测同一 unix socket 双连接各自 initialize 成功，thread/started 广播到所有已初始化连接。
4. **§4-C1 强化：慢消费者的失败模式是静默丢帧**。700 条广播压力下送达仅 77 条，服务端
  181 条 "dropping message for disconnected connection"，无断线无报错。桥的转发路径必须：
  逐连接出站队列水位监控 + 丢帧计数告警 + 队列满主动断开慢连接（宁可断可观测，不可静默丢）。
  另修正 C3：**thread/subscribe 不存在**（只有 unsubscribe；通知为广播制），细粒度路由以
  unsubscribe/optOut 表达，per-thread 通知语义留待有登录态环境复核。

### 已关闭的开放问题（§10 Q1/Q2/Q3）

| 问题 | 决策 |
|---|---|
| Q1 桥崩溃降级形态 | 桥=独立 systemd 服务（Restart=always + StartLimitBurst 退避）；/api/health 暴露 bridge_status(ok/down/recovering)；桥 down 时浏览器保留只读（列表/历史走网关侧数据），新 turn 进入 30s 有限排队，超时明确报错；**禁止回落旧隐藏 renderer 链路**（防双客户端互踩）。恢复路径=重连+重新 initialize+重放订阅，列为 Phase 2 验收项 |
| Q2 官方入口真机验证 | 已完成（本节四条修正即产物）；26.908 已具备桥所需全部能力（--listen unix/ws、多连接广播、daemon 族），**Phase 1-2 无需先升 26.930** |
| Q3 smart-router 归属 | **独立合法第二连接**（同 socket、clientType=opencodex-router、完整 initialize 能力协商，实测可行）。L23 寄生层（opencodex.router: 前缀、tombstone、-32001、字节帧分类 clientFramesConflict）整体退役。router ephemeral 线程即用即删，与单 live attachment 约束无冲突 |

### 部署与鉴权补充决策

- D1 桥与网关进程解耦为两个 systemd 单元；网关重启不再牵动桥与 app-server（对 25 次 SIGTERM
  连坐事故的结构性收口）。
- D2 鉴权双层：浏览器 token（web 壳会话）与官方凭据（CODEX_HOME）彻底分离；桥只接受网关
  转发的已鉴权连接，自身不面向公网。
- D3 Phase 顺序修订：原 Phase 0（锁 26.930+符号锚定）**后移**——桥在当前 26.908 上落地
  （Phase 1 拔浏览器模拟层 → Phase 2 socket 化+桥进程），符号锚定与 26.930 升级合并为桥稳定
  后的独立阶段（overlay patch 在桥化后有整层退役，锚定面本身会缩小）。

### 仍开放（进入 Phase 1 前需补）


- D2 补充（用户裁决 2026-10-06 下午）：**不采用官方 gatewayOAuth/userVerification**——本系统始终免 OAuth，
  对外认证用 API key，由配套 codex-proxy 项目承担接入与转发；桥与网关的鉴权面保持现状分层
  （web 壳会话 token + API key），不随 26.930 的鉴权族扩张演进。
1. per-thread 通知路由与 optOutNotificationMethods 的真实语义（需带登录态环境复核，probe 隔离
   实例无凭据未能覆盖）。
2. 桥自建 IpcRouter 总线的最小面（官方 bundle 依赖的 client-discovery/client-status-changed 等
   信封是否必须在 Phase 2 提供，可由 L19 handler 表清点推导）。
3. daemon 模式取舍：托管路径 symlink（packages/standalone/current）与直起 --listen 的运维差异，
   建议桥先用直起 + systemd 管理，daemon 族留作升级路径。
