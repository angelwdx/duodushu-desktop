"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { getApiUrl, getBookmarks } from "../lib/api";

interface Bookmark {
  id: number;
  book_id: string;
  page_number: number;
  title: string;
  note?: string;
  created_at: string;
}

interface OutlineItem {
  title: string;
  dest: any;
  pageNumber?: number;
  items?: OutlineItem[];
}

interface LeftSidebarProps {
  bookId: string;
  currentPage: number;
  onPageJump: (pageNumber: number | string) => void;
  onBookmarksChange?: () => void;
  outline?: OutlineItem[];
  totalPages?: number;
  bookmarksRefreshKey?: number;
  width?: number;
  collapsed?: boolean;
  onCollapse?: (collapsed: boolean) => void;
  className?: string;
}

type LeftSidebarMode = 'toc' | 'bookmarks' | 'thumbnails';

export default function LeftSidebar({
  bookId,
  currentPage,
  onPageJump,
  onBookmarksChange,
  outline = [],
  totalPages,
  bookmarksRefreshKey = 0,
  width = 256,
  collapsed = false,
  onCollapse,
  className = "",
}: LeftSidebarProps) {
  const [mode, setMode] = useState<LeftSidebarMode>('toc');
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loadingBookmarks, setLoadingBookmarks] = useState(false);
  const [loadedThumbnails, setLoadedThumbnails] = useState<Set<number>>(new Set());
  const [failedThumbnails, setFailedThumbnails] = useState<Set<number>>(new Set());
  const thumbnailsContainerRef = useRef<HTMLDivElement>(null);
  const loadingThumbnailsRef = useRef<Set<number>>(new Set());
  const loadedThumbnailsRef = useRef<Set<number>>(new Set());
  const failedThumbnailsRef = useRef<Set<number>>(new Set());

  const getThumbnailUrl = useCallback(
    (page: number) => `${getApiUrl()}/api/books/thumbnail/${bookId}/${page}`,
    [bookId],
  );

  const loadBookmarks = useCallback(async () => {
    try {
      setLoadingBookmarks(true);
      const data = await getBookmarks(bookId);
      setBookmarks(data);
    } catch (e) {
      console.error("Failed to load bookmarks", e);
    } finally {
      setLoadingBookmarks(false);
    }
  }, [bookId]);

  // Load bookmarks when mode changes or refreshKey changes
  useEffect(() => {
    if (mode === 'bookmarks') {
      loadBookmarks();
    }
  }, [mode, bookId, bookmarksRefreshKey, loadBookmarks]);

  const handleDeleteBookmark = async (bookmarkId: number) => {
    try {
      const { deleteBookmark } = await import("../lib/api");
      await deleteBookmark(bookmarkId);
      await loadBookmarks();
      onBookmarksChange?.();
    } catch (e) {
      console.error("Failed to delete bookmark", e);
      alert("Failed to delete bookmark");
    }
  };

  // Render outline items recursively
  const renderOutlineItems = (items: OutlineItem[], level: number = 0): React.ReactNode => {
    return items.map((item, idx) => (
      <div key={idx}>
        <button
          onClick={() => (item.pageNumber || item.dest) && onPageJump(item.pageNumber || item.dest)}
          disabled={!item.dest && !item.pageNumber}
          className={`w-full text-left px-3 py-2 text-xs rounded hover:bg-gray-100 transition-colors ${
            typeof currentPage === 'number' && item.pageNumber === currentPage ? 'bg-gray-200 text-gray-900 font-medium' : 'text-gray-700'
          }`}
          style={{ paddingLeft: `${8 + level * 16}px` }}
          title={item.pageNumber ? `第 ${item.pageNumber} 页` : undefined}
        >
          <span className="line-clamp-2">{item.title}</span>
          {!!item.pageNumber && (
            <span className="text-gray-400 ml-1">p.{item.pageNumber}</span>
          )}
        </button>
        {item.items && item.items.length > 0 && (
          <div className="mt-0.5">
            {renderOutlineItems(item.items, level + 1)}
          </div>
        )}
      </div>
    ));
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString("zh-CN", {
      month: "short",
      day: "numeric",
    });
  };

  // Keep refs in sync with state
  useEffect(() => {
    loadedThumbnailsRef.current = loadedThumbnails;
  }, [loadedThumbnails]);

  useEffect(() => {
    failedThumbnailsRef.current = failedThumbnails;
  }, [failedThumbnails]);

  // Load a single thumbnail
  const loadThumbnail = useCallback((page: number) => {
    // Use refs for checking to avoid dependency issues
    if (loadedThumbnailsRef.current.has(page) ||
        failedThumbnailsRef.current.has(page) ||
        loadingThumbnailsRef.current.has(page)) {
      return;
    }

    loadingThumbnailsRef.current.add(page);

    const img = new Image();
    const thumbnailUrl = getThumbnailUrl(page);

    img.onload = () => {
      setLoadedThumbnails((prev) => new Set([...prev, page]));
      loadingThumbnailsRef.current.delete(page);
    };

    img.onerror = () => {
      setFailedThumbnails((prev) => new Set([...prev, page]));
      loadingThumbnailsRef.current.delete(page);
    };

    img.src = thumbnailUrl;
  }, [getThumbnailUrl]);

  // Load thumbnails in a range
  const loadThumbnailRange = useCallback((start: number, end: number) => {
    if (!totalPages) return;

    const actualStart = Math.max(1, start);
    const actualEnd = Math.min(totalPages, end);

    for (let page = actualStart; page <= actualEnd; page++) {
      loadThumbnail(page);
    }
  }, [totalPages, loadThumbnail]);

  // Reset loaded thumbnails when mode or book changes
  useEffect(() => {
    if (mode === 'thumbnails') {
      const newLoadedSet = new Set<number>();
      const newFailedSet = new Set<number>();
      setLoadedThumbnails(newLoadedSet);
      setFailedThumbnails(newFailedSet);
      loadedThumbnailsRef.current = newLoadedSet;
      failedThumbnailsRef.current = newFailedSet;
      loadingThumbnailsRef.current = new Set();
      // Load first batch immediately
      loadThumbnailRange(1, Math.min(30, totalPages || 30));
    }
  }, [mode, bookId, totalPages, loadThumbnailRange]);

  // Handle scroll to load more thumbnails with debounce
  useEffect(() => {
    if (mode !== 'thumbnails' || !thumbnailsContainerRef.current || !totalPages) return;

    const container = thumbnailsContainerRef.current;
    const thumbnailHeight = 180; // Single column, taller thumbnails
    const itemsPerRow = 1;
    const rowsVisible = Math.ceil(container.clientHeight / thumbnailHeight);
    const itemsVisible = rowsVisible * itemsPerRow;
    const bufferItems = itemsVisible * 2;

    let scrollTimeout: NodeJS.Timeout | null = null;
    let lastStartPage = -1;
    let lastEndPage = -1;

    const handleScroll = () => {
      if (scrollTimeout) clearTimeout(scrollTimeout);

      scrollTimeout = setTimeout(() => {
        const scrollTop = container.scrollTop;
        const startRow = Math.floor(scrollTop / thumbnailHeight);
        const startPage = Math.max(1, startRow * itemsPerRow - itemsVisible);
        const endPage = Math.min(totalPages, startPage + itemsVisible + bufferItems);

        // Only load if range changed significantly
        if (Math.abs(startPage - lastStartPage) > itemsVisible / 2 ||
            Math.abs(endPage - lastEndPage) > itemsVisible / 2) {
          lastStartPage = startPage;
          lastEndPage = endPage;
          loadThumbnailRange(startPage, endPage);
        }
      }, 50); // 50ms debounce
    };

    // Initial load
    handleScroll();

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      if (scrollTimeout) clearTimeout(scrollTimeout);
      container.removeEventListener('scroll', handleScroll);
    };
  }, [mode, totalPages, loadThumbnailRange]);

  return (
    <div
      className={`shrink-0 z-10 h-full bg-white border-r shadow-lg flex flex-col ${className}`}
      style={collapsed ? {} : { width: `${width}px` }}
    >
      {/* Header with close button */}
      {!collapsed && (
        <div className="p-2 border-b bg-gray-50 flex items-center gap-2">
          <div className="flex gap-1 flex-1">
            <button
              onClick={() => setMode('toc')}
              className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition-all ${
                mode === 'toc'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
              title="目录"
            >
              <svg className="w-4 h-4 mx-auto mb-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
              目录
            </button>
            <button
              onClick={() => setMode('bookmarks')}
              className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition-all ${
                mode === 'bookmarks'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
              title="书签"
            >
              <svg className="w-4 h-4 mx-auto mb-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
              书签
            </button>
            <button
              onClick={() => setMode('thumbnails')}
              className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition-all ${
                mode === 'thumbnails'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
              title="缩略图"
            >
              <svg className="w-4 h-4 mx-auto mb-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              缩略图
            </button>
          </div>
          <button
            onClick={() => onCollapse?.(true)}
            className="p-1.5 hover:bg-gray-200 rounded text-gray-600"
            title="关闭"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Content Area */}
      <div className="flex-1 overflow-hidden">
        {mode === 'toc' && (
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="px-3 py-2 border-b bg-gray-50">
              <h3 className="text-xs font-semibold text-gray-900">目录</h3>
              <p className="text-xs text-gray-500">{outline.length} 项</p>
            </div>

            {/* TOC List */}
            <div className="flex-1 overflow-auto">
              {outline.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-32 text-gray-400 gap-2 px-4 text-center">
                  <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                  </svg>
                  <p className="text-xs">暂无目录</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {renderOutlineItems(outline, 0)}
                </div>
              )}
            </div>
          </div>
        )}

        {mode === 'bookmarks' && (
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="px-3 py-2 border-b bg-gray-50">
              <h3 className="text-xs font-semibold text-gray-900">书签</h3>
              <p className="text-xs text-gray-500">{bookmarks.length} 个</p>
            </div>

            {/* List */}
            <div className="flex-1 overflow-auto">
              {loadingBookmarks ? (
                <div className="flex items-center justify-center h-20 text-gray-400">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-400"></div>
                </div>
              ) : bookmarks.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-32 text-gray-400 gap-2 px-4 text-center">
                  <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                  </svg>
                  <p className="text-xs">暂无书签</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {bookmarks.map((bookmark) => (
                    <div
                      key={bookmark.id}
                      className="p-3 hover:bg-gray-50 transition-colors group"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <button
                          onClick={() => onPageJump(bookmark.page_number)}
                          className="flex-1 text-left hover:text-gray-900"
                        >
                          <h4 className="text-xs font-medium text-gray-900 mb-1 truncate">
                            {bookmark.title}
                          </h4>
                          <div className="flex items-center gap-2 text-xs text-gray-500">
                            <span className="inline-flex items-center gap-1">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                              第 {bookmark.page_number} 页
                            </span>
                            <span>•</span>
                            <span>{formatDate(bookmark.created_at)}</span>
                          </div>
                          {bookmark.note && (
                            <p className="text-xs text-gray-600 mt-1 line-clamp-2">
                              {bookmark.note}
                            </p>
                          )}
                        </button>
                        <button
                          onClick={() => handleDeleteBookmark(bookmark.id)}
                          className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                          title="删除"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {mode === 'thumbnails' && (
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="px-3 py-2 border-b bg-gray-50">
              <h3 className="text-xs font-semibold text-gray-900">页面缩略</h3>
              <p className="text-xs text-gray-500">{totalPages || 0} 页</p>
            </div>

            {/* Page Grid */}
            <div ref={thumbnailsContainerRef} className="flex-1 overflow-auto p-2">
              {totalPages ? (
                <div className="flex flex-col gap-2">
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => {
                    const isLoaded = loadedThumbnails.has(page);
                    const isFailed = failedThumbnails.has(page);
                    const thumbnailUrl = getThumbnailUrl(page);

                    return (
                      <button
                        key={page}
                        onClick={() => onPageJump(page)}
                        className={`
                          w-full aspect-[3/4] rounded-md transition-all
                          flex items-center justify-center border
                          relative overflow-hidden shrink-0
                          ${page === currentPage
                            ? 'ring-2 ring-blue-500 ring-offset-1'
                            : 'hover:ring-1 hover:ring-gray-300'
                          }
                        `}
                        title={`第 ${page} 页`}
                      >
                        { }
                         {isLoaded ? (
                           // eslint-disable-next-line @next/next/no-img-element -- Electron 本地缩略图无需 next/image 优化
                           <img
                             src={thumbnailUrl}
                             alt={`第 ${page} 页`}
                            className="w-full h-full object-contain bg-gray-50"
                          />
                        ) : isFailed ? (
                          <div className="w-full h-full flex items-center justify-center bg-gray-100">
                            <span className="text-xs text-gray-400">{page}</span>
                          </div>
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-gray-50">
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-300"></div>
                          </div>
                        )}
                        {/* Page number overlay */}
                        <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-xs py-1 text-center">
                          第 {page} 页
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-32 text-gray-400 gap-2 px-4 text-center">
                  <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <p className="text-xs">暂无页面信息</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
