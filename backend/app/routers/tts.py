from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Literal, Optional
import httpx
import logging
from ..services import tts_service

router = APIRouter(prefix="/api/tts", tags=["tts"])
logger = logging.getLogger(__name__)

OPENAI_PRESET_VOICES = [
    ("alloy", "Alloy"),
    ("ash", "Ash"),
    ("coral", "Coral"),
    ("echo", "Echo"),
    ("fable", "Fable"),
    ("nova", "Nova"),
    ("onyx", "Onyx"),
    ("sage", "Sage"),
    ("shimmer", "Shimmer"),
]

DEFAULT_TTS_CONFIG = {
    "provider": "edge",
    "edge": {"voice": "aria", "voice_japanese": "nanami", "voice_chinese": "xiaoxiao", "speed": 1.0},
    "openai_api": {"base_url": "https://api.openai.com/v1", "api_key": "", "model": "tts-1", "voice": "alloy", "speed": 1.0},
    "qwen3": {"base_url": "http://127.0.0.1:18790/v1", "model": "tts-1", "voice": "塔塔", "voice_japanese": "", "speed": 1.0},
}


def _merge_tts_config(raw_tts: dict) -> dict:
    return {
        **DEFAULT_TTS_CONFIG,
        **raw_tts,
        "edge": {**DEFAULT_TTS_CONFIG["edge"], **raw_tts.get("edge", {})},
        "openai_api": {**DEFAULT_TTS_CONFIG["openai_api"], **raw_tts.get("openai_api", {})},
        "qwen3": {**DEFAULT_TTS_CONFIG["qwen3"], **raw_tts.get("qwen3", {})},
    }


def _resolve_openai_api_key(raw_api_key: str, existing_tts: dict) -> str:
    if "****" in raw_api_key:
        return existing_tts.get("openai_api", {}).get("api_key", "")
    return raw_api_key


def _build_runtime_tts_config(req: "TTSConfigRequest", existing_tts: Optional[dict] = None) -> dict:
    resolved_api_key = _resolve_openai_api_key(req.openai_api.api_key, existing_tts or {})
    return _merge_tts_config({
        "provider": req.provider,
        "edge": req.edge.model_dump(),
        "openai_api": {
            **req.openai_api.model_dump(),
            "api_key": resolved_api_key,
        },
        "qwen3": req.qwen3.model_dump(),
    })


def _voice_option(voice_id: str, name: str) -> dict:
    return {"id": voice_id, "name": name, "voice": voice_id}


def _dedupe_voice_options(voice_options: list[dict]) -> list[dict]:
    deduped: list[dict] = []
    seen: set[str] = set()
    for option in voice_options:
        voice_id = str(option.get("voice", "")).strip()
        if not voice_id or voice_id in seen:
            continue
        seen.add(voice_id)
        deduped.append({
            "id": voice_id,
            "name": str(option.get("name", voice_id)).strip() or voice_id,
            "voice": voice_id,
        })
    return deduped


async def _fetch_qwen3_voice_names(base_url: str) -> list[str]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        res = await client.get(f"{base_url.rstrip('/')}/audio/voices")
        res.raise_for_status()
        data = res.json()
        raw_voices = data.get("voices", [])
        return [
            str(voice)
            for voice in raw_voices
            if any(ord(ch) > 127 for ch in str(voice))
        ]


def _build_openai_voice_options(configured_voice: str) -> list[dict]:
    preferred_voice = configured_voice.strip() or "alloy"
    return _dedupe_voice_options([
        _voice_option(preferred_voice, preferred_voice),
        *[_voice_option(voice_id, name) for voice_id, name in OPENAI_PRESET_VOICES],
    ])


async def _fetch_openai_compatible_voices(base_url: str) -> list[dict]:
    if not base_url:
        return []

    url = f"{base_url.rstrip('/')}/audio/voices"
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.get(url)
        response.raise_for_status()
        data = response.json()

    raw_voices = data.get("voices", [])
    voice_options: list[dict] = []
    for voice in raw_voices:
        if isinstance(voice, dict):
            voice_id = str(voice.get("voice") or voice.get("id") or "").strip()
            name = str(voice.get("name") or voice_id).strip()
        else:
            voice_id = str(voice).strip()
            name = voice_id
        if voice_id:
            voice_options.append(_voice_option(voice_id, name))
    return _dedupe_voice_options(voice_options)


async def list_provider_voices(
    tts: dict,
    provider: Literal["edge", "openai_api", "qwen3"],
) -> list[dict]:
    if provider == "edge":
        return [
            {"id": "default", "name": "Aria (Female)", "voice": "en-US-AriaNeural"},
            {"id": "male", "name": "Christopher (Male)", "voice": "en-US-ChristopherNeural"},
            {"id": "female", "name": "Jenny (Female)", "voice": "en-US-JennyNeural"},
        ]

    if provider == "qwen3":
        cfg = tts.get("qwen3", {})
        configured_voice = cfg.get("voice", "塔塔")

        try:
            voices = await _fetch_qwen3_voice_names(
                cfg.get("base_url", "http://127.0.0.1:18790/v1")
            )
            if voices:
                return [
                    {"id": voice, "name": voice, "voice": voice}
                    for voice in dict.fromkeys([configured_voice, *voices])
                ]
        except Exception as exc:
            logger.warning("获取 Qwen3 音色列表失败: %s", exc)

        return [{"id": configured_voice, "name": configured_voice, "voice": configured_voice}]

    if provider == "openai_api":
        cfg = tts.get("openai_api", {})
        base_url = str(cfg.get("base_url", ""))
        configured_voice = str(cfg.get("voice", "")).strip()
        try:
            compatible_voices = await _fetch_openai_compatible_voices(base_url)
            if compatible_voices:
                preferred_voice = configured_voice or compatible_voices[0]["voice"]
                return _dedupe_voice_options([
                    _voice_option(preferred_voice, preferred_voice),
                    *compatible_voices,
                ])
        except Exception as exc:
            logger.warning("获取 OpenAI 兼容音色列表失败: %s", exc)

        return _build_openai_voice_options(configured_voice)

    return []


# ─── 请求/响应模型 ─────────────────────────────────────────────────────────

class TTSRequest(BaseModel):
    text: str
    voice: str = "default"
    provider: Optional[Literal["edge", "openai_api", "qwen3"]] = None
    speed: Optional[float] = None


class TTSRequestStream(BaseModel):
    text: str
    voice: str = "default"
    provider: Optional[Literal["edge", "openai_api", "qwen3"]] = None
    speed: Optional[float] = None


class TTSConfigEdge(BaseModel):
    voice: str = "default"
    voice_japanese: str = "nanami"
    voice_chinese: str = "xiaoxiao"
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
    voice_japanese: str = ""
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

    file_path = await tts_service.generate_speech_file(req.text, req.voice, req.provider, req.speed)
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

    response = await tts_service.get_stream_response(req.text, req.voice, req.provider, req.speed)
    response.headers["X-TTS-Synthesis-Speed"] = str(
        tts_service.get_tts_synthesis_speed(req.provider, req.speed)
    )
    return response


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
async def list_voices(provider: Optional[Literal["edge", "openai_api", "qwen3"]] = None):
    """List available voices for current or requested provider"""
    from app.routers.config import load_config

    tts = _merge_tts_config(load_config().get("tts", {}))
    resolved_provider = provider or tts.get("provider", "edge")
    voices = await list_provider_voices(tts, resolved_provider)
    return {"voices": voices}


@router.post("/voices/query")
async def query_voices(
    req: TTSConfigRequest,
    provider: Optional[Literal["edge", "openai_api", "qwen3"]] = None,
):
    """基于临时配置查询音色列表，不落盘。"""
    from app.routers.config import load_config

    existing_tts = load_config().get("tts", {})
    runtime_tts = _build_runtime_tts_config(req, existing_tts)
    resolved_provider = provider or req.provider
    voices = await list_provider_voices(runtime_tts, resolved_provider)
    return {"voices": voices}


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
    tts = _merge_tts_config(config.get("tts", {}))
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
    existing_tts = config.get("tts", {})
    config["tts"] = _build_runtime_tts_config(req, existing_tts)
    save_config(config)
    return {"status": "success", "provider": req.provider}


@router.post("/test")
async def test_tts_config(req: Optional[TTSConfigRequest] = None):
    """
    用当前（或临时）配置合成一段测试音频并流式返回。
    若传入 req，临时使用该配置（不保存）；否则使用已保存配置。
    """
    TEST_TEXT = "你好，这是一段中文朗读测试。こんにちは、日本語の朗读テストです。Hello, this is a TTS test."

    try:
        if req is not None:
            from app.services.tts_providers import build_provider_from_config
            from app.routers.config import load_config

            provider = build_provider_from_config(
                _build_runtime_tts_config(req, load_config().get("tts", {}))
            )
        else:
            provider = tts_service.get_active_tts_provider()

        content_type, body = await provider.stream_with_content_type(TEST_TEXT, "")
        response = StreamingResponse(body, media_type=content_type)
        response.headers["X-TTS-Synthesis-Speed"] = str(provider.synthesis_speed)
        return response
    except httpx.HTTPStatusError as exc:
        detail = f"TTS provider error ({exc.response.status_code})"
        try:
            payload = exc.response.json()
            if isinstance(payload, dict):
                detail = payload.get("detail") or payload.get("message") or payload.get("error") or detail
        except Exception:
            body_text = (await exc.response.aread()).decode("utf-8", errors="ignore").strip()
            if body_text:
                detail = body_text[:500]
        raise HTTPException(status_code=502, detail=detail) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
