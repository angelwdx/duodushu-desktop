import re
from typing import Optional


HIRAGANA_RE = re.compile(r"[\u3040-\u309F]")
KATAKANA_RE = re.compile(r"[\u30A0-\u30FF\u31F0-\u31FF]")
KANJI_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々〆ヵヶ]")
HANGUL_RE = re.compile(r"[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]")
LATIN_RE = re.compile(r"[A-Za-z]")

SUPPORTED_LANGUAGE_ALIASES = {
    "ja": "ja",
    "jpn": "ja",
    "jp": "ja",
    "en": "en",
    "eng": "en",
    "zh": "zh",
    "zho": "zh",
    "chi": "zh",
    "ko": "ko",
    "kor": "ko",
    "kr": "ko",
}


def normalize_book_language(language: Optional[str]) -> str:
    if not language:
        return "unknown"

    normalized = language.strip().lower().replace("_", "-")
    if not normalized:
        return "unknown"

    for alias, value in SUPPORTED_LANGUAGE_ALIASES.items():
        if normalized == alias or normalized.startswith(f"{alias}-"):
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
    hangul_count = len(HANGUL_RE.findall(sample))
    latin_count = len(LATIN_RE.findall(sample))

    japanese_phonetic_count = hiragana_count + katakana_count
    total_signal_count = japanese_phonetic_count + kanji_count + hangul_count + latin_count

    if total_signal_count == 0:
        return "unknown"

    if hangul_count >= 8 and hangul_count >= (japanese_phonetic_count + kanji_count) * 2:
        return "ko"

    # 日文正文通常会同时包含假名和汉字；只出现少量汉字更像中文或混排噪音。
    if japanese_phonetic_count >= 8 and (japanese_phonetic_count + kanji_count) >= max(12, latin_count // 2):
        return "ja"

    if latin_count >= 24 and latin_count >= (japanese_phonetic_count + kanji_count + hangul_count) * 2:
        return "en"

    if kanji_count >= 16 and japanese_phonetic_count == 0 and hangul_count == 0:
        return "zh"

    if hangul_count > 0 and hangul_count >= japanese_phonetic_count + kanji_count:
        return "ko"

    if japanese_phonetic_count > 0:
        return "ja"

    return "unknown"
