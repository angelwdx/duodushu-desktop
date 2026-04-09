from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import dict_service


def test_get_lemma_candidates_handles_double_consonant_and_plural():
    candidates = dict_service._get_lemma_candidates("spotted", validate_candidates=False)
    assert "spot" in [candidate.lower() for candidate in candidates]

    candidates = dict_service._get_lemma_candidates("hits", validate_candidates=False)
    assert "hit" in [candidate.lower() for candidate in candidates]


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
