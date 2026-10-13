---
name: hf-download
description: 下载 HuggingFace / ModelScope 资产(单文件、目录快照、模型权重)并对限流做指数退避。需要在本地拉取模型、数据集或缓存时使用。优先 ModelScope，缺失时回退到 HuggingFace。
allowed-tools: Bash, Read
metadata:
  source: mcpmarket-my-toolkit / hf-download (v1.0.0)
  upstream-author: Richard Fremmerlid
---

# HuggingFace / ModelScope 下载原语

## 状态
Active — 安装于本地 Codex 桌面(~/.codex/skills/hf-download)。

## 适用场景
- 拉取模型权重(含 GGUF、safetensors)。
- 拉取数据集文件或快照。
- 拉取任意 HF / ModelScope repo 文件夹快照。

## 依赖
- Python >= 3.8(仅标准库 + huggingface_hub)。
- 可选:hf_transfer(高速并发下载)、modelscope(国内镜像回退)。
- 环境变量:HUGGING_FACE_TOKEN、HUGGING_FACE_USERNAME(HF); ModelScope 端可选 MODELSCOPE_CACHE / MODELSCOPE_TOKEN。

## 下载源优先级(与全局 AGENTS.md 一致)
1. **ModelScope**(https://www.modelscope.cn)— 默认首选,国内可达、稳定。
2. hf-mirror.com作为huggingface.co的加速镜像,作为次优选
3. **HuggingFace**(huggingface.co)— 在 ModelScope 找不到同名 repo / 文件时回退。
4. HF 下载慢时优先 hf_transfer;单文件小集合走 hf_download 多并发。
5. 大文件速度太慢使用 aria2c 至少5并发下载，注意下载之后改名（有可能到90% 以上时速度限流，可以重启aria2c下载，加速完成）

## 可用操作

| 函数 | 描述 |
|---|---|
| download_file() | 拉取单个文件 |
| download_folder() | 拉取文件夹快照(按 glob 过滤) |

## 用法(Python 库)

```python
import asyncio
from pathlib import Path
from scripts.hf_download import download_file, download_folder

p = asyncio.run(download_file(
    filename="config.json",
    local_dir=Path("/data/models/unsloth/gemma-4-12b-it-GGUF"),
))

p = asyncio.run(download_folder(
    local_dir=Path("/data/models/unsloth/gemma-4-12b-it-GGUF"),
    repo_id="unsloth/gemma-4-12b-it-GGUF",
    repo_type="model",
    allow_patterns=["*UD-Q4_K_XL.gguf"],
))
```

## 用法(CLI)

```bash
python scripts/hf_download.py --filename data/soul_traces.jsonl --local-dir ./local_data

python scripts/hf_download.py \
    --repo-id unsloth/gemma-4-12b-it-GGUF \
    --repo-type model \
    --allow-patterns "*UD-Q4_K_XL.gguf" \
    --local-dir /data/models/unsloth/gemma-4-12b-it-GGUF \
    --prefer modelscope
```

## 凭证解析

```python
from scripts.hf_config import HFConfig, ModelScopeConfig
cfg = HFConfig.from_env()
ms = ModelScopeConfig.from_env()
```

## 错误处理

- 默认 5 次指数退避(2^attempt 秒)覆盖 429/网络错误。
- 401/403:调用方应使用 hf_config.resolve_token() 验证 scope。
- 404:日志记录精确 repo ID 与 file 路径,停止并提示核对。
- 本地写权限错误:抛出原始 OSError,不重试。

详见 references/ACCEPTANCE.md 与 references/FALLBACK.md。

## 已知约束

- 该 skill 的 Depends on: hf-init 在 mcpmarket 父工具包中—在本地 Codex 中未启用。HF 凭证可直接通过环境变量注入;ModelScope 凭证可选。
- 默认下载目录遵循全局 AGENTS.md:/data/models/(非软链),跨机共享放 /nas2/models/。
