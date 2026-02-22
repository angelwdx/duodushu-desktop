"""
句子处理工具模块

提供句子切分和验证功能，用于从书籍中提取高质量例句。
"""

import re
import logging

extraction_logger = logging.getLogger("extraction")


def split_sentences(text: str) -> list:
    """
    改进的句子切分，正确处理英文缩写

    支持的缩写：
    - Mr., Mrs., Ms., Dr., Prof.
    - St., e.g., i.e., vs., etc.
    - U.S., U.K., U.N.

    Args:
        text: 文本内容

    Returns:
        切分后的句子列表
    """
    if not text:
        return []

    # 常见英文缩写列表
    ABBREVIATIONS = [
        "Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Rev.", "St.",
        "e.g.", "i.e.", "vs.", "etc.", "esp.",
        "U.S.", "U.K.", "U.N.", "N.Y.", "L.A.", "D.C.",
        "Jan.", "Feb.", "Mar.", "Apr.", "Jun.", "Jul.",
        "Aug.", "Sep.", "Sept.", "Oct.", "Nov.", "Dec.",
        "Mon.", "Tue.", "Wed.", "Thu.", "Fri.", "Sat.", "Sun.",
        "No.", "pp.", "vol.", "sec.", "fig.", "tab.",
        "tel.", "fax.", "email.", "www.", "http://", "https://",
    ]

    # 临时保护缩写（替换为特殊标记）
    protected_text = text
    for i, abbr in enumerate(ABBREVIATIONS):
        placeholder = f"__ABBR{i}__"
        protected_text = protected_text.replace(abbr, placeholder)

    # 切分句子
    sentences = re.split(r"(?<=[.!?])(?:\s+|(?=[A-Z]))|(?:\n\n+)", protected_text)

    # 恢复缩写
    result_sentences = []
    for sent in sentences:
        for i, abbr in enumerate(ABBREVIATIONS):
            placeholder = f"__ABBR{i}__"
            sent = sent.replace(placeholder, abbr)

        cleaned = " ".join(sent.split())
        if len(cleaned) >= 10:
            result_sentences.append(cleaned)

    return result_sentences


def is_valid_sentence(sentence: str, word: str) -> bool:
    """
    Check if a sentence is a valid, high-quality example.
    Filters out:
    - Lists/Indexes (Series Names, Character Names)
    - Mostly uppercase text
    - Too long/short text
    - Text with excessive colons (dictionary-like entries)
    """
    s = sentence.strip()

    # 1. Basic length check
    if len(s) < 10 or len(s) > 800:
        return False

    # 2. Uppercase ratio check
    letters = [c for c in s if c.isalpha()]
    if not letters:
        return False
    uppercase_count = sum(1 for c in letters if c.isupper())
    if uppercase_count / len(letters) > 0.5:
        return False

    # 3. Keyword blocklist
    blocklist = [
        "Series Names", "Character Names", "Pronounced like",
        "Table of Contents", "Index:", "ISBN", "Copyright",
        "All rights reserved", "Translated by", "Edited by",
    ]
    for block in blocklist:
        if block.lower() in s.lower():
            return False

    # 4. Punctuation check
    if s.count(":") > 2:
        return False

    return True


def extract_sentences_with_word(text: str, word: str) -> list:
    """
    从文本中提取包含指定词的句子（增强版）

    改进：
    - 使用词形还原支持不规则变形
    - 改进句子切分，正确处理缩写
    - 支持更多词性变形

    Args:
        text: 文本内容
        word: 要查找的单词

    Returns:
        匹配的句子列表（最多10个）
    """
    from app.utils.lemmatizer import get_word_variants

    if not text:
        return []

    # 1. 获取单词的所有变体
    word_lower = word.lower()
    word_variants = get_word_variants(word)
    extraction_logger.info(f"[词形还原] '{word}' 的变体: {sorted(word_variants)}")

    # 2. 构建匹配模式
    exact_pattern = r"\b" + re.escape(word) + r"\b"

    # 3. 改进的句子切分
    sentences = split_sentences(text)

    matching_sentences = []

    for sentence in sentences:
        cleaned = " ".join(sentence.split())

        if not is_valid_sentence(cleaned, word):
            continue

        # 优先级1: 完全匹配原始单词
        if re.search(exact_pattern, sentence, re.IGNORECASE):
            matching_sentences.append(cleaned)
            continue

        # 优先级2: 匹配任意变体
        variants_pattern = r"\b(" + "|".join(map(re.escape, word_variants)) + r")\b"
        if re.search(variants_pattern, sentence, re.IGNORECASE):
            matching_sentences.append(cleaned)
            continue

        # 优先级3: 前缀匹配
        if len(matching_sentences) < 5:
            prefix_pattern = r"\b" + re.escape(word) + r"[a-z]*"
            if re.search(prefix_pattern, sentence, re.IGNORECASE):
                matching_sentences.append(cleaned)
                continue

        # 优先级4：放宽匹配
        if len(matching_sentences) < 3 and word_lower in cleaned.lower():
            matching_sentences.append(cleaned)

    # 去重
    seen = set()
    result = []
    for s in matching_sentences:
        if s.lower() not in seen:
            result.append(s)
            seen.add(s.lower())
            if len(result) >= 10:
                break

    extraction_logger.info(f"[句子匹配] 从 {len(sentences)} 个句子中找到 {len(result)} 个匹配")

    return result
