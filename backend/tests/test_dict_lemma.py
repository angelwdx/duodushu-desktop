from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import dict_service


def test_get_lemma_candidates_handles_double_consonant_and_plural():
    candidates = dict_service._get_lemma_candidates("spotted", validate_candidates=False)
    assert "spot" in [candidate.lower() for candidate in candidates]

    candidates = dict_service._get_lemma_candidates("hits", validate_candidates=False)
    assert "hit" in [candidate.lower() for candidate in candidates]

    candidates = dict_service._get_lemma_candidates("strewn", validate_candidates=False)
    assert "strew" in [candidate.lower() for candidate in candidates]


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
    assert result["word"] == "spotted"
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
    assert result["word"] == "flecks"
    assert result["lookup_term"] == "flecks"
    assert result["multiple_sources"] is True
    assert len(result["results"]) == 2
    lemma_result = next(item for item in result["results"] if item["source"] == "LemmaDict")
    assert lemma_result["word"] == "flecks"
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
    assert result["word"] == "strewn"
    assert result["lookup_term"] == "strewn"
    assert result["lemma_from"] == "strew"
