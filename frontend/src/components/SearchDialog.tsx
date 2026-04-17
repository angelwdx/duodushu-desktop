"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { searchContent, SearchBookResult, SearchPageResult } from "../lib/api";

interface SearchDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/** 将 snippet 中的 <mark>...</mark> 渲染为高亮 span */
function SnippetHTML({ html }: { html: string }) {
  // 简单安全处理：只允许 <mark> 标签
  const safe = html
    .replace(/</g, "&lt;")
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>")
    // FTS5 返回的已经是字面 <mark>...</mark>
    .replace(/&lt;mark>/g, "<mark>")
    .replace(/&lt;\/mark>/g, "</mark>");
  return (
    <span
      className="text-gray-500 text-xs leading-relaxed"
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

export default function SearchDialog({ isOpen, onClose }: SearchDialogProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [books, setBooks] = useState<SearchBookResult[]>([]);
  const [pages, setPages] = useState<SearchPageResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // 聚焦输入框
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery("");
      setBooks([]);
      setPages([]);
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // Debounced 搜索
  const doSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setBooks([]);
      setPages([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await searchContent(trimmed, 15);
      setBooks(result.books);
      setPages(result.pages);
      setSelectedIndex(0);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(query), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, doSearch]);

  // 所有结果条目（用于键盘导航）
  const allItems: Array<{ type: "book"; data: SearchBookResult } | { type: "page"; data: SearchPageResult }> = [
    ...books.map((b) => ({ type: "book" as const, data: b })),
    ...pages.map((p) => ({ type: "page" as const, data: p })),
  ];

  const handleSelect = useCallback((item: typeof allItems[number]) => {
    onClose();
    if (item.type === "book") {
      router.push(`/read?id=${item.data.id}`);
    } else {
      const p = item.data;
      router.push(
        `/read?id=${p.book_id}&page=${p.page_number}&word=${encodeURIComponent(query.trim())}`
      );
    }
  }, [onClose, router, query]);

  // 键盘导航
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, allItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && allItems[selectedIndex]) {
      e.preventDefault();
      handleSelect(allItems[selectedIndex]);
    }
  };

  if (!isOpen) return null;

  const hasResults = books.length > 0 || pages.length > 0;
  const showEmpty = query.trim().length > 0 && !loading && !hasResults;

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden flex flex-col"
        style={{ maxHeight: "70vh" }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* 搜索输入框 */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
          {loading ? (
            <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin shrink-0" />
          ) : (
            <svg className="w-5 h-5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          )}
          <input
            ref={inputRef}
            type="text"
            placeholder="搜索书名或书中内容..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 text-base text-gray-900 outline-none placeholder-gray-400 bg-transparent"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="text-gray-400 hover:text-gray-600 shrink-0"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          <kbd className="hidden sm:inline-flex items-center px-2 py-1 text-xs text-gray-400 bg-gray-100 rounded-md shrink-0">Esc</kbd>
        </div>

        {/* 结果列表 */}
        <div className="overflow-y-auto flex-1">
          {!query.trim() && (
            <div className="py-12 text-center text-gray-400 text-sm">
              <svg className="w-10 h-10 mx-auto mb-3 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              输入关键词搜索书名或书中内容
            </div>
          )}

          {showEmpty && (
            <div className="py-12 text-center text-gray-400 text-sm">
              未找到「{query}」相关结果
            </div>
          )}

          {/* 书名匹配 */}
          {books.length > 0 && (
            <div>
              <div className="px-5 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide bg-gray-50 border-b border-gray-100">
                书籍
              </div>
              {books.map((book, i) => {
                const isSelected = selectedIndex === i;
                return (
                  <button
                    key={book.id}
                    className={`w-full text-left flex items-center gap-3 px-5 py-3 transition-colors ${
                      isSelected ? "bg-blue-50" : "hover:bg-gray-50"
                    }`}
                    onClick={() => handleSelect({ type: "book", data: book })}
                    onMouseEnter={() => setSelectedIndex(i)}
                  >
                    <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center shrink-0 text-xs font-bold text-gray-500 uppercase">
                      {book.format.slice(0, 3)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900 truncate">{book.title}</div>
                      {book.author && <div className="text-xs text-gray-500 truncate">{book.author}</div>}
                    </div>
                    <svg className="w-4 h-4 text-gray-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                );
              })}
            </div>
          )}

          {/* 书内内容匹配 */}
          {pages.length > 0 && (
            <div>
              <div className="px-5 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide bg-gray-50 border-b border-gray-100">
                书中内容
              </div>
              {pages.map((page, i) => {
                const globalIdx = books.length + i;
                const isSelected = selectedIndex === globalIdx;
                return (
                  <button
                    key={`${page.book_id}-${page.page_number}-${i}`}
                    className={`w-full text-left flex items-start gap-3 px-5 py-3 transition-colors ${
                      isSelected ? "bg-blue-50" : "hover:bg-gray-50"
                    }`}
                    onClick={() => handleSelect({ type: "page", data: page })}
                    onMouseEnter={() => setSelectedIndex(globalIdx)}
                  >
                    <div className="shrink-0 mt-0.5">
                      <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-gray-800 truncate">{page.book_title}</span>
                        <span className="text-xs text-gray-400 shrink-0">第 {page.page_number} 页</span>
                      </div>
                      <SnippetHTML html={page.snippet} />
                    </div>
                    <svg className="w-4 h-4 text-gray-300 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer 提示 */}
        {hasResults && (
          <div className="px-5 py-2.5 border-t border-gray-100 flex items-center gap-4 text-xs text-gray-400">
            <span><kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-500">↑↓</kbd> 导航</span>
            <span><kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-500">↵</kbd> 打开</span>
            <span><kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-500">Esc</kbd> 关闭</span>
            <span className="ml-auto">{books.length + pages.length} 个结果</span>
          </div>
        )}
      </div>

      <style jsx>{`
        mark {
          background-color: #fef08a;
          color: inherit;
          border-radius: 2px;
          padding: 0 1px;
        }
      `}</style>
    </div>
  );
}
