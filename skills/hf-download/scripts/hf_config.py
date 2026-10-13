#!/usr/bin/env python3
"""HF / ModelScope 凭证解析。

设计目标:
- 仅使用标准库 + huggingface_hub(用于本地调用)。
- Token 永远不写入日志或下载缓存的明文。
- HF 默认从 HUGGING_FACE_TOKEN 读取。
- ModelScope 默认从 MODELSCOPE_TOKEN 读取(可选)。
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Optional

_TOKEN_PATTERNS = (
    re.compile(r"^hf_[A-Za-z0-9]{20,}$"),        # 标准 HF 格式
    re.compile(r"^[A-Za-z0-9_\-]{20,}$"),          # 自定义 token 兼容
)

# ModelScope SDK 使用 ``MODELSCOPE_API_TOKEN`` 或环境变量 ``MODELSCOPE_TOKEN``
# 这里兼容两种写法。


@dataclass
class HFConfig:
    """HuggingFace 凭证配置。"""
    token: Optional[str] = None
    username: Optional[str] = None
    endpoint: str = "https://huggingface.co"

    @classmethod
    def from_env(cls) -> "HFConfig":
        token = (
            os.environ.get("HUGGING_FACE_TOKEN")
            or os.environ.get("HUGGINGFACE_HUB_TOKEN")
            or os.environ.get("HF_TOKEN")
        )
        username = os.environ.get("HUGGING_FACE_USERNAME") or os.environ.get("HF_USERNAME")
        endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co")
        # 全局 AGENTS.md: 禁用 hf-mirror
        if "hf-mirror.com" in endpoint:
            raise ValueError(
                "HF_ENDPOINT 包含 hf-mirror.com,与全局 AGENTS.md 规则冲突,请改用默认 endpoint 或 ModelScope。"
            )
        return cls(token=token, username=username, endpoint=endpoint)

    def masked(self) -> str:
        """返回脱敏后的 token 表示,用于日志。"""
        if not self.token:
            return "<no-token>"
        if len(self.token) <= 8:
            return "***"
        return f"{self.token[:4]}...{self.token[-4:]}"

    def is_valid(self) -> bool:
        return bool(self.token) and any(p.match(self.token) for p in _TOKEN_PATTERNS)


@dataclass
class ModelScopeConfig:
    """ModelScope 凭证配置(可选)。"""
    token: Optional[str] = None
    cache_dir: Optional[str] = None
    endpoint: str = "https://www.modelscope.cn"

    @classmethod
    def from_env(cls) -> "ModelScopeConfig":
        token = (
            os.environ.get("MODELSCOPE_TOKEN")
            or os.environ.get("MODELSCOPE_API_TOKEN")
        )
        cache_dir = os.environ.get("MODELSCOPE_CACHE")
        endpoint = os.environ.get("MODELSCOPE_ENDPOINT", "https://www.modelscope.cn")
        return cls(token=token, cache_dir=cache_dir, endpoint=endpoint)

    def masked(self) -> str:
        if not self.token:
            return "<no-token>"
        if len(self.token) <= 8:
            return "***"
        return f"{self.token[:4]}...{self.token[-4:]}"


def resolve_token(name: str) -> str:
    """根据 ``name`` 返回对应 token,缺失时抛出 ``EnvironmentError``。"""
    n = name.lower()
    if n in ("hf", "huggingface"):
        cfg = HFConfig.from_env()
        if not cfg.token:
            raise EnvironmentError(
                "未检测到 HUGGING_FACE_TOKEN。请设置环境变量或在 ~/.cache/huggingface/stored_tokens 中登录。"
            )
        if not cfg.is_valid():
            raise EnvironmentError("HUGGING_FACE_TOKEN 格式无效(scope/权限可能不匹配)。")
        return cfg.token
    if n in ("ms", "modelscope"):
        cfg = ModelScopeConfig.from_env()
        if not cfg.token:
            raise EnvironmentError("未检测到 MODELSCOPE_TOKEN(可选;ModelScope 大多数公开模型无需 token)。")
        return cfg.token
    raise ValueError(f"未知凭证源: {name}")


__all__ = ["HFConfig", "ModelScopeConfig", "resolve_token"]
