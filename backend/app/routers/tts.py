from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from ..services import tts_service

router = APIRouter(prefix="/api/tts", tags=["tts"])


class TTSRequest(BaseModel):
    text: str
    voice: str = "default"


class TTSRequestStream(BaseModel):
    text: str
    voice: str = "default"


@router.post("/")
async def generate_speech(req: TTSRequest):
    """
    Generate audio for given text. Returns URL to cached file.
    Best for: Short texts, when you want to cache the result.
    """
    if len(req.text) > 5000:
        raise HTTPException(status_code=400, detail="Text too long")

    file_path = await tts_service.generate_speech_file(req.text, req.voice)
    filename = file_path.split("/")[-1].split("\\")[-1]

    return {"url": f"/api/tts/audio/{filename}"}


@router.post("/stream")
async def stream_speech(req: TTSRequestStream):
    """
    Stream audio directly as it generates.
    Best for: Long texts, when you want audio to start playing immediately.
    """
    if len(req.text) > 10000:
        raise HTTPException(status_code=400, detail="Text too long for streaming")

    return StreamingResponse(
        tts_service.stream_speech(req.text, req.voice),
        media_type="audio/mpeg"
    )


@router.get("/audio/{filename}")
async def get_audio(filename: str):
    """Serve the generated audio file"""
    # 检查路径遍历攻击
    if ".." in filename or "/" in filename or "\\" in filename:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Invalid filename")
    return tts_service.get_audio_file(filename)


@router.get("/cache/info")
async def cache_info():
    """Get cache statistics"""
    return tts_service.get_cache_info()


@router.delete("/cache")
async def clear_cache():
    """Clear all cached audio files"""
    return tts_service.clear_cache()


@router.get("/voices")
async def list_voices():
    """List available voices"""
    return {
        "voices": [
            {"id": "default", "name": "Aria (Female)", "voice": "en-US-AriaNeural"},
            {"id": "male", "name": "Christopher (Male)", "voice": "en-US-ChristopherNeural"},
            {"id": "female", "name": "Jenny (Female)", "voice": "en-US-JennyNeural"}
        ]
    }
