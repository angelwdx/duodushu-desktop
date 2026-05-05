from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.book_language_service import detect_book_language, normalize_book_language
from app.services.japanese_text_service import annotate_japanese_text, normalize_japanese_text_for_tts


def test_normalize_book_language_handles_common_values():
    assert normalize_book_language("ja-JP") == "ja"
    assert normalize_book_language("en_US") == "en"
    assert normalize_book_language("zh-Hans") == "zh"
    assert normalize_book_language("fr") == "unknown"


def test_detect_book_language_prefers_metadata_and_japanese_signal():
    assert detect_book_language("This is a novel written in English.", metadata_language="ja") == "ja"
    assert detect_book_language("これは日本語の小説です。漢字にふりがなを付けたい。") == "ja"
    assert detect_book_language("This is a novel written in English with several paragraphs of plain prose.") == "en"


def test_annotate_japanese_text_adds_ruby_for_common_okurigana_words():
    result = annotate_japanese_text("食べる")

    assert result["has_furigana"] is True
    assert result["segments"] == [
        {"type": "ruby", "base": "食", "reading": "た"},
        {"type": "text", "text": "べる"},
    ]


def test_annotate_japanese_text_handles_kana_prefix_and_suffix():
    result = annotate_japanese_text("お母さん")

    assert result["has_furigana"] is True
    assert result["segments"] == [
        {"type": "text", "text": "お"},
        {"type": "ruby", "base": "母", "reading": "かあ"},
        {"type": "text", "text": "さん"},
    ]


def test_annotate_japanese_text_handles_common_exception_readings():
    result = annotate_japanese_text("一昨日")

    assert result["has_furigana"] is True
    assert result["segments"] == [
        {"type": "ruby", "base": "一昨日", "reading": "おととい"},
    ]


def test_annotate_japanese_text_handles_spaced_compound_words():
    result = annotate_japanese_text("女 の 夜 市")

    assert result["has_furigana"] is True
    assert result["segments"] == [
        {"type": "ruby", "base": "女", "reading": "おんな"},
        {"type": "text", "text": " の "},
        {"type": "ruby", "base": "夜 市", "reading": "よるいち"},
    ]


def test_annotate_japanese_text_handles_spaced_place_names():
    result = annotate_japanese_text("勇は 上 石 原")

    assert result["has_furigana"] is True
    assert result["segments"] == [
        {"type": "ruby", "base": "勇", "reading": "いさみ"},
        {"type": "text", "text": "は "},
        {"type": "ruby", "base": "上 石 原", "reading": "かみいしはら"},
    ]


def test_annotate_japanese_text_handles_kondo_isami_name_reading():
    result = annotate_japanese_text("近藤勇")

    assert result["has_furigana"] is True
    assert result["segments"] == [
        {"type": "ruby", "base": "近藤勇", "reading": "こんどういさみ"},
    ]


def test_annotate_japanese_text_handles_contextual_compound_nouns():
    result = annotate_japanese_text("石田村百姓")

    assert result["has_furigana"] is True
    assert result["segments"] == [
        {"type": "ruby", "base": "石田村百姓", "reading": "いしだむらびゃくしょう"},
    ]


def test_annotate_japanese_text_merges_kanji_suffix_compounds():
    result = annotate_japanese_text("住宅街は街灯もまばらで")

    assert result["has_furigana"] is True
    assert result["segments"] == [
        {"type": "ruby", "base": "住宅街", "reading": "じゅうたくがい"},
        {"type": "text", "text": "は"},
        {"type": "ruby", "base": "街灯", "reading": "がいとう"},
        {"type": "text", "text": "もまばらで"},
    ]


def test_annotate_japanese_text_skips_plain_kana():
    result = annotate_japanese_text("こんにちは")

    assert result["has_furigana"] is False
    assert result["segments"] == [{"type": "text", "text": "こんにちは"}]


def test_normalize_japanese_text_for_tts_reuses_furigana_readings():
    assert normalize_japanese_text_for_tts("お母さんは一昨日来た。") == "お母さんはおととい来た。"


def test_normalize_japanese_text_for_tts_handles_spacing_and_contextual_readings():
    assert normalize_japanese_text_for_tts("女 の 夜 市") == "女のよるいち"
    assert normalize_japanese_text_for_tts("石田村百姓") == "いしだむらびゃくしょう"
    assert normalize_japanese_text_for_tts("勇は 上 石 原") == "いさみはかみいしはら"
    assert normalize_japanese_text_for_tts("環 状 八 号 線") == "環状八号線"
    assert normalize_japanese_text_for_tts("二十分ほどしか離れていない") == "二十分ほどしか離れていない"
    assert normalize_japanese_text_for_tts("住宅街は街灯もまばらで") == "住宅街は街灯もまばらで"
    assert normalize_japanese_text_for_tts("星空とは比べるべくもないが") == "星空とは比べるべくもないが"


def test_normalize_japanese_text_for_tts_repairs_fullsize_tsu_extraction_errors():
    assert normalize_japanese_text_for_tts("浴槽に浸つかった") == "浴槽に浸かった"
    assert normalize_japanese_text_for_tts("彼は勝つていた") == "彼は勝っていた"


def test_normalize_japanese_text_for_tts_keeps_valid_tsu_verbs():
    assert normalize_japanese_text_for_tts("持つから大丈夫だ") == "持つから大丈夫だ"


def test_normalize_japanese_text_for_tts_normalizes_particles_and_punctuation():
    assert normalize_japanese_text_for_tts("彼は、海へ本を持っていく...") == "彼は、海へ本を持っていく。"
    assert normalize_japanese_text_for_tts("山/川(谷)") == "山、川、谷"
