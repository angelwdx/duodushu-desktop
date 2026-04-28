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

// ─── 常量 ──────────────────────────────────────────────────────────────────
const MAX_CHUNK = 9800;
const MAX_CHUNK_QWEN3 = 180;
const MAX_CONSECUTIVE_EMPTY = 3;
const PREFETCH_DEPTH_DEFAULT = 1;
const PREFETCH_DEPTH_QWEN3 = 2;

const EDGE_VOICES = [
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
  // en-AU
  { id: 'natasha',     label: 'Natasha (澳式女声)' },
  { id: 'william',     label: 'William (澳式男声)' },
  // en-CA
  { id: 'clara',       label: 'Clara (加式女声)' },
  { id: 'liam',        label: 'Liam (加式男声)' },
  // en-IN
  { id: 'neerja',      label: 'Neerja (印度女声)' },
  { id: 'prabhat',     label: 'Prabhat (印度男声)' },
  // en-IE
  { id: 'emily',       label: 'Emily (爱尔兰女声)' },
  { id: 'connor',      label: 'Connor (爱尔兰男声)' },
] as const;

export type TTSVoice = string;
export type TTSVoiceOption = { id: string; label: string };

// ─── 类型 ──────────────────────────────────────────────────────────────────
export interface UseFullTextTTSOptions {
  getPageText: (page: number) => string;
  totalPages: number;
  currentPage: number;
  onPageChange: (page: number) => void;
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
  provider: 'edge' | 'openai_api' | 'qwen3';
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
    .split(/(?<=[。！？!?；;…]|\. |\! |\? |\n)/)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

function splitTextIntoChunksForQwen3(text: string, maxLen = MAX_CHUNK_QWEN3): string[] {
  const sentences = splitIntoSentences(text.trim());
  if (sentences.length === 0) return [];

  return sentences.flatMap(sentence => splitLongSentence(sentence, maxLen));
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useFullTextTTS({
  getPageText,
  totalPages,
  currentPage,
  onPageChange,
  pageChangeDelay = 600,
  pageStep = 1,
}: UseFullTextTTSOptions): UseFullTextTTSReturn {
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
  const [voice, setVoice] = useState<TTSVoice>('default');
  const [voices, setVoices] = useState<TTSVoiceOption[]>([...EDGE_VOICES]);
  const [provider, setProvider] = useState<'edge' | 'openai_api' | 'qwen3'>('edge');
  const [speed, setSpeedState] = useState<number>(getInitialSpeed);

  // ── 核心 Refs ──
  const audioRef               = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef             = useRef<string | null>(null);
  const shouldPlayRef          = useRef(false);  // false 时循环退出
  const readingPageRef         = useRef<number>(1);
  const providerRef            = useRef(provider);
  // stop() 时用于强制 resolve 挂起的 playChunk Promise
  const abortCurrentChunkRef   = useRef<(() => void) | null>(null);
  const pendingAudioLoadsRef   = useRef(0);
  const persistReadyRef        = useRef(false);

  // ── 最新值引用（避免异步闭包过时） ──
  const getPageTextRef     = useRef(getPageText);
  const totalPagesRef      = useRef(totalPages);
  const onPageChangeRef    = useRef(onPageChange);
  const voiceRef           = useRef(voice);
  const pageChangeDelayRef = useRef(pageChangeDelay);
  const pageStepRef        = useRef(pageStep);
  const speedRef           = useRef(speed);

  useEffect(() => { getPageTextRef.current     = getPageText;     }, [getPageText]);
  useEffect(() => { totalPagesRef.current      = totalPages;      }, [totalPages]);
  useEffect(() => { onPageChangeRef.current    = onPageChange;    }, [onPageChange]);
  useEffect(() => { voiceRef.current           = voice;           }, [voice]);
  useEffect(() => { pageChangeDelayRef.current = pageChangeDelay; }, [pageChangeDelay]);
  useEffect(() => { pageStepRef.current        = pageStep;        }, [pageStep]);
  useEffect(() => { providerRef.current        = provider;        }, [provider]);
  useEffect(() => {
    speedRef.current = speed;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('reader_tts_speed', String(speed));
    }
    if (audioRef.current) {
      audioRef.current.playbackRate = speed;
    }
  }, [speed]);

  const setSpeed = useCallback((nextSpeed: number) => {
    const normalized = Math.min(2, Math.max(0.5, Number(nextSpeed) || 1));
    setSpeedState(normalized);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadActiveTTSConfig = async () => {
      try {
        const { getTTSConfig, getTTSVoices } = await import('../lib/api');
        const config = await getTTSConfig();
        if (cancelled) return;

        setProvider(config.provider);

        if (config.provider === 'qwen3') {
          const configuredVoice = config.qwen3.voice?.trim() || '塔塔';
          setSpeed(config.qwen3.speed || 1);
          const availableVoices = await getTTSVoices();
          if (cancelled) return;
          const mappedVoices = availableVoices.length > 0
            ? availableVoices.map(v => ({ id: v.voice, label: v.name || v.voice }))
            : [{ id: configuredVoice, label: configuredVoice }];
          setVoices(mappedVoices);
          setVoice(configuredVoice);
          persistReadyRef.current = true;
          return;
        }

        if (config.provider === 'openai_api') {
          const configuredVoice = config.openai_api.voice?.trim() || 'alloy';
          setSpeed(config.openai_api.speed || 1);
          setVoices([{ id: configuredVoice, label: configuredVoice }]);
          setVoice(configuredVoice);
          persistReadyRef.current = true;
          return;
        }

        setVoices([...EDGE_VOICES]);
        setVoice(config.edge.voice || 'aria');
        setSpeed(config.edge.speed || 1);
        persistReadyRef.current = true;
      } catch {
        if (!cancelled) {
          setProvider('edge');
          setVoices([...EDGE_VOICES]);
          setVoice('default');
          setSpeed(1);
          persistReadyRef.current = true;
        }
      }
    };

    loadActiveTTSConfig();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!persistReadyRef.current) return;

    const timer = window.setTimeout(async () => {
      try {
        const { getTTSConfig, saveTTSConfig } = await import('../lib/api');
        const config = await getTTSConfig();
        const nextConfig = {
          ...config,
          edge: { ...config.edge },
          openai_api: { ...config.openai_api },
          qwen3: { ...config.qwen3 },
        };

        if (providerRef.current === 'qwen3') {
          nextConfig.qwen3.voice = voiceRef.current;
          nextConfig.qwen3.speed = speedRef.current;
        } else if (providerRef.current === 'openai_api') {
          nextConfig.openai_api.voice = voiceRef.current;
          nextConfig.openai_api.speed = speedRef.current;
        } else {
          nextConfig.edge.voice = voiceRef.current;
          nextConfig.edge.speed = speedRef.current;
        }

        await saveTTSConfig(nextConfig);
      } catch (error) {
        console.warn('[useFullTextTTS] Failed to persist reader TTS config:', error);
      }
    }, 400);

    return () => window.clearTimeout(timer);
  }, [voice, speed, provider]);

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
    audioRef.current?.pause();
    audioRef.current = null;
    // 强制 resolve 挂起的 playChunk Promise，让循环可以检测到 shouldPlayRef 并退出
    abortCurrentChunkRef.current?.();
    abortCurrentChunkRef.current = null;
    revokeBlobUrl();
  }, [revokeBlobUrl]);

  const loadChunkAudio = useCallback(async (text: string): Promise<string> => {
    const { streamSpeech } = await import('../lib/api');
    pendingAudioLoadsRef.current += 1;
    setIsGenerating(true);
    try {
      return await streamSpeech(text, voiceRef.current);
    } finally {
      pendingAudioLoadsRef.current = Math.max(0, pendingAudioLoadsRef.current - 1);
      setIsGenerating(pendingAudioLoadsRef.current > 0);
    }
  }, []);

  // ── 播放已加载的 chunk（返回 Promise，挂起直到播放完毕或被 abort） ──
  const playPreparedChunk = useCallback(async (blobUrl: string): Promise<void> => {
    if (!shouldPlayRef.current) {
      URL.revokeObjectURL(blobUrl);
      return;
    }

    revokeBlobUrl();
    blobUrlRef.current = blobUrl;

    const audio = new Audio(blobUrl);
    audio.playbackRate = speedRef.current;
    audioRef.current = audio;

    return new Promise((resolve, reject) => {
      // 注册 abort 回调：stop() 时调用 resolve() 让循环退出
      abortCurrentChunkRef.current = resolve;

      audio.onended = () => {
        abortCurrentChunkRef.current = null;
        resolve();
      };
      audio.onerror = () => {
        abortCurrentChunkRef.current = null;
        reject(new Error('Audio playback error'));
      };
      audio.play().catch(reject);
      // 注意：不在 onpause 里 resolve —— 这样暂停时 Promise 保持挂起，
      // resume() 调用 audio.play() 后音频从原位继续，onended 照常触发。
    });
  }, [revokeBlobUrl]);

  // ── 朗读一整页（可能分多个 chunk），返回是否有内容 ──
  const playPage = useCallback(async (page: number): Promise<boolean> => {
    if (!shouldPlayRef.current) return false;
    const rawText = getPageTextRef.current(page).trim();
    if (!rawText) return false;
    const isQwen3 = providerRef.current === 'qwen3';
    const chunks = isQwen3
      ? splitTextIntoChunksForQwen3(rawText)
      : splitTextIntoChunks(rawText);
    const prefetchDepth = isQwen3 ? PREFETCH_DEPTH_QWEN3 : PREFETCH_DEPTH_DEFAULT;
    const blobQueue: Array<Promise<string>> = [];
    const enqueueNext = (chunkIndex: number) => {
      if (chunkIndex >= chunks.length) return;
      blobQueue.push(loadChunkAudio(chunks[chunkIndex]));
    };

    for (let i = 0; i < Math.min(prefetchDepth, chunks.length); i++) {
      enqueueNext(i);
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!shouldPlayRef.current) {
        setTimeout(() => setCurrentChunkText(null), 0);
        return true;
      }

      const blobUrl = await blobQueue.shift()!;
      enqueueNext(i + prefetchDepth);

      // 高亮当前正在朗读的片段
      setTimeout(() => setCurrentChunkText(chunk), 0);
      await playPreparedChunk(blobUrl);
    }
    setTimeout(() => setCurrentChunkText(null), 0);
    return true;
  }, [loadChunkAudio, playPreparedChunk]);

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

        onPageChangeRef.current(page);
        await delay(pageChangeDelayRef.current);
      }
    } catch (err) {
      console.error('[useFullTextTTS] Playback error:', err);
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
      await playPageRef.current(page);
    } catch (err) {
      console.error('[useFullTextTTS] playCurrentPage error:', err);
    } finally {
      stopAudio();
      setIsPlaying(false);
      setIsPaused(false);
      setTimeout(() => setCurrentReadingPage(null), 0);
      setTimeout(() => setCurrentChunkText(null), 0);
    }
  }, [stopAudio, currentPage]);

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
