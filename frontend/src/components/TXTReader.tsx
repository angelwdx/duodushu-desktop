"use client";

import { useMemo, useEffect, useState, useRef, useCallback } from "react";
import type { FuriganaAnnotation } from "../lib/api";
import { isJapaneseBookLanguage } from "../lib/japaneseText";
import {
  createPlainFuriganaAnnotation,
  ensureFuriganaAnnotations,
  getCachedFuriganaAnnotation,
} from "../lib/japaneseFurigana";
import { useFullTextTTS } from "../hooks/useFullTextTTS";
import TTSLoadingDots from "./TTSLoadingDots";
import FuriganaText from "./FuriganaText";
import { preprocessTTSPlainText } from "../lib/ttsText";
import { createLogger } from "../lib/logger";

const log = createLogger("TXTReader");

interface TXTReaderProps {
  textContent?: string;
  pageNumber?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
  onWordClick?: (word: string, context?: string) => void;
  bookLanguage?: string | null;
}

const FURIGANA_PREFERENCE_KEY = "reader_japanese_furigana_enabled";

export default function TXTReader({
  textContent,
  pageNumber = 1,
  totalPages = 1,
  onPageChange,
  onWordClick,
  bookLanguage,
}: TXTReaderProps) {
  const SPEED_OPTIONS = [
    { value: 1, label: "1.0x" },
    { value: 1.1, label: "1.1x" },
    { value: 1.2, label: "1.2x" },
    { value: 1.3, label: "1.3x" },
    { value: 1.4, label: "1.4x" },
    { value: 1.5, label: "1.5x" },
  ] as const;
  const isJapaneseBook = useMemo(() => isJapaneseBookLanguage(bookLanguage), [bookLanguage]);
  const [showFurigana, setShowFurigana] = useState(true);
  const furiganaCacheRef = useRef<Map<string, FuriganaAnnotation>>(new Map());

  const rawLines = useMemo(() => textContent?.split("\n") ?? [], [textContent]);
  const fullText = textContent ?? "";
  const lineOffsets = useMemo(() => {
    const offsets: number[] = [];
    let total = 0;
    for (let i = 0; i < rawLines.length; i++) {
      offsets.push(total);
      total += rawLines[i].length;
      if (i < rawLines.length - 1) total += 1;
    }
    return offsets;
  }, [rawLines]);

  const segments = useMemo(() => {
    if (!textContent) return [];

    return textContent
      .split("\n")
      .map((line, lineIndex) => {
        const parts = line.split(/(\b[a-zA-ZÀ-ÿ]+(?:'[a-zA-Z]+)?\b)/g).filter(Boolean);

        return {
          lineIndex,
          parts: parts.map((part, partIndex) => ({
            text: part,
            isEnglishWord: /^[a-zA-ZÀ-ÿ]+(?:'[a-zA-Z]+)?$/.test(part),
            key: `${lineIndex}-${partIndex}`,
          })),
        };
      })
      .filter((line) => line.parts.length > 0 || textContent.includes("\n\n"));
  }, [textContent]);

  useEffect(() => {
    if (!isJapaneseBook) {
      setShowFurigana(false);
      return;
    }

    const saved = window.localStorage.getItem(FURIGANA_PREFERENCE_KEY);
    setShowFurigana(saved === null ? true : saved === "true");
  }, [isJapaneseBook]);

  useEffect(() => {
    if (!isJapaneseBook) return;
    window.localStorage.setItem(FURIGANA_PREFERENCE_KEY, String(showFurigana));
  }, [isJapaneseBook, showFurigana]);

  const [furiganaLines, setFuriganaLines] = useState<FuriganaAnnotation[]>([]);

  useEffect(() => {
    let cancelled = false;

    const loadFurigana = async () => {
      if (!rawLines.length) {
        setFuriganaLines([]);
        return;
      }

      if (!isJapaneseBook || !showFurigana) {
        setFuriganaLines(rawLines.map((line) => createPlainFuriganaAnnotation(line)));
        return;
      }

      await ensureFuriganaAnnotations(rawLines, furiganaCacheRef.current);

      if (cancelled) return;

      setFuriganaLines(
        rawLines.map((line) => getCachedFuriganaAnnotation(line, furiganaCacheRef.current)),
      );
    };

    loadFurigana().catch((error) => {
      log.warn("加载假名失败，回退到原文显示", error);
      if (!cancelled) {
        setFuriganaLines(rawLines.map((line) => createPlainFuriganaAnnotation(line)));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [rawLines, isJapaneseBook, showFurigana]);

  const handlePrevPage = () => {
    if (pageNumber > 1 && onPageChange) {
      onPageChange(pageNumber - 1);
    }
  };

  const handleNextPage = () => {
    if (pageNumber < totalPages && onPageChange) {
      onPageChange(pageNumber + 1);
    }
  };

  const [innerPage, setInnerPage] = useState(0);
  const [innerTotalPages, setInnerTotalPages] = useState(1);
  const [visibleStartOffset, setVisibleStartOffset] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const readStartOffset = visibleStartOffset;

  useEffect(() => {
    const calcPages = () => {
      if (!contentRef.current) return;
      const { scrollWidth, clientWidth } = contentRef.current;
      const pages = Math.ceil(scrollWidth / (clientWidth + 40));
      setInnerTotalPages(Math.max(1, pages));
    };

    const timer = setTimeout(calcPages, 100);
    window.addEventListener("resize", calcPages);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", calcPages);
    };
  }, [textContent, segments, furiganaLines]);

  useEffect(() => {
    setInnerPage(0);
  }, [textContent]);

  const handlePrev = () => {
    if (innerPage > 0) {
      setInnerPage(innerPage - 1);
      return;
    }
    handlePrevPage();
  };

  const handleNext = () => {
    if (innerPage < innerTotalPages - 1) {
      setInnerPage(innerPage + 1);
      return;
    }
    handleNextPage();
  };

  const [contentHeight, setContentHeight] = useState<number>(500);
  const [colWidth, setColWidth] = useState<number>(800);

  useEffect(() => {
    const updateLayout = () => {
      const height = window.innerHeight - 180;
      setContentHeight(Math.max(300, height));

      if (contentRef.current) {
        setColWidth(contentRef.current.clientWidth);
        return;
      }

      setColWidth(window.innerWidth - 80);
    };

    const timer = setTimeout(updateLayout, 100);
    window.addEventListener("resize", updateLayout);

    return () => {
      window.removeEventListener("resize", updateLayout);
      clearTimeout(timer);
    };
  }, []);

  const updateVisibleOffsets = useCallback(() => {
    if (!contentRef.current || !viewportRef.current) {
      return { start: 0, end: null as number | null };
    }

    const viewportRect = viewportRef.current.getBoundingClientRect();
    const nodes = Array.from(
      contentRef.current.querySelectorAll<HTMLElement>("[data-char-start]"),
    );

    if (nodes.length === 0) {
      setVisibleStartOffset(0);
      return { start: 0, end: null as number | null };
    }

    let start: number | null = null;
    let end: number | null = null;

    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      const intersects =
        rect.right > viewportRect.left &&
        rect.left < viewportRect.right &&
        rect.bottom > viewportRect.top &&
        rect.top < viewportRect.bottom;

      if (!intersects) continue;

      const nodeStart = Number(node.dataset.charStart ?? "-1");
      const nodeEnd = Number(node.dataset.charEnd ?? "-1");
      if (nodeStart >= 0 && (start === null || nodeStart < start)) start = nodeStart;
      if (nodeEnd >= 0 && (end === null || nodeEnd > end)) end = nodeEnd;
    }

    const nextStart = start ?? 0;
    setVisibleStartOffset(nextStart);
    return { start: nextStart, end };
  }, []);

  useEffect(() => {
    const timer = setTimeout(updateVisibleOffsets, 80);
    const rafId = requestAnimationFrame(updateVisibleOffsets);
    window.addEventListener("resize", updateVisibleOffsets);

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", updateVisibleOffsets);
    };
  }, [innerPage, textContent, colWidth, contentHeight, updateVisibleOffsets, furiganaLines]);

  const getPageText = useCallback(() => {
    if (!textContent?.trim()) return "";
    if (visibleStartOffset <= 0) return preprocessTTSPlainText(textContent, bookLanguage);
    return preprocessTTSPlainText(fullText.slice(visibleStartOffset), bookLanguage);
  }, [bookLanguage, fullText, textContent, visibleStartOffset]);

  const tts = useFullTextTTS({
    getPageText,
    totalPages,
    currentPage: pageNumber,
    onPageChange: (page) => {
      setInnerPage(0);
      onPageChange?.(page);
    },
    pageChangeDelay: 250,
    bookLanguage,
  });

  const highlightRange = useMemo(() => {
    if (!tts.currentChunkText || !fullText) return { start: -1, end: -1 };
    const start = fullText.indexOf(tts.currentChunkText, readStartOffset);
    if (start < 0) {
      const fallback = fullText.indexOf(tts.currentChunkText);
      return {
        start: fallback,
        end: fallback >= 0 ? fallback + tts.currentChunkText.length : -1,
      };
    }
    return { start, end: start + tts.currentChunkText.length };
  }, [tts.currentChunkText, fullText, readStartOffset]);

  useEffect(() => {
    if (!tts.isPlaying || !tts.currentChunkText) return;
    const el = document.querySelector("[data-tts-hl='true']");
    el?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  }, [tts.currentChunkText, tts.isPlaying]);

  const handlePlay = useCallback(() => {
    updateVisibleOffsets();
    requestAnimationFrame(() => {
      tts.play();
    });
  }, [tts, updateVisibleOffsets]);

  const textContainerClassName = isJapaneseBook && showFurigana
    ? "prose prose-slate prose-lg max-w-none font-serif text-gray-800 text-justify leading-[2.35] [overflow-wrap:anywhere]"
    : "prose prose-slate prose-lg max-w-none font-serif leading-loose text-gray-800 text-justify";
  const contentInsetTop = isJapaneseBook && showFurigana ? 56 : 40;

  return (
    <div className="h-full w-full flex flex-col bg-gray-50 overflow-hidden relative">
      <div className="flex-1 w-full flex flex-col overflow-hidden p-4 sm:p-6 pb-2 items-center justify-center">
        <div
          className="max-w-4xl mx-auto w-full bg-white shadow-xl rounded-xl border border-gray-100 flex flex-col overflow-hidden relative"
          style={{ height: contentHeight }}
        >
          <div ref={viewportRef} className="flex-1 relative overflow-hidden">
            <div
              ref={contentRef}
              className="absolute bottom-24 left-10 right-10 transition-transform duration-300 ease-out"
              style={{
                top: `${contentInsetTop}px`,
                columnWidth: `${colWidth}px`,
                columnGap: "5rem",
                columnFill: "auto",
                width: "auto",
                transform: `translateX(-${innerPage * (colWidth + 80)}px)`,
              }}
            >
              <div className={textContainerClassName}>
                {isJapaneseBook && showFurigana
                  ? rawLines.map((lineText, lineIndex) => {
                      const lineStart = lineOffsets[lineIndex] ?? 0;
                      const annotation =
                        furiganaLines[lineIndex] ??
                        createPlainFuriganaAnnotation(rawLines[lineIndex] ?? "");

                      return (
                        <p key={lineIndex} className={lineText.trim() ? "mb-6 indent-8 break-words" : "mb-6 h-6"}>
                          {lineText ? (
                            <FuriganaText
                              annotation={annotation}
                              baseOffset={lineStart}
                              highlightRange={highlightRange}
                            />
                          ) : (
                            <span className="opacity-0">　</span>
                          )}
                        </p>
                      );
                    })
                  : segments.map((line, lineIndex) => {
                      const lineStart = lineOffsets[lineIndex] ?? 0;
                      let partOffset = 0;

                      return (
                        <p key={line.lineIndex} className="mb-6 indent-8">
                          {line.parts.map((part) => {
                            const start = lineStart + partOffset;
                            const end = start + part.text.length;
                            partOffset = end - lineStart;
                            const isHighlighted =
                              highlightRange.start >= 0 &&
                              highlightRange.end >= 0 &&
                              start < highlightRange.end &&
                              end > highlightRange.start;

                            return part.isEnglishWord ? (
                              <span
                                key={part.key}
                                data-char-start={start}
                                data-char-end={end}
                                data-tts-hl={isHighlighted ? "true" : undefined}
                                className={`cursor-pointer rounded-sm transition-colors px-0.5 ${
                                  isHighlighted
                                    ? "bg-yellow-200 text-gray-900"
                                    : "hover:bg-yellow-200 hover:text-blue-700"
                                }`}
                                onClick={() => onWordClick?.(part.text)}
                              >
                                {part.text}
                              </span>
                            ) : (
                              <span
                                key={part.key}
                                data-char-start={start}
                                data-char-end={end}
                                data-tts-hl={isHighlighted ? "true" : undefined}
                                className={isHighlighted ? "bg-yellow-100 rounded-sm" : undefined}
                              >
                                {part.text}
                              </span>
                            );
                          })}
                        </p>
                      );
                    })}
              </div>
            </div>
          </div>

          <div className="absolute bottom-2 right-4 text-xs text-gray-300 font-mono">
            {innerPage + 1} / {innerTotalPages}
          </div>
        </div>
      </div>

      <div className="flex-none flex items-center justify-center gap-4 py-3 bg-gray-50 border-t-0 z-10 w-full mb-2">
        <div className="bg-white/80 backdrop-blur-md shadow-sm border border-gray-200 rounded-full px-2 py-1 flex items-center gap-2">
          {isJapaneseBook && (
            <>
              <button
                onClick={() => setShowFurigana((prev) => !prev)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                  showFurigana
                    ? "bg-sky-50 text-sky-700 border border-sky-200"
                    : "text-gray-500 hover:bg-gray-100"
                }`}
                title={showFurigana ? "关闭假名标注" : "显示假名标注"}
              >
                假名
              </button>
              <div className="w-px h-4 bg-gray-200"></div>
            </>
          )}

          <select
            value={tts.voice}
            onChange={(e) => tts.setVoice(e.target.value as any)}
            className="text-xs bg-transparent border border-gray-200/60 rounded-full px-2 py-1 text-gray-500 hover:text-gray-700 hover:border-gray-300 cursor-pointer focus:outline-none transition-colors"
            title="选择朗读语音"
          >
            {tts.voices.map((voiceOption) => (
              <option key={voiceOption.id} value={voiceOption.id}>
                {voiceOption.label}
              </option>
            ))}
          </select>

          <select
            value={tts.speed}
            onChange={(e) => tts.setSpeed(Number(e.target.value))}
            className="text-xs bg-transparent border border-gray-200/60 rounded-full px-2 py-1 text-gray-500 hover:text-gray-700 hover:border-gray-300 cursor-pointer focus:outline-none transition-colors"
            title="调整朗读速度"
          >
            {SPEED_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          {!tts.isPlaying && !tts.isPaused ? (
            <div className="flex items-center gap-1">
              <button
                onClick={handlePlay}
                className="px-4 py-1.5 rounded-full text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-all"
                title="从当前页面开始朗读（自动翻页）"
              >
                朗读
              </button>
              <button
                onClick={() => {
                  updateVisibleOffsets();
                  requestAnimationFrame(() => {
                    tts.playCurrentPage();
                  });
                }}
                className="px-4 py-1.5 rounded-full text-sm font-medium text-blue-600 hover:bg-blue-50 transition-all"
                title="只朗读当前页面，读完后停止"
              >
                本页
              </button>
            </div>
          ) : (
            <>
              {tts.isPlaying ? (
                <button
                  onClick={tts.pause}
                  className="px-4 py-1.5 rounded-full text-sm font-medium text-amber-600 hover:bg-amber-50 transition-all"
                  title="暂停朗读"
                >
                  暂停
                </button>
              ) : (
                <button
                  onClick={tts.resume}
                  className="px-4 py-1.5 rounded-full text-sm font-medium text-green-600 hover:bg-green-50 transition-all"
                  title="继续朗读"
                >
                  继续
                </button>
              )}
              <button
                onClick={tts.stop}
                className="px-4 py-1.5 rounded-full text-sm font-medium text-gray-500 hover:bg-red-50 hover:text-red-500 transition-all"
                title="停止朗读"
              >
                停止
              </button>
            </>
          )}

          <div className="w-px h-4 bg-gray-200"></div>

          <button
            onClick={handlePrev}
            disabled={pageNumber <= 1 && innerPage === 0}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all ${
              pageNumber <= 1 && innerPage === 0
                ? "text-gray-300 cursor-not-allowed"
                : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            }`}
          >
            ← 上一页
          </button>

          <div className="w-px h-4 bg-gray-200"></div>

          <div className="px-2 text-xs font-semibold text-gray-400 tabular-nums flex gap-1">
            <span>第 {pageNumber} 章</span>
            <span className="opacity-50">·</span>
            <span>{Math.round(((innerPage + 1) / innerTotalPages) * 100)}%</span>
            <span className="opacity-50">·</span>
            <span className="inline-flex min-w-[13em] justify-start">
              {tts.isPlaying || tts.isPaused ? (
                <>
                  <span>{tts.isPaused ? "已暂停" : "正在朗读"}</span>
                  <span className="ml-1.5 text-gray-300">
                    <TTSLoadingDots active={tts.provider === "qwen3" && tts.isGenerating} />
                  </span>
                </>
              ) : (
                <span className="inline-flex items-center">
                  <span className="opacity-0">正在朗读</span>
                  <span className="ml-1.5 text-gray-300 opacity-0">
                    <TTSLoadingDots active />
                  </span>
                </span>
              )}
            </span>
          </div>

          <div className="w-px h-4 bg-gray-200"></div>

          <button
            onClick={handleNext}
            disabled={pageNumber >= totalPages && innerPage >= innerTotalPages - 1}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all ${
              pageNumber >= totalPages && innerPage >= innerTotalPages - 1
                ? "text-gray-300 cursor-not-allowed"
                : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            }`}
          >
            下一页 →
          </button>
        </div>
      </div>
    </div>
  );
}
