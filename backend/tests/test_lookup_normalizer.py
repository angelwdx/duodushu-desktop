from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.utils.lookup_normalizer import extract_lookup_segments, normalize_lookup_word


def test_normalize_lookup_word_strips_possessive_and_punctuation():
    assert normalize_lookup_word(" John's ") == "john"
    assert normalize_lookup_word("formed,") == "formed"


def test_normalize_lookup_word_preserves_contractions():
    assert normalize_lookup_word("it's") == "it's"
    assert normalize_lookup_word("don't") == "don't"


def test_extract_lookup_segments_splits_dashed_tokens():
    assert extract_lookup_segments("sand—hits") == ["sand", "hits"]
    assert extract_lookup_segments("dust-usually") == ["dust", "usually"]
