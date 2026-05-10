import { generateJapaneseFurigana, type FuriganaAnnotation } from "./api";
import { containsJapaneseText } from "./japaneseText";
import { createLogger } from "./logger";

const log = createLogger("japaneseFurigana");

const MAX_FURIGANA_BATCH_ITEMS = 120;
const MAX_FURIGANA_BATCH_CHARS = 24000;
const MAX_FURIGANA_SINGLE_TEXT_CHARS = 30000;

export function createPlainFuriganaAnnotation(text: string): FuriganaAnnotation {
  return {
    text,
    segments: [{ type: "text", text }],
    has_furigana: false,
  };
}

export function getCachedFuriganaAnnotation(
  text: string,
  cache: Map<string, FuriganaAnnotation>,
): FuriganaAnnotation {
  return cache.get(text) ?? createPlainFuriganaAnnotation(text);
}

async function fetchFuriganaBatch(
  batch: string[],
  cache: Map<string, FuriganaAnnotation>,
): Promise<void> {
  if (batch.length === 0) return;

  const items = await generateJapaneseFurigana(batch);
  items.forEach((item) => {
    cache.set(item.text, item);
  });
}

export async function ensureFuriganaAnnotations(
  texts: string[],
  cache: Map<string, FuriganaAnnotation>,
): Promise<void> {
  const uniqueTexts = Array.from(
    new Set(
      texts.filter((text) => {
        if (!text.trim()) return false;
        if (!containsJapaneseText(text)) return false;
        if (cache.has(text)) return false;
        return true;
      }),
    ),
  );

  let batch: string[] = [];
  let charCount = 0;

  for (const text of uniqueTexts) {
    if (text.length > MAX_FURIGANA_SINGLE_TEXT_CHARS) {
      log.warn("假名文本过长，跳过标注以避免卡死", {
        length: text.length,
        preview: text.slice(0, 80),
      });
      cache.set(text, createPlainFuriganaAnnotation(text));
      continue;
    }

    const shouldFlushBatch =
      batch.length >= MAX_FURIGANA_BATCH_ITEMS ||
      charCount + text.length > MAX_FURIGANA_BATCH_CHARS;

    if (shouldFlushBatch) {
      await fetchFuriganaBatch(batch, cache);
      batch = [];
      charCount = 0;
    }

    batch.push(text);
    charCount += text.length;
  }

  await fetchFuriganaBatch(batch, cache);
}
