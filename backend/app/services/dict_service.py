from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import Optional, Dict, Any, List
from ..models.models import CacheDictionary
from ..services import (
    cache_service,
    gemini_service,
    ecdict_service,
    open_dict_service,
)
from app import config
import requests
import json
import string
import logging

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
    candidates = []
    word_lower = word.lower()

    # 1. 检查例外列表：如果原词在例外列表中，直接返回空列表
    for suffix, words in _EXCEPTION_WORDS.items():
        if word_lower in words:
            return []

    # 2. 复数形式还原
    if word_lower.endswith("ies"):
        # cities -> city
        candidates.append(word[:-3] + "y")
    if word_lower.endswith("es"):
        # boxes -> box, watches -> watch
        candidates.append(word[:-2])
    if word_lower.endswith("s") and not word_lower.endswith("ss"):
        # deserts -> desert, books -> book
        candidates.append(word[:-1])

    # 3. 过去式/过去分词还原
    if word_lower.endswith("ied"):
        # studied -> study
        candidates.append(word[:-3] + "y")
    if word_lower.endswith("ed"):
        # walked -> walk
        candidates.append(word[:-2])
        # loved -> love
        candidates.append(word[:-1])

    # 4. 进行时还原
    if word_lower.endswith("ing"):
        # running -> run (双写辅音)
        if len(word) > 4 and word[-4] == word[-5]:
            candidates.append(word[:-4])
        # loving -> love
        candidates.append(word[:-3] + "e")
        # running -> run, walking -> walk
        candidates.append(word[:-3])

    # 5. 比较级/最高级还原
    if word_lower.endswith("er"):
        # bigger -> big (双写辅音)
        if len(word) > 4 and word[-3] == word[-4]:
            candidates.append(word[:-3])
        # larger -> large
        candidates.append(word[:-2])
    if word_lower.endswith("est"):
        candidates.append(word[:-3])
        candidates.append(word[:-2])  # largest -> large
    if word_lower.endswith("ier"):
        candidates.append(word[:-3] + "y")  # happier -> happy
    if word_lower.endswith("iest"):
        candidates.append(word[:-4] + "y")  # happiest -> happy

    # 6. 可选：验证候选词是否在词典中存在
    if validate_candidates:
        return _validate_lemma_candidates(candidates)

    return candidates


def _validate_lemma_candidates(candidates: List[str]) -> List[str]:
    """
    验证候选词是否在词典中存在。

    Args:
        candidates: 原始候选词列表

    Returns:
        验证后的候选词列表（只包含在词典中存在的词）
    """
    valid_candidates = []

    for lemma in candidates:
        # 过滤过短的词
        if len(lemma) < 2:
            continue

        # 过滤掉明显无效的转换（如单字母）
        if len(lemma) <= 2 and not lemma.isalpha():
            continue

        # 查询词典验证存在性
        if get_dict_manager().word_exists(lemma):
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


def lookup_word(db: Session, word: str, source: Optional[str] = None) -> Optional[Dict]:
    """Look up word in dictionary (cache -> local mdx -> gemini -> internet)

    Args:
        db: Database session
        word: Word to look up
        source: Optional dictionary source to prefer
    """
    # 清理词语
    word = word.strip()

    # 标准化引号：将 Unicode 智能引号转换为普通单引号
    # U+2018 ' LEFT SINGLE QUOTATION MARK
    # U+2019 ' RIGHT SINGLE QUOTATION MARK
    # U+0027 ' APOSTROPHE (普通单引号)
    word = word.replace("\u2019", "'").replace("\u2018", "'")

    # 剥离句末常见标点
    while word and word[-1] in ".,!?;:":
        word = word[:-1]
    # 剥离句首常见标点
    while word and word[0] in ".,!?;:\"'(":
        word = word[1:]

    # 处理所有格 's：剥离 's 查询原型，但保留缩写形式
    # 常见缩写后缀：n't, 'm, 're, 've, 'll, 'd, 's (it's, that's, what's 等)
    contraction_suffixes = ("n't", "'m", "'re", "'ve", "'ll", "'d")
    is_contraction = any(word.lower().endswith(suffix) for suffix in contraction_suffixes)

    # 特殊缩写词：it's, that's, what's, who's, there's, here's, let's 等
    contraction_words = {
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
    is_contraction = is_contraction or word.lower() in contraction_words

    # 如果是 's 结尾且不是缩写，则剥离 's 查询原型
    if word.endswith("'s") and not is_contraction:
        word = word[:-2]  # 去掉 's

    if not word:
        return None

    # 保存原始查询词，用于后续词形还原
    original_word = word

    # 1. Try Imported MDX Dictionaries FIRST
    imported_res = None
    try:
        dict_manager = get_dict_manager()
        imported_res = dict_manager.lookup_word(word, source=source)
    except Exception as e:
        logger.warning(f"DictManager lookup failed: {e}")

    # Get ECDICT Data (used for translation and phonetic fallback regardless of source)
    ecdict_data = ecdict_service.get_word_details(word)
    cn_translation = ecdict_data.get("translation") if ecdict_data else None
    ecdict_phonetic = ecdict_data.get("phonetic") if ecdict_data else None

    # If found in MDX, return it with ECDICT translation and phonetic as supplement
    if imported_res:
        logger.info(f"Found in dictionary: {imported_res.get('source', 'unknown')}")
        if cn_translation:
            imported_res["chinese_translation"] = cn_translation
        # 始终使用 ECDICT 的音标，覆盖导入词典的音标
        if ecdict_phonetic:
            imported_res["phonetic"] = ecdict_phonetic
        return imported_res

    # 1.5. 尝试词形还原后重新查询 MDX（仅在 MDX 查询失败时）
    if _should_try_lemma(original_word, imported_res):
        lemma_candidates = _get_lemma_candidates(original_word, validate_candidates=True)
        if lemma_candidates:
            logger.info(f"Trying lemma candidates for '{original_word}': {lemma_candidates}")
            for lemma in lemma_candidates:
                try:
                    lemma_result = dict_manager.lookup_word(lemma, source=source)
                    if lemma_result:
                        logger.info(f"Found via lemma reduction: '{original_word}' → '{lemma}'")
                        # 用原词作为显示词，但使用 lemma 的释义
                        lemma_result["word"] = original_word
                        lemma_result["lemma_from"] = lemma
                        # 补充 ECDICT 翻译和音标
                        lemma_cn_translation = ecdict_service.get_translation(lemma)
                        if lemma_cn_translation:
                            lemma_result["chinese_translation"] = lemma_cn_translation
                        lemma_phonetic = ecdict_service.get_word_details(lemma).get("phonetic") if ecdict_service.get_word_details(lemma) else None
                        if lemma_phonetic:
                            lemma_result["phonetic"] = lemma_phonetic
                        return lemma_result
                except Exception as e:
                    logger.warning(f"Lemma lookup failed for '{lemma}': {e}")
                    continue

    # 2. Use Full ECDICT as Primary Local Fallback
    if ecdict_data:
        # Map ECDICT fields to frontend expected structure
        result = {
            "word": ecdict_data.get("word"),
            "phonetic": ecdict_data.get("phonetic"),
            "chinese_translation": cn_translation,
            "source": "ECDICT",
            "is_ecdict": True,
            "raw_data": ecdict_data, # Pass everything for user inspection
            "meanings": [
                {
                    "partOfSpeech": ecdict_data.get("pos"),
                    "definitions": [
                        {"definition": ecdict_data.get("definition", ""), "translation": cn_translation}
                    ]
                }
            ]
        }
        return result


    # 3. Search Database (Cache/Gemini generated)
    if not source or source == "AI":
        db_res = db.query(CacheDictionary).filter(func.lower(CacheDictionary.word) == word.lower()).first()
        if db_res:
            data = db_res.data
            result = {
                "word": db_res.word,
                "meanings": data.get("meanings", []),
                "chinese_summary": data.get("chinese_summary"),
                "chinese_translation": data.get("chinese_translation"),
                "source": data.get("source"),
                "cached": True,
            }
            if cn_translation:
                result["chinese_translation"] = cn_translation
            return result

    # 3. Try Gemini AI (Preferred for Chinese translation)
    # Note: gemini_service.lookup_word_ai() function doesn't exist, commented out
    # ai_result = gemini_service.lookup_word_ai(word)
    # # Gemini may return list or dict
    # if ai_result:
    #     # If it's a list, take the first item
    #     if isinstance(ai_result, list) and len(ai_result) > 0:
    #         ai_result = ai_result[0]
    #
    #     if isinstance(ai_result, dict):
    #         # Add audio placeholder if Gemini doesn't provide it
    #         try:
    #             audio_resp = requests.get(FREE_DICT_API.format(word=word), timeout=1)
    #             if audio_resp.status_code == 200:
    #                 data = audio_resp.json()
    #                 if isinstance(data, list) and data:
    #                     for p in data[0].get("phonetics", []):
    #                         if p.get("audio"):
    #                             ai_result["audio_url"] = p["audio"]
    #                             break
    #         except:
    #             pass
    #
    #         ai_result["cached"] = False
    #
    #         # Inject ECDICT translation if available
    #         if cn_translation:
    #             ai_result["chinese_translation"] = cn_translation
    #
    #         cache_service.save_dictionary_cache(db, word.lower(), ai_result)
    #         return ai_result

    # 4. Fallback to Free Dictionary API
    try:
        resp = requests.get(FREE_DICT_API.format(word=word), timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, list) and len(data) > 0:
                entry = data[0]

                # Extract relevant data
                result = {
                    "word": entry.get("word"),
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

    return {
        "word": word,
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
    return get_dict_manager().check_sources(word)
