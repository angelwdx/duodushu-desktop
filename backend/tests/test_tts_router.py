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
        assert tts["provider"] == "edge"
        assert tts["qwen3"]["voice"] == "塔塔"
        assert provider == "qwen3"
        return [{"id": "塔塔", "name": "塔塔", "voice": "塔塔"}]

    monkeypatch.setattr("app.routers.config.load_config", lambda: {"tts": {"provider": "edge"}})
    monkeypatch.setattr(tts_router, "list_provider_voices", fake_list_provider_voices)

    result = await tts_router.list_voices("qwen3")

    assert result == {"voices": [{"id": "塔塔", "name": "塔塔", "voice": "塔塔"}]}


@pytest.mark.asyncio
async def test_list_provider_voices_returns_openai_presets():
    voices = await tts_router.list_provider_voices(
        {
            "openai_api": {
                "base_url": "https://api.openai.com/v1",
                "voice": "alloy",
            }
        },
        "openai_api",
    )

    assert any(voice["voice"] == "alloy" for voice in voices)
    assert any(voice["voice"] == "nova" for voice in voices)


@pytest.mark.asyncio
async def test_list_provider_voices_returns_openai_compatible_voices(monkeypatch):
    async def fake_fetch_openai_compatible_voices(_base_url: str) -> list[dict]:
        return [
            {"id": "voice-user", "name": "My Voice", "voice": "voice-user"},
        ]

    monkeypatch.setattr(tts_router, "_fetch_openai_compatible_voices", fake_fetch_openai_compatible_voices)

    voices = await tts_router.list_provider_voices(
        {
            "openai_api": {
                "base_url": "https://example.com/v1",
                "voice": "voice-user",
            }
        },
        "openai_api",
    )

    assert voices == [{"id": "voice-user", "name": "voice-user", "voice": "voice-user"}]


@pytest.mark.asyncio
async def test_list_provider_voices_falls_back_to_openai_presets_when_query_is_empty(monkeypatch):
    async def fake_fetch_openai_compatible_voices(_base_url: str) -> list[dict]:
        return []

    monkeypatch.setattr(tts_router, "_fetch_openai_compatible_voices", fake_fetch_openai_compatible_voices)

    voices = await tts_router.list_provider_voices(
        {
            "openai_api": {
                "base_url": "https://example.com/v1",
                "model": "tts-1",
                "voice": "alloy",
            }
        },
        "openai_api",
    )

    assert any(voice["voice"] == "alloy" for voice in voices)
    assert any(voice["voice"] == "nova" for voice in voices)


def test_build_runtime_tts_config_keeps_masked_key():
    runtime_config = tts_router._build_runtime_tts_config(
        tts_router.TTSConfigRequest(
            provider="openai_api",
            openai_api={
                "base_url": "https://api.openai.com/v1",
                "api_key": "sk-****1234",
                "model": "tts-1",
                "voice": "alloy",
                "speed": 1.0,
            },
        ),
        {
            "openai_api": {
                "api_key": "sk-live-secret",
            }
        },
    )

    assert runtime_config["openai_api"]["api_key"] == "sk-live-secret"
