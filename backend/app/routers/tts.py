from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel
from typing import Optional
import httpx
from ..services import tts_service

router = APIRouter(prefix="/api/tts", tags=["tts"])


# ─── 请求/响应模型 ─────────────────────────────────────────────────────────

class TTSRequest(BaseModel):
    text: str
    voice: str = "default"


class TTSRequestStream(BaseModel):
    text: str
    voice: str = "default"


class TTSConfigEdge(BaseModel):
    voice: str = "default"
    speed: float = 1.0


class TTSConfigOpenAIApi(BaseModel):
    base_url: str = "https://api.openai.com/v1"
    api_key: str = ""
    model: str = "tts-1"
    voice: str = "alloy"
    speed: float = 1.0


class TTSConfigQwen3(BaseModel):
    base_url: str = "http://127.0.0.1:18790/v1"
    model: str = "tts-1"
    voice: str = "塔塔"
    speed: float = 1.0


class TTSConfigRequest(BaseModel):
    """保存 TTS provider 配置"""
    provider: str = "edge"          # "edge" | "openai_api" | "qwen3"
    edge: TTSConfigEdge = TTSConfigEdge()
    openai_api: TTSConfigOpenAIApi = TTSConfigOpenAIApi()
    qwen3: TTSConfigQwen3 = TTSConfigQwen3()


# ─── 原有端点 (保持兼容) ────────────────────────────────────────────────────

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

    return await tts_service.get_stream_response(req.text, req.voice)


@router.get("/audio/{filename}")
async def get_audio(filename: str):
    """Serve the generated audio file"""
    if ".." in filename or "/" in filename or "\\" in filename:
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
    """List available voices for current provider"""
    from app.routers.config import load_config

    tts = load_config().get("tts", {})
    provider = tts.get("provider", "edge")

    if provider == "edge":
        return {
            "voices": [
                {"id": "default", "name": "Aria (Female)", "voice": "en-US-AriaNeural"},
                {"id": "male", "name": "Christopher (Male)", "voice": "en-US-ChristopherNeural"},
                {"id": "female", "name": "Jenny (Female)", "voice": "en-US-JennyNeural"}
            ]
        }

    if provider == "qwen3":
        cfg = tts.get("qwen3", {})
        base_url = cfg.get("base_url", "http://127.0.0.1:18790/v1").rstrip("/")
        configured_voice = cfg.get("voice", "塔塔")

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(f"{base_url}/audio/voices")
                res.raise_for_status()
                data = res.json()
                raw_voices = data.get("voices", [])
                voices = [
                    {"id": str(v), "name": str(v), "voice": str(v)}
                    for v in raw_voices
                    if any(ord(ch) > 127 for ch in str(v))
                ]
                if voices:
                    return {"voices": voices}
        except Exception:
            pass

        return {"voices": [{"id": configured_voice, "name": configured_voice, "voice": configured_voice}]}

    if provider == "openai_api":
        cfg = tts.get("openai_api", {})
        configured_voice = cfg.get("voice", "alloy")
        return {"voices": [{"id": configured_voice, "name": configured_voice, "voice": configured_voice}]}

    return {"voices": []}


# ─── 新增：TTS provider 配置端点 ────────────────────────────────────────────

def _mask_key(key: str) -> str:
    """脱敏 API Key，只保留首尾各 4 位"""
    if not key or len(key) <= 8:
        return key
    return key[:4] + "****" + key[-4:]


@router.get("/config")
def get_tts_config():
    """获取当前 TTS provider 配置（API Key 脱敏返回）"""
    from app.routers.config import load_config
    config = load_config()
    default_tts = {
        "provider": "edge",
        "edge": {"voice": "default", "speed": 1.0},
        "openai_api": {"base_url": "https://api.openai.com/v1", "api_key": "", "model": "tts-1", "voice": "alloy", "speed": 1.0},
        "qwen3": {"base_url": "http://127.0.0.1:18790/v1", "model": "tts-1", "voice": "塔塔", "speed": 1.0},
    }
    raw_tts = config.get("tts", {})
    tts = {
        **default_tts,
        **raw_tts,
        "edge": {**default_tts["edge"], **raw_tts.get("edge", {})},
        "openai_api": {**default_tts["openai_api"], **raw_tts.get("openai_api", {})},
        "qwen3": {**default_tts["qwen3"], **raw_tts.get("qwen3", {})},
    }
    # 脱敏 API Key
    if tts.get("openai_api", {}).get("api_key"):
        tts = dict(tts)
        tts["openai_api"] = dict(tts["openai_api"])
        tts["openai_api"]["api_key"] = _mask_key(tts["openai_api"]["api_key"])
    return tts


@router.post("/config")
def save_tts_config(req: TTSConfigRequest):
    """保存 TTS provider 配置"""
    from app.routers.config import load_config, save_config

    config = load_config()

    # 如果前端传来的是脱敏 key（含 ****），保留原有真实 key
    existing_tts = config.get("tts", {})
    new_api_key = req.openai_api.api_key
    if "****" in new_api_key:
        new_api_key = existing_tts.get("openai_api", {}).get("api_key", "")

    config["tts"] = {
        "provider": req.provider,
        "edge": req.edge.model_dump(),
        "openai_api": {
            **req.openai_api.model_dump(),
            "api_key": new_api_key,  # 使用真实 key 存储
        },
        "qwen3": req.qwen3.model_dump(),
    }
    save_config(config)
    return {"status": "success", "provider": req.provider}


@router.post("/test")
async def test_tts_config(req: Optional[TTSConfigRequest] = None):
    """
    用当前（或临时）配置合成一段测试音频并流式返回。
    若传入 req，临时使用该配置（不保存）；否则使用已保存配置。
    """
    TEST_TEXT = "你好，这是一段语音合成测试。Hello, this is a TTS test."

    if req is not None:
        from app.services.tts_providers import build_provider_from_config
        from app.routers.config import load_config
        existing_api_key = load_config().get("tts", {}).get("openai_api", {}).get("api_key", "")
        api_key = req.openai_api.api_key
        if "****" in api_key:
            api_key = existing_api_key

        tmp_cfg = {
            "provider": req.provider,
            "edge": req.edge.model_dump(),
            "openai_api": {**req.openai_api.model_dump(), "api_key": api_key},
            "qwen3": req.qwen3.model_dump(),
        }
        provider = build_provider_from_config(tmp_cfg)
    else:
        provider = tts_service.get_active_tts_provider()

    content_type, body = await provider.stream_with_content_type(TEST_TEXT, "")
    return StreamingResponse(body, media_type=content_type)
