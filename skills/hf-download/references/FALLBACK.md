# Procedural Fallback Tree: hf-download

> 来自 mcpmarket-my-toolkit (v1.0.0) 的回退树。本地实现见 `scripts/hf_download.py`。

## 1. 凭证缺失或无效 (401/403)
- **现象**:HF API 返回 401 / 403。
- **动作**:调用 `HFConfig.from_env()` 校验 token;缺失则提示 `export HUGGING_FACE_TOKEN=hf_xxx`;无效则提示检查 token scope 是否有 read 权限。本地 Codex 无 `hf-init` skill,使用 `hf_config.resolve_token("hf")` 自助校验。

## 2. 资源/仓库不存在 (404)
- **现象**:`EntryNotFoundError` / `RepositoryNotFoundError`。
- **动作**:日志输出精确 repo ID + file path,停止下载。建议调用方:核对 repo 拼写、确认是否私有仓库、在 ModelScope 搜索同名 repo。

## 3. 本地写权限拒绝
- **现象**:`PermissionError` 或 `OSError(EACCES)`。
- **动作**:抛出原始异常,**不再发起 API 查询**。建议调用方:检查目录所属用户(`stat /data/models/<repo>`)或切换到有写权限的工作目录。

## 4. 限流 (429)
- **现象**:HTTP 429 / 5xx。
- **动作**:指数退避循环,默认 5 次,等待 `2^attempt + jitter` 秒。耗尽后报告 timeout/limit,建议调用方稍后重试。

## 5. ModelScope 与 HuggingFace 双源回退
- **现象**:ModelScope `snapshot_download` 抛 `EntryNotFoundError` 或网络错误。
- **动作**:在同一调用内回退 HuggingFace(若 `--prefer auto`)或仅 HF(若 `--prefer huggingface`)。日志会明确记录每个源的成功/失败。
