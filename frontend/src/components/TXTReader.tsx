"use client";

import { useMemo, useEffect, useState, useRef } from 'react';

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
  const contentRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="h-full w-full flex flex-col bg-gray-50 overflow-hidden relative">
      {/* 主体区域 */}
      <div className="flex-1 w-full flex flex-col overflow-hidden p-4 sm:p-6 pb-2 items-center justify-center">
        {/* 白纸卡片 */}
        <div 
          className="max-w-4xl mx-auto w-full bg-white shadow-xl rounded-xl border border-gray-100 flex flex-col overflow-hidden relative"
          style={{ height: contentHeight }} 
        >
          
          <div className="flex-1 relative overflow-hidden">
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
                    {line.parts.map((part) => (
                      part.isEnglishWord ? (
                        <span
                          key={part.key}
                          className="cursor-pointer hover:bg-yellow-200 hover:text-blue-700 rounded-sm transition-colors px-0.5"
                          onClick={() => onWordClick?.(part.text)}
                        >
                          {part.text}
                        </span>
                      ) : (
                        <span key={part.key}>{part.text}</span>
                      )
                    ))}
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
