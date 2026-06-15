from pathlib import Path
import sys
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import dict_service
from app.services import jmdict_service


@pytest.fixture(autouse=True)
def clear_lemma_caches():
    dict_service._get_ecdict_entry_info.cache_clear()
    yield
    dict_service._get_ecdict_entry_info.cache_clear()


def test_get_lemma_candidates_handles_double_consonant_and_plural():
    candidates = dict_service._get_lemma_candidates("spotted", validate_candidates=False)
    assert "spot" in [candidate.lower() for candidate in candidates]

    candidates = dict_service._get_lemma_candidates("hits", validate_candidates=False)
    assert "hit" in [candidate.lower() for candidate in candidates]

    candidates = dict_service._get_lemma_candidates("strewn", validate_candidates=False)
    assert "strew" in [candidate.lower() for candidate in candidates]

    candidates = dict_service._get_lemma_candidates("scatter", validate_candidates=False)
    assert "scat" not in [candidate.lower() for candidate in candidates]

    candidates = dict_service._get_lemma_candidates("peer", validate_candidates=False)
    assert "pe" not in [candidate.lower() for candidate in candidates]


def test_get_lemma_candidates_handles_regular_and_irregular_inflections():
    assert "large" in [candidate.lower() for candidate in dict_service._get_lemma_candidates("larger")]
    assert "big" in [candidate.lower() for candidate in dict_service._get_lemma_candidates("biggest")]
    assert "late" in [candidate.lower() for candidate in dict_service._get_lemma_candidates("later")]
    assert "happy" in [candidate.lower() for candidate in dict_service._get_lemma_candidates("happier")]
    assert "early" in [candidate.lower() for candidate in dict_service._get_lemma_candidates("earlier")]
    assert "movie" in [candidate.lower() for candidate in dict_service._get_lemma_candidates("movies")]
    assert "die" in [candidate.lower() for candidate in dict_service._get_lemma_candidates("died")]
    assert "have" in [candidate.lower() for candidate in dict_service._get_lemma_candidates("has")]
    assert "be" in [candidate.lower() for candidate in dict_service._get_lemma_candidates("is")]
    assert "good" in [candidate.lower() for candidate in dict_service._get_lemma_candidates("best")]


def test_get_lemma_candidates_avoids_common_false_positives():
    assert "care" not in [candidate.lower() for candidate in dict_service._get_lemma_candidates("career")]
    assert "carry" not in [candidate.lower() for candidate in dict_service._get_lemma_candidates("carrier")]
    assert "fore" not in [candidate.lower() for candidate in dict_service._get_lemma_candidates("forest")]
    assert "thi" not in [candidate.lower() for candidate in dict_service._get_lemma_candidates("this")]
    assert "hi" not in [candidate.lower() for candidate in dict_service._get_lemma_candidates("his")]
    assert "her" not in [candidate.lower() for candidate in dict_service._get_lemma_candidates("hers")]
    assert "ye" not in [candidate.lower() for candidate in dict_service._get_lemma_candidates("yes")]


def test_lookup_word_all_sources_falls_back_to_lemma_ecdict(monkeypatch):
    class StubDictManager:
        def get_dicts(self):
            return []

        def lookup_word(self, word, source=None):
            return None

        def word_exists(self, word):
            return False

    def fake_get_word_details(word):
        if word == "spot":
            return {
                "word": "spot",
                "phonetic": "/spɒt/",
                "translation": "斑点；发现",
                "definition": "to notice or see",
                "pos": "v.",
            }
        return None

    monkeypatch.setattr(dict_service, "get_dict_manager", lambda: StubDictManager())
    monkeypatch.setattr(dict_service.ecdict_service, "get_word_details", fake_get_word_details)

    result = dict_service.lookup_word_all_sources(db=None, word="spotted")

    assert result is not None
    assert result["word"] == "spot"
    assert result["lookup_term"] == "spotted"
    assert result["lemma_from"] == "spot"
    assert result["source"] == "ECDICT"


def test_lookup_word_all_sources_tries_lemma_per_dictionary(monkeypatch):
    class StubDictManager:
        def get_dicts(self):
            return [
                {"name": "DirectDict", "type": "imported", "is_active": True},
                {"name": "LemmaDict", "type": "imported", "is_active": True},
            ]

        def lookup_word(self, word, source=None):
            if source == "DirectDict" and word == "flecks":
                return {"word": "flecks", "meanings": [{"partOfSpeech": "n.", "definitions": [{"definition": "small marks"}]}]}
            if source == "LemmaDict" and word == "fleck":
                return {"word": "fleck", "meanings": [{"partOfSpeech": "n.", "definitions": [{"definition": "a small spot"}]}]}
            return None

        def word_exists(self, word):
            return word == "fleck"

    def fake_get_word_details(word):
        if word == "flecks":
            return {
                "word": "flecks",
                "phonetic": "/fleks/",
                "translation": "斑点",
                "definition": "small marks",
                "pos": "n.",
            }
        if word == "fleck":
            return {
                "word": "fleck",
                "phonetic": "/flek/",
                "translation": "小斑点",
                "definition": "a small spot",
                "pos": "n.",
            }
        return None

    monkeypatch.setattr(dict_service, "get_dict_manager", lambda: StubDictManager())
    monkeypatch.setattr(dict_service.ecdict_service, "get_word_details", fake_get_word_details)

    result = dict_service.lookup_word_all_sources(db=None, word="flecks")

    assert result is not None
    assert result["word"] == "fleck"
    assert result["lookup_term"] == "flecks"
    assert result["multiple_sources"] is True
    assert result["preferred_source"] == "LemmaDict"
    assert len(result["results"]) == 2
    lemma_result = next(item for item in result["results"] if item["source"] == "LemmaDict")
    assert lemma_result["word"] == "fleck"
    assert lemma_result["lookup_term"] == "flecks"
    assert lemma_result["lemma_from"] == "fleck"


def test_lookup_word_keeps_original_lookup_term_when_dictionary_redirects(monkeypatch):
    class StubDictManager:
        def lookup_word(self, word, source=None):
            if source == "LemmaDict" and word == "strewn":
                return {
                    "word": "strew",
                    "meanings": [{"partOfSpeech": "v.", "definitions": [{"definition": "scatter things"}]}],
                }
            return None

        def word_exists(self, word):
            return word == "strew"

    def fake_get_word_details(word):
        if word == "strew":
            return {
                "word": "strew",
                "phonetic": "/struː/",
                "translation": "散播",
                "definition": "scatter or spread",
                "pos": "v.",
            }
        return None

    monkeypatch.setattr(dict_service, "get_dict_manager", lambda: StubDictManager())
    monkeypatch.setattr(dict_service.ecdict_service, "get_word_details", fake_get_word_details)
    monkeypatch.setattr(dict_service.ecdict_service, "get_translation", lambda word: "散播" if word == "strew" else None)

    result = dict_service.lookup_word(db=None, word="strewn", source="LemmaDict")

    assert result is not None
    assert result["word"] == "strew"
    assert result["lookup_term"] == "strewn"
    assert result["lemma_from"] == "strew"


def test_lookup_word_prefers_lemma_before_original(monkeypatch):
    class StubDictManager:
        def lookup_word(self, word, source=None):
            if source == "LemmaDict" and word == "spot":
                return {
                    "word": "spot",
                    "meanings": [{"partOfSpeech": "v.", "definitions": [{"definition": "notice"}]}],
                }
            if source == "LemmaDict" and word == "spotted":
                return {
                    "word": "spotted",
                    "meanings": [{"partOfSpeech": "adj.", "definitions": [{"definition": "marked with spots"}]}],
                }
            return None

        def word_exists(self, word):
            return word == "spot"

    def fake_get_word_details(word):
        if word == "spot":
            return {
                "word": "spot",
                "phonetic": "/spɒt/",
                "translation": "发现",
                "definition": "notice",
                "pos": "v.",
            }
        if word == "spotted":
            return {
                "word": "spotted",
                "phonetic": "/ˈspɒtɪd/",
                "translation": "有斑点的",
                "definition": "marked with spots",
                "pos": "adj.",
            }
        return None

    monkeypatch.setattr(dict_service, "get_dict_manager", lambda: StubDictManager())
    monkeypatch.setattr(dict_service.ecdict_service, "get_word_details", fake_get_word_details)

    result = dict_service.lookup_word(db=None, word="spotted", source="LemmaDict")

    assert result is not None
    assert result["word"] == "spot"
    assert result["lookup_term"] == "spotted"
    assert result["lemma_from"] == "spot"


def test_get_lookup_terms_generates_korean_fallbacks(monkeypatch):
    known_terms = {
        "학교", "먹다", "공부하다", "좋다", "가다", "나무라다",
        "시작하다", "말하다", "끌리다", "크다", "작다", "보이다", "무채색",
        "개성있다", "기다리다", "테이블", "힘있다", "없다", "약속시간", "늦다",
        "않다", "되다", "나오다", "남자", "가느다랗다", "원인", "신경쓰이다",
        "브래지어",
    }

    monkeypatch.setattr(dict_service, "_candidate_exists", lambda candidate: candidate in known_terms)

    def assert_terms_start(word, expected_prefix):
        assert dict_service._get_lookup_terms(word)[: len(expected_prefix)] == expected_prefix

    assert_terms_start("학교에", ["학교에", "학교"])
    assert_terms_start("먹어요", ["먹어요", "먹다"])
    assert_terms_start("공부해요", ["공부해요", "공부하다"])
    assert_terms_start("좋아요", ["좋아요", "좋다"])
    assert_terms_start("갑니다", ["갑니다", "가다"])
    assert_terms_start("갔다", ["갔다", "가다"])
    assert_terms_start("나무라자", ["나무라자", "나무라다"])
    assert_terms_start("나무라라", ["나무라라", "나무라다"])
    assert_terms_start("먹어라", ["먹어라", "먹다"])
    assert_terms_start("공부해라", ["공부해라", "공부하다"])
    assert_terms_start("시작하기", ["시작하기", "시작하다"])
    assert_terms_start("말하자면", ["말하자면", "말하다"])
    assert_terms_start("끌리지도", ["끌리지도", "끌리다"])
    assert_terms_start("크지도", ["크지도", "크다"])
    assert_terms_start("작지도", ["작지도", "작다"])
    assert_terms_start("보이는", ["보이는", "보이다"])
    assert_terms_start("무채색의", ["무채색의", "무채색"])
    assert_terms_start("개성있어 보이는", ["개성있어 보이는", "개성있다", "보이다"])
    assert_terms_start("개성있어", ["개성있어", "개성있다"])
    assert_terms_start("기다리는", ["기다리는", "기다리다"])
    assert_terms_start("테이블로", ["테이블로", "테이블"])
    assert_terms_start("힘있지도", ["힘있지도", "힘있다"])
    assert_terms_start("없어 보였기", ["없어 보였기", "없다", "보이다"])
    assert_terms_start("약속시간에", ["약속시간에", "약속시간"])
    assert_terms_start("늦을까봐", ["늦을까봐", "늦다"])
    assert_terms_start("않아도", ["않아도", "않다"])
    assert_terms_start("되었으며", ["되었으며", "되다"])
    assert_terms_start("나오는", ["나오는", "나오다"])
    assert_terms_start("남자들과", ["남자들과", "남자"])
    assert_terms_start("가느다란", ["가느다란", "가느다랗다"])
    assert_terms_start("원인이었던", ["원인이었던", "원인"])
    assert_terms_start("작은", ["작은", "작다"])
    assert_terms_start("신경쓰이지", ["신경쓰이지", "신경쓰이다"])
    assert_terms_start("브래지어를", ["브래지어를", "브래지어"])


def test_lookup_word_uses_korean_fallback_for_imported_dictionary(monkeypatch):
    class StubDictManager:
        def lookup_word(self, word, source=None):
            if source == "KoreanDict" and word == "먹다":
                return {
                    "word": "먹다",
                    "source": "KoreanDict",
                    "html_content": "<div>to eat</div>",
                    "meanings": [{"partOfSpeech": "v.", "definitions": [{"definition": "to eat"}]}],
                }
            return None

        def word_exists(self, word):
            return word == "먹다"

    monkeypatch.setattr(dict_service, "get_dict_manager", lambda: StubDictManager())
    monkeypatch.setattr(dict_service.ecdict_service, "get_word_details", lambda word: None)

    result = dict_service.lookup_word(db=None, word="먹어요", source="KoreanDict")

    assert result is not None
    assert result["word"] == "먹다"
    assert result["lookup_term"] == "먹어요"
    assert result["lemma_from"] == "먹다"


def test_lookup_word_all_sources_limits_korean_to_korean_dictionaries(monkeypatch):
    lookup_calls = []

    class StubDictManager:
        def get_dicts(self):
            return [
                {"name": "Oxford", "type": "imported", "is_active": True},
                {"name": "韩语", "type": "imported", "is_active": True},
                {"name": "大辞泉", "type": "imported", "is_active": True},
            ]

        def lookup_word(self, word, source=None):
            lookup_calls.append((word, source))
            if source == "韩语" and word == "먹다":
                return {
                    "word": "먹다",
                    "source": "韩语",
                    "html_content": "<div>to eat</div>",
                    "meanings": [{"partOfSpeech": "v.", "definitions": [{"definition": "to eat"}]}],
                }
            return None

        def word_exists(self, word):
            return word == "먹다"

    monkeypatch.setattr(dict_service, "get_dict_manager", lambda: StubDictManager())
    monkeypatch.setattr(dict_service.ecdict_service, "get_word_details", lambda word: None)

    result = dict_service.lookup_word_all_sources(db=None, word="먹어요")

    assert result is not None
    assert result["word"] == "먹다"
    assert result["source"] == "韩语"
    assert ("먹어요", "Oxford") not in lookup_calls
    assert ("먹어요", "大辞泉") not in lookup_calls
    assert lookup_calls == [("먹어요", "韩语"), ("먹다", "韩语")]


def test_cached_korean_result_ignores_stale_word(monkeypatch):
    class Row:
        def __init__(self, data):
            self.data = data

    class Query:
        def __init__(self, row):
            self.row = row

        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return self.row

    class StubDB:
        def __init__(self, row):
            self.row = row

        def query(self, _model):
            return Query(self.row)

    stale_row = Row({"word": "브래지다", "source": "AI"})
    result = dict_service._get_cached_dictionary_result(StubDB(stale_row), "브래지어를", "브래지어")

    assert result is None


def test_jmdict_service_returns_known_japanese_entry():
    result = jmdict_service.get_word_details("一軒家")

    assert result is not None
    assert result["word"] == "一軒家"
    assert result["source"] == "JMdict"
    assert result["is_jmdict"] is True
    assert result["phonetic"] == "いっけんや"
    assert result["meanings"]


def test_lookup_word_uses_japanese_lemma_for_jmdict():
    result = dict_service.lookup_word(db=None, word="行った", source="JMdict")

    assert result is not None
    assert result["word"] == "行く"
    assert result["lookup_term"] == "行った"
    assert result["lemma_from"] == "行く"
    assert result["source"] == "JMdict"
