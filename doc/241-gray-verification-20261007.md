# 241 灰度全面验证记录（2026-10-07）

背景：10-06 晚部署 wdev_2026.10.06.161245 + phase1；10-07 凌晨排查"request timed out"（根因=K1 迁移抹掉 openai_base_url + ensure-codex-home.py MARKER bug 每次重启重复删键 + 241 出站官方端点死路；修复见 fix_241）。修复后由 8 个子智能体（Q38-Flash-Next）并发完成全面验证，全部证据在 /data/tmp/aq_analysis/ 对应目录。

## 结论：全部通过

| 测试面 | 结果 | 要点 |
|---|---|---|
| 配置（t7_config） | 7/7 PASS | 注入块与 235 同构；MARKER 修复经受 02:08 K1 真实重启实战检验；5 分钟 ocx timer 同受保护；30 分钟错误水位 0 |
| UI 灰度（t8_ui） | A1-A3/S1-S4/移动/登出 全 PASS | 上报休眠、L18 消失、L13 门控（sentry-ipc 热修零 CSP）、聊天/列表/内容三实时（零刷新硬判据）、L14 拦截保留（audit 82+47 次）、移动 UA 可用 |
| 子智能体（t9_subagent） | PASS | 两轮×2 真并发（rollout 91ms 差）、结果独立复跑逐字吻合、状态与汇总免刷新自动流转（原始投诉未复现）、零超时、usage +25 全 Q38 |
| 主对话（t10_main） | 5/5 轮 PASS | 写/读/追加/上下文/工具调用全对；磁盘终态 md5 吻合；流式渲染逐步；token 徽标与账本对账；零超时零断连 |
| 根因佐证（t1/t3/t4） | 收敛 | diff 定位分叉、隔离实例复现错误链（1.4-2.0s 修复对照）、抓包证实修复前唯一出站=被污染公网 IP、修复后唯一=10101 |

## 跟进清单
1. thread-content-invalidation 的 onLog 接线（下个构建，纯诊断增强，浏览器级行为已证明）
2. reload 后虚拟列表 token 徽标懒渲染（前端小问题）
3. 子智能体派生瞬间上游 502×2（透明重试成功，观察）
4. K1 迁移重启准入（每次重启连坐在两会话，建议活跃 turn=0 才动）
5. /home/aigc/w241/gateway.log 陈旧文件清理
6. S5 幂等缓存分布判定并入 24h 观察表

报告索引：t1_diff / t3_appsrv / t4_gwpath / fix_241 / t6_browser / t7_config / t8_ui / t9_subagent / t10_main（均在 /data/tmp/aq_analysis/ 下同名目录）。
