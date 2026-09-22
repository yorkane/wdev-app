# 两个线上问题：空闲后再对话报 `no such export ID`、Kiki 移动端 Markdown 渲染失败

> 2026-09-22　适用：codex-desktop（官方包重打包 + 内置 OpenCodex 网关），241.t 生产

## 一、`no such export ID: 1`（空闲 session 恢复时出现，只能刷新页面）

### 现象与取证

241.t 的 `/var/log/codex-desktop/gateway.log` 里该错误累计出现 **3350 次**，形态高度一致：

```
[electron-message-handler] sa_server_request_failed error={"message":"no such export ID: 1",
  "stack":"... at me.ensureResolvingExport (…/assets/usingCtx-….js)"}
  method=get rendererWebContentsId=1 rendererWindowVisible=false
  routePattern=/wham/tasks/list url=/wham/tasks/list?limit=20&task_filter=current
```

即**隐藏渲染页**（网关托管官方页面的那个 webContents）的 RPC 会话丢了 export，此后它的周期轮询一直失败；
日志里还伴随页面侧桥接的 `Gateway WebSocket disconnected`。重复出现但暂停使用后不再刷。

### 机制（已逐行确认）

1. 官方 main 每收到一次 `codex_desktop:connect-app-host`（浏览器页建 MessagePort 时触发）就 **new 一个全新 RPC session**，
   与 MessagePort 终身绑定，且对旧 session 零清理。
2. 页面侧 session **只在页面加载时建一次**，首帧把 view-service 根表 push 给 main → 在 main 侧落位 **export id 1**；
   WS 重连后**不会 re-export**。
3. 网关原先在 WS 断开时（`ws-hub.removeClient` → `closeAppHostRelays(…,"client_disconnected")`）
   给官方端 `postMessage(null)` 并释放端口 → 官方端把那个 session abort 掉。
4. 页面按设计**保留同一个 MessagePort**，重连后重发 `app-host-connect`（同 portId）；网关若新建 relay+新官方端口，
   官方 main 便建**全新 session（export 表为空）**，而页面手里仍是**旧 session 的 port（表里有 id 1）** → 错位 → `no such export ID: 1`。
5. **为什么刷新能修好隐藏页**：网关把所有浏览器页的 connect 都挂在同一个隐藏 webContents 上，官方 main 按 `webContents.id`(1) 键控 view；
   错位的会话被注册成该 view，隐藏渲染页的轮询也归属它 → 一起坏。刷新浏览器页重建握手后两端对齐，隐藏页随之恢复。

### 修复

**网关侧（主修）**：WS 临时断开时**不再销毁** app-host 会话，而是把 relay **孤儿化**（不发 null、不关官方端口），
按 `clientId+portId` 保留；页面重连时**重新挂接同一条 relay / 同一个 MessagePortMain** → 官方 session 从未更换，
页面的 export 表始终有效。配回收定时器（默认 5 分钟，`OPENCODEX_APP_HOST_ORPHAN_TTL_MS`）与全局上限：页面真的不回来了才按旧语义释放。
断线窗口内官方→浏览器的帧会被缓冲并在重挂后按 FIFO 冲刷，避免 RPC 丢帧/乱序。

**客户端侧（辅修）**：`codex-bridge-polyfill.js` 的 `scheduleReconnect()` 原本在 `document.visibilityState === "hidden"` 时**无限期推迟重连**，
而隐藏渲染页恒为 hidden → WS 一掉就永不重连。给它加**有上限的推迟**（隐藏态最多 N 秒仍强制重连一次）。

**可观测性**：新增 `app_host_orphaned` / `app_host_reattached` / `app_host_orphan_recycled` 等生命周期日志（同端口限流），
自愈成功会留下 `app_host_reattached` 记录，便于日后统计「自愈了多少次」。

### 判据

```bash
# 修复前：断开重连后会出现 no such export ID；修复后应看到 reattached 且不再报错
grep -a "app_host_orphaned\|app_host_reattached\|app_host_orphan_recycled" /var/log/codex-desktop/gateway.log | tail
grep -ac "no such export ID" /var/log/codex-desktop/gateway.log   # 应停止增长
```

## 二、Kiki 移动端浏览器 Markdown 渲染失败（Chrome 正常）

### 判断

这套页面是**官方的 web 资源在浏览器里跑**，网关只额外注入自己的 provider 脚本。所以「同一份页面、
只有 Kiki 出错」只能来自**内核差异**：官方 bundle 或注入脚本用到了 Kiki 内核缺失的运行期 API，
或注入脚本里有该内核不支持的语法。

扫描结论（命中风险清单）：

| 命中 | 位置 | 需要内核 | 影响 |
|---|---|---|---|
| **`toSorted` / `findLast`** | 官方 app-initial 的**消息分段 → 终端段**取值路径 | C110 / C97 | **最可能**：正好在 markdown 增量渲染链路上，每次流式更新抛错 → 「部分结果渲染中断」 |
| **`URL.parse`** ×3 | 官方 app-primary / app-initial 的图片 URL 校验 | C123 | 次可能：消息含图片时该路径抛错 |
| `structuredClone` ×8 / `Intl.Segmenter` ×2 | 官方 | C98 / C85 | 点状失败 |
| `replaceAll`（注入脚本） | `codex-smart-scheduling-injection-health.js` | C85 | 已改写为 `split/join` |

注入 providers 里的 `?.` / `??` 属 ES2020（Chromium 80+），`esbuild --target=es2019` 校验也能过，**不是**解析风险。

### 加固

1. **新增 `web-shell/internal/providers/codex-js-error-capture.js`**（纯 ES2019 语法）：
   - 全局错误捕获（`error` + `unhandledrejection` + script 加载失败），带 `message/source/line/col/UA/platform/设备信息/脱敏 href`，
     markdown 相关错误打 `tag:"markdown"`；客户端批量限流。
   - 14 项能力探测，每页上报一次 `js-capability`（缺哪些、补了哪些）。
   - 最小 polyfill（幂等、只补缺失、可关）：`toSorted` / `findLast` / `findLastIndex` / `URL.parse` / `at` / `replaceAll` /
     `Object.hasOwn` / `structuredClone` / `requestIdleCallback` / `queueMicrotask` / `AbortSignal.timeout`。
2. **服务端默认落盘 JS 错误**（与吵杂的调试开关解耦）：`js-*` 事件走 `client-js-error` 落 `/var/log/codex-desktop/gateway.log`，
   网关侧同样限流（同签名 + 单客户端窗口上限），避免被刷爆。

### 判据 / 下一步

```bash
grep -a "client-js-error\|js-capability" /var/log/codex-desktop/gateway.log | tail
```

**仍需真机确认**：Kiki 的确切内核/UA 只能从真实复现里拿。请下次在 Kiki 上复现任意一次报错，
我们从上面这条日志取 `UA + message + line` 即可定案（若命中的是消息分段路径，本次 polyfill 已直接修好渲染）。

## 附：为什么这两件事都要「默认可见、不靠调试开关」

两个问题都发生在**用户侧、难以复现**的场景（空闲恢复 / 特定手机浏览器）。若诊断信息默认关闭，
事后只能靠猜。因此：会话自愈留 `app_host_reattached` 生命周期日志，浏览器 JS 错误默认落盘并附 UA，
都是为了让下次复现能直接定位，而不是再让用户「刷新试试」。
