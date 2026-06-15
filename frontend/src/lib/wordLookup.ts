const LOOKUP_SEGMENT_RE = /[A-Za-zÀ-ɏ]+(?:['’][A-Za-zÀ-ɏ]+)*/g;
const LOOKUP_SEGMENT_FULL_RE = /^[A-Za-zÀ-ɏ]+(?:['’][A-Za-zÀ-ɏ]+)*$/;
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
const LOOKUP_EAST_ASIAN_EDGE_PATTERN = /^[\s\u3000"'“”‘’「」『』（）()【】〔〕［］｛｝〈〉《》、。！？・…—–-]+|[\s\u3000"'“”‘’「」『』（）()【】〔〕［］｛｝〈〉《》、。！？・…—–-]+$/g;
const HAN_CHAR_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々〆ヵヶ]/;
const KANA_CHAR_RE = /[\u3040-\u30FFー]/;
const HANGUL_CHAR_RE = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]/;
const HANGUL_TEXT_RE = /^[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]+$/;
const EAST_ASIAN_CHAR_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々〆ヵヶー\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]/;

export type LookupSegment = {
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

function isLatinChar(char: string): boolean {
  return /^[A-Za-zÀ-ɏ]$/.test(char);
}

function isHanChar(char: string): boolean {
  return HAN_CHAR_RE.test(char);
}

function isKanaChar(char: string): boolean {
  return KANA_CHAR_RE.test(char);
}

function isHangulChar(char: string): boolean {
  return HANGUL_CHAR_RE.test(char);
}

export function containsEastAsianLookupText(text?: string | null): boolean {
  if (!text) return false;
  return EAST_ASIAN_CHAR_RE.test(text);
}

function normalizeHangulInlineSpaces(text: string): string {
  const normalized = text.replace(/[ \t\u3000]+/g, " ").trim();
  const parts = normalized.split(" ");
  if (parts.length <= 1) return normalized;

  if (parts.every((part) => HANGUL_TEXT_RE.test(part)) && parts.some((part) => part.length <= 1)) {
    return parts.join("");
  }

  return normalized;
}

export function normalizeLookupWord(raw: string): string | null {
  if (!raw) return null;

  let word = raw.trim();
  if (!word) return null;

  word = word.replace(/[’]/g, "'");

  if (containsEastAsianLookupText(word)) {
    const withoutEdgePunctuation = word.replace(LOOKUP_EAST_ASIAN_EDGE_PATTERN, "");
    const normalized = HANGUL_CHAR_RE.test(withoutEdgePunctuation)
      ? normalizeHangulInlineSpaces(withoutEdgePunctuation)
      : withoutEdgePunctuation.replace(/[ \t\u3000]+/g, "");
    return normalized || null;
  }

  const directMatch = word.match(LOOKUP_SEGMENT_FULL_RE);
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

export function normalizeLookupComparableText(text: string): string {
  if (!text) return "";

  const normalized = text.replace(/[’]/g, "'").trim();
  if (!normalized) return "";

  if (containsEastAsianLookupText(normalized)) {
    return normalized
      .replace(LOOKUP_EAST_ASIAN_EDGE_PATTERN, "")
      .replace(/[ \t\u3000、。！？・…，．,:;；]+/g, "");
  }

  return normalized
    .toLowerCase()
    .replace(/[^a-z0-9\u00C0-\u024F'\s]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createLookupSegment(raw: string, start: number, end: number): LookupSegment | null {
  const normalized = normalizeLookupWord(raw);
  if (!normalized) return null;
  return { raw, normalized, start, end };
}

function splitLongHanRun(text: string, start: number): LookupSegment[] {
  const segments: LookupSegment[] = [];
  if (text.length <= 4) {
    const segment = createLookupSegment(text, start, start + text.length);
    return segment ? [segment] : [];
  }

  let offset = 0;
  while (offset < text.length) {
    const remaining = text.length - offset;
    let chunkLength = remaining;
    if (remaining > 4) {
      chunkLength = offset === 0 && remaining % 2 === 1 ? 3 : 2;
    }

    const chunk = text.slice(offset, offset + chunkLength);
    const segment = createLookupSegment(chunk, start + offset, start + offset + chunkLength);
    if (segment) segments.push(segment);
    offset += chunkLength;
  }

  return segments;
}

function splitLongKanaRun(text: string, start: number): LookupSegment[] {
  const segments: LookupSegment[] = [];
  if (text.length <= 8) {
    const segment = createLookupSegment(text, start, start + text.length);
    return segment ? [segment] : [];
  }

  for (let offset = 0; offset < text.length; offset += 4) {
    const chunk = text.slice(offset, offset + 4);
    const segment = createLookupSegment(chunk, start + offset, start + offset + chunk.length);
    if (segment) segments.push(segment);
  }

  return segments;
}

export function getLookupSegments(text: string): LookupSegment[] {
  if (!text) return [];

  const directSegments: LookupSegment[] = [];
  let offset = 0;

  while (offset < text.length) {
    const current = text[offset];
    if (!current) break;

    if (isLatinChar(current)) {
      let end = offset + 1;
      while (end < text.length) {
        const next = text[end];
        if (isLatinChar(next)) {
          end += 1;
          continue;
        }
        if ((next === "'" || next === "’") && end + 1 < text.length && isLatinChar(text[end + 1])) {
          end += 2;
          continue;
        }
        break;
      }

      const segment = createLookupSegment(text.slice(offset, end), offset, end);
      if (segment) directSegments.push(segment);
      offset = end;
      continue;
    }

    if (isHangulChar(current)) {
      let end = offset + 1;
      while (end < text.length && isHangulChar(text[end])) {
        end += 1;
      }
      const segment = createLookupSegment(text.slice(offset, end), offset, end);
      if (segment) directSegments.push(segment);
      offset = end;
      continue;
    }

    if (isHanChar(current)) {
      let end = offset + 1;
      while (end < text.length && isHanChar(text[end])) {
        end += 1;
      }
      while (end < text.length && isKanaChar(text[end])) {
        end += 1;
      }

      const raw = text.slice(offset, end);
      const segments = /[\u3040-\u30FFー]/.test(raw) ? splitLongKanaRun(raw, offset) : splitLongHanRun(raw, offset);
      directSegments.push(...segments);
      offset = end;
      continue;
    }

    if (isKanaChar(current)) {
      let end = offset + 1;
      while (end < text.length && isKanaChar(text[end])) {
        end += 1;
      }
      directSegments.push(...splitLongKanaRun(text.slice(offset, end), offset));
      offset = end;
      continue;
    }

    offset += 1;
  }

  if (directSegments.length !== 1) {
    return directSegments;
  }

  const onlySegment = directSegments[0];
  if (
    onlySegment.raw.length < 7 ||
    onlySegment.raw.length !== text.length ||
    !LOOKUP_SEGMENT_FULL_RE.test(text)
  ) {
    return directSegments;
  }

  const inferredSegments = inferOcrJoinedSegments(text);
  return inferredSegments.length > 1 ? inferredSegments : directSegments;
}

export function getLookupSegmentAtTextOffset(text: string, offset: number): LookupSegment | null {
  const segments = getLookupSegments(text);
  if (segments.length === 0) return null;

  const clampedOffset = Number.isFinite(offset)
    ? Math.min(Math.max(0, offset), text.length)
    : 0;

  let best: LookupSegment | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const segment of segments) {
    if (clampedOffset >= segment.start && clampedOffset <= segment.end) {
      return segment;
    }

    const distance =
      clampedOffset < segment.start
        ? segment.start - clampedOffset
        : clampedOffset - segment.end;

    if (distance < bestDistance) {
      best = segment;
      bestDistance = distance;
    }
  }

  return best;
}

export function getLookupWordFromText(text: string, clickRatio = 0.5): string | null {
  const clampedRatio = Number.isFinite(clickRatio) ? Math.min(1, Math.max(0, clickRatio)) : 0.5;
  const segment = getLookupSegmentAtTextOffset(text, text.length * clampedRatio);
  return segment?.normalized || null;
}

export function splitTextForWordLookup(text: string): string[] {
  if (!text) return [];

  const segments = getLookupSegments(text);
  if (segments.length === 0) return [text];

  const parts: string[] = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.start > cursor) {
      parts.push(text.slice(cursor, segment.start));
    }
    parts.push(text.slice(segment.start, segment.end));
    cursor = segment.end;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts;
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
