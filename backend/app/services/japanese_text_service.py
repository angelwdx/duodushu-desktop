import hashlib
from functools import lru_cache
import re
from typing import Any

from sqlalchemy.orm import Session

from app.models.models import CacheFurigana
from app.services.book_language_service import contains_japanese_text

KANJI_CHARACTERS = set("々〆ヵヶ")
INLINE_JAPANESE_SPACING_RE = re.compile(r"[ \t\u3000]+")
JAPANESE_READING_VERSION = "fugashi-unidic-lite-v9"
JAPANESE_PAUSE_RE = re.compile(r"[、]{2,}")
JAPANESE_ELLIPSIS_RE = re.compile(r"(?:\.{3,}|…{2,}|‥{2,})")
JAPANESE_BRACKETS_RE = re.compile(r"[()\[\]{}（）［］｛｝【】〈〉《》]")
JAPANESE_PUNCTUATION_SPACING_RE = re.compile(r"\s*([、。！？])\s*")
READING_OVERRIDES: tuple[tuple[str, str], ...] = (
    ("土方歳三", "ひじかたとしぞう"),
    ("近藤勇", "こんどういさみ"),
    ("石田村百姓", "いしだむらびゃくしょう"),
    ("一軒家", "いっけんや"),
    ("一軒", "いっけん"),
    ("勇", "いさみ"),
    ("新選組", "しんせんぐみ"),
    ("上石原", "かみいしはら"),
    ("副長", "ふくちょう"),
    ("局長", "きょくちょう"),
    ("夜市", "よるいち"),
    ("お父様", "おとうさま"),
    ("お母様", "おかあさま"),
    ("お兄様", "おにいさま"),
    ("お姉様", "おねえさま"),
    ("お父さん", "おとうさん"),
    ("お母さん", "おかあさん"),
    ("お兄さん", "おにいさん"),
    ("お姉さん", "おねえさん"),
    ("村百姓", "むらびゃくしょう"),
    ("一昨日", "おととい"),
)
TTS_PRESERVE_SURFACES = {
    "お父様",
    "お母様",
    "お兄様",
    "お姉様",
    "お父さん",
    "お母さん",
    "お兄さん",
    "お姉さん",
}
NUMBER_LIKE_SURFACES = set("0123456789〇一二三四五六七八九十百千万億兆")
COUNTER_SURFACES = {"号"}
LOOKUP_EXCLUDED_POS1 = {"助詞", "助動詞", "補助記号", "記号"}
LOOKUP_EXCLUDED_POS2 = {"非自立可能"}


def _is_hiragana(char: str) -> bool:
    return "\u3040" <= char <= "\u309f"


def _is_katakana(char: str) -> bool:
    return "\u30a0" <= char <= "\u30ff" or "\u31f0" <= char <= "\u31ff"


def _is_kana(char: str) -> bool:
    return _is_hiragana(char) or _is_katakana(char)


def _is_kanji(char: str) -> bool:
    return (
        "\u3400" <= char <= "\u4dbf"
        or "\u4e00" <= char <= "\u9fff"
        or "\uf900" <= char <= "\ufaff"
        or char in KANJI_CHARACTERS
    )


def _is_all_kanji(text: str) -> bool:
    return bool(text) and all(_is_kanji(char) for char in text)


def _is_japanese_analysis_char(char: str) -> bool:
    return _is_kana(char) or _is_kanji(char)


def katakana_to_hiragana(text: str) -> str:
    converted: list[str] = []
    for char in text:
        code = ord(char)
        if 0x30A1 <= code <= 0x30F6:
            converted.append(chr(code - 0x60))
        else:
            converted.append(char)
    return "".join(converted)


def _build_text_segment(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def _build_ruby_segment(base: str, reading: str) -> dict[str, Any]:
    return {"type": "ruby", "base": base, "reading": reading}


def _build_reading_token(
    surface: str,
    reading: str | None,
    *,
    pos1: str | None = None,
    pos2: str | None = None,
) -> dict[str, str | None]:
    return {
        "surface": surface,
        "reading": reading,
        "pos1": pos1,
        "pos2": pos2,
    }


def _build_lookup_segment(
    text: str,
    start: int,
    end: int,
    *,
    lookup_text: str | None = None,
) -> dict[str, Any]:
    return {
        "text": text,
        "lookup_text": lookup_text or text,
        "start": start,
        "end": end,
    }


def _build_fugashi_word_entry(
    surface: str,
    reading: str | None,
    *,
    start: int,
    end: int,
    pos1: str | None = None,
    pos2: str | None = None,
) -> dict[str, Any]:
    return {
        "surface": surface,
        "reading": reading,
        "start": start,
        "end": end,
        "pos1": pos1,
        "pos2": pos2,
    }


def _merge_adjacent_text_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []

    for segment in segments:
        if (
            segment["type"] == "text"
            and merged
            and merged[-1]["type"] == "text"
        ):
            merged[-1]["text"] += segment["text"]
        else:
            merged.append(segment.copy())

    return merged


def build_japanese_reading_cache_key(text: str) -> str:
    return hashlib.md5(f"{JAPANESE_READING_VERSION}:{text}".encode("utf-8")).hexdigest()


def _normalize_text_for_analysis(text: str) -> tuple[str, list[int]]:
    normalized_chars: list[str] = []
    normalized_index_map: list[int] = []
    text_length = len(text)
    previous_kept_char: str | None = None

    for index, char in enumerate(text):
        if INLINE_JAPANESE_SPACING_RE.fullmatch(char):
            next_index = index + 1
            next_non_spacing_char: str | None = None
            while next_index < text_length:
                if not INLINE_JAPANESE_SPACING_RE.fullmatch(text[next_index]):
                    next_non_spacing_char = text[next_index]
                    break
                next_index += 1

            if (
                previous_kept_char is not None
                and next_non_spacing_char is not None
                and _is_japanese_analysis_char(previous_kept_char)
                and _is_japanese_analysis_char(next_non_spacing_char)
            ):
                continue

        normalized_chars.append(char)
        normalized_index_map.append(index)
        previous_kept_char = char

    return "".join(normalized_chars), normalized_index_map


def _normalize_japanese_punctuation_for_tts(text: str) -> str:
    trailing_sentence_pause = bool(re.search(r"(?:\.{3,}|…{2,}|‥{2,}|(?<!\d)\.)\s*$", text))
    normalized = JAPANESE_ELLIPSIS_RE.sub("、", text)
    normalized = JAPANESE_BRACKETS_RE.sub("、", normalized)
    normalized = normalized.replace("!", "！").replace("?", "？")
    normalized = re.sub(r"(?<!\d)[/／\\|](?!\d)", "、", normalized)
    normalized = re.sub(r"(?<!\d)[,，;；:：](?!\d)", "、", normalized)
    normalized = re.sub(r"(?<!\d)\.(?!\d)", "。", normalized)
    normalized = JAPANESE_PUNCTUATION_SPACING_RE.sub(r"\1", normalized)
    normalized = JAPANESE_PAUSE_RE.sub("、", normalized)
    normalized = re.sub(r"、([。！？])", r"\1", normalized)
    normalized = re.sub(r"([。！？])[。！？]+", r"\1", normalized)
    if trailing_sentence_pause:
        normalized = re.sub(r"[、\s]*$", "。", normalized)
    normalized = re.sub(r"([。！？])[。！？]+", r"\1", normalized)
    return normalized.strip("、 ")


@lru_cache(maxsize=1)
def _get_fugashi_tagger():
    """Get fugashi (MeCab + UniDic) tagger for high-accuracy morphological analysis."""
    try:
        import fugashi
    except ImportError as exc:
        raise RuntimeError(
            "Japanese reading dependencies are not installed: fugashi and unidic-lite"
        ) from exc

    try:
        return fugashi.Tagger()
    except Exception as exc:
        raise RuntimeError("Failed to initialize fugashi tagger") from exc


def get_japanese_lookup_terms(text: str) -> list[str]:
    normalized_text, _ = _normalize_text_for_analysis(text)
    normalized_text = normalized_text.strip()
    if not normalized_text:
        return []

    candidates: list[str] = [normalized_text]

    try:
        tagger = _get_fugashi_tagger()
    except RuntimeError:
        return candidates

    content_lemmas: list[str] = []
    for token in tagger(normalized_text):
        surface = token.surface.strip()
        if not surface:
            continue

        pos1 = getattr(token.feature, "pos1", None)
        if pos1 in LOOKUP_EXCLUDED_POS1:
            continue

        lemma = getattr(token.feature, "lemma", None) or getattr(token.feature, "orthBase", None) or surface
        if not lemma or lemma == "*":
            lemma = surface
        content_lemmas.append(str(lemma))

    if content_lemmas:
        candidates.append("".join(content_lemmas))
        if len(content_lemmas) == 1:
            candidates.append(content_lemmas[0])

    deduped: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if candidate and candidate not in seen:
            seen.add(candidate)
            deduped.append(candidate)

    return deduped


def _split_ruby_segments(surface: str, reading: str) -> list[dict[str, Any]]:
    if not surface or not reading or not any(_is_kanji(ch) for ch in surface):
        return [_build_text_segment(surface)]

    surface_kana = katakana_to_hiragana(surface)
    reading_hiragana = katakana_to_hiragana(reading)

    prefix_len = 0
    while (
        prefix_len < len(surface)
        and prefix_len < len(reading_hiragana)
        and _is_kana(surface[prefix_len])
        and katakana_to_hiragana(surface[prefix_len]) == reading_hiragana[prefix_len]
    ):
        prefix_len += 1

    suffix_len = 0
    max_suffix = min(len(surface) - prefix_len, len(reading_hiragana) - prefix_len)
    while suffix_len < max_suffix:
        surface_char = surface[len(surface) - 1 - suffix_len]
        reading_char = reading_hiragana[len(reading_hiragana) - 1 - suffix_len]
        if not _is_kana(surface_char) or katakana_to_hiragana(surface_char) != reading_char:
            break
        suffix_len += 1

    core_surface_end = len(surface) - suffix_len
    core_reading_end = len(reading_hiragana) - suffix_len
    prefix_text = surface[:prefix_len]
    core_surface = surface[prefix_len:core_surface_end]
    core_reading = reading_hiragana[prefix_len:core_reading_end]
    suffix_text = surface[core_surface_end:]

    if not core_surface or not core_reading or not any(_is_kanji(ch) for ch in core_surface):
        return [_build_text_segment(surface)]

    segments: list[dict[str, Any]] = []
    if prefix_text:
        segments.append(_build_text_segment(prefix_text))
    segments.append(_build_ruby_segment(core_surface, core_reading))
    if suffix_text:
        segments.append(_build_text_segment(suffix_text))
    return segments


def _match_reading_override(text: str, start_index: int) -> tuple[str, str] | None:
    for surface, reading in READING_OVERRIDES:
        if text.startswith(surface, start_index):
            return surface, reading
    return None


def _build_annotation_result(text: str, segments: list[dict[str, Any]]) -> dict[str, Any]:
    normalized_segments = _merge_adjacent_text_segments(segments) if segments else [_build_text_segment(text)]
    return {
        "text": text,
        "segments": normalized_segments,
        "lookup_segments": build_japanese_lookup_segments(text),
        "has_furigana": any(segment["type"] == "ruby" for segment in normalized_segments),
    }


def _project_segments_to_original_text(
    original_text: str,
    normalized_segments: list[dict[str, Any]],
    normalized_index_map: list[int],
) -> list[dict[str, Any]]:
    if not normalized_segments or not normalized_index_map:
        return normalized_segments

    projected_segments: list[dict[str, Any]] = []
    normalized_cursor = 0
    original_cursor = 0

    for segment in normalized_segments:
        segment_text = segment["text"] if segment["type"] == "text" else segment["base"]
        segment_length = len(segment_text)
        if segment_length <= 0:
            continue

        original_start = normalized_index_map[normalized_cursor]
        original_end = normalized_index_map[normalized_cursor + segment_length - 1] + 1

        if original_cursor < original_start:
            projected_segments.append(_build_text_segment(original_text[original_cursor:original_start]))

        original_segment_text = original_text[original_start:original_end]
        if segment["type"] == "text":
            projected_segments.append(_build_text_segment(original_segment_text))
        else:
            projected_segments.append(_build_ruby_segment(original_segment_text, segment["reading"]))

        original_cursor = original_end
        normalized_cursor += segment_length

    if original_cursor < len(original_text):
        projected_segments.append(_build_text_segment(original_text[original_cursor:]))

    return _merge_adjacent_text_segments(projected_segments)


def _annotate_plain_chunk_with_fugashi(text: str) -> list[dict[str, Any]]:
    """Use fugashi (MeCab + UniDic) for context-aware morphological analysis.

    UniDic provides much better accuracy for:
    - Compound words (夜市 → よるいち)
    - Historical names (土方歳三, 近藤勇)
    - Contextual readings based on surrounding text
    """
    segments: list[dict[str, Any]] = []
    current_index = 0

    for word in _get_plain_chunk_fugashi_words(text):
        position = word["start"]
        surface = word["surface"]
        reading = word["reading"]

        if position > current_index:
            segments.append(_build_text_segment(text[current_index:position]))

        if reading and any(_is_kanji(ch) for ch in surface):
            segments.extend(_split_ruby_segments(surface, reading))
        else:
            segments.append(_build_text_segment(surface))

        current_index = word["end"]

    if current_index < len(text):
        segments.append(_build_text_segment(text[current_index:]))

    return _merge_adjacent_text_segments(segments) if segments else [_build_text_segment(text)]


def _tokenize_plain_chunk_with_fugashi(text: str) -> list[dict[str, str | None]]:
    tokens: list[dict[str, str | None]] = []
    current_index = 0

    for word in _get_plain_chunk_fugashi_words(text):
        position = word["start"]
        surface = word["surface"]
        reading = word["reading"]

        if position > current_index:
            tokens.append(_build_reading_token(text[current_index:position], None))

        if reading and any(_is_kanji(ch) for ch in surface):
            tokens.append(
                _build_reading_token(
                    surface,
                    reading,
                    pos1=word["pos1"],
                    pos2=word["pos2"],
                )
            )
        else:
            tokens.append(
                _build_reading_token(
                    surface,
                    None,
                    pos1=word["pos1"],
                    pos2=word["pos2"],
                )
            )

        current_index = word["end"]

    if current_index < len(text):
        tokens.append(_build_reading_token(text[current_index:], None))

    return tokens


def _get_lookup_word_entries_from_plain_chunk(
    text: str,
    *,
    start_offset: int = 0,
) -> list[dict[str, Any]]:
    lookup_words: list[dict[str, Any]] = []

    for word in _get_plain_chunk_fugashi_words(text):
        lookup_words.append(
            _build_fugashi_word_entry(
                word["surface"],
                word["reading"],
                start=word["start"] + start_offset,
                end=word["end"] + start_offset,
                pos1=word["pos1"],
                pos2=word["pos2"],
            )
        )

    return lookup_words


def _should_merge_fugashi_words(
    previous_word: dict[str, Any],
    current_word: dict[str, Any],
) -> bool:
    if previous_word["end"] != current_word["start"]:
        return False

    if current_word["pos1"] != "接尾辞":
        return False

    previous_surface = previous_word["surface"] or ""
    current_surface = current_word["surface"] or ""
    previous_reading = previous_word["reading"] or ""
    current_reading = current_word["reading"] or ""

    return (
        _is_all_kanji(previous_surface)
        and _is_all_kanji(current_surface)
        and bool(previous_reading)
        and bool(current_reading)
    )


def _get_plain_chunk_fugashi_words(text: str) -> list[dict[str, Any]]:
    tagger = _get_fugashi_tagger()
    words: list[dict[str, Any]] = []
    current_index = 0

    for word in tagger(text):
        surface = word.surface
        if not surface:
            continue

        position = text.find(surface, current_index)
        if position == -1:
            continue

        feature = word.feature
        kana = getattr(feature, "kana", None) or ""
        reading = katakana_to_hiragana(kana) or None
        word_entry = _build_fugashi_word_entry(
            surface,
            reading if any(_is_kanji(ch) for ch in surface) else None,
            start=position,
            end=position + len(surface),
            pos1=getattr(feature, "pos1", None),
            pos2=getattr(feature, "pos2", None),
        )

        if words and _should_merge_fugashi_words(words[-1], word_entry):
            words[-1]["surface"] += surface
            words[-1]["reading"] = (words[-1]["reading"] or "") + (word_entry["reading"] or "")
            words[-1]["end"] = word_entry["end"]
        else:
            words.append(word_entry)

        current_index = position + len(surface)

    return words


def _is_likely_missing_okurigana_extraction_error(
    previous_word: dict[str, Any],
    current_word: dict[str, Any],
) -> bool:
    previous_surface = previous_word["surface"] or ""
    current_surface = current_word["surface"] or ""
    previous_pos1 = previous_word["pos1"] or ""
    previous_pos2 = previous_word["pos2"] or ""
    current_pos1 = current_word["pos1"] or ""

    return (
        len(previous_surface) == 1
        and _is_all_kanji(previous_surface)
        and not previous_word["reading"]
        and previous_pos1 == "名詞"
        and previous_pos2 == "普通名詞"
        and current_surface.startswith("つ")
        and not current_word["reading"]
        and current_pos1 in {"動詞", "形容詞"}
    )


def _is_likely_tsu_te_ta_extraction_error(
    current_word: dict[str, Any],
    next_word: dict[str, Any],
) -> bool:
    current_surface = current_word["surface"] or ""
    current_pos1 = current_word["pos1"] or ""
    next_surface = next_word["surface"] or ""
    next_pos1 = next_word["pos1"] or ""

    return (
        current_pos1 == "動詞"
        and current_surface.endswith("つ")
        and next_surface in {"て", "た"}
        and next_pos1 in {"助詞", "助動詞"}
    )


def _repair_small_tsu_extraction_errors(text: str) -> str:
    repaired = text

    while True:
        words = _get_plain_chunk_fugashi_words(repaired)
        did_repair = False

        for previous_word, current_word in zip(words, words[1:]):
            if not _is_likely_missing_okurigana_extraction_error(previous_word, current_word):
                continue

            candidate = repaired[:current_word["start"]] + repaired[current_word["start"] + 1:]
            candidate_words = _get_plain_chunk_fugashi_words(candidate)
            repaired_word = next(
                (
                    word
                    for word in candidate_words
                    if word["start"] <= previous_word["start"] < word["end"]
                    and (word["pos1"] or "") in {"動詞", "形容詞"}
                    and bool(word["reading"])
                ),
                None,
            )
            if repaired_word is None:
                continue

            repaired = candidate
            did_repair = True
            break

        if did_repair:
            continue

        for current_word, next_word in zip(words, words[1:]):
            if not _is_likely_tsu_te_ta_extraction_error(current_word, next_word):
                continue

            replacement_index = current_word["end"] - 1
            repaired = repaired[:replacement_index] + "っ" + repaired[replacement_index + 1:]
            did_repair = True
            break

        if not did_repair:
            return repaired


def _tokenize_with_fugashi(text: str) -> list[dict[str, str | None]]:
    tokens: list[dict[str, str | None]] = []
    chunk_start = 0
    current_index = 0

    while current_index < len(text):
        matched_override = _match_reading_override(text, current_index)
        if matched_override is None:
            current_index += 1
            continue

        if chunk_start < current_index:
            tokens.extend(_tokenize_plain_chunk_with_fugashi(text[chunk_start:current_index]))

        override_surface, override_reading = matched_override
        tokens.append(
            _build_reading_token(
                override_surface,
                override_reading,
                pos1="override",
                pos2="override",
            )
        )
        current_index += len(override_surface)
        chunk_start = current_index

    if chunk_start < len(text):
        tokens.extend(_tokenize_plain_chunk_with_fugashi(text[chunk_start:]))

    return tokens


def _get_lookup_word_entries(text: str) -> list[dict[str, Any]]:
    words: list[dict[str, Any]] = []
    chunk_start = 0
    current_index = 0

    while current_index < len(text):
        matched_override = _match_reading_override(text, current_index)
        if matched_override is None:
            current_index += 1
            continue

        if chunk_start < current_index:
            words.extend(
                _get_lookup_word_entries_from_plain_chunk(
                    text[chunk_start:current_index],
                    start_offset=chunk_start,
                )
            )

        override_surface, override_reading = matched_override
        words.append(
            _build_fugashi_word_entry(
                override_surface,
                override_reading,
                start=current_index,
                end=current_index + len(override_surface),
                pos1="override",
                pos2="override",
            )
        )
        current_index += len(override_surface)
        chunk_start = current_index

    if chunk_start < len(text):
        words.extend(
            _get_lookup_word_entries_from_plain_chunk(
                text[chunk_start:],
                start_offset=chunk_start,
            )
        )

    return words


def _should_merge_lookup_words(
    previous_word: dict[str, Any],
    current_word: dict[str, Any],
) -> bool:
    if previous_word["end"] != current_word["start"]:
        return False

    previous_pos1 = previous_word["pos1"] or ""
    current_pos1 = current_word["pos1"] or ""

    if previous_pos1 == "接頭辞" and current_pos1 not in LOOKUP_EXCLUDED_POS1:
        return True

    if current_pos1 == "接尾辞" and previous_pos1 not in LOOKUP_EXCLUDED_POS1:
        return True

    return False


def _merge_lookup_word_entries(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []

    for word in words:
        if not merged:
            merged.append(word.copy())
            continue

        previous_word = merged[-1]
        if not _should_merge_lookup_words(previous_word, word):
            merged.append(word.copy())
            continue

        previous_word["surface"] += word["surface"]
        previous_word["reading"] = (
            (previous_word["reading"] or "") + (word["reading"] or "")
        ) or None
        previous_word["end"] = word["end"]
        if (previous_word["pos1"] or "") == "接頭辞" and (word["pos1"] or "") != "接尾辞":
            previous_word["pos1"] = word["pos1"]
            previous_word["pos2"] = word["pos2"]

    return merged


def _should_include_lookup_word(word: dict[str, Any]) -> bool:
    surface = word["surface"] or ""
    pos1 = word["pos1"] or ""
    pos2 = word["pos2"] or ""

    if not surface.strip():
        return False

    if pos1 in LOOKUP_EXCLUDED_POS1:
        return False

    if pos2 in LOOKUP_EXCLUDED_POS2 and pos1 == "動詞" and not word["reading"]:
        return False

    return any(_is_japanese_analysis_char(char) for char in surface)


def _project_lookup_segments_to_original_text(
    original_text: str,
    normalized_lookup_segments: list[dict[str, Any]],
    normalized_index_map: list[int],
) -> list[dict[str, Any]]:
    projected_segments: list[dict[str, Any]] = []

    for segment in normalized_lookup_segments:
        segment_length = segment["end"] - segment["start"]
        if segment_length <= 0:
            continue

        original_start = normalized_index_map[segment["start"]]
        original_end = normalized_index_map[segment["end"] - 1] + 1
        projected_segments.append(
            _build_lookup_segment(
                original_text[original_start:original_end],
                original_start,
                original_end,
                lookup_text=segment["lookup_text"],
            )
        )

    return projected_segments


def build_japanese_lookup_segments(text: str) -> list[dict[str, Any]]:
    original_text = text or ""
    if not original_text or not contains_japanese_text(original_text):
        return []

    normalized_text, normalized_index_map = _normalize_text_for_analysis(original_text)
    if not normalized_text:
        return []

    lookup_words = _merge_lookup_word_entries(_get_lookup_word_entries(normalized_text))
    normalized_segments = [
        _build_lookup_segment(
            word["surface"],
            word["start"],
            word["end"],
            lookup_text=word["surface"],
        )
        for word in lookup_words
        if _should_include_lookup_word(word)
    ]

    if normalized_text == original_text:
        return normalized_segments

    return _project_lookup_segments_to_original_text(
        original_text,
        normalized_segments,
        normalized_index_map,
    )


def _is_number_like_token(token: dict[str, str | None]) -> bool:
    surface = token["surface"] or ""
    pos2 = token["pos2"] or ""
    return pos2 == "数詞" or bool(surface) and all(char in NUMBER_LIKE_SURFACES for char in surface)


def _get_tts_separator(
    previous_token: dict[str, str | None],
    current_token: dict[str, str | None],
) -> str:
    current_surface = current_token["surface"] or ""
    current_pos1 = current_token["pos1"] or ""
    previous_surface = previous_token["surface"] or ""
    previous_pos1 = previous_token["pos1"] or ""

    if _is_number_like_token(previous_token) and current_surface in COUNTER_SURFACES:
        return ""

    if current_pos1 in {"補助記号", "記号"}:
        return ""

    if previous_pos1 in {"補助記号", "記号"}:
        return ""

    if current_pos1 == "助詞":
        return ""

    if previous_pos1 == "助詞" and previous_surface == "は":
        return "、"

    if current_pos1 in {"動詞", "形容詞", "助動詞"}:
        return ""

    if previous_pos1 == "助詞":
        return ""

    return " "


def _normalize_non_kanji_token_for_tts(
    token: dict[str, str | None],
    previous_token: dict[str, str | None] | None = None,
) -> str:
    surface = token["surface"] or ""
    pos1 = token["pos1"] or ""

    if pos1 == "助詞":
        if surface == "は":
            if previous_token and (previous_token["pos1"] or "") == "助詞":
                return "は"
            return "わ"
        if surface == "へ":
            return "え"
        if surface == "を":
            return "お"

    return surface


def _apply_reading_overrides_inline_for_tts(text: str) -> str:
    parts: list[str] = []
    current_index = 0

    while current_index < len(text):
        matched_override = _match_reading_override(text, current_index)
        if matched_override is None:
            parts.append(text[current_index])
            current_index += 1
            continue

        override_surface, override_reading = matched_override
        parts.append(
            override_surface if override_surface in TTS_PRESERVE_SURFACES else override_reading
        )
        current_index += len(override_surface)

    normalized = "".join(parts)
    normalized = re.sub(r"[ \t\u3000]{2,}", " ", normalized)
    return JAPANESE_PUNCTUATION_SPACING_RE.sub(r"\1", normalized).strip()


def _annotate_with_fugashi(text: str) -> dict[str, Any]:
    segments: list[dict[str, Any]] = []
    chunk_start = 0
    current_index = 0

    while current_index < len(text):
        matched_override = _match_reading_override(text, current_index)
        if matched_override is None:
            current_index += 1
            continue

        if chunk_start < current_index:
            segments.extend(_annotate_plain_chunk_with_fugashi(text[chunk_start:current_index]))

        override_surface, override_reading = matched_override
        segments.extend(_split_ruby_segments(override_surface, override_reading))
        current_index += len(override_surface)
        chunk_start = current_index

    if chunk_start < len(text):
        segments.extend(_annotate_plain_chunk_with_fugashi(text[chunk_start:]))

    return _build_annotation_result(text, segments)


def annotate_japanese_text(text: str) -> dict[str, Any]:
    original_text = text or ""
    if not original_text:
        return {
            "text": original_text,
            "segments": [],
            "lookup_segments": [],
            "has_furigana": False,
        }

    if not contains_japanese_text(original_text):
        return {
            "text": original_text,
            "segments": [_build_text_segment(original_text)],
            "lookup_segments": [],
            "has_furigana": False,
        }

    normalized_text, normalized_index_map = _normalize_text_for_analysis(original_text)
    if not normalized_text:
        return {
            "text": original_text,
            "segments": [_build_text_segment(original_text)],
            "lookup_segments": [],
            "has_furigana": False,
        }

    normalized_result = _annotate_with_fugashi(normalized_text)
    if normalized_text == original_text:
        return normalized_result

    projected_segments = _project_segments_to_original_text(
        original_text,
        normalized_result["segments"],
        normalized_index_map,
    )
    return _build_annotation_result(original_text, projected_segments)


def normalize_japanese_text_for_tts(text: str) -> str:
    original_text = text or ""
    if not original_text or not contains_japanese_text(original_text):
        return original_text

    normalized_text, _ = _normalize_text_for_analysis(original_text)
    normalized_text = _normalize_japanese_punctuation_for_tts(normalized_text)
    normalized_text = _repair_small_tsu_extraction_errors(normalized_text)
    return _apply_reading_overrides_inline_for_tts(normalized_text)


def annotate_japanese_texts(texts: list[str], db: Session) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    pending_cache_rows: list[CacheFurigana] = []
    computed_annotations: dict[str, dict[str, Any]] = {}
    computed_lookup_segments: dict[str, list[dict[str, Any]]] = {}
    normalized_items = [(text or "", build_japanese_reading_cache_key(text or "")) for text in texts]
    unique_hashes = list(dict.fromkeys(text_hash for _, text_hash in normalized_items))
    cached_rows = (
        db.query(CacheFurigana).filter(CacheFurigana.text_hash.in_(unique_hashes)).all()
        if unique_hashes
        else []
    )
    cached_map = {
        row.text_hash: row
        for row in cached_rows
    }

    for normalized_text, text_hash in normalized_items:
        lookup_segments = computed_lookup_segments.get(normalized_text)
        if lookup_segments is None:
            lookup_segments = build_japanese_lookup_segments(normalized_text)
            computed_lookup_segments[normalized_text] = lookup_segments

        cached = cached_map.get(text_hash)
        if cached is not None and cached.text == normalized_text:
            results.append(
                {
                    "text": normalized_text,
                    "segments": cached.segments,
                    "lookup_segments": lookup_segments,
                    "has_furigana": bool(cached.has_furigana),
                }
            )
            continue

        annotated = computed_annotations.get(normalized_text)
        if annotated is None:
            annotated = annotate_japanese_text(normalized_text)
            computed_annotations[normalized_text] = annotated

        results.append(annotated)
        if text_hash not in cached_map:
            pending_cache_rows.append(
                CacheFurigana(
                    text_hash=text_hash,
                    text=normalized_text,
                    segments=annotated["segments"],
                    has_furigana=1 if annotated["has_furigana"] else 0,
                )
            )
            cached_map[text_hash] = pending_cache_rows[-1]

    if pending_cache_rows:
        for row in pending_cache_rows:
            db.merge(row)
        db.commit()

    return results
