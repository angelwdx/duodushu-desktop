import re
from typing import List


LOOKUP_SEGMENT_RE = re.compile(r"[A-Za-zÀ-ÿ]+(?:['’][A-Za-zÀ-ÿ]+)*")
JAPANESE_CHAR_RE = re.compile(r"[\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF々〆ヵヶ]")
JAPANESE_EDGE_PUNCTUATION_RE = re.compile(r"^[\s\u3000「」『』【】（）()［］｛｝〈〉《》〔〕〝〟'\"、。！？・…]+|[\s\u3000「」『』【】（）()［］｛｝〈〉《》〔〕〝〟'\"、。！？・…]+$")
JAPANESE_INLINE_SPACE_RE = re.compile(r"[ \t\u3000]+")
CONTRACTION_SUFFIXES = ("n't", "'m", "'re", "'ve", "'ll", "'d")
CONTRACTION_WORDS = {
    "it's",
    "that's",
    "what's",
    "who's",
    "there's",
    "here's",
    "let's",
    "he's",
    "she's",
    "how's",
    "where's",
    "when's",
    "why's",
}


def extract_lookup_segments(text: str) -> List[str]:
    if not text:
        return []
    return [match.group(0) for match in LOOKUP_SEGMENT_RE.finditer(text)]


def normalize_lookup_word(raw: str) -> str:
    if not raw:
        return ""

    word = raw.strip().replace("\u2019", "'").replace("\u2018", "'")
    if not word:
        return ""

    if JAPANESE_CHAR_RE.search(word):
        normalized = JAPANESE_EDGE_PUNCTUATION_RE.sub("", word)
        normalized = JAPANESE_INLINE_SPACE_RE.sub("", normalized)
        return normalized.strip()

    full_match = LOOKUP_SEGMENT_RE.fullmatch(word)
    if not full_match:
        segments = extract_lookup_segments(word)
        if not segments:
            return ""
        word = segments[0]

    lower_word = word.lower()
    is_contraction = lower_word.endswith(CONTRACTION_SUFFIXES) or lower_word in CONTRACTION_WORDS

    if lower_word.endswith("'s") and not is_contraction:
        word = word[:-2]

    return word.strip("'").lower()
