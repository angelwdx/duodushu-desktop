"use client";

import { useMemo, useEffect } from 'react';

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

  if (!textContent) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        <p>正在加载内容...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-gray-50">
      {/* 主内容区 - 关键修复：添加 min-h-0 允许子容器正确触发滚动 */}
      <div className="flex-1 overflow-y-auto min-h-0 flex justify-center p-4 md:p-8">
        <div className="max-w-4xl w-full bg-white shadow-xl rounded-2xl p-8 md:p-16 h-fit my-4 border border-gray-100">
          <div className="prose prose-slate prose-lg max-w-none font-serif leading-loose text-gray-800">
            {segments.map((line, lineIndex) => (
              <p key={lineIndex} className="mb-6 last:mb-0">
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
          
          {/* 辅助底部分页占位，确保滚动到底部时有呼吸感 */}
          <div className="h-16"></div>
        </div>
      </div>

      {/* 分页导航 - 确保 shrink-0 不被压缩 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 py-4 bg-white/80 backdrop-blur-md border-t shrink-0 z-10">
          <button
            onClick={handlePrevPage}
            disabled={pageNumber <= 1}
            className={`px-5 py-2 rounded-full font-medium transition-all shadow-sm ${
              pageNumber <= 1
                ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                : "bg-white border border-gray-200 hover:border-gray-400 text-gray-700 hover:shadow-md active:scale-95"
            }`}
          >
            ← 上一页
          </button>
          <div className="px-4 py-2 bg-gray-100 rounded-full text-gray-600 text-sm font-semibold tabular-nums min-w-[80px] text-center">
            {pageNumber} / {totalPages}
          </div>
          <button
            onClick={handleNextPage}
            disabled={pageNumber >= totalPages}
            className={`px-5 py-2 rounded-full font-medium transition-all shadow-sm ${
              pageNumber >= totalPages
                ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                : "bg-white border border-gray-200 hover:border-gray-400 text-gray-700 hover:shadow-md active:scale-95"
            }`}
          >
            下一页 →
          </button>
        </div>
      )}
    </div>
  );
}
