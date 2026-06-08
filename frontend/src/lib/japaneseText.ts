const JAPANESE_TEXT_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff々〆ヵヶ]/;
const HANGUL_TEXT_RE = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff]/;
const LANGUAGE_ALIASES: Record<string, "ja" | "en" | "zh" | "ko"> = {
  ja: "ja",
  jpn: "ja",
  jp: "ja",
  en: "en",
  eng: "en",
  zh: "zh",
  zho: "zh",
  chi: "zh",
  ko: "ko",
  kor: "ko",
  kr: "ko",
};

export function normalizeBookLanguage(language?: string | null): "ja" | "en" | "zh" | "ko" | "unknown" {
  if (!language) return "unknown";
  const normalized = language.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return "unknown";

  for (const [alias, value] of Object.entries(LANGUAGE_ALIASES)) {
    if (normalized === alias || normalized.startsWith(`${alias}-`)) {
      return value;
    }
  }

  return "unknown";
}

export function isJapaneseBookLanguage(language?: string | null): boolean {
  return normalizeBookLanguage(language) === "ja";
}

export function containsJapaneseText(text?: string | null): boolean {
  if (!text) return false;
  return JAPANESE_TEXT_RE.test(text);
}

export function containsHangulText(text?: string | null): boolean {
  if (!text) return false;
  return HANGUL_TEXT_RE.test(text);
}

export function containsEastAsianText(text?: string | null): boolean {
  if (!text) return false;
  return containsJapaneseText(text) || containsHangulText(text);
}
