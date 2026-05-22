/**
 * useFullTextTTS — 全文连续朗读 hook
 *
 * 功能:
 * - 从指定页开始朗读，结束后自动翻到下一页/章节继续
 * - 真正的暂停/继续（音频从暂停位置继续，不重新请求）
 * - 长文本自动切分（单段 ≤ 9800 字符），多段顺序播放
 * - 停止时强制结束挂起的 Promise，防止循环泄露
 *
 * 架构说明:
 * - pause()  : 仅暂停音频，while 循环挂起等待 onended
 * - resume() : 调用 audio.play() 从原位继续，循环无感知
 * - stop()   : 通过 abortCurrentChunkRef 强制 resolve 挂起的 Promise，循环靠 shouldPlayRef 退出
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import type { TTSConfig as StoredTTSConfig, TTSVoiceOption as ApiTTSVoiceOption } from '../lib/api';
import { createLogger } from '../lib/logger';
import { isJapaneseBookLanguage } from '../lib/japaneseText';

const log = createLogger('useFullTextTTS');

// ─── 常量 ──────────────────────────────────────────────────────────────────
const MAX_CHUNK = 9800;
const MAX_CHUNK_QWEN3 = 180;
const MAX_CHUNK_JAPANESE = 320;
const MAX_CONSECUTIVE_EMPTY = 3;
const PREFETCH_DEPTH_DEFAULT = 1;
const PREFETCH_DEPTH_QWEN3 = 2;
const PREFETCH_DEPTH_JAPANESE = 2;
const PAGE_OVERLAP_WINDOW = 1200;
const PAGE_OVERLAP_MIN = 24;

const EDGE_VOICES_EN = [
  // en-US
  { id: 'aria',        label: 'Aria (美式女声)' },
  { id: 'jenny',       label: 'Jenny (美式女声)' },
  { id: 'michelle',    label: 'Michelle (美式女声)' },
  { id: 'ana',         label: 'Ana (美式女声 · 童声)' },
  { id: 'emma',        label: 'Emma (美式女声)' },
  { id: 'ava',         label: 'Ava (美式女声)' },
  { id: 'guy',         label: 'Guy (美式男声)' },
  { id: 'christopher', label: 'Christopher (美式男声)' },
  { id: 'eric',        label: 'Eric (美式男声)' },
  { id: 'roger',       label: 'Roger (美式男声)' },
  { id: 'steffan',     label: 'Steffan (美式男声)' },
  { id: 'andrew',      label: 'Andrew (美式男声)' },
  { id: 'brian',       label: 'Brian (美式男声)' },
  // en-GB
  { id: 'sonia',       label: 'Sonia (英式女声)' },
  { id: 'libby',       label: 'Libby (英式女声)' },
  { id: 'maisie',      label: 'Maisie (英式女声)' },
  { id: 'ryan',        label: 'Ryan (英式男声)' },
  { id: 'thomas',      label: 'Thomas (英式男声)' },
] as const;

const EDGE_VOICES_JA = [
  { id: 'nanami', label: 'Nanami（日语女声）' },
  { id: 'keita', label: 'Keita（日语男声）' },
] as const;

const EDGE_VOICES_ZH = [
  { id: 'xiaoxiao', label: 'Xiaoxiao（中文女声）' },
  { id: 'yunxi', label: 'Yunxi（中文男声）' },
] as const;

type TTSProvider = 'edge' | 'openai_api' | 'qwen3';
type TTSLanguage = 'default' | 'ja' | 'zh';

export type TTSVoice = string;
export type TTSVoiceOption = {
  id: string;
  label: string;
  provider: TTSProvider;
  voice: string;
  speed: number;
};

// ─── 类型 ──────────────────────────────────────────────────────────────────
export interface UseFullTextTTSOptions {
  getPageText: (page: number) => string;
  getCurrentPageText?: () => string;
  getNextPageText?: (page: number) => string;
  totalPages: number;
  currentPage: number;
  onPageChange: (page: number) => void | boolean | Promise<void | boolean>;
  bookLanguage?: string | null;
  /** 翻页后等待内容加载的时间（ms），PDF ≈ 400，EPUB ≈ 1000 */
  pageChangeDelay?: number;
  /** 翻页步长（双页模式=2，单页模式=1） */
  pageStep?: number;
}

export interface UseFullTextTTSReturn {
  isPlaying: boolean;
  isPaused: boolean;
  isGenerating: boolean;
  currentReadingPage: number | null;
  /** 当前正在朗读的文本片段（用于 UI 高亮） */
  currentChunkText: string | null;
  provider: TTSProvider;
  voice: TTSVoice;
  voices: TTSVoiceOption[];
  speed: number;
  setVoice: (v: TTSVoice) => void;
  setSpeed: (speed: number) => void;
  play: () => void;
  /** 只朗读当前页，读完后停止，不自动翻页 */
  playCurrentPage: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

function getTTSLanguage(bookLanguage?: string | null): TTSLanguage {
  if (isJapaneseBookLanguage(bookLanguage)) return 'ja';

  const normalized = bookLanguage?.trim().toLowerCase();
  if (normalized === 'zh' || normalized?.startsWith('zh-')) {
    return 'zh';
  }

  return 'default';
}

function getConfiguredVoice(config: StoredTTSConfig, provider: TTSProvider, ttsLanguage: TTSLanguage): string {
  if (provider === 'qwen3') {
    if (ttsLanguage === 'ja') {
      return config.qwen3.voice_japanese?.trim() || config.qwen3.voice?.trim() || '塔塔';
    }
    return config.qwen3.voice?.trim() || '塔塔';
  }

  if (provider === 'openai_api') {
    return config.openai_api.voice?.trim() || 'alloy';
  }

  if (ttsLanguage === 'ja') {
    return config.edge.voice_japanese?.trim() || 'nanami';
  }
  if (ttsLanguage === 'zh') {
    return config.edge.voice_chinese?.trim() || 'xiaoxiao';
  }
  return config.edge.voice?.trim() || 'aria';
}

function getConfiguredOpenAIVoice(config: StoredTTSConfig): string {
  return config.openai_api.voice?.trim() || '';
}

function buildVoiceKey(provider: TTSProvider, voice: string): string {
  return `${provider}::${voice}`;
}

function buildReaderVoiceOptions(
  config: StoredTTSConfig,
  qwen3Voices: ApiTTSVoiceOption[],
  ttsLanguage: TTSLanguage,
): TTSVoiceOption[] {
  const options: TTSVoiceOption[] = [];
  const seen = new Set<string>();

  const pushOption = (
    provider: TTSProvider,
    voice: string,
    label: string,
    speed: number,
  ) => {
    const normalizedVoice = voice.trim();
    if (!normalizedVoice) return;

    const key = buildVoiceKey(provider, normalizedVoice);
    if (seen.has(key)) return;

    seen.add(key);
    options.push({
      id: key,
      label,
      provider,
      voice: normalizedVoice,
      speed,
    });
  };

  const edgeVoices = ttsLanguage === 'ja'
    ? EDGE_VOICES_JA
    : ttsLanguage === 'zh'
      ? EDGE_VOICES_ZH
      : EDGE_VOICES_EN;

  edgeVoices.forEach((edgeVoice) => {
    pushOption('edge', edgeVoice.id, `Edge TTS · ${edgeVoice.label}`, config.edge.speed || 1);
  });

  const configuredOpenAIVoice = getConfiguredOpenAIVoice(config);
  if (configuredOpenAIVoice) {
    pushOption('openai_api', configuredOpenAIVoice, `自定义 API · ${configuredOpenAIVoice}`, config.openai_api.speed || 1);
  }

  const configuredQwenVoice = getConfiguredVoice(config, 'qwen3', ttsLanguage);
  pushOption('qwen3', configuredQwenVoice, `本地 Qwen3 · ${configuredQwenVoice}`, config.qwen3.speed || 1);
  qwen3Voices.forEach((voiceOption) => {
    const label = voiceOption.name?.trim() || voiceOption.voice;
    pushOption('qwen3', voiceOption.voice, `本地 Qwen3 · ${label}`, config.qwen3.speed || 1);
  });

  return options;
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────

function splitTextIntoChunks(text: string, maxLen = MAX_CHUNK): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('. ', maxLen);
    if (splitAt === -1) splitAt = remaining.lastIndexOf('! ', maxLen);
    if (splitAt === -1) splitAt = remaining.lastIndexOf('? ', maxLen);
    if (splitAt === -1) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt === -1) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt + 1).trim());
    remaining = remaining.slice(splitAt + 1).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function splitLongSentence(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('，', maxLen);
    if (splitAt === -1) splitAt = remaining.lastIndexOf('；', maxLen);
    if (splitAt === -1) splitAt = remaining.lastIndexOf(',', maxLen);
    if (splitAt === -1) splitAt = remaining.lastIndexOf(';', maxLen);
    if (splitAt === -1) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt === -1) splitAt = maxLen - 1;

    chunks.push(remaining.slice(0, splitAt + 1).trim());
    remaining = remaining.slice(splitAt + 1).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function splitIntoSentences(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[。！？!?；;…]|\.(?=\s)|!(?=\s)|\?(?=\s)|[」』](?=\s|$|[「『])|\n)/)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

function splitTextIntoChunksForQwen3(text: string, maxLen = MAX_CHUNK_QWEN3): string[] {
  const sentences = splitIntoSentences(text.trim());
  if (sentences.length === 0) return [];

  return sentences.flatMap(sentence => splitLongSentence(sentence, maxLen));
}

function splitTextIntoChunksForJapanese(text: string, maxLen = MAX_CHUNK_JAPANESE): string[] {
  const sentences = splitIntoSentences(text.trim());
  if (sentences.length === 0) return [];

  const chunks: string[] = [];
  let currentChunk = '';

  const pushChunk = () => {
    const trimmed = currentChunk.trim();
    if (trimmed) chunks.push(trimmed);
    currentChunk = '';
  };

  for (const sentence of sentences.flatMap(part => splitLongSentence(part, maxLen))) {
    if (!currentChunk) {
      currentChunk = sentence;
      continue;
    }

    if (currentChunk.length + sentence.length <= maxLen) {
      currentChunk += sentence;
      continue;
    }

    pushChunk();
    currentChunk = sentence;
  }

  pushChunk();
  return chunks;
}

const delay = (ms: number) => (
  ms <= 0 ? Promise.resolve() : new Promise<void>(r => setTimeout(r, ms))
);

function normalizeOverlapText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim()
    .toLowerCase();
}

function trimRepeatedPagePrefix(text: string, previousText: string): string {
  const current = text.trim();
  const previous = previousText.trim();
  if (!current || !previous) return current;

  const previousWindow = previous.slice(-PAGE_OVERLAP_WINDOW);
  const currentWindow = current.slice(0, PAGE_OVERLAP_WINDOW);
  const normalizedPrevious = normalizeOverlapText(previousWindow);
  const normalizedCurrent = normalizeOverlapText(currentWindow);

  const maxOverlap = Math.min(normalizedPrevious.length, normalizedCurrent.length);
  for (let length = maxOverlap; length >= PAGE_OVERLAP_MIN; length -= 1) {
    const prefix = normalizedCurrent.slice(0, length);
    if (normalizedPrevious.endsWith(prefix)) {
      const rawPrefix = currentWindow;
      let rawCut = 0;
      let normalizedCount = 0;

      while (rawCut < rawPrefix.length && normalizedCount < length) {
        const char = rawPrefix[rawCut];
        const normalizedChar = normalizeOverlapText(char);
        if (normalizedChar) normalizedCount += normalizedChar.length;
        rawCut += 1;
      }

      return current.slice(rawCut).trim();
    }
  }

  return current;
}

function getTextFingerprint(text: string): string {
  return normalizeOverlapText(text)
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 160);
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useFullTextTTS({
  getPageText,
  getCurrentPageText,
  getNextPageText,
  totalPages,
  currentPage,
  onPageChange,
  bookLanguage,
  pageChangeDelay = 600,
  pageStep = 1,
}: UseFullTextTTSOptions): UseFullTextTTSReturn {
  const ttsLanguage = getTTSLanguage(bookLanguage);
  const isJapaneseTTSLanguage = ttsLanguage === 'ja';
  const getInitialSpeed = () => {
    if (typeof window === 'undefined') return 1;
    const raw = window.localStorage.getItem('reader_tts_speed');
    const parsed = raw ? Number(raw) : 1;
    if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 2) return 1;
    return parsed;
  };

  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused]   = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [currentReadingPage, setCurrentReadingPage] = useState<number | null>(null);
  const [currentChunkText, setCurrentChunkText]     = useState<string | null>(null);
  const [voice, setVoiceState] = useState<TTSVoice>(
    buildVoiceKey('edge', ttsLanguage === 'ja' ? 'nanami' : ttsLanguage === 'zh' ? 'xiaoxiao' : 'aria'),
  );
  const [voices, setVoices] = useState<TTSVoiceOption[]>([]);
  const [provider, setProvider] = useState<TTSProvider>('edge');
  const [speed, setSpeedState] = useState<number>(getInitialSpeed);

  // ── 核心 Refs ──
  const audioRef               = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef             = useRef<string | null>(null);
  const currentAudioSynthesisSpeedRef = useRef(1);
  const shouldPlayRef          = useRef(false);  // false 时循环退出
  const readingPageRef         = useRef<number>(1);
  const providerRef            = useRef(provider);
  const voiceOptionsRef        = useRef<TTSVoiceOption[]>([]);
  // stop() 时用于强制 resolve 挂起的 playChunk Promise
  const abortCurrentChunkRef   = useRef<(() => void) | null>(null);
  const pendingAudioLoadsRef   = useRef(0);
  const persistReadyRef        = useRef(false);
  // ── 最新值引用（避免异步闭包过时） ──
  const getPageTextRef     = useRef(getPageText);
  const getCurrentPageTextRef = useRef(getCurrentPageText);
  const getNextPageTextRef = useRef(getNextPageText);
  const totalPagesRef      = useRef(totalPages);
  const onPageChangeRef    = useRef(onPageChange);
  const voiceRef           = useRef(ttsLanguage === 'ja' ? 'nanami' : ttsLanguage === 'zh' ? 'xiaoxiao' : 'aria');
  const pageChangeDelayRef = useRef(pageChangeDelay);
  const pageStepRef        = useRef(pageStep);
  const speedRef           = useRef(speed);
  const lastSpokenPageTextRef = useRef('');
  const prefetchedPageAudioRef = useRef<{
    page: number;
    text: string;
    firstChunk: string;
    firstChunkFingerprint: string;
    firstAudio: Promise<{ blobUrl: string; synthesisSpeed: number } | null>;
  } | null>(null);

  const getCurrentAudioPlaybackRate = useCallback(() => {
    const synthesisSpeed = currentAudioSynthesisSpeedRef.current || 1;
    const rawRatio = speedRef.current / synthesisSpeed;
    if (!Number.isFinite(rawRatio) || rawRatio <= 0) return 1;
    return Math.min(2, Math.max(0.5, rawRatio));
  }, []);

  const syncCurrentAudioPlaybackRate = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = getCurrentAudioPlaybackRate();
    }
  }, [getCurrentAudioPlaybackRate]);

  useEffect(() => { getPageTextRef.current     = getPageText;     }, [getPageText]);
  useEffect(() => { getCurrentPageTextRef.current = getCurrentPageText; }, [getCurrentPageText]);
  useEffect(() => { getNextPageTextRef.current = getNextPageText; }, [getNextPageText]);
  useEffect(() => { totalPagesRef.current      = totalPages;      }, [totalPages]);
  useEffect(() => { onPageChangeRef.current    = onPageChange;    }, [onPageChange]);
  useEffect(() => {
    voiceOptionsRef.current = voices;
    const selectedVoiceOption = voices.find((option) => option.id === voice);
    if (selectedVoiceOption) {
      voiceRef.current = selectedVoiceOption.voice;
    }
  }, [voice, voices]);
  useEffect(() => { pageChangeDelayRef.current = pageChangeDelay; }, [pageChangeDelay]);
  useEffect(() => { pageStepRef.current        = pageStep;        }, [pageStep]);
  useEffect(() => { providerRef.current        = provider;        }, [provider]);
  useEffect(() => {
    speedRef.current = speed;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('reader_tts_speed', String(speed));
    }
    syncCurrentAudioPlaybackRate();
  }, [speed, syncCurrentAudioPlaybackRate]);

  useEffect(() => {
    setVoices((prevVoices) => {
      let changed = false;
      const nextVoices = prevVoices.map((voiceOption) => {
        if (voiceOption.provider !== provider || voiceOption.speed === speed) {
          return voiceOption;
        }
        changed = true;
        return { ...voiceOption, speed };
      });

      return changed ? nextVoices : prevVoices;
    });
  }, [provider, speed]);

  const setSpeed = useCallback((nextSpeed: number) => {
    const normalized = Math.min(2, Math.max(0.5, Number(nextSpeed) || 1));
    setSpeedState(normalized);
  }, []);

  const setVoice = useCallback((nextVoiceId: TTSVoice) => {
    const selectedVoiceOption = voiceOptionsRef.current.find((option) => option.id === nextVoiceId);
    if (!selectedVoiceOption) return;

    const providerChanged = providerRef.current !== selectedVoiceOption.provider;
    voiceRef.current = selectedVoiceOption.voice;
    setVoiceState(selectedVoiceOption.id);
    setProvider(selectedVoiceOption.provider);

    if (providerChanged) {
      setSpeedState(selectedVoiceOption.speed || 1);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadActiveTTSConfig = async () => {
      try {
        const { getTTSConfig, getTTSVoices } = await import('../lib/api');
        const [config, qwen3Voices] = await Promise.all([
          getTTSConfig(),
          getTTSVoices('qwen3'),
        ]);
        if (cancelled) return;

        const nextVoices = buildReaderVoiceOptions(config, qwen3Voices, ttsLanguage);
        const configuredVoice = getConfiguredVoice(config, config.provider, ttsLanguage);
        const activeVoiceOption = nextVoices.find((option) =>
          option.provider === config.provider && option.voice === configuredVoice,
        ) ?? nextVoices.find((option) => option.provider === config.provider) ?? nextVoices[0];

        if (!activeVoiceOption) {
          throw new Error('No available TTS voices');
        }

        voiceOptionsRef.current = nextVoices;
        voiceRef.current = activeVoiceOption.voice;
        setVoices(nextVoices);
        setVoiceState(activeVoiceOption.id);
        setProvider(activeVoiceOption.provider);
        setSpeed(activeVoiceOption.speed || 1);
        persistReadyRef.current = true;
      } catch {
        if (!cancelled) {
          const fallbackVoice = ttsLanguage === 'ja' ? 'nanami' : ttsLanguage === 'zh' ? 'xiaoxiao' : 'aria';
          const fallbackLabel = ttsLanguage === 'ja'
            ? 'Nanami（日语女声）'
            : ttsLanguage === 'zh'
              ? 'Xiaoxiao（中文女声）'
              : 'Aria (美式女声)';
          const fallbackVoices = [{
            id: buildVoiceKey('edge', fallbackVoice),
            label: `Edge TTS · ${fallbackLabel}`,
            provider: 'edge' as const,
            voice: fallbackVoice,
            speed: 1,
          }];
          voiceOptionsRef.current = fallbackVoices;
          voiceRef.current = fallbackVoice;
          setVoices(fallbackVoices);
          setVoiceState(fallbackVoices[0].id);
          setProvider('edge');
          setSpeed(1);
          persistReadyRef.current = true;
        }
      }
    };

    loadActiveTTSConfig();
    return () => { cancelled = true; };
  }, [setSpeed, ttsLanguage]);

  useEffect(() => {
    if (!persistReadyRef.current) return;

    const timer = window.setTimeout(async () => {
      try {
        const { getTTSConfig, saveTTSConfig } = await import('../lib/api');
        const config = await getTTSConfig();
        const nextConfig = {
          ...config,
          provider: providerRef.current,
          edge: { ...config.edge },
          openai_api: { ...config.openai_api },
          qwen3: { ...config.qwen3 },
        };

        if (providerRef.current === 'qwen3') {
          if (isJapaneseTTSLanguage) {
            nextConfig.qwen3.voice_japanese = voiceRef.current;
          } else {
            nextConfig.qwen3.voice = voiceRef.current;
          }
          nextConfig.qwen3.speed = speedRef.current;
        } else if (providerRef.current === 'openai_api') {
          nextConfig.openai_api.voice = voiceRef.current;
          nextConfig.openai_api.speed = speedRef.current;
        } else {
          if (isJapaneseTTSLanguage) {
            nextConfig.edge.voice_japanese = voiceRef.current;
          } else if (ttsLanguage === 'zh') {
            nextConfig.edge.voice_chinese = voiceRef.current;
          } else {
            nextConfig.edge.voice = voiceRef.current;
          }
          nextConfig.edge.speed = speedRef.current;
        }

        await saveTTSConfig(nextConfig);
      } catch (error) {
        log.warn('Failed to persist reader TTS config', error);
      }
    }, 400);

    return () => window.clearTimeout(timer);
  }, [voice, speed, provider, isJapaneseTTSLanguage, ttsLanguage]);

  // ── 释放 blob URL ──
  const revokeBlobUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  // ── 停止音频（不改 state，调用方负责 state 更新） ──
  const stopAudio = useCallback(() => {
    shouldPlayRef.current = false;
    lastSpokenPageTextRef.current = '';
    prefetchedPageAudioRef.current = null;
    audioRef.current?.pause();
    audioRef.current = null;
    currentAudioSynthesisSpeedRef.current = 1;
    // 强制 resolve 挂起的 playChunk Promise，让循环可以检测到 shouldPlayRef 并退出
    abortCurrentChunkRef.current?.();
    abortCurrentChunkRef.current = null;
    revokeBlobUrl();
  }, [revokeBlobUrl]);

  const loadChunkAudio = useCallback(async (
    text: string,
  ): Promise<{ blobUrl: string; synthesisSpeed: number }> => {
    const { streamSpeech } = await import('../lib/api');
    pendingAudioLoadsRef.current += 1;
    setIsGenerating(true);
    try {
      const { blobUrl, synthesisSpeed } = await streamSpeech(
        text,
        voiceRef.current,
        providerRef.current,
        speedRef.current,
      );
      return { blobUrl, synthesisSpeed };
    } finally {
      pendingAudioLoadsRef.current = Math.max(0, pendingAudioLoadsRef.current - 1);
      setIsGenerating(pendingAudioLoadsRef.current > 0);
    }
  }, []);

  // ── 播放已加载的 chunk（返回 Promise，挂起直到播放完毕或被 abort） ──
  const playPreparedChunk = useCallback(async (
    preparedAudio: { blobUrl: string; synthesisSpeed: number },
  ): Promise<void> => {
    const { blobUrl, synthesisSpeed } = preparedAudio;
    if (!shouldPlayRef.current) {
      URL.revokeObjectURL(blobUrl);
      return;
    }

    revokeBlobUrl();
    blobUrlRef.current = blobUrl;
    currentAudioSynthesisSpeedRef.current = synthesisSpeed;

    const audio = new Audio(blobUrl);
    audio.playbackRate = getCurrentAudioPlaybackRate();
    audioRef.current = audio;

    return new Promise((resolve, reject) => {
      // 注册 abort 回调：stop() 时调用 resolve() 让循环退出
      abortCurrentChunkRef.current = resolve;

      audio.onended = () => {
        abortCurrentChunkRef.current = null;
        currentAudioSynthesisSpeedRef.current = 1;
        resolve();
      };
      audio.onerror = () => {
        abortCurrentChunkRef.current = null;
        currentAudioSynthesisSpeedRef.current = 1;
        reject(new Error('Audio playback error'));
      };
      audio.play().catch(reject);
      // 注意：不在 onpause 里 resolve —— 这样暂停时 Promise 保持挂起，
      // resume() 调用 audio.play() 后音频从原位继续，onended 照常触发。
    });
  }, [getCurrentAudioPlaybackRate, revokeBlobUrl]);

  const splitTextForCurrentProvider = useCallback((text: string): string[] => {
    const isQwen3 = providerRef.current === 'qwen3';
    return isQwen3
      ? splitTextIntoChunksForQwen3(text)
      : isJapaneseTTSLanguage
        ? splitTextIntoChunksForJapanese(text)
        : splitTextIntoChunks(text);
  }, [isJapaneseTTSLanguage]);

  // ── 朗读一整页（可能分多个 chunk），返回是否有内容 ──
  const playText = useCallback(async (
    rawText: string,
    prefetchedFirstAudio?: {
      firstChunk: string;
      firstChunkFingerprint: string;
      firstAudio: Promise<{ blobUrl: string; synthesisSpeed: number } | null>;
    },
  ): Promise<boolean> => {
    if (!shouldPlayRef.current) return false;
    const normalizedText = rawText.trim();
    if (!normalizedText) return false;
    const chunks = splitTextForCurrentProvider(normalizedText);
    const isQwen3 = providerRef.current === 'qwen3';
    const prefetchDepth = isQwen3
      ? PREFETCH_DEPTH_QWEN3
      : isJapaneseTTSLanguage
        ? PREFETCH_DEPTH_JAPANESE
        : PREFETCH_DEPTH_DEFAULT;
    const blobQueue: Array<Promise<{ blobUrl: string; synthesisSpeed: number } | null>> = [];
    const enqueueNext = (chunkIndex: number) => {
      if (chunkIndex >= chunks.length) return;
      blobQueue.push(loadChunkAudio(chunks[chunkIndex]));
    };

    let initialPrefetchOffset = 0;
    if (
      prefetchedFirstAudio &&
      getTextFingerprint(chunks[0]) === prefetchedFirstAudio.firstChunkFingerprint
    ) {
      blobQueue.push(prefetchedFirstAudio.firstAudio);
      initialPrefetchOffset = 1;
    }

    for (let i = initialPrefetchOffset; i < Math.min(prefetchDepth, chunks.length); i++) {
      enqueueNext(i);
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!shouldPlayRef.current) {
        setTimeout(() => setCurrentChunkText(null), 0);
        return true;
      }

      let preparedAudio = await blobQueue.shift()!;
      if (!preparedAudio) {
        preparedAudio = await loadChunkAudio(chunk);
      }
      enqueueNext(i + prefetchDepth);

      // 高亮当前正在朗读的片段
      setTimeout(() => setCurrentChunkText(chunk), 0);
      await playPreparedChunk(preparedAudio);
    }
    setTimeout(() => setCurrentChunkText(null), 0);
    return true;
  }, [isJapaneseTTSLanguage, loadChunkAudio, playPreparedChunk, splitTextForCurrentProvider]);

  const playPage = useCallback(async (page: number): Promise<boolean> => {
    const rawText = getPageTextRef.current(page);
    const text = trimRepeatedPagePrefix(rawText, lastSpokenPageTextRef.current);
    const prefetched =
      prefetchedPageAudioRef.current?.page === page
        ? prefetchedPageAudioRef.current
        : null;
    prefetchedPageAudioRef.current = null;

    const nextPage = page + pageStepRef.current;
    if (nextPage <= totalPagesRef.current && getNextPageTextRef.current) {
      try {
        const nextRawText = getNextPageTextRef.current(nextPage);
        const nextText = trimRepeatedPagePrefix(nextRawText, rawText);
        const nextChunks = splitTextForCurrentProvider(nextText.trim());
        if (nextChunks[0]) {
          prefetchedPageAudioRef.current = {
            page: nextPage,
            text: nextText,
            firstChunk: nextChunks[0],
            firstChunkFingerprint: getTextFingerprint(nextChunks[0]),
            firstAudio: loadChunkAudio(nextChunks[0]).catch((error) => {
              log.debug('Next page first chunk prefetch failed:', error);
              return null;
            }),
          };
        }
      } catch (error) {
        log.debug('Next page TTS prefetch failed:', error);
      }
    }

    const hadContent = await playText(text, prefetched ?? undefined);
    if (hadContent) {
      lastSpokenPageTextRef.current = rawText.trim();
    }
    return hadContent;
  }, [loadChunkAudio, playText, splitTextForCurrentProvider]);

  const playPageRef = useRef(playPage);
  useEffect(() => { playPageRef.current = playPage; }, [playPage]);

  // ── 主循环：先读当前页，再翻下一页并等待加载 ──
  const startReadingLoop = useCallback(async (startPage: number) => {
    shouldPlayRef.current = true;
    setIsPlaying(true);
    setIsPaused(false);

    let page = startPage;
    let consecutiveEmpty = 0;

    try {
      while (shouldPlayRef.current && page <= totalPagesRef.current) {
        readingPageRef.current = page;
        const capturedPage = page;
        setTimeout(() => setCurrentReadingPage(capturedPage), 0);

        const hadContent = await playPageRef.current(page);

        if (!shouldPlayRef.current) break;

        if (!hadContent) {
          consecutiveEmpty++;
          if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) break;
        } else {
          consecutiveEmpty = 0;
        }

        page += pageStepRef.current;
        if (page > totalPagesRef.current) break;

        const pageChanged = await onPageChangeRef.current(page);
        if (pageChanged === false) break;
        await delay(pageChangeDelayRef.current);
      }
    } catch (err) {
      log.error('Playback error', err);
    } finally {
      if (shouldPlayRef.current) {
        // 正常读完
        stopAudio();
        setIsPlaying(false);
        setIsPaused(false);
        setTimeout(() => setCurrentReadingPage(null), 0);
        setTimeout(() => setCurrentChunkText(null), 0);
      }
    }
  }, [stopAudio]);

  // ── 公开 API ──────────────────────────────────────────────────────────────

  const play = useCallback(() => {
    stopAudio();
    const startPage = currentPage > 0 ? currentPage : 1;
    startReadingLoop(startPage);
  }, [stopAudio, startReadingLoop, currentPage]);

  /**
   * 只朗读当前页，读完后停止，不自动翻页。
   */
  const playCurrentPage = useCallback(async () => {
    stopAudio();
    shouldPlayRef.current = true;
    setIsPlaying(true);
    setIsPaused(false);
    const page = currentPage > 0 ? currentPage : 1;
    readingPageRef.current = page;
    setTimeout(() => setCurrentReadingPage(page), 0);
    try {
      const rawText = getCurrentPageTextRef.current?.() ?? getPageTextRef.current(page);
      await playText(rawText);
    } catch (err) {
      log.error('playCurrentPage error', err);
    } finally {
      stopAudio();
      setIsPlaying(false);
      setIsPaused(false);
      setTimeout(() => setCurrentReadingPage(null), 0);
      setTimeout(() => setCurrentChunkText(null), 0);
    }
  }, [stopAudio, currentPage, playText]);

  /**
   * 暂停：只暂停音频，while 循环保持挂起（等待 onended）
   * 不调用 stopAudio，不改 shouldPlayRef
   */
  const pause = useCallback(() => {
    if (!isPlaying || isPaused) return;
    audioRef.current?.pause();   // 暂停音频，onended 不触发，Promise 继续挂起
    setIsPaused(true);
    setIsPlaying(false);
  }, [isPlaying, isPaused]);

  /**
   * 继续：从暂停位置继续播放，循环无感知
   */
  const resume = useCallback(() => {
    if (!isPaused) return;
    setIsPaused(false);
    setIsPlaying(true);
    audioRef.current?.play();    // 音频从原位继续，onended 正常触发，循环继续
  }, [isPaused]);

  const stop = useCallback(() => {
    stopAudio();
    setIsPlaying(false);
    setIsPaused(false);
    setTimeout(() => setCurrentReadingPage(null), 0);
    setTimeout(() => setCurrentChunkText(null), 0);
  }, [stopAudio]);

  // ── 组件卸载时清理 ──
  useEffect(() => {
    return () => { stopAudio(); };
  }, [stopAudio]);

  return {
    isPlaying,
    isPaused,
    isGenerating,
    currentReadingPage,
    currentChunkText,
    provider,
    voice,
    voices,
    speed,
    setVoice,
    setSpeed,
    play,
    playCurrentPage,
    pause,
    resume,
    stop,
  };
}
