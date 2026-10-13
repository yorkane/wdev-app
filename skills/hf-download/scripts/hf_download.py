#!/usr/bin/env python3
"""hf_download: HF / ModelScope 下载原语。

设计:
- ``download_file`` 与 ``download_folder`` 为 ``async`` 接口,内部在线程池中调用同步 API。
- 默认优先 ModelScope(repo_id 同名匹配),缺失时回退 HuggingFace。
- 指数退避 5 次,2^attempt 秒覆盖 429 / 网络错误。
- 401/403 / 404 / OSError 不重试,直接抛出。
- 凭证不写入日志,只通过 ``HFConfig.masked()`` 暴露前 4 后 4 位。

CLI 示例:
    python hf_download.py --repo-id unsloth/gemma-4-12b-it-GGUF \
        --repo-type model --allow-patterns "*UD-Q4_K_XL.gguf" \
        --local-dir /data/models/unsloth/gemma-4-12b-it-GGUF --prefer modelscope
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import random
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence

try:
    from huggingface_hub import hf_hub_download, snapshot_download
    from huggingface_hub.errors import (
        EntryNotFoundError,
        GatedRepoError,
        RepositoryNotFoundError,
        RevisionNotFoundError,
    )
except ImportError:  # pragma: no cover - 依赖未安装时延迟报错
    hf_hub_download = None  # type: ignore
    snapshot_download = None  # type: ignore
    EntryNotFoundError = RepositoryNotFoundError = GatedRepoError = RevisionNotFoundError = Exception  # type: ignore

# 让 ``scripts/`` 可作为脚本独立运行,无需 package marker
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
from hf_config import HFConfig, ModelScopeConfig  # noqa: E402

log = logging.getLogger("hf_download")

MAX_ATTEMPTS = 5
BACKOFF_BASE = 2  # 2^attempt 秒
RETRYABLE_HTTP = {429, 500, 502, 503, 504}


@dataclass
class DownloadResult:
    path: Path
    source: str  # "modelscope" / "huggingface"


def _backoff_sleep(attempt: int) -> float:
    """指数退避 + 抖动。"""
    base = BACKOFF_BASE ** attempt
    return base + random.uniform(0, 1)


# ---------------------------------------------------------------------------
# ModelScope 后端
# ---------------------------------------------------------------------------


def _ms_available() -> bool:
    try:
        import modelscope  # noqa: F401
        return True
    except ImportError:
        return False


def _ms_download_file(repo_id: str, filename: str, repo_type: str, local_dir: Path) -> Path:
    from modelscope import snapshot_download
    local_dir.mkdir(parents=True, exist_ok=True)
    cache = snapshot_download(
        repo_id=repo_id,
        repo_type=repo_type,
        allow_patterns=[filename],
        cache_dir=str(local_dir),
    )
    p = Path(cache) / filename
    # snapshot_download 会把文件放在 cache 子目录,需要按需软链到 local_dir
    target = local_dir / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        try:
            target.symlink_to(p)
        except OSError:
            import shutil
            shutil.copy2(p, target)
    return target


def _ms_download_folder(
    repo_id: str,
    repo_type: str,
    local_dir: Path,
    allow_patterns: Optional[Sequence[str]],
    ignore_patterns: Optional[Sequence[str]],
) -> Path:
    from modelscope import snapshot_download
    local_dir.mkdir(parents=True, exist_ok=True)
    cache = snapshot_download(
        repo_id=repo_id,
        repo_type=repo_type,
        allow_patterns=list(allow_patterns) if allow_patterns else None,
        ignore_patterns=list(ignore_patterns) if ignore_patterns else None,
        cache_dir=str(local_dir),
    )
    # 把快照里的文件硬链/复制到 local_dir(避免软链,符合 AGENTS.md)
    cache_path = Path(cache)
    for f in cache_path.rglob("*"):
        if f.is_file():
            rel = f.relative_to(cache_path)
            target = local_dir / rel
            if target.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            import shutil
            try:
                target.hardlink_to(f)
            except OSError:
                shutil.copy2(f, target)
    return local_dir


# ---------------------------------------------------------------------------
# HuggingFace 后端
# ---------------------------------------------------------------------------


def _hf_download_file(
    repo_id: str, filename: str, repo_type: str, local_dir: Path, cfg: HFConfig
) -> Path:
    if hf_hub_download is None:
        raise RuntimeError("huggingface_hub 未安装。请执行 pip install huggingface_hub。")
    local_dir.mkdir(parents=True, exist_ok=True)
    path = hf_hub_download(
        repo_id=repo_id,
        filename=filename,
        repo_type=repo_type,
        local_dir=str(local_dir),
        token=cfg.token,
    )
    return Path(path)


def _hf_download_folder(
    repo_id: str,
    repo_type: str,
    local_dir: Path,
    allow_patterns: Optional[Sequence[str]],
    ignore_patterns: Optional[Sequence[str]],
    cfg: HFConfig,
) -> Path:
    if snapshot_download is None:
        raise RuntimeError("huggingface_hub 未安装。请执行 pip install huggingface_hub。")
    local_dir.mkdir(parents=True, exist_ok=True)
    path = snapshot_download(
        repo_id=repo_id,
        repo_type=repo_type,
        local_dir=str(local_dir),
        allow_patterns=list(allow_patterns) if allow_patterns else None,
        ignore_patterns=list(ignore_patterns) if ignore_patterns else None,
        token=cfg.token,
    )
    return Path(path)


# ---------------------------------------------------------------------------
# 重试包装
# ---------------------------------------------------------------------------


def _with_retries(fn, *args, **kwargs):
    last_exc: Optional[BaseException] = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return fn(*args, **kwargs)
        except (EntryNotFoundError, RepositoryNotFoundError, RevisionNotFoundError) as e:
            # 404 不重试,直接抛出
            log.error("资源不存在: %s", e)
            raise
        except GatedRepoError as e:
            log.error("仓库被 gating,请检查 token scope: %s", e)
            raise
        except PermissionError as e:
            log.error("本地写权限错误: %s", e)
            raise
        except Exception as e:  # 包括 429 / 网络错误
            last_exc = e
            # 尝试抽取 http code
            code = getattr(e, "response", None) and getattr(e.response, "status_code", None)
            if code and int(code) not in RETRYABLE_HTTP:
                raise
            if attempt >= MAX_ATTEMPTS:
                log.error("达到最大重试次数(%d),放弃", MAX_ATTEMPTS)
                raise
            sleep_s = _backoff_sleep(attempt)
            log.warning(
                "第 %d/%d 次尝试失败: %s;%.1fs 后重试",
                attempt, MAX_ATTEMPTS, e, sleep_s,
            )
            time.sleep(sleep_s)
    if last_exc:
        raise last_exc


# ---------------------------------------------------------------------------
# 公共 API
# ---------------------------------------------------------------------------


async def download_file(
    *,
    filename: str,
    local_dir: Path,
    repo_id: Optional[str] = None,
    repo_type: str = "model",
    prefer: str = "modelscope",
) -> DownloadResult:
    """下载单文件。``prefer`` 接受 "modelscope" / "huggingface" / "auto"。"""
    if repo_id is None:
        raise ValueError("download_file 需要 repo_id。")

    async def _do(source: str) -> Path:
        loop = asyncio.get_running_loop()
        if source == "modelscope":
            if not _ms_available():
                raise RuntimeError("modelscope 未安装,pip install modelscope")
            return await loop.run_in_executor(
                None, _with_retries, _ms_download_file, repo_id, filename, repo_type, local_dir
            )
        cfg = HFConfig.from_env()
        return await loop.run_in_executor(
            None, _with_retries, _hf_download_file, repo_id, filename, repo_type, local_dir, cfg
        )

    order = ["modelscope", "huggingface"] if prefer in ("modelscope", "auto") else ["huggingface", "modelscope"]
    last_err: Optional[BaseException] = None
    for src in order:
        try:
            p = await _do(src)
            return DownloadResult(path=p, source=src)
        except (EntryNotFoundError, RepositoryNotFoundError, RevisionNotFoundError, GatedRepoError) as e:
            log.warning("%s 资源不存在或不可访问(%s),尝试下一源", src, e)
            last_err = e
            continue
        except Exception as e:
            last_err = e
            log.warning("%s 下载失败: %s", src, e)
            continue
    raise RuntimeError(f"所有源均失败({order}): {last_err}")


async def download_folder(
    *,
    local_dir: Path,
    repo_id: str,
    repo_type: str = "model",
    allow_patterns: Optional[Sequence[str]] = None,
    ignore_patterns: Optional[Sequence[str]] = None,
    prefer: str = "modelscope",
) -> DownloadResult:
    loop = asyncio.get_running_loop()

    async def _do(source: str) -> Path:
        if source == "modelscope":
            if not _ms_available():
                raise RuntimeError("modelscope 未安装")
            return await loop.run_in_executor(
                None,
                _with_retries,
                _ms_download_folder,
                repo_id, repo_type, local_dir, allow_patterns, ignore_patterns,
            )
        cfg = HFConfig.from_env()
        return await loop.run_in_executor(
            None,
            _with_retries,
            _hf_download_folder,
            repo_id, repo_type, local_dir, allow_patterns, ignore_patterns, cfg,
        )

    order = ["modelscope", "huggingface"] if prefer in ("modelscope", "auto") else ["huggingface", "modelscope"]
    last_err: Optional[BaseException] = None
    for src in order:
        try:
            p = await _do(src)
            return DownloadResult(path=p, source=src)
        except (EntryNotFoundError, RepositoryNotFoundError, RevisionNotFoundError, GatedRepoError) as e:
            log.warning("%s 资源不存在或不可访问(%s),尝试下一源", src, e)
            last_err = e
            continue
        except Exception as e:
            last_err = e
            log.warning("%s 下载失败: %s", src, e)
            continue
    raise RuntimeError(f"所有源均失败({order}): {last_err}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_patterns(values: Iterable[str]) -> List[str]:
    out: List[str] = []
    for v in values:
        for p in v.split(","):
            p = p.strip()
            if p:
                out.append(p)
    return out


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="下载 HF / ModelScope 资产(优先 ModelScope)。",
    )
    parser.add_argument("--repo-id")
    parser.add_argument("--repo-type", default="model", choices=["model", "dataset", "space"])
    parser.add_argument("--filename", help="单文件模式下的文件名")
    parser.add_argument("--local-dir", required=True)
    parser.add_argument("--allow-patterns", nargs="*", default=[], help="逗号或空格分隔的 glob")
    parser.add_argument("--ignore-patterns", nargs="*", default=[])
    parser.add_argument("--prefer", default="modelscope", choices=["modelscope", "huggingface", "auto"])
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    local_dir = Path(args.local_dir).resolve()
    local_dir.mkdir(parents=True, exist_ok=True)

    async def run() -> DownloadResult:
        if args.filename:
            return await download_file(
                filename=args.filename,
                local_dir=local_dir,
                repo_id=args.repo_id,
                repo_type=args.repo_type,
                prefer=args.prefer,
            )
        if not args.repo_id:
            raise SystemExit("--repo-id 必填(文件夹快照模式)")
        return await download_folder(
            local_dir=local_dir,
            repo_id=args.repo_id,
            repo_type=args.repo_type,
            allow_patterns=_parse_patterns(args.allow_patterns) or None,
            ignore_patterns=_parse_patterns(args.ignore_patterns) or None,
            prefer=args.prefer,
        )

    result = asyncio.run(run())
    print(f"[ok] source={result.source} path={result.path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
