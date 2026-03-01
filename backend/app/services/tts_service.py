import edge_tts
import os
import hashlib
import asyncio
from fastapi.responses import FileResponse, StreamingResponse
from fastapi import HTTPException
from typing import AsyncGenerator
from app.config import UPLOADS_DIR

AUDIO_CACHE_DIR = os.path.join(UPLOADS_DIR, "audio_cache")
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)

# Voices map
VOICES = {"default": "en-US-AriaNeural", "male": "en-US-ChristopherNeural", "female": "en-US-JennyNeural"}

# Lock to prevent duplicate generation of same text
_generation_locks: dict[str, asyncio.Lock] = {}
_locks_lock = asyncio.Lock()


async def _get_lock(text: str, voice: str) -> asyncio.Lock:
    """Get or create a lock for specific text+voice combination."""
    key = hashlib.md5(f"{text}-{voice}".encode("utf-8")).hexdigest()
    async with _locks_lock:
        if key not in _generation_locks:
            _generation_locks[key] = asyncio.Lock()
        return _generation_locks[key]


async def generate_speech_file(text: str, voice: str = "default") -> str:
    """
    Generates speech from text using edge-tts and saves to cache.
    Returns the absolute path to the audio file.
    Uses lock to prevent duplicate generation.
    """
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail="Text is empty")

    voice_name = VOICES.get(voice, voice)

    # Create hash of text + voice to serve as filename
    text_hash = hashlib.md5(f"{text}-{voice_name}".encode("utf-8")).hexdigest()
    filename = f"{text_hash}.mp3"
    file_path = os.path.join(AUDIO_CACHE_DIR, filename)

    # Check cache first (without lock for speed)
    if os.path.exists(file_path):
        return file_path

    # Use lock to prevent duplicate generation
    lock = await _get_lock(text, voice_name)
    async with lock:
        # Double check after acquiring lock
        if os.path.exists(file_path):
            return file_path

        # Generate
        try:
            communicate = edge_tts.Communicate(text, voice_name)
            await communicate.save(file_path)
            return file_path
        except Exception as e:
            print(f"TTS Error: {e}")
            raise HTTPException(status_code=500, detail=f"TTS generation failed: {str(e)}")


async def stream_speech(text: str, voice: str = "default") -> AsyncGenerator[bytes, None]:
    """
    Stream speech audio chunks as they are generated.
    Faster for long texts as audio starts playing immediately.
    """
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail="Text is empty")

    voice_name = VOICES.get(voice, voice)

    try:
        communicate = edge_tts.Communicate(text, voice_name)
        # Stream chunks as they arrive
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":  # type: ignore
                yield chunk["data"]  # type: ignore
    except Exception as e:
        print(f"TTS Streaming Error: {e}")
        raise HTTPException(status_code=500, detail=f"TTS streaming failed: {str(e)}")


def get_audio_file(filename: str):
    file_path = os.path.join(AUDIO_CACHE_DIR, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Audio file not found")
    return FileResponse(file_path, media_type="audio/mpeg")


def clear_cache() -> dict:
    """Clear all cached audio files. Returns count of deleted files."""
    count = 0
    for filename in os.listdir(AUDIO_CACHE_DIR):
        if filename.endswith(".mp3"):
            os.remove(os.path.join(AUDIO_CACHE_DIR, filename))
            count += 1
    return {"deleted": count}


def get_cache_info() -> dict:
    """Get cache statistics."""
    files = [f for f in os.listdir(AUDIO_CACHE_DIR) if f.endswith(".mp3")]
    total_size = sum(os.path.getsize(os.path.join(AUDIO_CACHE_DIR, f)) for f in files)
    return {"file_count": len(files), "total_bytes": total_size, "total_mb": round(total_size / (1024 * 1024), 2)}
