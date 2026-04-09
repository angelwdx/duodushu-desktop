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
from ..utils.lookup_normalizer import normalize_lookup_word
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

    def add_candidate(candidate: str) -> None:
        if not candidate:
            return
        if candidate.lower() == word_lower:
            return
        candidates.append(candidate)

    # 1. 检查例外列表：如果原词在例外列表中，直接返回空列表
    for suffix, words in _EXCEPTION_WORDS.items():
        if word_lower in words:
            return []

    # 2. 复数形式还原
    if word_lower.endswith("ies"):
        # cities -> city
        add_candidate(word[:-3] + "y")
    if word_lower.endswith(("ses", "xes", "zes", "ches", "shes", "oes")):
        # boxes -> box, watches -> watch, heroes -> hero
        add_candidate(word[:-2])
    elif word_lower.endswith("es") and len(word) > 3:
        add_candidate(word[:-1])
        add_candidate(word[:-2])
    if word_lower.endswith("s") and not word_lower.endswith("ss"):
        # deserts -> desert, books -> book
        add_candidate(word[:-1])

    # 3. 过去式/过去分词还原
    if word_lower.endswith("ied"):
        # studied -> study
        add_candidate(word[:-3] + "y")
    if word_lower.endswith("ed"):
        # spotted -> spot, stopped -> stop
        if len(word) > 4 and word[-3].lower() == word[-4].lower():
            add_candidate(word[:-3])
        # walked -> walk
        add_candidate(word[:-2])
        # loved -> love
        add_candidate(word[:-1])

    # 4. 进行时还原
    if word_lower.endswith("ing"):
        # running -> run (双写辅音)
        if len(word) > 5 and word[-4].lower() == word[-5].lower():
            add_candidate(word[:-4])
        # loving -> love
        add_candidate(word[:-3] + "e")
        # running -> run, walking -> walk
        add_candidate(word[:-3])
        # panicking -> panic
        if word_lower.endswith("cking"):
            add_candidate(word[:-3])
            add_candidate(word[:-4])

    # 5. 比较级/最高级还原
    if word_lower.endswith("er"):
        # bigger -> big (双写辅音)
        if len(word) > 4 and word[-3].lower() == word[-4].lower():
            add_candidate(word[:-3])
        # larger -> large
        add_candidate(word[:-2])
    if word_lower.endswith("est"):
        add_candidate(word[:-3])
        add_candidate(word[:-2])  # largest -> large
    if word_lower.endswith("ier"):
        add_candidate(word[:-3] + "y")  # happier -> happy
    if word_lower.endswith("iest"):
        add_candidate(word[:-4] + "y")  # happiest -> happy

    # 6. 去重并保序
    deduped_candidates: List[str] = []
    seen = set()
    for candidate in candidates:
        lower_candidate = candidate.lower()
        if lower_candidate in seen:
            continue
        seen.add(lower_candidate)
        deduped_candidates.append(candidate)

    # 7. 可选：验证候选词是否在词典中存在
    if validate_candidates:
        return _validate_lemma_candidates(deduped_candidates)

    return deduped_candidates


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

        dict_manager = get_dict_manager()

        # 查询词典或 ECDICT 验证存在性
        if (dict_manager and dict_manager.word_exists(lemma)) or ecdict_service.get_word_details(lemma):
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

    # 获取所有启用的词典
    dict_manager = get_dict_manager()
    try:
        dicts = dict_manager.get_dicts()
        # 过滤出启用的导入词典（排除 ECDICT）
        active_imported_dicts = [d["name"] for d in dicts if d.get("type") == "imported" and d.get("is_active", True)]

        if not active_imported_dicts:
            # 没有启用的导入词典，直接跳过，后续会回退到 ECDICT
            pass

        # 查询所有启用的词典
        results = []
        for dict_name in active_imported_dicts:
            try:
                result = dict_manager.lookup_word(word, source=dict_name)
                if result:
                    # 添加 ECDICT 翻译和音标
                    ecdict_data = ecdict_service.get_word_details(word)
                    if ecdict_data:
                        if ecdict_data.get("translation"):
                            result["chinese_translation"] = ecdict_data["translation"]
                        if ecdict_data.get("phonetic"):
                            result["phonetic"] = ecdict_data["phonetic"]
                    results.append({"source_label": dict_name, "source": dict_name, **result})
            except Exception as e:
                logger.warning(f"Failed to lookup in {dict_name}: {e}")
                continue

        if not results:
            lemma_candidates = _get_lemma_candidates(original_word, validate_candidates=False)
            for lemma in lemma_candidates:
                lemma_results = []
                for dict_name in active_imported_dicts:
                    try:
                        result = dict_manager.lookup_word(lemma, source=dict_name)
                        if result:
                            lemma_ecdict = ecdict_service.get_word_details(lemma)
                            if lemma_ecdict:
                                if lemma_ecdict.get("translation"):
                                    result["chinese_translation"] = lemma_ecdict["translation"]
                                if lemma_ecdict.get("phonetic"):
                                    result["phonetic"] = lemma_ecdict["phonetic"]
                            result["word"] = original_word
                            result["lemma_from"] = lemma
                            lemma_results.append({"source_label": dict_name, "source": dict_name, **result})
                    except Exception as e:
                        logger.warning(f"Failed lemma lookup in {dict_name} for {lemma}: {e}")
                        continue

                if lemma_results:
                    if len(lemma_results) == 1:
                        return lemma_results[0]

                    lemma_ecdict = ecdict_service.get_word_details(lemma)
                    return {
                        "word": original_word,
                        "lemma_from": lemma,
                        "multiple_sources": True,
                        "results": lemma_results,
                        "phonetic": lemma_ecdict.get("phonetic") if lemma_ecdict else None,
                        "chinese_translation": lemma_ecdict.get("translation") if lemma_ecdict else None,
                    }

            # 所有导入词典都没找到，返回 ECDICT 结果
            ecdict_data = ecdict_service.get_word_details(word)
            if ecdict_data:
                return {
                    "word": ecdict_data.get("word"),
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

            for lemma in lemma_candidates:
                lemma_ecdict = ecdict_service.get_word_details(lemma)
                if lemma_ecdict:
                    return {
                        "word": original_word,
                        "lemma_from": lemma,
                        "phonetic": lemma_ecdict.get("phonetic"),
                        "chinese_translation": lemma_ecdict.get("translation"),
                        "source": "ECDICT",
                        "is_ecdict": True,
                        "raw_data": lemma_ecdict,
                        "meanings": [
                            {
                                "partOfSpeech": lemma_ecdict.get("pos"),
                                "definitions": [
                                    {
                                        "definition": lemma_ecdict.get("definition", lemma_ecdict.get("translation", "")),
                                        "translation": lemma_ecdict.get("translation"),
                                    }
                                ],
                            }
                        ],
                    }

            # ECDICT 也没找到，尝试 AI 兜底查询
            logger.info(f"[lookup_word_all_sources] Not found in any imported dict or ECDICT, trying AI fallback for word: {word}")
            try:
                from ..services import supplier_factory

                # 使用 AI 定义单词
                prompt = f"""Please define the English word "{word}" in the following JSON format:
{{
    "word": "{word}",
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
                    result = {
                        "word": ai_data.get("word", word),
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
        ecdict_for_multi = ecdict_service.get_word_details(original_word)
        chinese_translation = ecdict_for_multi.get("translation") if ecdict_for_multi else None
        phonetic = ecdict_for_multi.get("phonetic") if ecdict_for_multi else None

        # 如果 ECDICT 没有找到，尝试从第一个词典结果获取
        if not chinese_translation and results:
            chinese_translation = results[0].get("chinese_translation")
        if not phonetic and results:
            phonetic = results[0].get("phonetic")

        return {
            "word": original_word,
            "multiple_sources": True,
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
                        lemma_phonetic = (
                            ecdict_service.get_word_details(lemma).get("phonetic")
                            if ecdict_service.get_word_details(lemma)
                            else None
                        )
                        if lemma_phonetic:
                            lemma_result["phonetic"] = lemma_phonetic
                        return lemma_result
                except Exception as e:
                    logger.warning(f"Lemma lookup failed for '{lemma}': {e}")
                    continue

    # 2. Search Database Cache (before ECDICT, to avoid redundant lookups)
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

    # 3. Use Full ECDICT as Primary Local Fallback
    if ecdict_data:
        # Map ECDICT fields to frontend expected structure
        result = {
            "word": ecdict_data.get("word"),
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

    # 如果指定了 source 但没有找到结果，返回 None 而不是默认的错误页面
    # 这样前端会执行第二次查询（不指定 source 的 AI 兜底查询）
    if source:
        logger.info(f"No definition found for word '{word}' in source '{source}', returning None to trigger fallback")
        return None

    # 如果没有指定 source，返回默认的错误页面
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
