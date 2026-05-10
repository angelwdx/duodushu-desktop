from pathlib import Path
import sys

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models.database import Base
from app.models.models import CacheFurigana
from app.services.book_language_service import detect_book_language, normalize_book_language
from app.services import japanese_text_service
from app.services.japanese_text_service import (
    annotate_japanese_text,
    annotate_japanese_texts,
    build_japanese_lookup_segments,
    normalize_japanese_text_for_tts,
)


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    Base.metadata.create_all(bind=engine, tables=[CacheFurigana.__table__])
    session = SessionLocal()

    try:
        yield session
    finally:
        session.close()
        engine.dispose()


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


def test_annotate_japanese_text_handles_counter_compound_home_words():
    result = annotate_japanese_text("一軒家")

    assert result["has_furigana"] is True
    assert result["segments"] == [
        {"type": "ruby", "base": "一軒家", "reading": "いっけんや"},
    ]
    assert result["lookup_segments"] == [
        {"text": "一軒家", "lookup_text": "一軒家", "start": 0, "end": 3},
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
    assert normalize_japanese_text_for_tts("一軒家に帰る") == "いっけんやに帰る"
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


def test_build_japanese_lookup_segments_skips_particles_and_merges_honorifics():
    assert build_japanese_lookup_segments("彼は学校へ行く。") == [
        {"text": "彼", "lookup_text": "彼", "start": 0, "end": 1},
        {"text": "学校", "lookup_text": "学校", "start": 2, "end": 4},
        {"text": "行く", "lookup_text": "行く", "start": 5, "end": 7},
    ]
    assert build_japanese_lookup_segments("お母さんが帰ってきた。") == [
        {"text": "お母さん", "lookup_text": "お母さん", "start": 0, "end": 4},
        {"text": "帰っ", "lookup_text": "帰っ", "start": 5, "end": 7},
    ]
    assert build_japanese_lookup_segments("こんにちは、ありがとう。") == [
        {"text": "こんにちは", "lookup_text": "こんにちは", "start": 0, "end": 5},
        {"text": "ありがとう", "lookup_text": "ありがとう", "start": 6, "end": 11},
    ]


def test_build_japanese_lookup_segments_projects_spaced_tokens_back_to_original_text():
    assert build_japanese_lookup_segments("女 の 夜 市") == [
        {"text": "女", "lookup_text": "女", "start": 0, "end": 1},
        {"text": "夜 市", "lookup_text": "夜市", "start": 4, "end": 7},
    ]


def test_annotate_japanese_texts_reuses_cached_duplicates_in_one_batch(db_session, monkeypatch):
    call_count = 0
    original_annotate = japanese_text_service.annotate_japanese_text

    def counting_annotate(text: str):
        nonlocal call_count
        call_count += 1
        return original_annotate(text)

    monkeypatch.setattr(japanese_text_service, "annotate_japanese_text", counting_annotate)

    results = annotate_japanese_texts(["一軒家", "一軒家"], db_session)

    assert [item["text"] for item in results] == ["一軒家", "一軒家"]
    assert results[0]["segments"] == results[1]["segments"]
    assert results[0]["lookup_segments"] == results[1]["lookup_segments"]
    assert call_count == 1
    assert db_session.query(CacheFurigana).count() == 1
