export function isJapaneseBookLanguage(language?: string | null): boolean {
  if (!language) return false;
  const normalized = language.trim().toLowerCase();
  return normalized === "ja" || normalized.startsWith("ja-");
}

export function containsJapaneseText(text?: string | null): boolean {
  if (!text) return false;
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff々〆ヵヶ]/.test(text);
}
