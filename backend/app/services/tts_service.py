import hashlib
import asyncio
import json
import logging
from pathlib import Path
from fastapi.responses import FileResponse, Response
from fastapi import HTTPException
from typing import AsyncGenerator, Dict, List, Optional, Tuple
from app.config import UPLOADS_DIR
from app.services.tts_providers import (
    BaseTTSProvider,
    build_provider_from_config,
)

logger = logging.getLogger(__name__)

AUDIO_CACHE_DIR: Path = Path(UPLOADS_DIR) / "audio_cache"
AUDIO_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Lock to prevent duplicate generation of same text
_generation_locks: Dict[str, asyncio.Lock] = {}
_locks_lock = asyncio.Lock()

CONTENT_TYPE_EXTENSIONS = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/wave": ".wav",
}
MAX_CACHE_FILES = 50000
MAX_CACHE_BYTES = 10 * 1024 * 1024 * 1024  # 10 GB


def _get_tts_config() -> dict:
    """从 app_config.json 读取 TTS 配置节点"""
    try:
        from app.routers.config import load_config
        return load_config().get("tts", {})
    except Exception:
        return {}


def get_active_tts_provider() -> BaseTTSProvider:
    """根据当前配置实例化 TTS Provider"""
    return build_provider_from_config(_get_tts_config())


def _build_cache_key(text: str, voice: str) -> str:
    tts_config = _get_tts_config()
    normalized_config = json.dumps(tts_config, ensure_ascii=False, sort_keys=True)
    return hashlib.md5(f"{text}-{voice}-{normalized_config}".encode("utf-8")).hexdigest()


def _get_cache_meta_path(cache_key: str) -> Path:
    return AUDIO_CACHE_DIR / f"{cache_key}.json"


def _guess_extension(content_type: str) -> str:
    return CONTENT_TYPE_EXTENSIONS.get(content_type, ".bin")


def _find_cached_audio_path(cache_key: str) -> Optional[Path]:
    for entry in AUDIO_CACHE_DIR.iterdir():
        if entry.name.startswith(f"{cache_key}.") and entry.suffix != ".json":
            return entry
    return None


def _list_cached_audio_files() -> List[Path]:
    return [
        entry
        for entry in AUDIO_CACHE_DIR.iterdir()
        if entry.suffix in (".mp3", ".wav", ".bin")
    ]


def _load_cached_audio(cache_key: str) -> Optional[Tuple[str, bytes]]:
    meta_path = _get_cache_meta_path(cache_key)
    audio_path = _find_cached_audio_path(cache_key)
    if not audio_path or not meta_path.exists():
        return None

    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        audio_bytes = audio_path.read_bytes()
        return meta.get("content_type", "audio/mpeg"), audio_bytes
    except Exception:
        return None


def _write_cached_audio(cache_key: str, content_type: str, audio_bytes: bytes) -> Path:
    ext = _guess_extension(content_type)
    audio_path = AUDIO_CACHE_DIR / f"{cache_key}{ext}"
    meta_path = _get_cache_meta_path(cache_key)

    # 清除同一 cache_key 的旧缓存变体
    for entry in AUDIO_CACHE_DIR.iterdir():
        if entry.name.startswith(f"{cache_key}."):
            entry.unlink()

    audio_path.write_bytes(audio_bytes)
    meta_path.write_text(json.dumps({"content_type": content_type}, ensure_ascii=False), encoding="utf-8")

    _prune_cache_if_needed()
    return audio_path


def _remove_cache_entry(audio_path: Path) -> int:
    removed = 0
    meta_path = audio_path.with_suffix(".json")

    if audio_path.exists():
        removed += 1
        audio_path.unlink()
    if meta_path.exists():
        removed += 1
        meta_path.unlink()

    return removed


def _prune_cache_if_needed() -> None:
    audio_files = _list_cached_audio_files()
    if not audio_files:
        return

    total_size = sum(p.stat().st_size for p in audio_files)
    if len(audio_files) <= MAX_CACHE_FILES and total_size <= MAX_CACHE_BYTES:
        return

    audio_files.sort(key=lambda p: p.stat().st_mtime)

    while audio_files and (len(audio_files) > MAX_CACHE_FILES or total_size > MAX_CACHE_BYTES):
        oldest = audio_files.pop(0)
        if not oldest.exists():
            continue
        total_size -= oldest.stat().st_size
        _remove_cache_entry(oldest)


async def _get_lock(cache_key: str) -> asyncio.Lock:
    """Get or create a lock for specific text+voice combination."""
    async with _locks_lock:
        if cache_key not in _generation_locks:
            _generation_locks[cache_key] = asyncio.Lock()
        return _generation_locks[cache_key]


async def get_or_generate_audio(text: str, voice: str = "default") -> tuple[str, bytes]:
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail="Text is empty")

    provider = get_active_tts_provider()
    cache_key = _build_cache_key(text, voice)

    cached = _load_cached_audio(cache_key)
    if cached is not None:
        return cached

    lock = await _get_lock(cache_key)
    async with lock:
        cached = _load_cached_audio(cache_key)
        if cached is not None:
            return cached

        try:
            content_type, body = await provider.stream_with_content_type(text, voice)
            chunks: List[bytes] = []
            async for chunk in body:
                chunks.append(chunk)
            audio_bytes = b"".join(chunks)
            _write_cached_audio(cache_key, content_type, audio_bytes)
            return content_type, audio_bytes
        except Exception as e:
            logger.error(f"TTS 生成失败: {e}")
            raise HTTPException(status_code=500, detail=f"TTS generation failed: {str(e)}")


async def generate_speech_file(text: str, voice: str = "default") -> str:
    """
    生成语音并缓存到磁盘，返回音频文件的绝对路径。
    使用锁防止重复生成。
    """
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail="Text is empty")

    cache_key = _build_cache_key(text, voice)
    cached_path = _find_cached_audio_path(cache_key)
    if cached_path:
        return str(cached_path)

    await get_or_generate_audio(text, voice)
    file_path = _find_cached_audio_path(cache_key)
    if file_path:
        return str(file_path)
    raise HTTPException(status_code=500, detail="TTS generation failed: cache file missing")


async def stream_speech(text: str, voice: str = "default") -> AsyncGenerator[bytes, None]:
    """
    流式生成语音字节块。适合长文本，音频可以更快开始播放。
    """
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail="Text is empty")

    _, audio_bytes = await get_or_generate_audio(text, voice)
    yield audio_bytes


async def get_stream_response(text: str, voice: str = "default") -> Response:
    content_type, audio_bytes = await get_or_generate_audio(text, voice)
    return Response(content=audio_bytes, media_type=content_type)


def get_audio_file(filename: str):
    file_path = AUDIO_CACHE_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    media_type = "audio/wav" if file_path.suffix.lower() == ".wav" else "audio/mpeg"
    return FileResponse(str(file_path), media_type=media_type)


def clear_cache() -> dict:
    """清除所有缓存音频文件，返回删除数量"""
    count = 0
    for audio_path in _list_cached_audio_files():
        count += _remove_cache_entry(audio_path)
    return {"deleted": count}


def get_cache_info() -> dict:
    """获取缓存统计信息"""
    files = _list_cached_audio_files()
    total_size = sum(p.stat().st_size for p in files)
    return {
        "file_count": len(files),
        "total_bytes": total_size,
        "total_mb": round(total_size / (1024 * 1024), 2),
        "max_files": MAX_CACHE_FILES,
        "max_mb": round(MAX_CACHE_BYTES / (1024 * 1024), 2),
    }
