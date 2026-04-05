export function repairBrokenEnglishWordsForTTS(text: string): string {
  if (!text) return "";

  let repaired = text;

  // 修复多级首字下沉造成的交错文本（例如标题大写字母与正文首字母连在一起，以及它们各自的后缀连在一起）
  // 模式1：C H onstellations ave -> Constellations Have
  repaired = repaired.replace(
    /(^|[\s([{"'“‘])([A-Z])\s+([A-Z])\s+([a-z]{2,})\s+([a-z]{2,})\b/g,
    "$1$2$4 $3$5"
  );

  // 模式2：CH onstellations ave -> Constellations Have
  repaired = repaired.replace(
    /(^|[\s([{"'“‘])([A-Z])([A-Z])\s+([a-z]{2,})\s+([a-z]{2,})\b/g,
    "$1$2$4 $3$5"
  );

  // PDF / EPUB 文本层有时会把英文词拆成 "b lack" 这类形式。
  // 这里只做保守修复：仅合并孤立辅音 + 后续小写片段，避免误伤 "a lot" 之类正常短语。
  repaired = repaired.replace(
    /(^|[\s([{"'“‘])([b-df-hj-np-tv-zB-DF-HJ-NP-TV-Z])\s+([a-z]{2,})\b/g,
    "$1$2$3",
  );

  // 某些 PDF 会把极短的常见词拆成 "I f"、"I t" 这种形式。
  // 修复高频两字母词（大写开头 + 空格 + 小写字母）
  const twoLetterFixes: [RegExp, string][] = [
    // 原有规则
    [/\bI\s+f\b/g, "If"],
    [/\bI\s+n\b/g, "In"],
    [/\bI\s+s\b/g, "Is"],
    [/\bI\s+t\b/g, "It"],
    [/\bA\s+m\b/g, "Am"],
    [/\bA\s+n\b/g, "An"],
    [/\bA\s+s\b/g, "As"],
    [/\bA\s+t\b/g, "At"],
    // 补充高频词
    [/\bT\s+o\b/g, "To"],
    [/\bB\s+e\b/g, "Be"],
    [/\bB\s+y\b/g, "By"],
    [/\bD\s+o\b/g, "Do"],
    [/\bG\s+o\b/g, "Go"],
    [/\bH\s+e\b/g, "He"],
    [/\bM\s+e\b/g, "Me"],
    [/\bM\s+y\b/g, "My"],
    [/\bN\s+o\b/g, "No"],
    [/\bS\s+o\b/g, "So"],
    [/\bU\s+p\b/g, "Up"],
    [/\bU\s+s\b/g, "Us"],
    [/\bW\s+e\b/g, "We"],
    [/\bO\s+r\b/g, "Or"],
    [/\bO\s+f\b/g, "Of"],
    [/\bO\s+n\b/g, "On"],
  ];
  for (const [pattern, replacement] of twoLetterFixes) {
    repaired = repaired.replace(pattern, replacement);
  }

  // 某些 PDF 的下沉首字母会变成 "A t the" 这种句首碎片。
  // 这里只修复最常见的介词/冠词开头，避免把标题尾部的大写字母误搬到正文里。
  repaired = repaired.replace(/\bA\s+t\s+(the|a|an)\b/g, "At $1");
  repaired = repaired.replace(/\bI\s+n\s+(the|a|an)\b/g, "In $1");
  repaired = repaired.replace(/\bO\s+n\s+(the|a|an)\b/g, "On $1");
  repaired = repaired.replace(/\bO\s+f\s+(the|a|an)\b/g, "Of $1");

  // 如果修复后的句首单词与前一段标题粘连，补回缺失空格。
  repaired = repaired.replace(/([a-z'])((?:At|In|On|Of|To|By|Do|Go)\s+(?:the|a|an)\b)/g, "$1 $2");

  return repaired;
}

function containsCJK(text: string): boolean {
  return /[\u3400-\u9FFF\uF900-\uFAFF]/.test(text);
}

function endsWithSentencePunctuation(text: string): boolean {
  return /[。！？!?\.…:：]$/.test(text.trim());
}

function isLikelyStandaloneHeading(paragraph: string, nextParagraph?: string): boolean {
  const trimmed = paragraph.trim();
  if (!trimmed || endsWithSentencePunctuation(trimmed)) return false;

  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 2) return false;

  const compact = trimmed.replace(/\s+/g, " ");
  const compactLength = compact.length;
  const nextLength = (nextParagraph || "").replace(/\s+/g, " ").trim().length;

  if (containsCJK(compact)) {
    if (compactLength > 24) return false;
    return nextLength >= compactLength + 8;
  }

  const words = compact.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 8 || compactLength > 48) return false;
  return nextLength >= compactLength + 12;
}

function insertHeadingPauses(text: string): string {
  const normalizedText = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const lines = normalizedText.split("\n");
  const rewrittenLines: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i].trim();
    const previous = rewrittenLines.length > 0 ? rewrittenLines[rewrittenLines.length - 1].trim() : "";
    const next = i + 1 < lines.length ? lines[i + 1].trim() : "";

    rewrittenLines.push(lines[i]);

    if (!current || !next) continue;
    if (previous) continue;

    if (isLikelyStandaloneHeading(current, next)) {
      rewrittenLines[rewrittenLines.length - 1] = `${current}${containsCJK(current) ? "。" : "."}`;
      rewrittenLines.push("");
    }
  }

  const paragraphs = rewrittenLines
    .join("\n")
    .split(/\n\s*\n/);

  if (paragraphs.length < 2) return rewrittenLines.join("\n");

  const normalized = paragraphs.map((paragraph) => paragraph.trim()).filter(Boolean);
  if (normalized.length < 2) return rewrittenLines.join("\n");

  const withPauses = normalized.map((paragraph, index) => {
    const nextParagraph = normalized[index + 1];
    if (!nextParagraph || !isLikelyStandaloneHeading(paragraph, nextParagraph)) {
      return paragraph;
    }
    return `${paragraph}${containsCJK(paragraph) ? "。" : "."}`;
  });

  return withPauses.join("\n\n");
}

function removeStandalonePageNumberParagraphs(text: string): string {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n\s*\n/);

  const filtered = paragraphs.filter((paragraph) => {
    const trimmed = paragraph.trim();
    if (!trimmed) return false;

    // 过滤常见孤立页码，例如 "44"、"- 44 -"、"Page 44"
    if (/^[-–—]?\s*\d{1,4}\s*[-–—]?$/.test(trimmed)) return false;
    if (/^[-–—]?\s*Page\s+\d{1,4}\s*[-–—]?$/i.test(trimmed)) return false;
    if (/^第\s*\d{1,4}\s*页$/.test(trimmed)) return false;

    return true;
  });

  return filtered.join("\n\n");
}

function removeDecorativeSymbolsForTTS(text: string): string {
  let cleaned = text;

  // 常见 EPUB 装饰字符、dingbats、几何图形、私有区字符，容易被 TTS 念成怪声或笑声。
  cleaned = cleaned.replace(/[\uE000-\uF8FF]/g, " ");
  cleaned = cleaned.replace(/[\u2190-\u21FF\u2300-\u23FF\u2460-\u27BF]/g, " ");
  cleaned = cleaned.replace(/[\u25A0-\u25FF\u2600-\u26FF]/g, " ");
  cleaned = cleaned.replace(/[\u2B00-\u2BFF\uFE0E\uFE0F]/g, " ");
  cleaned = cleaned.replace(/[\u{1F300}-\u{1FAFF}]/gu, " ");

  // 仅由装饰分隔符组成的短行直接移除。
  cleaned = cleaned.replace(/(?:^|\n)\s*[~=_*#·•◆◇■□▪▫►▶▸▹★☆✦✧✪✩✶✷❖❥❦❧☙❀❁❂❃❈❉❊✿❋✽]+(?:\s+[~=_*#·•◆◇■□▪▫►▶▸▹★☆✦✧✪✩✶✷❖❥❦❧☙❀❁❂❃❈❉❊✿❋✽]+)*\s*(?=\n|$)/g, "\n");

  // 压缩因符号清理产生的多余空白。
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  return cleaned;
}

function normalizeQuotesForTTS(text: string): string {
  let normalized = text;

  // 保留单词内部的撇号，如 don't / it's / Wei Wuxian's
  normalized = normalized.replace(/([A-Za-z])[\u2018\u2019]([A-Za-z])/g, "$1'$2");

  // 其余装饰性引号统一移除，避免被 TTS 念成怪声。
  normalized = normalized.replace(/["“”„‟«»‹›「」『』《》〈〉]/g, "");
  normalized = normalized.replace(/[\u2018\u2019](?![A-Za-z])/g, "");
  normalized = normalized.replace(/(?<![A-Za-z])[\u2018\u2019]/g, "");

  return normalized;
}

export function preprocessTTSPlainText(text: string): string {
  if (!text) return "";
  let processed = text;

  // 过滤常见的纯页码页脚，避免 PDF 朗读把页码念出来。
  processed = processed.replace(/(?:^|\n)\s*[-–—]?\s*Page\s+\d+\s*[-–—]?\s*(?=\n|$)/gim, "\n");
  processed = processed.replace(/(?:^|\n)\s*第\s*\d+\s*页\s*(?=\n|$)/gim, "\n");
  processed = processed.replace(/(?:^|\n)\s*\d+\s*(?=\n|$)/gm, "\n");
  processed = normalizeQuotesForTTS(processed);
  processed = removeDecorativeSymbolsForTTS(processed);
  processed = repairBrokenEnglishWordsForTTS(processed);
  processed = insertHeadingPauses(processed);
  processed = removeStandalonePageNumberParagraphs(processed);

  return processed.trim();
}
