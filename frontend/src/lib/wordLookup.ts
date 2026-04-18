const LOOKUP_SEGMENT_RE = /[A-Za-zÀ-ɏ]+(?:['’][A-Za-zÀ-ɏ]+)*/g;
const OCR_JOIN_STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "be", "but", "by", "for", "from", "if",
  "in", "into", "is", "it", "of", "on", "or", "than", "that", "the", "to",
  "was", "with",
]);
const CONTRACTION_SUFFIXES = ["n't", "'m", "'re", "'ve", "'ll", "'d"];
const CONTRACTION_WORDS = new Set([
  "it's", "that's", "what's", "who's", "there's", "here's", "let's", "he's",
  "she's", "how's", "where's", "when's", "why's",
]);

type LookupSegment = {
  raw: string;
  normalized: string;
  start: number;
  end: number;
};

type SplittableWordData = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  block_id?: number;
};

export function normalizeLookupWord(raw: string): string | null {
  if (!raw) return null;

  let word = raw.trim();
  if (!word) return null;

  word = word.replace(/[’]/g, "'");

  const directMatch = word.match(/^[A-Za-zÀ-ɏ]+(?:'[A-Za-zÀ-ɏ]+)*$/);
  if (!directMatch) {
    const segments = word.match(LOOKUP_SEGMENT_RE);
    if (!segments || segments.length === 0) return null;
    word = segments[0];
  }

  const lowerWord = word.toLowerCase();
  const isContraction =
    CONTRACTION_SUFFIXES.some((suffix) => lowerWord.endsWith(suffix)) ||
    CONTRACTION_WORDS.has(lowerWord);

  if (lowerWord.endsWith("'s") && !isContraction) {
    word = word.slice(0, -2);
  }

  word = word.replace(/^'+|'+$/g, "").toLowerCase();
  return word || null;
}

export function getLookupSegments(text: string): LookupSegment[] {
  if (!text) return [];

  const directSegments = Array.from(text.matchAll(LOOKUP_SEGMENT_RE)).map((match) => {
    const raw = match[0];
    const start = match.index ?? 0;
    return {
      raw,
      normalized: normalizeLookupWord(raw) ?? raw.replace(/[’]/g, "'").toLowerCase(),
      start,
      end: start + raw.length,
    };
  });

  if (directSegments.length !== 1) {
    return directSegments;
  }

  const onlySegment = directSegments[0];
  if (onlySegment.raw.length < 7 || onlySegment.raw.length !== text.length || /[^A-Za-zÀ-ɏ]/.test(text)) {
    return directSegments;
  }

  const inferredSegments = inferOcrJoinedSegments(text);
  return inferredSegments.length > 1 ? inferredSegments : directSegments;
}

export function getLookupWordFromText(text: string, clickRatio = 0.5): string | null {
  const segments = getLookupSegments(text);
  if (segments.length === 0) return null;
  if (segments.length === 1) return segments[0].normalized;

  const clampedRatio = Number.isFinite(clickRatio) ? Math.min(1, Math.max(0, clickRatio)) : 0.5;
  const clickPos = text.length * clampedRatio;

  let best = segments[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const segment of segments) {
    const center = (segment.start + segment.end) / 2;
    const distance = Math.abs(center - clickPos);
    if (distance < bestDistance) {
      best = segment;
      bestDistance = distance;
    }
  }

  return best.normalized;
}

export function splitTextForWordLookup(text: string): string[] {
  return text.split(/([A-Za-zÀ-ɏ]+(?:['’][A-Za-zÀ-ɏ]+)*)/);
}

export function splitWordDataForLookup<T extends SplittableWordData>(word: T): T[] {
  const segments = getLookupSegments(word.text);
  if (segments.length <= 1) {
    return [{ ...word, text: normalizeLookupWord(word.text) ? word.text : word.text }] as T[];
  }

  const totalLength = Math.max(word.text.length, 1);
  return segments.map((segment) => {
    const startRatio = segment.start / totalLength;
    const endRatio = segment.end / totalLength;
    return {
      ...word,
      text: segment.raw,
      x: word.x + word.width * startRatio,
      width: Math.max(word.width * (endRatio - startRatio), 1),
    };
  });
}

function inferOcrJoinedSegments(text: string): LookupSegment[] {
  const normalizedText = text.toLowerCase();
  let bestSplit = -1;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let split = 2; split <= text.length - 2; split += 1) {
    const left = normalizedText.slice(0, split);
    const right = normalizedText.slice(split);
    let score = Number.NEGATIVE_INFINITY;

    // 只在 left 本身不像完整词根时才拆分，避免误切 Washington→Washingt+on。
    // branch 1：right 是完整停用词（如 "on"/"in"），left 足够长
    if (OCR_JOIN_STOPWORDS.has(right) && left.length >= 6) {
      score = left.length * 2 - right.length;
    } else if (OCR_JOIN_STOPWORDS.has(right) && left.length >= 4 && right.length <= 2) {
      // branch 2 仅限 right 为 2 字母完整停用词（不再用 slice(-2) 模糊匹配）
      score = left.length - 6;
    }

    if (score > bestScore) {
      bestScore = score;
      bestSplit = split;
    }
  }

  // 门槛从 2 提高到 8，等价于要求 left.length >= 7（branch 1）才拆分，
  // 过滤 Washington(8)、Anderson(7) 等正常词，保留真正的 OCR 粘连词。
  if (bestSplit === -1 || bestScore < 8) {
    return [];
  }

  return [
    {
      raw: text.slice(0, bestSplit),
      normalized: text.slice(0, bestSplit).toLowerCase(),
      start: 0,
      end: bestSplit,
    },
    {
      raw: text.slice(bestSplit),
      normalized: text.slice(bestSplit).toLowerCase(),
      start: bestSplit,
      end: text.length,
    },
  ];
}
