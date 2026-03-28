import os
import hashlib
import asyncio
import json
from fastapi.responses import FileResponse, Response
from fastapi import HTTPException
from typing import AsyncGenerator
from app.config import UPLOADS_DIR
from app.services.tts_providers import (
    BaseTTSProvider,
    build_provider_from_config,
)

AUDIO_CACHE_DIR = os.path.join(UPLOADS_DIR, "audio_cache")
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)

# Lock to prevent duplicate generation of same text
_generation_locks: dict[str, asyncio.Lock] = {}
_locks_lock = asyncio.Lock()

CONTENT_TYPE_EXTENSIONS = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/wave": ".wav",
}
MAX_CACHE_FILES = 200
MAX_CACHE_BYTES = 512 * 1024 * 1024


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


def _get_cache_meta_path(cache_key: str) -> str:
    return os.path.join(AUDIO_CACHE_DIR, f"{cache_key}.json")


def _guess_extension(content_type: str) -> str:
    return CONTENT_TYPE_EXTENSIONS.get(content_type, ".bin")


def _find_cached_audio_path(cache_key: str) -> str | None:
    for entry in os.listdir(AUDIO_CACHE_DIR):
        if entry.startswith(f"{cache_key}.") and not entry.endswith(".json"):
            return os.path.join(AUDIO_CACHE_DIR, entry)
    return None


def _list_cached_audio_files() -> list[str]:
    return [
        os.path.join(AUDIO_CACHE_DIR, entry)
        for entry in os.listdir(AUDIO_CACHE_DIR)
        if entry.endswith((".mp3", ".wav", ".bin"))
    ]


def _load_cached_audio(cache_key: str) -> tuple[str, bytes] | None:
    meta_path = _get_cache_meta_path(cache_key)
    audio_path = _find_cached_audio_path(cache_key)
    if not audio_path or not os.path.exists(meta_path):
        return None

    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        with open(audio_path, "rb") as f:
            audio_bytes = f.read()
        return meta.get("content_type", "audio/mpeg"), audio_bytes
    except Exception:
        return None


def _write_cached_audio(cache_key: str, content_type: str, audio_bytes: bytes) -> str:
    ext = _guess_extension(content_type)
    audio_path = os.path.join(AUDIO_CACHE_DIR, f"{cache_key}{ext}")
    meta_path = _get_cache_meta_path(cache_key)

    # Remove stale cache variants for the same key before writing the new one.
    for entry in os.listdir(AUDIO_CACHE_DIR):
        if entry.startswith(f"{cache_key}."):
            os.remove(os.path.join(AUDIO_CACHE_DIR, entry))

    with open(audio_path, "wb") as f:
        f.write(audio_bytes)
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump({"content_type": content_type}, f, ensure_ascii=False)

    _prune_cache_if_needed()
    return audio_path


def _remove_cache_entry(audio_path: str) -> int:
    removed = 0
    meta_path = os.path.splitext(audio_path)[0] + ".json"

    if os.path.exists(audio_path):
        removed += 1
        os.remove(audio_path)
    if os.path.exists(meta_path):
        removed += 1
        os.remove(meta_path)

    return removed


def _prune_cache_if_needed() -> None:
    audio_files = _list_cached_audio_files()
    if not audio_files:
        return

    total_size = sum(os.path.getsize(path) for path in audio_files)
    if len(audio_files) <= MAX_CACHE_FILES and total_size <= MAX_CACHE_BYTES:
        return

    audio_files.sort(key=lambda path: os.path.getmtime(path))

    while audio_files and (len(audio_files) > MAX_CACHE_FILES or total_size > MAX_CACHE_BYTES):
        oldest = audio_files.pop(0)
        if not os.path.exists(oldest):
            continue
        total_size -= os.path.getsize(oldest)
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
            chunks: list[bytes] = []
            async for chunk in body:
                chunks.append(chunk)
            audio_bytes = b"".join(chunks)
            _write_cached_audio(cache_key, content_type, audio_bytes)
            return content_type, audio_bytes
        except Exception as e:
            print(f"TTS Error: {e}")
            raise HTTPException(status_code=500, detail=f"TTS generation failed: {str(e)}")


async def generate_speech_file(text: str, voice: str = "default") -> str:
    """
    Generates speech from text and saves to cache.
    Returns the absolute path to the audio file.
    Uses lock to prevent duplicate generation.
    """
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail="Text is empty")

    cache_key = _build_cache_key(text, voice)
    cached_path = _find_cached_audio_path(cache_key)
    if cached_path:
        return cached_path

    await get_or_generate_audio(text, voice)
    file_path = _find_cached_audio_path(cache_key)
    if file_path:
        return file_path
    raise HTTPException(status_code=500, detail="TTS generation failed: cache file missing")


async def stream_speech(text: str, voice: str = "default") -> AsyncGenerator[bytes, None]:
    """
    Stream speech audio chunks as they are generated.
    Faster for long texts as audio starts playing immediately.
    """
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail="Text is empty")

    content_type, audio_bytes = await get_or_generate_audio(text, voice)
    _ = content_type
    yield audio_bytes


async def get_stream_response(text: str, voice: str = "default") -> Response:
    content_type, audio_bytes = await get_or_generate_audio(text, voice)
    return Response(content=audio_bytes, media_type=content_type)


def get_audio_file(filename: str):
    file_path = os.path.join(AUDIO_CACHE_DIR, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Audio file not found")
    ext = os.path.splitext(file_path)[1].lower()
    media_type = "audio/wav" if ext == ".wav" else "audio/mpeg"
    return FileResponse(file_path, media_type=media_type)


def clear_cache() -> dict:
    """Clear all cached audio files. Returns count of deleted files."""
    count = 0
    for audio_path in _list_cached_audio_files():
        count += _remove_cache_entry(audio_path)
    return {"deleted": count}


def get_cache_info() -> dict:
    """Get cache statistics."""
    files = _list_cached_audio_files()
    total_size = sum(os.path.getsize(path) for path in files)
    return {
        "file_count": len(files),
        "total_bytes": total_size,
        "total_mb": round(total_size / (1024 * 1024), 2),
        "max_files": MAX_CACHE_FILES,
        "max_mb": round(MAX_CACHE_BYTES / (1024 * 1024), 2),
    }
