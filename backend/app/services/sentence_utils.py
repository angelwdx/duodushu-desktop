"""
句子处理工具模块

提供句子切分和验证功能，用于从书籍中提取高质量例句。
"""

import re
import logging

extraction_logger = logging.getLogger("extraction")

NARRATIVE_VERBS = {
    "said", "asked", "looked", "walked", "turned", "smiled", "laughed", "cried",
    "thought", "felt", "watched", "heard", "saw", "told", "whispered", "shouted",
    "nodded", "sighed", "ran", "stood", "sat", "opened", "closed", "came", "went",
    "held", "pulled", "pushed", "stared", "glanced", "waited", "followed", "remembered",
}

NON_NARRATIVE_PATTERNS = [
    r"^\s*(chapter|part|book|section|appendix|contents?)\b",
    r"^\s*(note|notes|footnote|annotation|annotations?)\b",
    r"^\s*(figure|table|fig\.|vol\.|no\.)\b",
    r"^\s*\d+(\.\d+)*\s+[A-Z]",
    r"^\s*[ivxlcdm]+\.\s+[A-Z]",
    r"\b(table of contents|index|bibliography|references|appendix)\b",
    r"\bcopyright\b",
    r"\ball rights reserved\b",
    r"\btranslated by\b",
    r"\bedited by\b",
    r"\bpublished by\b",
    r"\bpage \d+\b",
    r"\bchapter \d+\b",
]

PAGE_SKIP_PATTERNS = [
    r"\btable of contents\b",
    r"\bcontents\b",
    r"\bindex\b",
    r"\bbibliography\b",
    r"\breferences\b",
    r"\bappendix\b",
    r"\bfootnotes?\b",
    r"\bendnotes?\b",
]

PAGE_HEADER_SKIP_PATTERNS = [
    r"^\s*table of contents\b",
    r"^\s*contents\b",
    r"^\s*index\b",
    r"^\s*bibliography\b",
    r"^\s*references\b",
    r"^\s*appendix\b",
    r"^\s*appendices\b",
    r"^\s*notes\b",
    r"^\s*footnotes?\b",
    r"^\s*endnotes?\b",
    r"^\s*glossary\b",
]

PAGE_HEADER_DEMOTION_PATTERNS = [
    r"^\s*introduction\b",
    r"^\s*preface\b",
    r"^\s*foreword\b",
    r"^\s*afterword\b",
    r"^\s*summary\b",
    r"^\s*exercise(s)?\b",
    r"^\s*review questions\b",
]


def _page_header_lines(text: str, limit: int = 5) -> list[str]:
    return [line.strip().lower() for line in text.splitlines() if line.strip()][:limit]


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

    # 5. Filter table-of-contents, notes, and metadata-like lines
    lower_s = s.lower()
    for pattern in NON_NARRATIVE_PATTERNS:
        if re.search(pattern, lower_s, re.IGNORECASE):
            return False

    # 6. Filter citation-heavy and note-heavy text
    bracket_pairs = s.count("(") + s.count("[")
    if bracket_pairs >= 3:
        return False
    if re.search(r"\[\d+\]|\(\d+\)", s):
        return False

    # 7. Reject lines that look like headings or fragments rather than story sentences
    word_count = len(re.findall(r"\b[\w'-]+\b", s))
    if word_count < 5:
        return False
    if not re.search(r"[.!?\"']$", s):
        return False
    if "," not in s and word_count < 5:
        return False

    return True


def sentence_quality_score(sentence: str) -> int:
    """
    Prefer body-text sentences with narrative cues over notes, headings, and exposition.
    """
    score = 0
    lower_s = sentence.lower()
    tokens = re.findall(r"\b[\w'-]+\b", lower_s)

    if 8 <= len(tokens) <= 35:
        score += 3
    elif len(tokens) <= 45:
        score += 1
    else:
        score -= 2

    if any(verb in tokens for verb in NARRATIVE_VERBS):
        score += 4

    if '"' in sentence or "'" in sentence:
        score += 2

    pronoun_hits = sum(1 for token in tokens if token in {"he", "she", "they", "we", "i", "you"})
    if pronoun_hits:
        score += min(pronoun_hits, 3)

    if re.search(r"\bthen\b|\bsuddenly\b|\bwhen\b|\bbefore\b|\bafter\b|\bwhile\b", lower_s):
        score += 2

    if ":" in sentence:
        score -= 3
    if ";" in sentence:
        score -= 1
    if re.search(r"\b(example|definition|exercise|answer|summary|introduction|preface)\b", lower_s):
        score -= 4

    return score


def should_skip_page_text(text: str) -> bool:
    """
    Skip pages that are overwhelmingly non-body text, such as TOC, notes, or references.
    """
    if not text:
        return True

    normalized = " ".join(text.lower().split())
    for pattern in PAGE_SKIP_PATTERNS:
        if re.search(pattern, normalized):
            return True

    header_lines = _page_header_lines(text)
    for line in header_lines:
        for pattern in PAGE_HEADER_SKIP_PATTERNS:
            if re.search(pattern, line):
                return True

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return True

    heading_like = 0
    annotation_like = 0
    short_lines = 0
    punctuated_lines = 0

    for line in lines[:40]:
        if len(line.split()) <= 6:
            short_lines += 1
        if re.search(r"[.!?\"']$", line):
            punctuated_lines += 1
        if re.match(r"^(\d+(\.\d+)*|[IVXLCDM]+\.?)\s+[A-Z]", line):
            heading_like += 1
        if re.search(r"^\s*(note|footnote|annotation|fig\.|table)\b", line, re.IGNORECASE):
            annotation_like += 1
        if re.search(r"\[\d+\]|\(\d+\)$", line):
            annotation_like += 1

    total = min(len(lines), 40)
    if total == 0:
        return True

    if heading_like / total >= 0.35:
        return True
    if annotation_like / total >= 0.25:
        return True
    if short_lines / total >= 0.75 and punctuated_lines / total <= 0.25:
        return True

    return False


def page_body_text_score(text: str) -> int:
    """
    Score pages so narrative body pages are processed before marginal/non-body pages.
    """
    if should_skip_page_text(text):
        return -100

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    normalized = " ".join(text.lower().split())
    header_lines = _page_header_lines(text)
    score = 0

    punctuated_lines = sum(1 for line in lines[:40] if re.search(r"[.!?\"']$", line))
    long_lines = sum(1 for line in lines[:40] if len(re.findall(r"\b[\w'-]+\b", line)) >= 8)
    dialogue_lines = sum(1 for line in lines[:40] if '"' in line or "\u201c" in line or "\u201d" in line)

    score += punctuated_lines * 2
    score += long_lines * 2
    score += dialogue_lines * 3

    if re.search(r"\b(he|she|they|we|i|you)\b", normalized):
        score += 4
    if re.search(r"\b(said|asked|looked|walked|thought|felt|came|went|turned|watched)\b", normalized):
        score += 6
    if re.search(r"\bchapter\b|\bsection\b|\bappendix\b|\bexercise\b|\bsummary\b", normalized):
        score -= 8
    for line in header_lines:
        for pattern in PAGE_HEADER_DEMOTION_PATTERNS:
            if re.search(pattern, line):
                score -= 10
        if re.search(r"^\s*chapter\s+\d+\b", line):
            score += 2

    return score


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
            matching_sentences.append((cleaned, sentence_quality_score(cleaned), 0))
            continue

        # 优先级2: 匹配任意变体
        variants_pattern = r"\b(" + "|".join(map(re.escape, word_variants)) + r")\b"
        if re.search(variants_pattern, sentence, re.IGNORECASE):
            matching_sentences.append((cleaned, sentence_quality_score(cleaned), 1))
            continue

        # 优先级3: 前缀匹配
        if len(matching_sentences) < 5:
            prefix_pattern = r"\b" + re.escape(word) + r"[a-z]*"
            if re.search(prefix_pattern, sentence, re.IGNORECASE):
                matching_sentences.append((cleaned, sentence_quality_score(cleaned), 2))
                continue

        # 优先级4：放宽匹配
        if len(matching_sentences) < 3 and word_lower in cleaned.lower():
            matching_sentences.append((cleaned, sentence_quality_score(cleaned), 3))

    matching_sentences.sort(key=lambda item: (item[2], -item[1], len(item[0])))

    # 去重
    seen = set()
    result = []
    for sentence_text, _score, _priority in matching_sentences:
        if sentence_text.lower() not in seen:
            result.append(sentence_text)
            seen.add(sentence_text.lower())
            if len(result) >= 10:
                break

    extraction_logger.info(f"[句子匹配] 从 {len(sentences)} 个句子中找到 {len(result)} 个匹配")

    return result
