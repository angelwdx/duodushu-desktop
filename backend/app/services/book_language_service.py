import re
from typing import Optional


HIRAGANA_RE = re.compile(r"[\u3040-\u309F]")
KATAKANA_RE = re.compile(r"[\u30A0-\u30FF\u31F0-\u31FF]")
KANJI_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々〆ヵヶ]")
LATIN_RE = re.compile(r"[A-Za-z]")

SUPPORTED_LANGUAGE_PREFIXES = {
    "ja": "ja",
    "en": "en",
    "zh": "zh",
}


def normalize_book_language(language: Optional[str]) -> str:
    if not language:
        return "unknown"

    normalized = language.strip().lower().replace("_", "-")
    if not normalized:
        return "unknown"

    for prefix, value in SUPPORTED_LANGUAGE_PREFIXES.items():
        if normalized == prefix or normalized.startswith(f"{prefix}-"):
            return value

    return "unknown"


def contains_japanese_text(text: Optional[str]) -> bool:
    if not text:
        return False
    return bool(HIRAGANA_RE.search(text) or KATAKANA_RE.search(text) or KANJI_RE.search(text))


def detect_book_language(text: Optional[str], metadata_language: Optional[str] = None) -> str:
    normalized_metadata = normalize_book_language(metadata_language)
    if normalized_metadata != "unknown":
        return normalized_metadata

    if not text:
        return "unknown"

    sample = text[:12000]
    hiragana_count = len(HIRAGANA_RE.findall(sample))
    katakana_count = len(KATAKANA_RE.findall(sample))
    kanji_count = len(KANJI_RE.findall(sample))
    latin_count = len(LATIN_RE.findall(sample))

    japanese_phonetic_count = hiragana_count + katakana_count
    total_signal_count = japanese_phonetic_count + kanji_count + latin_count

    if total_signal_count == 0:
        return "unknown"

    # 日文正文通常会同时包含假名和汉字；只出现少量汉字更像中文或混排噪音。
    if japanese_phonetic_count >= 8 and (japanese_phonetic_count + kanji_count) >= max(12, latin_count // 2):
        return "ja"

    if latin_count >= 24 and latin_count >= (japanese_phonetic_count + kanji_count) * 2:
        return "en"

    if kanji_count >= 16 and japanese_phonetic_count == 0:
        return "zh"

    if japanese_phonetic_count > 0:
        return "ja"

    return "unknown"
