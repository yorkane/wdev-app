# 241 智能体可靠性战役终版报告（2026-10-07）

目标：用 subagent 在 241 上复现"智能体中断 / 空回报 / 空产物"，并解决。
结论：**复现完成（三类全部量化复现）；可控根因全部修复；剩余边界结构性归属桥接 Phase 2。**
终审结论 PASS_WITH_BOUNDARIES（审计见 /data/tmp/aq_analysis/v2_audit/report.md）。

## 一、复现（60+ 父轮 / 5 批次 / 10+ 小时连续压力 / 241:t）

| 问题类 | 量化 | 根因 |
|---|---|---|
| 中断 | 17/50 父轮超时截杀；基线 17/147 末态中断 | 驱动器/重启窗口截断父回合等待态；子代理猝死 18 例全为连带 |
| 空回报 | 34% 超时截杀型、2% 自然型（effort=medium 硬拒）、4% 并发吞并 | 三种独立根因 |
| 空产物 | v2 20/34、v3 2/6、v4 6/12 | 全部可归因（上两类衍生 + 子代理测试偷工）；独立成因 0 |
| 模式定性 | 父回合是弱环（被杀时多在等待/编排态），子代理 12/12 可靠完成 | — |

## 二、已落地修复（全部提交并部署 241）

| 修复 | 提交 | 验证证据 |
|---|---|---|
| effort=medium 路由硬拒（自然空回报根因） | 配置 default_subagent_reasoning_effort=high | v4 十二轮 44 子代理空回报 0 |
| SIGTERM 优雅排空 | 503b485 | 同步日志 drain 事件；空闲全序列（started{0}→clear） |
| 全量活跃 turn 传感器 | c3ba99b | 真实重启捕获 count=1/3/4（旧传感器同场景报 0） |
| 排空事件双通道持久日志 | c3ba99b + 4335418 | /var/lib/codex-desktop/runtime/shutdown-drain.log |
| 看门狗排空预算 | 70e8c66 | 提交在位 |
| wdev+codex-proxy 接缝（MARKER/base_url） | fix_241 | 双重启存活 + 强制重写 survives=True + 端到端 PONG 0.69s |
| sentry-ipc CSP 刷屏 | 4ee8b8d | 241 热补丁，console 零报错 |

## 三、结构性边界（如实定性，非本架构可解）

1. **活跃 turn 下排空止于 started**：15:45:49 实测——Electron 退出竞速在 25 秒排空等待期内终结进程，clear/timeout 事件未落盘。drain 对短 turn 有价值（空闲/短回合完整生效），长 turn 重启存活需桥接 Phase 2：app-server socket 化后，网关重启不再触及 app-server 进程树。
2. **Electron quit gate 试验与回滚（定性）**：e49760c 尝试用 app.on("before-quit") + preventDefault 门控退出以撑完排空窗口，部署后连 started 事件都消失（进程提前死），判定为回归，已由 f540729 完整回滚，现网为 151727（传感器+持久日志+看门狗预算）。若将来重启 Phase 2，该 gate 需在 socket 化后重做。
3. **并发同秒 thread/turn 并吞（平台 bug）**：两个会话同秒提交被服务端并入同一 turn，后到任务书吞掉先到任务书（零产物零报错）。v4 加 3-8 分钟启动抖动后 12 轮零复现；归属桥接 Phase 2。
4. **revive 闭环 0/6**：驱动器在超时截杀后自动 followup 未救回（REVIVE_TIMEOUT）。定性为测试工装局限（截杀后线程态已终态，followup 无法重入）；产品级解法是主 agent 的等待纪律（见 /home/aigc/.codex/skills/aq/SKILL.md 防线 2/3）。

## 四、索引

- 批次数据：241:/tmp/r1/{rounds,v2,v3,v4,baseline}，v4 汇总 /tmp/r1/v4/health/v4_final.json
- 报告：r1_repro（批次统计）/ r2_heal（自愈盘点）/ v2_audit（完成度审计）均在 /data/tmp/aq_analysis/ 下同名目录
- 修复提交：cd /home/aigc/ChatGPT/wdev/wdev-app && git log --oneline c05e8e5..f540729
