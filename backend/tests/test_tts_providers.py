from app.services.tts_providers import EDGE_VOICE_MAP, Qwen3TTSProvider


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
