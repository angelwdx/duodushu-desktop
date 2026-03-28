export function repairBrokenEnglishWordsForTTS(text: string): string {
  if (!text) return "";

  let repaired = text;

  // PDF / EPUB 文本层有时会把英文词拆成 "b lack" 这类形式。
  // 这里只做保守修复：仅合并孤立辅音 + 后续小写片段，避免误伤 "a lot" 之类正常短语。
  repaired = repaired.replace(
    /\b([b-df-hj-np-tv-zB-DF-HJ-NP-TV-Z])\s+([a-z]{2,})\b/g,
    "$1$2",
  );

  // 某些 PDF 会把极短的常见词拆成 "I f"、"I t" 这种形式。
  // 这里只修复高频两字母词，避免误伤正常短语。
  repaired = repaired.replace(/\bI\s+f\b/g, "If");
  repaired = repaired.replace(/\bI\s+n\b/g, "In");
  repaired = repaired.replace(/\bI\s+s\b/g, "Is");
  repaired = repaired.replace(/\bI\s+t\b/g, "It");
  repaired = repaired.replace(/\bA\s+m\b/g, "Am");
  repaired = repaired.replace(/\bA\s+n\b/g, "An");
  repaired = repaired.replace(/\bA\s+s\b/g, "As");
  repaired = repaired.replace(/\bA\s+t\b/g, "At");

  // 某些 PDF 的下沉首字母会变成 "A t the" 这种句首碎片。
  // 这里只修复最常见的介词/冠词开头，避免把标题尾部的大写字母误搬到正文里。
  repaired = repaired.replace(/\bA\s+t\s+(the|a|an)\b/g, "At $1");
  repaired = repaired.replace(/\bI\s+n\s+(the|a|an)\b/g, "In $1");
  repaired = repaired.replace(/\bO\s+n\s+(the|a|an)\b/g, "On $1");
  repaired = repaired.replace(/\bO\s+f\s+(the|a|an)\b/g, "Of $1");

  // 如果修复后的句首单词与前一段标题粘连，补回缺失空格。
  repaired = repaired.replace(/([a-z’])((?:At|In|On|Of)\s+(?:the|a|an)\b)/g, "$1 $2");

  return repaired;
}

export function preprocessTTSPlainText(text: string): string {
  if (!text) return "";
  let processed = text;

  // 过滤常见的纯页码页脚，避免 PDF 朗读把页码念出来。
  processed = processed.replace(/(?:^|\n)\s*[-–—]?\s*Page\s+\d+\s*[-–—]?\s*(?=\n|$)/gim, "\n");
  processed = processed.replace(/(?:^|\n)\s*第\s*\d+\s*页\s*(?=\n|$)/gim, "\n");
  processed = processed.replace(/(?:^|\n)\s*\d+\s*(?=\n|$)/gm, "\n");

  return repairBrokenEnglishWordsForTTS(processed).trim();
}
