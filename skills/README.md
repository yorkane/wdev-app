# skills/ —— 随部署分发的 skill 白名单

本目录是**分发白名单**：收录其中的 skill 会随部署分发到目标机的 `$CODEX_HOME/skills/`，
供该机上的 codex-desktop 网关会话使用。当前白名单只有两个：

| 目录 | skill 名 | 用途 |
|---|---|---|
| `aq-orchestrator/` | aq-orchestrator | 主模型担任规划者与整合者，派生 subagent 做探索/实现/测试/研究的编排技能 |
| `hf-download/` | hf-download | 下载 HuggingFace / ModelScope 资产并对限流做指数退避 |

## 白名单规则

- **只收录上表两个 skill。**新增 skill 需明确评审后加入本目录。
- **机器本地运维 skill 一律不入库**：如 `docker-acr`（镜像中转）等依赖特定机群环境的
  skill，只保留在单机 `$CODEX_HOME/skills/` 下，不进入仓库、不随部署分发。

## 安装到目标机

从仓库根目录执行（`$CODEX_HOME` 取目标机 `/etc/codex-desktop/gateway.env` 里的值）：

```bash
CODEX_HOME=$(sudo sed -n "s/^CODEX_HOME=//p" /etc/codex-desktop/gateway.env | tail -1)
cp -a skills/aq-orchestrator "$CODEX_HOME/skills/"
cp -a skills/hf-download    "$CODEX_HOME/skills/"
```

单个 skill 的通用形式：

```bash
cp -a skills/<name> "$CODEX_HOME/skills/"
```

## 生效方式

复制完成后**新开一个会话即可生效，无需重启网关**。
枚举目录固定为 `$CODEX_HOME/skills/`，目录内每个子目录一个 skill（含 `SKILL.md`）。
