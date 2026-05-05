from app.services.tts_providers import (
    EDGE_VOICE_MAP,
    EdgeTTSProvider,
    Qwen3TTSProvider,
    build_provider_from_config,
    normalize_tts_speed,
)


def test_qwen_prepare_text_keeps_japanese_text():
    assert Qwen3TTSProvider._prepare_text("こんにちは 2025") == "こんにちは 2025"


def test_qwen_prepare_text_keeps_chinese_text():
    assert Qwen3TTSProvider._prepare_text("你好 2025") == "你好 2025"


def test_qwen_prepare_text_normalizes_english_numbers():
    prepared = Qwen3TTSProvider._prepare_text("In 2025, I read 3 books.")
    assert "2025" not in prepared
    assert "3" not in prepared


def test_edge_voice_map_contains_japanese_voices():
    assert EDGE_VOICE_MAP["nanami"] == "ja-JP-NanamiNeural"
    assert EDGE_VOICE_MAP["keita"] == "ja-JP-KeitaNeural"


def test_normalize_tts_speed_clamps_to_valid_range():
    assert normalize_tts_speed(None) == 1.0
    assert normalize_tts_speed(0.1) == 0.5
    assert normalize_tts_speed(1.25) == 1.25
    assert normalize_tts_speed(9) == 2.0


def test_edge_provider_converts_speed_to_rate():
    assert EdgeTTSProvider._speed_to_rate(1.0) == "+0%"
    assert EdgeTTSProvider._speed_to_rate(1.25) == "+25%"
    assert EdgeTTSProvider._speed_to_rate(0.8) == "-20%"


def test_build_provider_from_config_passes_edge_speed():
    provider = build_provider_from_config({
        "provider": "edge",
        "edge": {"speed": 1.3},
    })

    assert isinstance(provider, EdgeTTSProvider)
    assert provider.speed == 1.3
