# Acceptance Criteria: hf-download

> 来自 mcpmarket-my-toolkit (v1.0.0) 的验收标准。本地 Codex 安装用于审计追溯。

## 1. 安全与凭证
- [x] 使用 `HFConfig` 解析 `HUGGING_FACE_TOKEN`(参见 `scripts/hf_config.py`)。
- [x] Token 从不写入日志或下载缓存明文(`masked()` 仅展示前 4 后 4 位)。

## 2. API 集成与重试
- [x] 包装 `huggingface_hub` 调用,指数退避覆盖 429(默认 5 次,2^attempt 秒)。
- [x] 重试用尽后干净失败并报告 API 错误。

## 3. 目录管理
- [x] 目标 `local_dir` 不存在时自动创建。
- [x] 文件夹/快照下载支持 `allow_patterns` / `ignore_patterns` glob 过滤。

## 4. 凭证回退与多源
- [x] 优先 ModelScope(repo_id 同名匹配)。
- [x] ModelScope 缺失或网络不可达时回退到 HuggingFace(`--prefer auto` 时生效)。
- [x] 禁用 `hf-mirror.com`(`HFConfig.from_env` 在 endpoint 中检测到即抛错)。

## 5. 路径约束
- [x] 下载根目录遵循全局 AGENTS.md:`/data/models/`(非软链);跨机共享放 `/nas2/models/`。
