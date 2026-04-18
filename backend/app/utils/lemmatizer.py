"""
词形还原工具模块
用于增强例句提取时的词形匹配能力

支持：
- 不规则动词/名词映射（go → went, buy → bought）
- 常见后缀变形（-ing, -ed, -s, -es）
- 复数形式
- 比较级/最高级（better → good）
"""

import re
from typing import Set

# 不规则动词/名词映射
IRREGULAR_MAPPINGS = {
    # 不规则动词
    "went": "go",
    "gone": "go",
    "bought": "buy",
    "caught": "catch",
    "chose": "choose",
    "chosen": "choose",
    "came": "come",
    "did": "do",
    "done": "do",
    "drank": "drink",
    "drunk": "drink",
    "ate": "eat",
    "eaten": "eat",
    "fell": "fall",
    "fallen": "fall",
    "found": "find",
    "flew": "fly",
    "flown": "fly",
    "forgot": "forget",
    "forgotten": "forget",
    "froze": "freeze",
    "frozen": "freeze",
    "gave": "give",
    "given": "give",
    "got": "get",
    "gotten": "get",
    "grew": "grow",
    "grown": "grow",
    "had": "have",
    "has": "have",
    "heard": "hear",
    "hid": "hide",
    "hidden": "hide",
    "hit": "hit",
    "held": "hold",
    "kept": "keep",
    "knew": "know",
    "known": "know",
    "left": "leave",
    "lent": "lend",
    "let": "let",
    "lay": "lie",
    "laid": "lay",
    "lain": "lie",
    "lost": "lose",
    "made": "make",
    "meant": "mean",
    "met": "meet",
    "paid": "pay",
    "put": "put",
    "read": "read",
    "ran": "run",
    "said": "say",
    "saw": "see",
    "seen": "see",
    "sold": "sell",
    "sent": "send",
    "sang": "sing",
    "sung": "sing",
    "sat": "sit",
    "slept": "sleep",
    "spoke": "speak",
    "spoken": "speak",
    "spent": "spend",
    "stood": "stand",
    "stole": "steal",
    "stolen": "steal",
    "swam": "swim",
    "swum": "swim",
    "took": "take",
    "taken": "take",
    "taught": "teach",
    "thought": "think",
    "threw": "throw",
    "thrown": "throw",
    "told": "tell",
    "understood": "understand",
    "wore": "wear",
    "worn": "wear",
    "won": "win",
    "wrote": "write",
    "written": "write",
    # 不规则名词复数
    "children": "child",
    "men": "man",
    "women": "woman",
    "teeth": "tooth",
    "feet": "foot",
    "mice": "mouse",
    "geese": "goose",
    "people": "person",
    "oxen": "ox",
    "lives": "life",
    "leaves": "leaf",
    "loaves": "loaf",
    "thieves": "thief",
    "knives": "knife",
    "wives": "wife",
    "selves": "self",
    "calves": "calf",
    "halves": "half",
    "axes": "axis",
    "analyses": "analysis",
    "bases": "basis",
    "crises": "crisis",
    "criteria": "criterion",
    "data": "datum",
    "phenomena": "phenomenon",
    "strata": "stratum",
    "formulae": "formula",
    "vertices": "vertex",
    # 形容词比较级/最高级
    "better": "good",
    "best": "good",
    "worse": "bad",
    "worst": "bad",
    "farther": "far",
    "further": "far",
    "farthest": "far",
    "furthest": "far",
    "more": "many",
    "most": "many",
    "less": "little",
    "least": "little",
    # 辅音双写动词的现在分词（规则推导无法正确生成双写形式）
    "running": "run",
    "sitting": "sit",
    "hitting": "hit",
    "getting": "get",
    "putting": "put",
    "cutting": "cut",
    "letting": "let",
    "setting": "set",
    "swimming": "swim",
    "beginning": "begin",
    "planning": "plan",
    "stopping": "stop",
    "dropping": "drop",
    "shopping": "shop",
    "winning": "win",
    "spinning": "spin",
    "skipping": "skip",
    "fitting": "fit",
    "quitting": "quit",
    "committing": "commit",
    "omitting": "omit",
    "permitting": "permit",
    # 辅音双写的过去式
    "planned": "plan",
    "stopped": "stop",
    "dropped": "drop",
    "shopped": "shop",
    "skipped": "skip",
    "fitted": "fit",
    "committed": "commit",
    "omitted": "omit",
    "permitted": "permit",
}


def get_word_variants(word: str) -> Set[str]:
    """
    获取单词的所有可能变体

    Args:
        word: 原始单词

    Returns:
        包含所有变体的集合
    """
    word_lower = word.lower()
    variants = {word_lower}

    # 1. 检查不规则映射
    for variant, base in IRREGULAR_MAPPINGS.items():
        if variant == word_lower:
            variants.add(base)
        elif base == word_lower:
            variants.add(variant)

    # 2. 添加常见后缀变体
    # -s/-es (复数/第三人称单数)
    if not word_lower.endswith("s"):
        # -y → -ies（辅音 + y 结尾：study→studies, carry→carries）
        if (word_lower.endswith("y") and len(word_lower) > 1
                and word_lower[-2] not in "aeiou"):
            variants.add(word_lower[:-1] + "ies")
        else:
            variants.add(word_lower + "s")
        variants.add(word_lower + "es")

    # -ed (过去式/过去分词)
    if not word_lower.endswith("ed"):
        # 处理双写规则：run → running → runned（不正确，但匹配时有用）
        if word_lower.endswith("e"):
            variants.add(word_lower + "d")
        elif word_lower.endswith("y"):
            variants.add(word_lower[:-1] + "ied")
        else:
            variants.add(word_lower + "ed")

    # -ing (现在分词)
    if not word_lower.endswith("ing"):
        if word_lower.endswith("e"):
            variants.add(word_lower[:-1] + "ing")
        elif word_lower.endswith("ie"):
            variants.add(word_lower[:-2] + "ying")
        else:
            variants.add(word_lower + "ing")

    # -er/-est (比较级/最高级)
    if not (word_lower.endswith("er") or word_lower.endswith("est")):
        if word_lower.endswith("e"):
            variants.add(word_lower + "r")
            variants.add(word_lower + "st")
        else:
            variants.add(word_lower + "er")
            variants.add(word_lower + "est")

    # 3. 处理特殊后缀规则
    # 去掉 -ly (副词 → 形容词)
    if word_lower.endswith("ly") and len(word_lower) > 4:
        variants.add(word_lower[:-2])

    # 去掉 -ment (名词 → 动词)
    if word_lower.endswith("ment") and len(word_lower) > 6:
        variants.add(word_lower[:-4])

    # 去掉 -ness (名词 → 形容词)
    if word_lower.endswith("ness") and len(word_lower) > 5:
        variants.add(word_lower[:-4])

    # 4. 处理 -tion/-sion (名词 → 动词)
    if word_lower.endswith("tion"):
        variants.add(word_lower[:-4] + "e")
    elif word_lower.endswith("sion"):
        variants.add(word_lower[:-4] + "e")

    return variants


def test_word_variants():
    """测试词形还原功能"""
    test_words = [
        "go",
        "went",
        "buy",
        "bought",
        "study",
        "studies",
        "studying",
        "studied",
        "happy",
        "happier",
        "happiest",
        "happily",
        "run",
        "running",
        "children",
        "better",
    ]

    print("=== 词形还原测试 ===")
    for word in test_words:
        variants = get_word_variants(word)
        print(f"{word:12} → {sorted(variants)}")


if __name__ == "__main__":
    test_word_variants()
