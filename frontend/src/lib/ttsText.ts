export function repairBrokenEnglishWordsForTTS(text: string): string {
  if (!text) return "";

  let repaired = text;

  // PDF / EPUB 文本层有时会把英文词拆成 "b lack" 这类形式。
  // 这里只做保守修复：仅合并孤立辅音 + 后续小写片段，避免误伤 "a lot" 之类正常短语。
  repaired = repaired.replace(
    /\b([b-df-hj-np-tv-zB-DF-HJ-NP-TV-Z])\s+([a-z]{2,})\b/g,
    "$1$2",
  );

  return repaired;
}

export function preprocessTTSPlainText(text: string): string {
  if (!text) return "";
  return repairBrokenEnglishWordsForTTS(text).trim();
}
