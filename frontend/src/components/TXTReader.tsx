"use client";

import { useMemo, useEffect, useState, useRef, useCallback } from 'react';
import { useFullTextTTS } from "../hooks/useFullTextTTS";
import TTSLoadingDots from "./TTSLoadingDots";
import { preprocessTTSPlainText } from "../lib/ttsText";

interface TXTReaderProps {
  textContent?: string;
  pageNumber?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
  onWordClick?: (word: string, context?: string) => void;
}

export default function TXTReader({
  textContent,
  pageNumber = 1,
  totalPages = 1,
  onPageChange,
  onWordClick,
}: TXTReaderProps) {
  const SPEED_OPTIONS = [
    { value: 1, label: '1.0x' },
    { value: 1.1, label: '1.1x' },
    { value: 1.2, label: '1.2x' },
    { value: 1.3, label: '1.3x' },
    { value: 1.4, label: '1.4x' },
    { value: 1.5, label: '1.5x' },
  ] as const;

  const rawLines = useMemo(() => textContent?.split('\n') ?? [], [textContent]);
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

  // 将文本分割为段落和可点击的英文单词
  const segments = useMemo(() => {
    if (!textContent) return [];

    // 按换行分割段落，保持原始结构
    const lines = textContent.split('\n');
    
    return lines.map((line, lineIndex) => {
      // 将每行文本分割为：英文单词 和 其他内容（中文、标点、空格等）
      const parts = line.split(/(\b[a-zA-ZÀ-ÿ]+(?:'[a-zA-Z]+)?\b)/g).filter(Boolean);
      
      return {
        lineIndex,
        parts: parts.map((part, partIndex) => ({
          text: part,
          isEnglishWord: /^[a-zA-ZÀ-ÿ]+(?:'[a-zA-Z]+)?$/.test(part),
          key: `${lineIndex}-${partIndex}`,
        })),
      };
    }).filter(s => s.parts.length > 0 || textContent.includes('\n\n')); 
    // 过滤掉完全空的行，除非是双换行意图，但标准小说通常每行都有内容或空格
  }, [textContent]);

  // 调试日志
  useEffect(() => {
    console.log('[TXTReader] textContent length:', textContent?.length || 0);
    console.log('[TXTReader] segments count:', segments.length);
    console.log('[TXTReader] page:', pageNumber, '/', totalPages);
  }, [textContent, segments.length, pageNumber, totalPages]);

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

  // 内部状态：当前显示的是第几屏（从 0 开始）
  const [innerPage, setInnerPage] = useState(0);
  const [innerTotalPages, setInnerTotalPages] = useState(1);
  const [visibleStartOffset, setVisibleStartOffset] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const readStartOffset = visibleStartOffset;

  // 当内容或窗口大小变化时，重新计算内部页数
  useEffect(() => {
    const calcPages = () => {
      if (contentRef.current) {
        const { scrollWidth, clientWidth } = contentRef.current;
        const pages = Math.ceil(scrollWidth / (clientWidth + 40)); // +40 for column gap buffer
        setInnerTotalPages(Math.max(1, pages));
        
        // 如果当前页超出了新的总页数，重置到最后一页
        // 注意：如果是新加载的内容（textContent 变化），通常重置为 0
        // 这里需要区分是 resize 还是 content change。简单起见，reset 到 0 已经在下方 effect 处理
      }
    };

    // 初始计算
    // 延迟一点以确保 layout 稳定
    const timer = setTimeout(calcPages, 100);
    window.addEventListener('resize', calcPages);
    
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', calcPages);
    };
  }, [textContent, segments]);

  // 当外部内容变化时，重置回第一屏
  useEffect(() => {
    setInnerPage(0);
  }, [textContent]);

  const handlePrev = () => {
    if (innerPage > 0) {
      setInnerPage(innerPage - 1);
    } else {
      // 已经是第一屏，尝试翻到上一章
      handlePrevPage();
    }
  };

  const handleNext = () => {
    if (innerPage < innerTotalPages - 1) {
      setInnerPage(innerPage + 1);
    } else {
      // 已经是最后一屏，尝试翻到下一章
      handleNextPage();
    }
  };
  // 动态计算可用高度和宽度，避免 CSS column 截断问题
  const [contentHeight, setContentHeight] = useState<number>(500);
  const [colWidth, setColWidth] = useState<number>(800);

  useEffect(() => {
    const updateLayout = () => {
      // 1. 计算合适的高度
      const h = window.innerHeight - 180; 
      setContentHeight(Math.max(300, h));

      // 2. 计算合适的列宽 (必须是像素值，不能是百分比)
      if (contentRef.current) {
         setColWidth(contentRef.current.clientWidth);
      } else {
         // Fallback
         setColWidth(window.innerWidth - 80); 
      }
    };
    
    // 延时执行确保 DOM 渲染
    const timer = setTimeout(updateLayout, 100);
    window.addEventListener('resize', updateLayout);
    
    return () => {
      window.removeEventListener('resize', updateLayout);
      clearTimeout(timer);
    };
  }, []);

  const updateVisibleOffsets = useCallback(() => {
    if (!contentRef.current || !viewportRef.current) return { start: 0, end: null as number | null };
    const viewportRect = viewportRef.current.getBoundingClientRect();
    const nodes = Array.from(contentRef.current.querySelectorAll<HTMLElement>('[data-char-start]'));
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

      const nodeStart = Number(node.dataset.charStart ?? '-1');
      const nodeEnd = Number(node.dataset.charEnd ?? '-1');
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
    window.addEventListener('resize', updateVisibleOffsets);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', updateVisibleOffsets);
    };
  }, [innerPage, textContent, colWidth, contentHeight, updateVisibleOffsets]);

  const getPageText = () => {
    if (!textContent?.trim()) return "";
    if (visibleStartOffset <= 0) return preprocessTTSPlainText(textContent);
    return preprocessTTSPlainText(fullText.slice(visibleStartOffset));
  };

  const tts = useFullTextTTS({
    getPageText,
    totalPages,
    currentPage: pageNumber,
    onPageChange: (page) => {
      setInnerPage(0);
      onPageChange?.(page);
    },
    pageChangeDelay: 250,
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
    const el = document.querySelector('[data-tts-hl="true"]');
    el?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }, [tts.currentChunkText, tts.isPlaying]);

  const handlePlay = useCallback(() => {
    updateVisibleOffsets();
    requestAnimationFrame(() => {
      tts.play();
    });
  }, [tts, updateVisibleOffsets]);

  return (
    <div className="h-full w-full flex flex-col bg-gray-50 overflow-hidden relative">
      {/* 主体区域 */}
      <div className="flex-1 w-full flex flex-col overflow-hidden p-4 sm:p-6 pb-2 items-center justify-center">
        {/* 白纸卡片 */}
        <div 
          className="max-w-4xl mx-auto w-full bg-white shadow-xl rounded-xl border border-gray-100 flex flex-col overflow-hidden relative"
          style={{ height: contentHeight }} 
        >
          
          <div ref={viewportRef} className="flex-1 relative overflow-hidden">
            <div 
              ref={contentRef}
              className="absolute top-10 bottom-24 left-10 right-10 transition-transform duration-300 ease-out"
              style={{
                columnWidth: `${colWidth}px`, // 修复：必须是精确像素值
                // height 由 top/bottom class 决定
                columnGap: '5rem', 
                columnFill: 'auto',
                width: 'auto', 
                transform: `translateX(-${innerPage * (colWidth + 80)}px)`, // 80 = 5rem gap
              }}
            >
              <div className="prose prose-slate prose-lg max-w-none font-serif leading-loose text-gray-800 text-justify">
                {segments.map((line, lineIndex) => (
                  <p key={lineIndex} className="mb-6 indent-8">
                    {(() => {
                      const lineStart = lineOffsets[lineIndex] ?? 0;
                      let partOffset = 0;

                      return line.parts.map((part) => {
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
                          data-tts-hl={isHighlighted ? 'true' : undefined}
                          className={`cursor-pointer rounded-sm transition-colors px-0.5 ${
                            isHighlighted
                              ? 'bg-yellow-200 text-gray-900'
                              : 'hover:bg-yellow-200 hover:text-blue-700'
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
                          data-tts-hl={isHighlighted ? 'true' : undefined}
                          className={isHighlighted ? 'bg-yellow-100 rounded-sm' : undefined}
                        >
                          {part.text}
                        </span>
                      );
                      });
                    })()}
                  </p>
                ))}
              </div>
            </div>
          </div>
          
          {/* 底部页码信息 */}
          <div className="absolute bottom-2 right-4 text-xs text-gray-300 font-mono">
             {innerPage + 1} / {innerTotalPages}
          </div>
        </div>
      </div>

      {/* 统一分页控制栏 - 融合了内部翻页和外部翻页 */}
      <div className="flex-none flex items-center justify-center gap-4 py-3 bg-gray-50 border-t-0 z-10 w-full mb-2">
        <div className="bg-white/80 backdrop-blur-md shadow-sm border border-gray-200 rounded-full px-2 py-1 flex items-center gap-2">
          <select
            value={tts.voice}
            onChange={(e) => tts.setVoice(e.target.value as any)}
            className="text-xs bg-transparent border border-gray-200/60 rounded-full px-2 py-1 text-gray-500 hover:text-gray-700 hover:border-gray-300 cursor-pointer focus:outline-none transition-colors"
            title="选择朗读语音"
          >
            {tts.voices.map(v => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>

          <select
            value={tts.speed}
            onChange={(e) => tts.setSpeed(Number(e.target.value))}
            className="text-xs bg-transparent border border-gray-200/60 rounded-full px-2 py-1 text-gray-500 hover:text-gray-700 hover:border-gray-300 cursor-pointer focus:outline-none transition-colors"
            title="调整朗读速度"
          >
            {SPEED_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>

          {!tts.isPlaying && !tts.isPaused ? (
            <button
              onClick={handlePlay}
              className="px-4 py-1.5 rounded-full text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-all"
              title="从当前页面开始朗读"
            >
              朗读
            </button>
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
          
          {/* 显示总体进度 */}
          <div className="px-2 text-xs font-semibold text-gray-400 tabular-nums flex gap-1">
             <span>第 {pageNumber} 章</span>
             <span className="opacity-50">·</span>
             <span>{Math.round(((innerPage + 1) / innerTotalPages) * 100)}%</span>
             <span className="opacity-50">·</span>
             <span className="inline-flex min-w-[13em] justify-start">
               {(tts.isPlaying || tts.isPaused) ? (
                 <>
                   <span>{tts.isPaused ? '已暂停' : '正在朗读'}</span>
                   <span className="ml-1.5 text-gray-300">
                     <TTSLoadingDots active={tts.provider === 'qwen3' && tts.isGenerating} />
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
