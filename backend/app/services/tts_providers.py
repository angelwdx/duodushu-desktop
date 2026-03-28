"""
TTS 多供应商 Provider 抽象层

支持三种后端：
- EdgeTTSProvider: 微软 Edge TTS（免费，无需 API Key）
- OpenAIApiProvider: 任意 OpenAI 兼容 TTS API
- Qwen3TTSProvider: 本地 Qwen3 TTS 服务（OpenAI 兼容接口，可能返回 audio/wav）
"""

from __future__ import annotations
from abc import ABC, abstractmethod
from typing import AsyncGenerator, Tuple
import httpx
import edge_tts
import logging

logger = logging.getLogger(__name__)

# Edge TTS 内置音色映射
EDGE_VOICE_MAP: dict[str, str] = {
    "default": "en-US-AriaNeural",
    "male":    "en-US-ChristopherNeural",
    "female":  "en-US-JennyNeural",
}


class BaseTTSProvider(ABC):
    """TTS Provider 抽象基类"""

    @abstractmethod
    async def stream_with_content_type(
        self, text: str, voice: str = ""
    ) -> Tuple[str, AsyncGenerator[bytes, None]]:
        """
        返回 (content_type, 字节流生成器)。
        content_type 由具体 provider 决定（如 audio/mpeg 或 audio/wav）。
        """
        ...

    async def stream(self, text: str, voice: str = "") -> AsyncGenerator[bytes, None]:
        """向后兼容接口，只返回字节流"""
        _, gen = await self.stream_with_content_type(text, voice)
        async for chunk in gen:
            yield chunk

    async def generate_bytes(self, text: str, voice: str = "") -> bytes:
        """收集全部音频字节（用于缓存）"""
        chunks: list[bytes] = []
        async for chunk in self.stream(text, voice):
            chunks.append(chunk)
        return b"".join(chunks)


class EdgeTTSProvider(BaseTTSProvider):
    """微软 Edge TTS - 免费，无需配置，输出 audio/mpeg"""

    async def stream_with_content_type(
        self, text: str, voice: str = "default"
    ) -> Tuple[str, AsyncGenerator[bytes, None]]:
        return "audio/mpeg", self._stream_inner(text, voice)

    async def _stream_inner(
        self, text: str, voice: str
    ) -> AsyncGenerator[bytes, None]:
        voice_name = EDGE_VOICE_MAP.get(voice, voice) if voice else EDGE_VOICE_MAP["default"]
        try:
            communicate = edge_tts.Communicate(text, voice_name)
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":  # type: ignore
                    yield chunk["data"]       # type: ignore
        except Exception as e:
            logger.error(f"[EdgeTTS] 流式生成失败: {e}")
            raise


class OpenAIApiProvider(BaseTTSProvider):
    """OpenAI 兼容 TTS API（支持 OpenAI、硅基流动、Fish Audio 等）

    Content-Type 由服务端响应头决定，透传给调用方（可能是 audio/mpeg 或 audio/wav）。
    """

    def __init__(
        self,
        base_url: str = "https://api.openai.com/v1",
        api_key: str = "",
        model: str = "tts-1",
        voice: str = "alloy",
        speed: float = 1.0,
        speech_path: str = "/audio/speech",   # 可覆盖为 /audio/speech/stream
        timeout: float = 60.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.default_voice = voice
        self.speed = speed
        self.speech_path = speech_path
        self.timeout = timeout

    async def stream_with_content_type(
        self, text: str, voice: str = ""
    ) -> Tuple[str, AsyncGenerator[bytes, None]]:
        use_voice = voice if voice and voice != "default" else self.default_voice

        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self.api_key and self.api_key != "not-needed":
            headers["Authorization"] = f"Bearer {self.api_key}"

        payload = {
            "model": self.model,
            "input": text,
            "voice": use_voice,
            "speed": self.speed,
        }

        # 先建立连接，读取响应头，再流式读取 body
        # 注意：必须在这个函数里完成初始连接，才能拿到 content_type
        client = httpx.AsyncClient(timeout=self.timeout)
        try:
            response = await client.send(
                client.build_request(
                    "POST",
                    f"{self.base_url}{self.speech_path}",
                    headers=headers,
                    json=payload,
                ),
                stream=True,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as e:
            await client.aclose()
            body = await e.response.aread()
            logger.error(f"[OpenAIApiTTS] HTTP 错误 {e.response.status_code}: {body[:300]}")
            raise
        except Exception as e:
            await client.aclose()
            logger.error(f"[OpenAIApiTTS] 请求失败: {e}")
            raise

        # 从响应头获取实际 Content-Type
        raw_ct = response.headers.get("content-type", "audio/mpeg")
        content_type = raw_ct.split(";")[0].strip()  # 去掉 charset 等参数
        logger.info(f"[OpenAIApiTTS] 响应 Content-Type: {content_type}")

        async def _body_gen():
            try:
                async for chunk in response.aiter_bytes(chunk_size=4096):
                    if chunk:
                        yield chunk
            finally:
                await response.aclose()
                await client.aclose()

        return content_type, _body_gen()


class Qwen3TTSProvider(OpenAIApiProvider):
    """本地 Qwen3 TTS 服务
    """

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:18790/v1",
        voice: str = "塔塔",
        model: str = "tts-1",
        speed: float = 1.0,
    ) -> None:
        super().__init__(
            base_url=base_url,
            api_key="not-needed",
            model=model,
            voice=voice,
            speed=speed,
            # 当前本地 qwen3-tts 的 /stream 端点首包很慢，不适合阅读页连续朗读。
            # 这里改用普通合成端点，配合调用侧更短的文本分段，整体更稳定。
            speech_path="/audio/speech",
            timeout=180.0,
        )


# ─── 工厂函数 ──────────────────────────────────────────────────────────────

def build_provider_from_config(tts_config: dict) -> BaseTTSProvider:
    """
    根据配置字典实例化对应的 TTS Provider。
    tts_config 结构见 app_config.json → tts 节点。
    """
    provider_type = tts_config.get("provider", "edge")

    if provider_type == "openai_api":
        cfg = tts_config.get("openai_api", {})
        return OpenAIApiProvider(
            base_url=cfg.get("base_url", "https://api.openai.com/v1"),
            api_key=cfg.get("api_key", ""),
            model=cfg.get("model", "tts-1"),
            voice=cfg.get("voice", "alloy"),
            speed=float(cfg.get("speed", 1.0)),
        )
    elif provider_type == "qwen3":
        cfg = tts_config.get("qwen3", {})
        return Qwen3TTSProvider(
            base_url=cfg.get("base_url", "http://127.0.0.1:18790/v1"),
            voice=cfg.get("voice", "塔塔"),
            model=cfg.get("model", "tts-1"),
            speed=float(cfg.get("speed", 1.0)),
        )
    else:
        return EdgeTTSProvider()
