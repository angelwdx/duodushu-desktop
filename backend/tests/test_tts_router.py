import pytest

from app.routers import tts as tts_router


@pytest.mark.asyncio
async def test_list_provider_voices_keeps_configured_qwen_voice(monkeypatch):
    async def fake_fetch_qwen3_voice_names(_base_url: str) -> list[str]:
        return ["素子", "塔塔"]

    monkeypatch.setattr(tts_router, "_fetch_qwen3_voice_names", fake_fetch_qwen3_voice_names)

    voices = await tts_router.list_provider_voices(
        {
            "qwen3": {
                "base_url": "http://127.0.0.1:18790/v1",
                "voice": "塔塔",
            }
        },
        "qwen3",
    )

    assert voices == [
        {"id": "塔塔", "name": "塔塔", "voice": "塔塔"},
        {"id": "素子", "name": "素子", "voice": "素子"},
    ]


@pytest.mark.asyncio
async def test_list_voices_uses_requested_provider(monkeypatch):
    async def fake_list_provider_voices(tts: dict, provider: str) -> list[dict]:
        assert tts == {"provider": "edge"}
        assert provider == "qwen3"
        return [{"id": "塔塔", "name": "塔塔", "voice": "塔塔"}]

    monkeypatch.setattr("app.routers.config.load_config", lambda: {"tts": {"provider": "edge"}})
    monkeypatch.setattr(tts_router, "list_provider_voices", fake_list_provider_voices)

    result = await tts_router.list_voices("qwen3")

    assert result == {"voices": [{"id": "塔塔", "name": "塔塔", "voice": "塔塔"}]}
