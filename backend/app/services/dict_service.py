from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import Optional, Dict, Any, List, Set, Tuple
from functools import lru_cache
from ..models.models import CacheDictionary
from ..services import (
    cache_service,
    gemini_service,
    ecdict_service,
    jmdict_service,
    open_dict_service,
)
from ..services.book_language_service import contains_japanese_text, contains_korean_text
from ..services.japanese_text_service import get_japanese_lookup_terms
from ..utils.lookup_normalizer import normalize_lookup_word
from app import config
import requests
import json
import string
import logging
import re

# 懒加载 DictManager，避免循环导入
_dict_manager = None


def get_dict_manager():
    """获取 DictManager（单例）"""
    global _dict_manager
    if _dict_manager is None:
        try:
            from .dict_manager import DictManager

            _dict_manager = DictManager()
        except Exception as e:
            logger.warning(f"DictManager 初始化失败: {e}")
            _dict_manager = None
    return _dict_manager


logger = logging.getLogger(__name__)

FREE_DICT_API = "https://api.dictionaryapi.dev/api/v2/entries/en/{word}"
JMDICT_SOURCE = "JMdict"

# 例外词列表：以常见后缀结尾但本身是完整词的词
# 这些词不应进行词形还原
_EXCEPTION_WORDS = {
    "ing": {
        # 名词
        "evening",
        "morning",
        "blessing",
        "meeting",
        "feeling",
        "building",
        "painting",
        "drawing",
        "clothing",
        "housing",
        "lighting",
        "sightseeing",
        "nothing",
        "something",
        "everything",
        "anything",
        "king",
        "ring",
        "wing",
        "thing",
        "bring",
        "string",
        "spring",
        "sing",
        "living",
        "being",
        "going",
        "doing",
        "dying",
        "icing",
        # 形容词
        "interesting",
        "boring",
        "exciting",
        "surprising",
        "amazing",
        "charming",
        "alarming",
        "frightening",
        "worrying",
        "tiring",
    },
    "ed": {
        # 名词
        "bed",
        "red",
        "wed",
        "fed",
        "led",
        "shed",
        "sled",
        "bred",
        "need",
        "seed",
        "deed",
        "feed",
        "weed",
        "reed",
        "speed",
        # 形容词
        "tired",
        "bored",
        "hired",
        "fired",
        "wired",
        "mired",
        "beloved",
        "wicked",
        "blessed",
        "learned",
        "aged",
    },
    "s": {
        # 单数名词（以 s 结尾）
        "bus",
        "lens",
        "class",
        "grass",
        "glass",
        "pass",
        "gas",
        # 学科
        "news",
        "maths",
        "physics",
        "politics",
        "economics",
        "linguistics",
        # 学术语
        "analysis",
        "crisis",
        "thesis",
        "basis",
        "status",
        "series",
        "species",
        "measles",
        "mumps",
        "rabies",
        "billiards",
        "darts",
        "bowls",
        # 其他
        "address",
        "process",
        "campus",
        "tennis",
        "golf",
        "campus",
    },
    "er": {
        # 名词（后缀 -er 表示"人"或"物品"）
        "teacher",
        "mother",
        "father",
        "brother",
        "sister",
        "water",
        "paper",
        "letter",
        "latter",
        "master",
        "matter",
        "center",
        "number",
        "member",
        "leader",
        "player",
        "driver",
        "farmer",
        "speaker",
        "reader",
        "worker",
        "buyer",
        "seller",
        "owner",
        "computer",
        "camera",
        "picture",
        "feature",
        "nature",
        "future",
        # 形容词/副词（better, latter 等不应被还原为 bet, lat）
        "better",
        "latter",
        "matter",
        "center",
        "number",
        "order",
        "weather",
        "feather",
        "leather",
        "gather",
        "together",
        "scatter",
        "chapter",
        "character",
        "monster",
        "shelter",
        "winter",
        "summer",
        "finger",
        "shoulder",
        "peer",
    },
    "est": {
        # 以 -est 结尾但不是最高级的词
        "interest",
        "different",
        "important",
        "excellent",
        "consistent",
        "permanent",
        "significant",
        "transparent",
        "competent",
    },
}

_IRREGULAR_LEMMAS = {
    "am": "be",
    "are": "be",
    "is": "be",
    "strewn": "strew",
    "strove": "strive",
    "driven": "drive",
    "written": "write",
    "wrote": "write",
    "spoken": "speak",
    "spoke": "speak",
    "taken": "take",
    "took": "take",
    "gone": "go",
    "went": "go",
    "seen": "see",
    "saw": "see",
    "has": "have",
    "had": "have",
    "done": "do",
    "did": "do",
    "been": "be",
    "was": "be",
    "were": "be",
    "given": "give",
    "gave": "give",
    "better": "good",
    "best": "good",
    "worse": "bad",
    "worst": "bad",
    "farther": "far",
    "further": "far",
    "farthest": "far",
    "furthest": "far",
}

_NOUN_VERB_POS = {"n", "v"}
_VERB_LIKE_POS = {"n", "v", "j"}
_COMPARATIVE_POS = {"j", "r"}
_HANGUL_BASE_CODE = 0xAC00
_HANGUL_INITIAL_COUNT = 19
_HANGUL_MEDIAL_COUNT = 21
_HANGUL_FINAL_COUNT = 28
_KOREAN_STRIPPABLE_FINALS = {4, 8, 16, 17, 20}
_KOREAN_VOWEL_DECONTRACTION_MAP = {
    1: 0,
    9: 8,
    10: 11,
    14: 13,
    15: 16,
}
_KOREAN_PARTICLE_SUFFIXES = (
    "으로는", "에게서", "한테서", "께서는", "에서는", "에게는", "한테는", "으로도",
    "들과는", "들에게", "들까지", "들부터", "들처럼", "들보다", "들과", "들",
    "이라도", "라고는", "이라고", "로부터", "으로", "에서", "에게", "한테", "께서",
    "까지", "부터", "처럼", "보다", "라도", "마저", "마다", "만은", "만도", "으로",
    "이나", "나마", "이나", "나", "은", "는", "이", "가", "을", "를", "에", "도",
    "와", "과", "랑", "로", "의", "만",
)
_KOREAN_HADA_SUFFIXES = (
    "했습니다", "했어요", "했다", "했던", "한다고", "한다", "합니다", "하네요", "하니",
    "하면", "하며", "하는", "하고", "하자", "하라", "해서", "해라", "해요", "해도", "해야",
    "해야지", "해야죠", "해야만", "해야", "해", "한", "할", "함",
)
_KOREAN_COPULA_SUFFIXES = (
    "이십니까", "입니까", "입니다", "이에요", "예요", "이야", "야", "이었다", "였어요", "였다",
)
_KOREAN_PREDICATE_SUFFIXES = (
    "었습니다", "았습니다", "었어요", "았어요", "겠어요", "겠습니다", "었으며", "았으며",
    "였으며", "셨습니까", "십니까", "십시오", "습니다", "네요", "군요", "거든요", "세요",
    "아요", "어요", "여요", "에요", "지요", "죠", "었으니", "았으니", "였으니",
    "었으니까", "았으니까", "였으니까", "었기", "았기", "였기", "어도", "아도",
    "여도", "도록", "으니", "으니까", "는다면서요", "다면서요", "다니까", "답니다",
    "잖냐", "느니", "다니", "라니", "거든", "으며", "면서", "는데", "지만",
    "려고", "려는지", "려는", "려다", "려고", "려", "었다", "았다", "였다",
    "겠다", "는다", "ㄴ다", "는다", "니다", "어서", "아서", "여서", "으면",
    "면", "다는", "다고", "다는지", "는지", "는다고", "는다는", "는답니다",
    "다고", "다는", "다고요", "며", "듯", "고", "게", "지", "니", "는", "은",
    "을", "어", "아", "여",
)
_KOREAN_COMMAND_SUFFIX_RULES = (
    ("어라", 1, False),
    ("아라", 1, False),
    ("여라", 1, False),
    ("거라", 1, False),
    ("너라", 1, False),
    ("자면", 2, False),
    ("라", 2, True),
    ("자", 2, True),
)
_KOREAN_NOMINAL_SUFFIX_RULES = (
    "하기", "기는", "기를", "기도", "기로", "기만", "기에", "기",
)
_KOREAN_COPULA_NOUN_SUFFIXES = (
    "이었던", "였던", "이었다는", "였다는", "이었다니", "였다니", "이었다", "였다", "이라니", "이니",
)
_KOREAN_INTENTION_SUFFIXES = (
    "을까봐", "ㄹ까봐", "을까 봐", "ㄹ까 봐", "까봐", "을까", "ㄹ까", "까",
)
_KOREAN_STRIPPED_PRIORITY_EXCEPTIONS = {"브래지어"}
_KOREAN_PHRASE_SPLIT_RE = re.compile(r"[\s,，、/·]+")


@lru_cache(maxsize=4096)
def _get_ecdict_entry_info(word: str) -> Tuple[bool, Tuple[str, ...]]:
    details = ecdict_service.get_word_details(word)
    if not details:
        return False, ()

    pos_value = details.get("pos") or ""
    tags: List[str] = []
    for part in pos_value.split("/"):
        tag = part.split(":", 1)[0].strip().lower().rstrip(".")
        normalized_tag = {
            "noun": "n",
            "n": "n",
            "verb": "v",
            "v": "v",
            "adj": "j",
            "adjective": "j",
            "j": "j",
            "adv": "r",
            "adverb": "r",
            "r": "r",
            "det": "d",
            "determiner": "d",
            "d": "d",
            "pron": "p",
            "pronoun": "p",
            "p": "p",
        }.get(tag, tag)
        if normalized_tag:
            tags.append(normalized_tag)

    return True, tuple(tags)


def _supports_inflection(word: str, allowed: Set[str]) -> bool:
    exists, tags = _get_ecdict_entry_info(word)
    if not exists or not tags:
        return True
    return bool(set(tags) & allowed)


def _candidate_exists(candidate: str) -> bool:
    exists, _ = _get_ecdict_entry_info(candidate)
    if exists:
        return True

    dict_manager = get_dict_manager()
    return bool(dict_manager and dict_manager.word_exists(candidate))


def _is_japanese_lookup(word: str) -> bool:
    return contains_japanese_text(word)


def _is_korean_lookup(word: str) -> bool:
    return contains_korean_text(word)


def _is_korean_dict_name(dict_name: Optional[str]) -> bool:
    if not dict_name:
        return False

    normalized_name = dict_name.lower()
    return any(
        marker in normalized_name
        for marker in ("韩", "韓", "korean", "krdict", "한국", "조선")
    )


def _get_imported_dicts_for_lookup(dict_names: List[str], original_word: str) -> List[str]:
    if not _is_korean_lookup(original_word):
        return dict_names

    korean_dicts = [dict_name for dict_name in dict_names if _is_korean_dict_name(dict_name)]
    return korean_dicts or dict_names


def _lookup_jmdict_terms(original_word: str, lookup_terms: List[str]) -> Optional[Dict]:
    for term in lookup_terms:
        result = jmdict_service.get_word_details(term)
        if not result:
            continue
        result["lookup_term"] = original_word
        if term != original_word:
            result["lemma_from"] = term
        return result
    return None


def _decompose_hangul_syllable(char: str) -> Optional[Tuple[int, int, int]]:
    if len(char) != 1:
        return None

    offset = ord(char) - _HANGUL_BASE_CODE
    if offset < 0 or offset >= _HANGUL_INITIAL_COUNT * _HANGUL_MEDIAL_COUNT * _HANGUL_FINAL_COUNT:
        return None

    initial = offset // (_HANGUL_MEDIAL_COUNT * _HANGUL_FINAL_COUNT)
    medial = (offset % (_HANGUL_MEDIAL_COUNT * _HANGUL_FINAL_COUNT)) // _HANGUL_FINAL_COUNT
    final = offset % _HANGUL_FINAL_COUNT
    return initial, medial, final


def _compose_hangul_syllable(initial: int, medial: int, final: int) -> str:
    return chr(
        _HANGUL_BASE_CODE
        + (((initial * _HANGUL_MEDIAL_COUNT) + medial) * _HANGUL_FINAL_COUNT)
        + final
    )


def _replace_last_hangul_syllable(text: str, *, medial: Optional[int] = None, final: Optional[int] = None) -> Optional[str]:
    if not text:
        return None

    decomposed = _decompose_hangul_syllable(text[-1])
    if not decomposed:
        return None

    initial_idx, medial_idx, final_idx = decomposed
    next_medial = medial_idx if medial is None else medial
    next_final = final_idx if final is None else final
    return f"{text[:-1]}{_compose_hangul_syllable(initial_idx, next_medial, next_final)}"


def _append_unique_term(terms: List[str], candidate: str) -> None:
    if not candidate:
        return
    if candidate not in terms:
        terms.append(candidate)


def _expand_korean_stem_variants(stem: str) -> List[str]:
    variants: List[str] = []

    def append_with_decontracted_vowel(candidate: str, *, prefer_decontracted: bool = False) -> None:
        decomposed_candidate = _decompose_hangul_syllable(candidate[-1]) if candidate else None
        if not decomposed_candidate:
            _append_unique_term(variants, candidate)
            return
        mapped_medial = _KOREAN_VOWEL_DECONTRACTION_MAP.get(decomposed_candidate[1])
        if mapped_medial is None:
            _append_unique_term(variants, candidate)
            return
        expanded_candidate = _replace_last_hangul_syllable(
            candidate,
            medial=mapped_medial,
            final=decomposed_candidate[2],
        )
        if prefer_decontracted and expanded_candidate:
            _append_unique_term(variants, expanded_candidate)
        _append_unique_term(variants, candidate)
        if not prefer_decontracted and expanded_candidate:
            _append_unique_term(variants, expanded_candidate)

    decomposed = _decompose_hangul_syllable(stem[-1]) if stem else None
    if decomposed and decomposed[2] in _KOREAN_STRIPPABLE_FINALS:
        stripped = _replace_last_hangul_syllable(stem, final=0)
        if stripped:
            append_with_decontracted_vowel(stripped, prefer_decontracted=True)

    append_with_decontracted_vowel(stem)

    return variants


def _build_korean_lookup_terms_from_stem(stem: str, *, include_bare: bool, include_da: bool) -> List[str]:
    terms: List[str] = []
    if stem.endswith(("있", "없")):
        if include_bare:
            _append_unique_term(terms, stem)
        if include_da:
            _append_unique_term(terms, f"{stem}다")
        return terms

    for variant in _expand_korean_stem_variants(stem):
        if include_bare:
            _append_unique_term(terms, variant)
        if include_da:
            _append_unique_term(terms, f"{variant}다")
    return terms


def _build_korean_copula_terms(stem: str) -> List[str]:
    terms: List[str] = []
    _append_unique_term(terms, stem)
    _append_unique_term(terms, f"{stem}이다")
    return terms


def _build_korean_h_irregular_terms(form: str) -> List[str]:
    if len(form) < 2 or not form.endswith("란"):
        return []

    return [f"{form[:-1]}랗다"]


def _build_korean_b_irregular_terms(form: str) -> List[str]:
    if form.endswith("스러워") and len(form) > len("스러워"):
        return [f"{form[:-3]}스럽다"]
    return []


def _get_korean_lookup_candidates(word: str, validate_candidates: bool = True) -> List[str]:
    candidates: List[str] = []
    original_exists = _candidate_exists(word) if validate_candidates else False

    def add_candidates(items: List[str]) -> None:
        for item in items:
            if item and item != word:
                _append_unique_term(candidates, item)

    def process_form(form: str, *, skip_original_exists: bool) -> None:
        for suffix in _KOREAN_COPULA_NOUN_SUFFIXES:
            if form.endswith(suffix) and len(form) > len(suffix):
                stem = form[: -len(suffix)]
                add_candidates(_build_korean_copula_terms(stem))

        add_candidates(_build_korean_h_irregular_terms(form))
        add_candidates(_build_korean_b_irregular_terms(form))

        for suffix in _KOREAN_HADA_SUFFIXES:
            if form.endswith(suffix) and len(form) > len(suffix):
                add_candidates([f"{form[: -len(suffix)]}하다"])

        for suffix in _KOREAN_COPULA_SUFFIXES:
            if form.endswith(suffix) and len(form) > len(suffix):
                stem = form[: -len(suffix)]
                add_candidates(_build_korean_lookup_terms_from_stem(stem, include_bare=True, include_da=False))

        for suffix, min_stem_length, skip_when_original_exists in _KOREAN_COMMAND_SUFFIX_RULES:
            if not form.endswith(suffix) or len(form) <= len(suffix):
                continue
            stem = form[: -len(suffix)]
            if len(stem) < min_stem_length:
                continue
            if skip_when_original_exists and skip_original_exists:
                continue
            add_candidates(_build_korean_lookup_terms_from_stem(stem, include_bare=False, include_da=True))

        for suffix in _KOREAN_PREDICATE_SUFFIXES:
            if form.endswith(suffix) and len(form) > len(suffix):
                stem = form[: -len(suffix)]
                if suffix.startswith("였"):
                    add_candidates([f"{stem}이다", stem])
                add_candidates(_build_korean_lookup_terms_from_stem(stem, include_bare=False, include_da=True))

        for suffix in _KOREAN_INTENTION_SUFFIXES:
            if form.endswith(suffix) and len(form) > len(suffix):
                stem = form[: -len(suffix)]
                add_candidates(_build_korean_lookup_terms_from_stem(stem, include_bare=False, include_da=True))

        for suffix in _KOREAN_NOMINAL_SUFFIX_RULES:
            if form.endswith(suffix) and len(form) > len(suffix):
                stem = form[: -len(suffix)]
                if suffix.startswith("하"):
                    add_candidates([f"{stem}하다"])
                add_candidates(_build_korean_lookup_terms_from_stem(stem, include_bare=False, include_da=True))

    phrase_parts = [part for part in _KOREAN_PHRASE_SPLIT_RE.split(word) if part]
    if len(phrase_parts) > 1:
        for part in phrase_parts:
            for candidate in _get_korean_lookup_candidates(part, validate_candidates=validate_candidates):
                _append_unique_term(candidates, candidate)

        for part in phrase_parts:
            if validate_candidates:
                if _candidate_exists(part):
                    _append_unique_term(candidates, part)
            else:
                _append_unique_term(candidates, part)

        if validate_candidates:
            return [candidate for candidate in candidates if _candidate_exists(candidate)]
        return candidates

    process_form(word, skip_original_exists=original_exists)

    stripped_forms = [word]
    seen_stripped = {word}
    ordered_stripped_forms: List[str] = []
    for _ in range(2):
        next_forms: List[str] = []
        for form in stripped_forms:
            for suffix in sorted(_KOREAN_PARTICLE_SUFFIXES, key=len, reverse=True):
                if not form.endswith(suffix) or len(form) <= len(suffix):
                    continue
                stripped = form[: -len(suffix)]
                if stripped in seen_stripped:
                    continue
                seen_stripped.add(stripped)
                ordered_stripped_forms.append(stripped)
                next_forms.append(stripped)
        stripped_forms = next_forms
        if not stripped_forms:
            break

    for stripped in ordered_stripped_forms:
        if stripped in _KOREAN_STRIPPED_PRIORITY_EXCEPTIONS or _candidate_exists(stripped):
            add_candidates([stripped])
            process_form(stripped, skip_original_exists=False)
        else:
            process_form(stripped, skip_original_exists=False)
            add_candidates([stripped])

    if len(word) > 1 and word.endswith("다"):
        stem = word[:-1]
        add_candidates(_build_korean_lookup_terms_from_stem(stem, include_bare=False, include_da=True))

    decomposed = _decompose_hangul_syllable(word[-1]) if word else None
    if decomposed and decomposed[2] in _KOREAN_STRIPPABLE_FINALS:
        add_candidates(_build_korean_lookup_terms_from_stem(word, include_bare=False, include_da=True))

    if not validate_candidates:
        return candidates

    return [candidate for candidate in candidates if _candidate_exists(candidate)]


def _get_lemma_candidates(word: str, validate_candidates: bool = True) -> List[str]:
    """
    生成可能的原型词列表。

    根据常见英语词尾规则推测原型，支持候选词验证。

    Args:
        word: 输入词
        validate_candidates: 是否验证候选词（默认 True）

    Returns:
        可能的原型词列表（按优先级排序）
    """
    candidates: List[Tuple[str, str]] = []
    word_lower = word.lower()

    def add_candidate(candidate: str, kind: str) -> None:
        if not candidate:
            return
        if candidate.lower() == word_lower:
            return
        candidates.append((candidate, kind))

    irregular = _IRREGULAR_LEMMAS.get(word_lower)
    if irregular:
        if validate_candidates:
            return _validate_lemma_candidates(word_lower, [(irregular, "irregular")])
        return [irregular]

    # 1. 检查例外列表：如果原词在例外列表中，直接返回空列表
    for suffix, words in _EXCEPTION_WORDS.items():
        if word_lower in words:
            return []

    # 2. 复数形式还原
    if word_lower.endswith("ies"):
        if _supports_inflection(word_lower, _NOUN_VERB_POS):
            # cities -> city, movies -> movie
            add_candidate(word[:-3] + "y", "plural")
            add_candidate(word[:-1], "plural")
    elif word_lower.endswith(("ses", "xes", "zes", "ches", "shes", "oes")):
        # boxes -> box, watches -> watch, heroes -> hero
        if _supports_inflection(word_lower, _NOUN_VERB_POS):
            add_candidate(word[:-2], "plural")
    elif word_lower.endswith("es") and len(word) > 3:
        if _supports_inflection(word_lower, _NOUN_VERB_POS):
            add_candidate(word[:-1], "plural")
            add_candidate(word[:-2], "plural")
    elif word_lower.endswith("s") and not word_lower.endswith("ss"):
        # deserts -> desert, books -> book
        if _supports_inflection(word_lower, _NOUN_VERB_POS):
            add_candidate(word[:-1], "plural")

    # 3. 过去式/过去分词还原
    if word_lower.endswith("ied"):
        if _supports_inflection(word_lower, _VERB_LIKE_POS):
            # studied -> study, died -> die
            add_candidate(word[:-3] + "y", "verb")
            add_candidate(word[:-1], "verb")
    elif word_lower.endswith("ed"):
        # spotted -> spot, stopped -> stop
        if _supports_inflection(word_lower, _VERB_LIKE_POS):
            if len(word) > 4 and word[-3].lower() == word[-4].lower():
                add_candidate(word[:-3], "verb")
            # walked -> walk
            add_candidate(word[:-2], "verb")
            # loved -> love
            add_candidate(word[:-1], "verb")

    # 4. 进行时还原
    if word_lower.endswith("ing"):
        if _supports_inflection(word_lower, _VERB_LIKE_POS):
            # running -> run (双写辅音)
            if len(word) > 5 and word[-4].lower() == word[-5].lower():
                add_candidate(word[:-4], "verb")
            # loving -> love
            add_candidate(word[:-3] + "e", "verb")
            # running -> run, walking -> walk
            add_candidate(word[:-3], "verb")
            # panicking -> panic
            if word_lower.endswith("cking"):
                add_candidate(word[:-3], "verb")
                add_candidate(word[:-4], "verb")

    # 5. 比较级/最高级还原
    if word_lower.endswith("iest"):
        if _supports_inflection(word_lower, _COMPARATIVE_POS):
            add_candidate(word[:-4] + "y", "superlative")  # happiest -> happy
    elif word_lower.endswith("ier"):
        if _supports_inflection(word_lower, _COMPARATIVE_POS):
            add_candidate(word[:-3] + "y", "comparative")  # happier -> happy
    elif word_lower.endswith("est"):
        if _supports_inflection(word_lower, _COMPARATIVE_POS):
            if len(word) > 5 and word[-4].lower() == word[-5].lower():
                add_candidate(word[:-4], "superlative")  # biggest -> big
            add_candidate(word[:-2], "superlative")  # largest -> large
            add_candidate(word[:-3], "superlative")  # fastest -> fast
    elif word_lower.endswith("er"):
        if _supports_inflection(word_lower, _COMPARATIVE_POS):
            if len(word) > 4 and word[-3].lower() == word[-4].lower():
                add_candidate(word[:-3], "comparative")  # bigger -> big
            add_candidate(word[:-1], "comparative")  # larger -> large
            add_candidate(word[:-2], "comparative")  # faster -> fast

    # 6. 去重并保序
    deduped_candidates: List[Tuple[str, str]] = []
    seen = set()
    for candidate, kind in candidates:
        lower_candidate = candidate.lower()
        if lower_candidate in seen:
            continue
        seen.add(lower_candidate)
        deduped_candidates.append((candidate, kind))

    # 7. 可选：验证候选词是否在词典中存在
    if validate_candidates:
        return _validate_lemma_candidates(word_lower, deduped_candidates)

    return [candidate for candidate, _ in deduped_candidates]


def _validate_lemma_candidates(original_word: str, candidates: List[Tuple[str, str]]) -> List[str]:
    """
    验证候选词是否在词典中存在。

    Args:
        original_word: 原始查询词
        candidates: 原始候选词列表

    Returns:
        验证后的候选词列表（只包含在词典中存在的词）
    """
    valid_candidates: List[str] = []
    original_supports_comparison = _supports_inflection(original_word, _COMPARATIVE_POS)

    for lemma, kind in candidates:
        # 过滤过短的词
        if len(lemma) < 2:
            continue

        # 过滤掉明显无效的转换（如单字母）
        if len(lemma) <= 2 and not lemma.isalpha():
            continue

        exists_in_ecdict, pos_tags = _get_ecdict_entry_info(lemma)
        pos_set = set(pos_tags)

        if kind in {"comparative", "superlative"}:
            if not original_supports_comparison:
                continue
            if pos_set:
                if pos_set & _COMPARATIVE_POS:
                    valid_candidates.append(lemma)
            continue

        if kind == "plural":
            if pos_set:
                if pos_set & _NOUN_VERB_POS:
                    valid_candidates.append(lemma)
            elif not exists_in_ecdict and _candidate_exists(lemma):
                valid_candidates.append(lemma)
            continue

        if kind == "verb":
            if pos_set:
                if pos_set & _VERB_LIKE_POS:
                    valid_candidates.append(lemma)
            elif not exists_in_ecdict and _candidate_exists(lemma):
                valid_candidates.append(lemma)
            continue

        if _candidate_exists(lemma):
            valid_candidates.append(lemma)

    return valid_candidates


def _should_try_lemma(original_word: str, mdx_res: Dict) -> bool:
    """
    判断是否应该尝试词形还原。

    简化版逻辑：
    1. 如果词典已经通过 @@@LINK= 重定向了，不需要再转换
    2. 如果词典没有找到结果，尝试转换
    3. 如果词典找到结果，但与原词相同，也尝试转换
       （因为新的 _get_lemma_candidates() 会自动过滤无效候选词）

    Args:
        original_word: 原始查询词
        mdx_res: MDX 查询结果

    Returns:
        是否应该尝试词形还原
    """
    if not mdx_res:
        # 没找到任何结果，尝试转换
        return True

    # 如果词典已经通过 @@@LINK= 重定向了，不需要再转换
    if mdx_res.get("redirect_from"):
        return False

    # 如果词典找到了与原词不同的结果，说明词典已经处理了变形
    result_word = mdx_res.get("word", "").lower()
    if result_word != original_word.lower():
        return False

    # 词典找到了原词，但仍然可以尝试转换
    # 新的 _get_lemma_candidates() 会自动过滤掉无效的候选词
    return True


def _annotate_lookup_result(
    result: Optional[Dict],
    original_word: str,
    matched_word: Optional[str] = None,
    lemma_from: Optional[str] = None,
) -> Optional[Dict]:
    if not result:
        return None

    matched = matched_word or result.get("word")
    result["lookup_term"] = original_word
    result["word"] = matched or original_word

    if lemma_from:
        result["lemma_from"] = lemma_from
    elif matched and matched.lower() != original_word.lower():
        result["matched_word"] = matched

    return result


def _get_lookup_terms(word: str, prefer_lemma: bool = True) -> List[str]:
    if _is_japanese_lookup(word):
        return get_japanese_lookup_terms(word)

    if _is_korean_lookup(word):
        terms = [word]
        for candidate in _get_korean_lookup_candidates(word, validate_candidates=False):
            if candidate != word:
                terms.append(candidate)
        return terms

    lemma_candidates = _get_lemma_candidates(word, validate_candidates=True)
    if not prefer_lemma:
        terms = [word]
        for lemma in lemma_candidates:
            if lemma.lower() != word.lower():
                terms.append(lemma)
        return terms

    terms: List[str] = []
    for lemma in lemma_candidates:
        if lemma.lower() != word.lower():
            terms.append(lemma)
    terms.append(word)
    return terms


def _get_preferred_fallback_term(original_word: str, lookup_terms: List[str]) -> str:
    for term in lookup_terms:
        if term.lower() != original_word.lower():
            return term
    return original_word


def _get_cached_dictionary_result(db: Optional[Session], original_word: str, fallback_term: str) -> Optional[Dict]:
    if db is None:
        return None

    is_korean_lookup = _is_korean_lookup(original_word)
    for cache_key in dict.fromkeys([original_word.lower(), fallback_term.lower()]):
        db_res = db.query(CacheDictionary).filter(func.lower(CacheDictionary.word) == cache_key).first()
        if not db_res:
            continue

        data = dict(db_res.data or {})
        cached_word = (data.get("word") or "").strip()
        if is_korean_lookup and cached_word:
            valid_korean_words = {original_word.lower(), fallback_term.lower()}
            if cached_word.lower() not in valid_korean_words:
                logger.info(
                    "[lookup_word_all_sources] Ignoring stale Korean cache for word '%s': cached word '%s' does not match fallback '%s'",
                    original_word,
                    cached_word,
                    fallback_term,
                )
                continue

        data["lookup_term"] = original_word
        data["cached"] = True
        if data.get("word") and data["word"].lower() != original_word.lower():
            data.setdefault("lemma_from", data["word"])
        return data

    return None


def lookup_word_all_sources(db: Session, word: str) -> Optional[Dict]:
    """Look up word in ALL active dictionaries and return aggregated results.

    Args:
        db: Database session
        word: Word to look up

    Returns:
        Dict with multiple_sources=True and results array
    """
    word = normalize_lookup_word(word)

    if not word:
        return None

    original_word = word
    is_japanese_lookup = _is_japanese_lookup(original_word)

    # 获取所有启用的词典
    dict_manager = get_dict_manager()
    try:
        dicts = dict_manager.get_dicts()
        # 过滤出启用的导入词典（排除内置词典）
        active_imported_dicts = [d["name"] for d in dicts if d.get("type") == "imported" and d.get("is_active", True)]
        lookup_imported_dicts = _get_imported_dicts_for_lookup(active_imported_dicts, original_word)

        lookup_terms = _get_lookup_terms(original_word, prefer_lemma=True)
        fallback_term = _get_preferred_fallback_term(original_word, lookup_terms)

        # 查询所有启用的词典。优先按原型查询，找不到再回退到原词。
        results = []
        for dict_name in lookup_imported_dicts:
            try:
                matched_word = original_word
                matched_lemma = None
                result = None

                for term in lookup_terms:
                    try:
                        candidate_result = dict_manager.lookup_word(term, source=dict_name)
                    except Exception as e:
                        logger.warning(f"Failed lookup in {dict_name} for {term}: {e}")
                        continue

                    if candidate_result:
                        result = candidate_result
                        matched_word = term
                        if term.lower() != original_word.lower():
                            matched_lemma = term
                        break

                if result:
                    result_word = result.get("word")
                    if result_word and result_word.lower() != original_word.lower():
                        matched_word = result_word
                        if result_word.lower() in [candidate.lower() for candidate in lookup_terms]:
                            matched_lemma = result_word

                    supplement = ecdict_service.get_word_details(matched_word) or ecdict_service.get_word_details(original_word)
                    if supplement:
                        if supplement.get("translation"):
                            result["chinese_translation"] = supplement["translation"]
                        if supplement.get("phonetic"):
                            result["phonetic"] = supplement["phonetic"]

                    result = _annotate_lookup_result(
                        result,
                        original_word=original_word,
                        matched_word=matched_word,
                        lemma_from=matched_lemma,
                    )
                    results.append({"source_label": dict_name, "source": dict_name, **result})
            except Exception as e:
                logger.warning(f"Failed to lookup in {dict_name}: {e}")
                continue

        if is_japanese_lookup:
            jmdict_result = _lookup_jmdict_terms(original_word, lookup_terms)
            if jmdict_result:
                results.append({"source_label": JMDICT_SOURCE, "source": JMDICT_SOURCE, **jmdict_result})

        if not results:
            if is_japanese_lookup:
                return None

            # 所有导入词典都没找到，优先返回原型的 ECDICT 结果，再回退原词。
            for term in lookup_terms:
                ecdict_data = ecdict_service.get_word_details(term)
                if not ecdict_data:
                    continue

                return {
                    "word": term,
                    "lookup_term": original_word,
                    "lemma_from": term if term.lower() != original_word.lower() else None,
                    "phonetic": ecdict_data.get("phonetic"),
                    "chinese_translation": ecdict_data.get("translation"),
                    "source": "ECDICT",
                    "is_ecdict": True,
                    "raw_data": ecdict_data,
                    "meanings": [
                        {
                            "partOfSpeech": ecdict_data.get("pos"),
                            "definitions": [
                                {
                                    "definition": ecdict_data.get("definition", ecdict_data.get("translation", "")),
                                    "translation": ecdict_data.get("translation"),
                                }
                            ],
                        }
                    ],
                }

            cached_result = _get_cached_dictionary_result(db, original_word, fallback_term)
            if cached_result:
                logger.info(f"[lookup_word_all_sources] Found cached fallback for word: {word}")
                return cached_result

            # ECDICT 也没找到，尝试 AI 兜底查询
            logger.info(f"[lookup_word_all_sources] Not found in any imported dict or ECDICT, trying AI fallback for word: {word}")
            try:
                from ..services import supplier_factory

                # 使用 AI 定义单词
                prompt_word = fallback_term
                prompt = f"""Please define the word "{prompt_word}" in the following JSON format. If the original lookup form "{original_word}" is inflected, define its dictionary form:
{{
    "word": "{prompt_word}",
    "phonetic": "[phonetic transcription if available]",
    "meanings": [
        {{
            "partOfSpeech": "part of speech",
            "definitions": [
                {{
                    "definition": "clear definition in English",
                    "translation": "Chinese translation"
                }}
            ]
        }}
    ]
}}

Return ONLY the JSON, no other text."""

                response = supplier_factory.chat_with_active_supplier(
                    prompt,
                    history=[],
                    temperature=0.3
                )

                if response:
                    logger.info(f"[lookup_word_all_sources] AI response for word {word}: {response[:200]}...")

                    # 尝试解析 JSON 响应
                    import json
                    import re

                    # 提取 JSON（去除可能的 markdown 代码块）
                    json_match = re.search(r'```json\s*(.*?)\s*```', response, re.DOTALL)
                    if json_match:
                        response = json_match.group(1).strip()
                    else:
                        # 尝试直接提取 JSON 对象
                        json_match = re.search(r'\{.*\}', response, re.DOTALL)
                        if json_match:
                            response = json_match.group(0).strip()

                    logger.info(f"[lookup_word_all_sources] Extracted JSON for word {word}: {response[:200]}...")
                    ai_data = json.loads(response)
                    logger.info(f"[lookup_word_all_sources] Parsed AI data for word {word}: {ai_data}")

                    # 构造返回结果
                    ai_word = fallback_term
                    result = {
                        "word": ai_word,
                        "lookup_term": original_word,
                        "lemma_from": ai_word if ai_word.lower() != original_word.lower() else None,
                        "source": "AI",
                        "is_ai": True,
                        "phonetic": ai_data.get("phonetic", ""),
                        "chinese_translation": "",
                    }

                    # 处理 meanings
                    meanings = ai_data.get("meanings", [])
                    if meanings:
                        result["meanings"] = []
                        for meaning in meanings:
                            definitions = meaning.get("definitions", [])
                            if definitions:
                                result["meanings"].append({
                                    "partOfSpeech": meaning.get("partOfSpeech", ""),
                                    "definitions": definitions
                                })

                        # 获取第一个中文翻译作为整体翻译
                        if definitions and definitions[0].get("translation"):
                            result["chinese_translation"] = definitions[0]["translation"]

                    if db is not None:
                        cache_service.save_dictionary_cache(db, original_word.lower(), result)
                        if fallback_term.lower() != original_word.lower():
                            cache_service.save_dictionary_cache(db, fallback_term.lower(), result)

                    logger.info(f"[lookup_word_all_sources] AI fallback successful for word: {word}")
                    return result
                else:
                    logger.warning(f"[lookup_word_all_sources] AI returned empty response for word {word}")

            except Exception as e:
                logger.warning(f"[lookup_word_all_sources] AI fallback failed for word {word}: {e}")
                import traceback
                logger.warning(f"[lookup_word_all_sources] Traceback: {traceback.format_exc()}")

            return None

        # 只有一个词典有结果，直接返回（使用单词典模式）
        if len(results) == 1:
            return results[0]

        # 多个词典有结果，返回聚合模式
        # 单独查询 ECDICT 获取中文翻译和音标，而不是依赖词典结果
        preferred_result = next((item for item in results if item.get("lemma_from")), results[0] if results else None)
        preferred_word = preferred_result.get("word") if preferred_result else original_word
        ecdict_for_multi = ecdict_service.get_word_details(preferred_word) or ecdict_service.get_word_details(original_word)
        chinese_translation = ecdict_for_multi.get("translation") if ecdict_for_multi else None
        phonetic = ecdict_for_multi.get("phonetic") if ecdict_for_multi else None

        # 如果 ECDICT 没有找到，尝试从第一个词典结果获取
        if not chinese_translation and results:
            chinese_translation = results[0].get("chinese_translation")
        if not phonetic and results:
            phonetic = results[0].get("phonetic")

        return {
            "word": preferred_word,
            "lookup_term": original_word,
            "lemma_from": preferred_result.get("lemma_from") if preferred_result else None,
            "multiple_sources": True,
            "preferred_source": preferred_result.get("source_label") if preferred_result else None,
            "results": results,
            "phonetic": phonetic,
            "chinese_translation": chinese_translation,
        }

    except Exception as e:
        logger.error(f"Error in lookup_word_all_sources: {e}")
        # 发生错误时，回退到 ECDICT 直接查询
        return ecdict_service.get_word_details(original_word)


def lookup_word(db: Session, word: str, source: Optional[str] = None) -> Optional[Dict]:
    """Look up word in dictionary (cache -> local mdx -> gemini -> internet)

    Args:
        db: Database session
        word: Word to look up
        source: Optional dictionary source to prefer

    Note:
        - If source is None, queries ALL active dictionaries and returns aggregated results
        - If source is specified (including empty string), only queries that specific dictionary
    """
    # 如果 source 是 None，使用多词典聚合查询
    # 空字符串被视为有效的 source 值（表示默认词典）
    if source is None:
        return lookup_word_all_sources(db, word)

    word = normalize_lookup_word(word)

    if not word:
        return None

    # 保存原始查询词，用于后续词形还原
    original_word = word
    is_japanese_lookup = _is_japanese_lookup(original_word)
    is_korean_lookup = _is_korean_lookup(original_word)

    lookup_terms = _get_lookup_terms(original_word, prefer_lemma=True)
    fallback_term = _get_preferred_fallback_term(original_word, lookup_terms)

    if source == JMDICT_SOURCE or (is_japanese_lookup and source == ""):
        return _lookup_jmdict_terms(original_word, lookup_terms)

    if is_korean_lookup and source == "":
        return lookup_word_all_sources(db, word)

    if is_korean_lookup and source and source not in ("AI", "ECDICT") and not _is_korean_dict_name(source):
        logger.info("Skipping non-Korean source '%s' for Korean word '%s'", source, word)
        return None

    # 1. Try Imported MDX Dictionaries FIRST
    imported_res = None
    matched_word = original_word
    try:
        dict_manager = get_dict_manager()
        for term in lookup_terms:
            imported_res = dict_manager.lookup_word(term, source=source)
            if imported_res:
                matched_word = term
                break
    except Exception as e:
        logger.warning(f"DictManager lookup failed: {e}")

    # Get ECDICT Data (used for translation and phonetic fallback regardless of source)
    ecdict_data = ecdict_service.get_word_details(matched_word) or ecdict_service.get_word_details(word)
    cn_translation = ecdict_data.get("translation") if ecdict_data else None
    ecdict_phonetic = ecdict_data.get("phonetic") if ecdict_data else None

    # If found in MDX, return it with ECDICT translation and phonetic as supplement
    if imported_res:
        # 检查返回的数据是否有效（meanings 不为空，或者 html_content 不包含错误信息）
        meanings = imported_res.get("meanings", [])
        html_content = imported_res.get("html_content", "")
        is_valid = (
            (meanings and len(meanings) > 0) or
            (html_content and "error" not in html_content.lower() and "no definition found" not in html_content.lower())
        )

        if not is_valid:
            logger.info(f"Dictionary returned invalid result for word '{word}', treating as not found")
            imported_res = None
        else:
            logger.info(f"Found in dictionary: {imported_res.get('source', 'unknown')}")
            if cn_translation:
                imported_res["chinese_translation"] = cn_translation
            # 始终使用 ECDICT 的音标，覆盖导入词典的音标
            if ecdict_phonetic:
                imported_res["phonetic"] = ecdict_phonetic
            result_word = imported_res.get("word")
            if result_word and result_word.lower() != original_word.lower():
                matched_word = result_word
            else:
                matched_word = matched_word or result_word
            imported_res = _annotate_lookup_result(
                imported_res,
                original_word=original_word,
                matched_word=matched_word,
                lemma_from=matched_word if matched_word and matched_word.lower() != original_word.lower() else None,
            )
            return imported_res

    if is_japanese_lookup:
        jmdict_res = _lookup_jmdict_terms(original_word, lookup_terms)
        if jmdict_res:
            return jmdict_res
        if source:
            logger.info("No definition found for Japanese word '%s' in source '%s'", word, source)
            return None
        return {
            "word": lookup_terms[0] if lookup_terms else original_word,
            "lookup_term": original_word,
            "lemma_from": lookup_terms[1] if len(lookup_terms) > 1 else None,
            "meanings": [],
            "source": "None",
        }

    # 2. Search Database Cache (before ECDICT, to avoid redundant lookups)
    if not source or source == "AI":
        db_res = db.query(CacheDictionary).filter(func.lower(CacheDictionary.word) == word.lower()).first()
        if db_res:
            data = db_res.data
            result = {
                "word": data.get("word", original_word),
                "lookup_term": original_word,
                "meanings": data.get("meanings", []),
                "chinese_summary": data.get("chinese_summary"),
                "chinese_translation": data.get("chinese_translation"),
                "source": data.get("source"),
                "cached": True,
            }
            if cn_translation:
                result["chinese_translation"] = cn_translation
            return result

    # 3. Use Full ECDICT as Primary Local Fallback
    if ecdict_data:
        # Map ECDICT fields to frontend expected structure
        result = {
            "word": matched_word,
            "lookup_term": original_word,
            "lemma_from": matched_word if matched_word.lower() != original_word.lower() else None,
            "phonetic": ecdict_data.get("phonetic"),
            "chinese_translation": cn_translation,
            "source": "ECDICT",
            "is_ecdict": True,
            "raw_data": ecdict_data,  # Pass everything for user inspection
            "meanings": [
                {
                    "partOfSpeech": ecdict_data.get("pos"),
                    "definitions": [{"definition": ecdict_data.get("definition", ""), "translation": cn_translation}],
                }
            ],
        }
        return result

    # 4. Try AI (Fallback for Chinese translation)
    if not source or source == "AI":
        try:
            from .supplier_factory import chat_with_active_supplier, get_supplier_factory

            # 检查是否有配置的 AI 供应商
            factory = get_supplier_factory()
            if factory.get_active_supplier_type():
                prompt = f"""请为英文单词 "{word}" 提供以下信息，返回 JSON 格式（只返回 JSON，不要有其他文本）：
{{
    "word": "{word}",
    "phonetic": "音标（如果知道）",
    "chinese_translation": "中文翻译",
    "meanings": [
        {{
            "partOfSpeech": "词性（如 noun, verb 等）",
            "definitions": [
                {{
                    "definition": "英文定义",
                    "translation": "中文翻译"
                }}
            ]
        }}
    ]
}}"""

                ai_response = chat_with_active_supplier(
                    prompt,
                    system_prompt="You are a professional English dictionary. Return only valid JSON.",
                    temperature=0.1,
                    max_tokens=1000
                )

                if ai_response:
                    import json
                    # 移除可能的 markdown 代码块标记
                    response_text = ai_response.strip()
                    if response_text.startswith("```"):
                        response_text = response_text.split("```")[1]
                        if response_text.startswith("json"):
                            response_text = response_text[4:]
                    response_text = response_text.strip()

                    try:
                        ai_result = json.loads(response_text)
                        ai_result["source"] = "AI"
                        ai_result["cached"] = False
                        ai_result["lookup_term"] = original_word
                        ai_result["word"] = fallback_term
                        if ai_result["word"].lower() != original_word.lower():
                            ai_result["lemma_from"] = ai_result["word"]

                        # 如果 ECDICT 有翻译，优先使用 ECDICT 的翻译
                        if cn_translation:
                            ai_result["chinese_translation"] = cn_translation

                        # 缓存 AI 结果
                        cache_service.save_dictionary_cache(db, word.lower(), ai_result)
                        logger.info(f"Found via AI: {word}")
                        return ai_result
                    except json.JSONDecodeError as e:
                        logger.warning(f"AI 返回的 JSON 解析失败: {e}")
            else:
                logger.debug("未配置 AI 供应商，跳过 AI 词典查询")
        except Exception as e:
            logger.warning(f"AI 词典查询失败: {e}")



    # 4. Fallback to Free Dictionary API
    try:
        resp = requests.get(FREE_DICT_API.format(word=word), timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, list) and len(data) > 0:
                entry = data[0]

                # Extract relevant data
                result = {
                    "word": matched_word,
                    "lookup_term": original_word,
                    "lemma_from": matched_word if matched_word.lower() != original_word.lower() else None,
                    "phonetic": entry.get("phonetic"),
                    "audio_url": next(
                        (p["audio"] for p in entry.get("phonetics", []) if p.get("audio")),
                        None,
                    ),
                    "meanings": entry.get("meanings", []),
                    "cached": False,
                }

                if cn_translation:
                    result["chinese_translation"] = cn_translation

                # 3. Save to cache
                cache_service.save_dictionary_cache(db, word.lower(), result)
                return result
    except Exception as e:
        logger.error(f"Dictionary API error: {e}")

    # 如果指定了 source 但没有找到结果，返回 None 而不是默认的错误页面
    # 这样前端会执行第二次查询（不指定 source 的 AI 兜底查询）
    if source:
        logger.info(f"No definition found for word '{word}' in source '{source}', returning None to trigger fallback")
        return None

    # 如果没有指定 source，返回默认的错误页面
    return {
        "word": fallback_term,
        "lookup_term": original_word,
        "lemma_from": fallback_term if fallback_term.lower() != original_word.lower() else None,
        "phonetic": "/.../",
        "meanings": [],
        "html_content": f"<div class='error'>No definition found for '{word}'</div>",
        "source": "None",
        "chinese_translation": cn_translation,
    }


def get_word_sources(word: str) -> Dict[str, bool]:
    """Check availability of word in different dictionaries.

    Args:
        word: Word to check

    Returns:
        Dict mapping source name to availability boolean
    """
    normalized_word = normalize_lookup_word(word)
    sources = get_dict_manager().check_sources(normalized_word)
    if _is_japanese_lookup(normalized_word):
        sources[JMDICT_SOURCE] = bool(_lookup_jmdict_terms(normalized_word, get_japanese_lookup_terms(normalized_word)))
    return sources
