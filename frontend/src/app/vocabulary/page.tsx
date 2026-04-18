"use client";

import React, { useEffect, useState, useRef } from "react";
import { createLogger } from "../../lib/logger";
import {
  getVocabulary,
  deleteVocabulary,
  getHighPriorityWords,
  exportVocabulary,
  exportVocabularyAnki,
} from "../../lib/api";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon, BookIcon } from "../../components/Icons";

const log = createLogger("VocabularyPage");

interface VocabularyItem {
  id: number;
  word: string;
  phonetic?: string;
  definition?: any;
  translation?: string;
  primary_context?: {
    book_id?: string;
    book_title?: string;
    page_number?: number;
    context_sentence?: string;
  };
  example_contexts: Array<{
    book_id: string;
    book_title?: string;
    book_type?: string;
    page_number: number;
    context_sentence: string;
  }>;
  review_count: number;
  query_count: number; // 新增
  mastery_level: number;
  difficulty_score: number;
  priority_score: number; // 新增
  learning_status: string; // 新增
  created_at: string;
  last_queried_at?: string; // 新增
}

  export default function VocabularyPage() {
  const router = useRouter();
  const [vocab, setVocab] = useState<VocabularyItem[]>([]);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<
    | "newest"
    | "alphabetical"
    | "review_count"
    | "query_count"
    | "priority_score"
  >("newest");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  // 新增：高优先级单词状态
  const [highPriorityWords, setHighPriorityWords] = useState<any[]>([]);
  const [showReminder, setShowReminder] = useState(true);
  const [reminderDismissed, setReminderDismissed] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isExportingAnki, setIsExportingAnki] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 监听来自 GlobalMenuHandler 的快捷键事件
  useEffect(() => {
    const handleSearchFocus = () => {
      if (searchInputRef.current) {
        searchInputRef.current.focus();
        searchInputRef.current.select();
      }
    };
    window.addEventListener('app-search-focus', handleSearchFocus);
    return () => window.removeEventListener('app-search-focus', handleSearchFocus);
  }, []);

  useEffect(() => {
    // 新增：加载高优先级单词
    const loadHighPriorityWords = async () => {
      try {
        // 检查本地存储中是否已关闭提醒
        let dismissedUntil: string | null = null;
        try {
          dismissedUntil = localStorage.getItem("reminder_dismissed_until");
        } catch (e) {
          // localStorage 不可用（隐私模式等）
          log.warn('localStorage not available:', e);
        }
        if (dismissedUntil && Date.now() < parseInt(dismissedUntil)) {
          setShowReminder(false);
          return;
        }

        const data = await getHighPriorityWords(70, 5);
        setHighPriorityWords(data.words);

        // 只有存在高优先级单词且未关闭提醒时才显示
        if (data.words.length > 0 && !reminderDismissed) {
          setShowReminder(true);
        } else {
          setShowReminder(false);
        }
      } catch (e) {
        log.error("Failed to load high priority words:", e);
      }
    };

    loadHighPriorityWords();
  }, [page, sortBy, reminderDismissed]);

  const loadVocab = React.useCallback(async () => {
    try {
      const data = await getVocabulary(
        undefined,
        page,
        30,
        "all",
        searchQuery || undefined,
        sortBy,
      );
      // 后端返回 {items, total}；兼容旧版纯数组格式
      const items = Array.isArray(data) ? data : (data.items || []);
      const total = Array.isArray(data) ? data.length : (data.total ?? data.length ?? 0);
      setVocab(items);
      setTotal(total);
    } catch (e) {
      log.error("Failed to load vocabulary:", e);
    }
  }, [page, sortBy, searchQuery]);

  useEffect(() => {
    loadVocab();
  }, [loadVocab]);

  const handleDelete = async (id: number) => {
    const numId = Number(id);
    setVocab((prev) => prev.filter((item) => item.id !== numId));

    try {
      await deleteVocabulary(numId);
    } catch (e) {
      log.error("Delete failed:", e);
      alert("删除失败，重新加载...");
      loadVocab();
    }
  };

  const startReview = () => {
    router.push("/vocabulary/review");
  };

  const handleExport = async () => {
    if (isExporting) return;
    try {
      setIsExporting(true);
      await exportVocabulary();
    } catch (e) {
      log.error("Export failed:", e);
      alert("导出失败，请重试。");
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportAnki = async () => {
    if (isExportingAnki) return;
    try {
      setIsExportingAnki(true);
      await exportVocabularyAnki();
    } catch (e) {
      log.error("Anki export failed:", e);
      alert("导出失败，请重试。");
    } finally {
      setIsExportingAnki(false);
    }
  };

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* 顶部导航 */}
      <header className="border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="text-gray-600 hover:text-gray-900 flex items-center gap-1.5 transition-colors"
          >
            <ArrowLeftIcon className="w-4 h-4" />
            返回图书馆
          </Link>
          <h1 className="font-bold text-gray-900">生词本</h1>
        </div>
         <div className="flex items-center gap-3">
           <span className="text-sm text-gray-500">共 {total} 个生词</span>
           <button
             onClick={() => router.push("/vocabulary/learn")}
             className="px-4 py-2 bg-white text-gray-900 border border-gray-200 hover:border-gray-900 hover:bg-gray-50 rounded-lg font-medium transition-all text-sm"
           >
             开始学习
           </button>
           <button
             onClick={startReview}
             className="px-4 py-2 bg-white text-gray-900 border border-gray-200 hover:border-gray-900 hover:bg-gray-50 rounded-lg font-medium transition-all text-sm"
           >
             开始复习
           </button>
           <button
             onClick={handleExport}
             disabled={isExporting || total === 0}
             className="px-4 py-2 bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 rounded-lg font-medium transition-all text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
           >
             {isExporting ? (
               <>
                 <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                   <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                   <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                 </svg>
                 导出中...
               </>
             ) : (
               <>
                 <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                 </svg>
                 导出库(CSV)
               </>
             )}
           </button>
           <button
             onClick={handleExportAnki}
             disabled={isExportingAnki || total === 0}
             className="px-4 py-2 bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100 rounded-lg font-medium transition-all text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
           >
             {isExportingAnki ? (
               <>
                 <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                   <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                   <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                 </svg>
                 导出中...
               </>
             ) : (
               <>
                 <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                 </svg>
                 导出到 Anki
               </>
             )}
           </button>
         </div>
      </header>

      {/* 智能提醒（低调样式） */}
      {showReminder && highPriorityWords.length > 0 && (
        <div className="border-b border-gray-100 px-4 py-2 bg-gray-50/50">
          <div className="max-w-7xl mx-auto flex items-center justify-between text-sm">
            <div className="flex items-center gap-2 text-gray-500">
              <span>💡</span>
              <span>
                有{" "}
                <span className="text-gray-700 font-medium">
                  {highPriorityWords.length}
                </span>{" "}
                个单词建议复习：
              </span>
              <div className="flex items-center gap-1.5">
                {highPriorityWords.slice(0, 3).map((word) => (
                  <span
                    key={word.id}
                    className="text-gray-600 bg-white border border-gray-200 rounded px-1.5 py-0.5 text-xs"
                  >
                    {word.word}
                  </span>
                ))}
                {highPriorityWords.length > 3 && (
                  <span className="text-gray-400 text-xs">
                    +{highPriorityWords.length - 3}
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setSortBy("priority_score");
                  setShowReminder(false);
                }}
                className="text-gray-500 hover:text-gray-700 text-xs underline"
              >
                查看
              </button>
              <button
                onClick={() => {
                  setShowReminder(false);
                  setReminderDismissed(true);
                  try {
                    localStorage.setItem(
                      "reminder_dismissed_until",
                      String(Date.now() + 24 * 60 * 60 * 1000),
                    );
                  } catch (e) {
                    log.warn('Failed to save reminder state to localStorage:', e);
                  }
                }}
                className="text-gray-400 hover:text-gray-600"
                title="关闭提醒"
              >
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 工具栏 */}
      <div className="border-b border-gray-200 px-4 py-3">
        <div className="flex flex-wrap items-center gap-4">
          {/* 搜索框 */}
          <input
            ref={searchInputRef}
            type="text"
            placeholder="搜索单词..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg w-64 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-400"
          />

          {/* 排序 */}
          <select
            title="排序方式"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 bg-white focus:outline-none focus:border-gray-400"
          >
            <option value="newest">最新添加</option>
            <option value="priority_score">推荐学习顺序 ⭐</option>
            <option value="query_count">查询次数最多</option>
            <option value="review_count">复习次数</option>
            <option value="alphabetical">按字母排序</option>
          </select>

          {/* 视图切换 */}
          <div className="flex items-center border border-gray-300 rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode("list")}
              className={`px-4 py-2 text-sm transition-all ${
                viewMode === "list"
                  ? "bg-gray-100 text-gray-900"
                  : "bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              列表
            </button>
            <button
              onClick={() => setViewMode("grid")}
              className={`px-4 py-2 text-sm transition-all ${
                viewMode === "grid"
                  ? "bg-gray-100 text-gray-900"
                  : "bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              网格
            </button>
          </div>
        </div>
      </div>

      {/* 主内容区 */}
      <main className="flex-1 p-4">
        {vocab.length === 0 ? (
          <div className="text-center py-10 text-gray-400">
            暂无生词，去读书吧！
          </div>
        ) : viewMode === "list" ? (
          <VocabListView vocab={vocab} onDelete={handleDelete} />
        ) : (
          <VocabGridView vocab={vocab} onDelete={handleDelete} />
        )}
      </main>

      {/* 分页 */}
      <div className="border-t border-gray-200 px-4 py-3">
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed text-sm text-gray-700"
          >
            上一页
          </button>
          <span className="text-sm text-gray-600">第 {page} 页</span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={page * 30 >= total}
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed text-sm text-gray-700"
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}

// 列表视图
function VocabListView({
  vocab,
  onDelete,
}: {
  vocab: VocabularyItem[];
  onDelete: (id: number) => void;
}) {
  const router = useRouter();
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-200">
            <th className="pb-3 text-left text-sm font-medium text-gray-600">
              单词
            </th>
            <th className="pb-3 text-left text-sm font-medium text-gray-600">
              释义
            </th>
            <th className="pb-3 text-left text-sm font-medium text-gray-600">
              来源
            </th>

            <th className="pb-3 text-left text-sm font-medium text-gray-600">
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          {vocab.map((item) => (
            <tr
              key={item.id}
              className="border-b border-gray-100 hover:bg-gray-50 transition-colors"
            >
              <td className="py-4">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-gray-900">
                    {item.word}
                  </span>
                  {item.phonetic && (
                    <span className="text-xs text-gray-400 font-mono bg-gray-100 px-1.5 py-0.5 rounded border border-gray-200">
                      /{item.phonetic}/
                    </span>
                  )}
                </div>
              </td>

              <td className="py-4">
                <p className="text-sm text-gray-800 max-w-xs line-clamp-2">
                  {item.translation ||
                    item.definition?.meanings?.[0]?.definition ||
                    "暂无定义"}
                </p>
              </td>

              <td className="py-4">
                <div className="text-sm text-gray-600">
                  <div>{item.primary_context?.book_title || "未知来源"}</div>
                  {!!item.primary_context?.page_number && (
                    <div className="text-xs text-gray-400">
                      第{item.primary_context.page_number}页
                    </div>
                  )}
                </div>
              </td>



              <td className="py-4">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => router.push(`/vocabulary/detail?id=${item.id}`)}
                    className="px-3 py-1.5 text-sm border border-gray-300 text-gray-700 rounded hover:bg-gray-50 transition-all"
                  >
                    查看详情
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(item.id);
                    }}
                    className="p-1.5 text-gray-400 hover:text-gray-900 transition-colors"
                    title="删除"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 网格视图
function VocabGridView({
  vocab,
  onDelete,
}: {
  vocab: VocabularyItem[];
  onDelete: (id: number) => void;
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {vocab.map((item) => (
        <div
          key={item.id}
          className="border border-gray-200 p-5 rounded-lg relative group hover:border-gray-300 hover:shadow-md transition-all"
        >
          {/* 删除按钮 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(item.id);
            }}
            className="absolute top-3 right-3 text-gray-400 hover:text-gray-900 p-1.5 rounded-lg hover:bg-gray-100 transition-colors opacity-100 md:opacity-0 group-hover:opacity-100"
            title="删除"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>

          <div className="pr-8">
            {/* 单词头部 */}
            <div className="flex items-center flex-wrap gap-2 mb-2">
              <h3 className="text-xl font-bold text-gray-900">{item.word}</h3>
              {item.phonetic && (
                <span className="text-xs text-gray-500 font-mono bg-gray-100 px-1.5 py-0.5 rounded border border-gray-200">
                  /{item.phonetic}/
                </span>
              )}
            </div>

            {/* 释义 */}
            <div className="mb-3">
              <p className="text-sm text-gray-800 line-clamp-2">
                {item.translation ||
                  item.definition?.meanings?.[0]?.definition ||
                  "暂无定义"}
              </p>
            </div>

            {/* 主要上下文 */}
            {item.primary_context && (
              <div className="mb-2">
                <div className="text-xs text-gray-500 mb-1">
                  <BookIcon className="w-3 h-3 inline mr-1" />
                  {item.primary_context.book_title}
                  {!!item.primary_context.page_number &&
                    ` 第${item.primary_context.page_number}页`}
                </div>
                 <p className="text-xs text-gray-600 line-clamp-2 italic bg-gray-50 rounded-r pl-2 py-1 border-l-2 border-gray-300">
                   &ldquo;{item.primary_context.context_sentence}&rdquo;
                 </p>
              </div>
            )}

             {/* 例句数量 */}
             {item.example_contexts.length > 0 && (
               <div className="mt-2">
                 <span className="text-xs text-gray-500">
                   共{item.example_contexts.length}个例句
                 </span>
               </div>
             )}
          </div>
        </div>
      ))}
    </div>
  );
}
