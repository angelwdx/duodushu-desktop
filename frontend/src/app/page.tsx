/* eslint-disable @next/next/no-img-element */
"use client";

import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getBooks, deleteBook, updateBookType, Book, getApiUrl, loadBookOrder, saveBookOrder } from '../lib/api';
import { createLogger } from '../lib/logger';
import MenuHandler from '../components/MenuHandler';
import SearchDialog from '../components/SearchDialog';
import Link from 'next/link';
import { useSettings } from '../contexts/SettingsContext';
import { useGlobalDialogs } from '../contexts/GlobalDialogsContext';

// ─── 可排序书卡组件 ────────────────────────────────────────────────────────────
interface BookCardProps {
  book: Book;
  apiUrl: string;
  hoveredBookId: string | null;
  isDragging?: boolean;
  onMouseEnter: (id: string) => void;
  onMouseLeave: () => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  onToggleType: (id: string, e: React.MouseEvent) => void;
}

function SortableBookCard(props: BookCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.book.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
    cursor: isDragging ? 'grabbing' : 'grab',
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <BookCardContent {...props} isDragging={isDragging} />
    </div>
  );
}

function BookCardContent({
  book,
  apiUrl,
  hoveredBookId,
  isDragging = false,
  onMouseEnter,
  onMouseLeave,
  onDelete,
  onToggleType,
}: BookCardProps) {
  return (
    <div
      className={`bg-white border rounded-lg transition-all h-full flex flex-col relative group select-none ${
        isDragging
          ? 'border-blue-300 shadow-2xl scale-105'
          : 'border-gray-200 hover:border-gray-300 hover:shadow-md'
      }`}
      onMouseEnter={() => onMouseEnter(book.id)}
      onMouseLeave={onMouseLeave}
    >
      <Link
        href={`/read?id=${book.id}`}
        className="h-full flex flex-col flex-1"
        onClick={(e) => {
          if (isDragging) e.preventDefault();
        }}
        draggable={false}
      >
        <div className="relative w-full pb-[133.33%] bg-gray-100 overflow-hidden rounded-t-lg">
          {book.cover_image ? (
            <img
              src={`${apiUrl}/api/books/cover/${book.cover_image}`}
              alt={book.title}
              className="absolute inset-0 w-full h-full object-cover"
              draggable={false}
            />
          ) : (
            <div className="absolute inset-0 w-full h-full flex items-center justify-center text-gray-400 text-sm">
              No Cover
            </div>
          )}

          <div
            className="absolute top-2 right-2 flex flex-col gap-2 z-10"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (typeof window !== 'undefined' && (window as any).electronAPI?.openNewWindow) {
                  (window as any).electronAPI.openNewWindow(`/read?id=${book.id}`);
                } else {
                  window.open(`/read?id=${book.id}`, '_blank', 'width=1280,height=800');
                }
              }}
              className="p-2 bg-white/90 backdrop-blur-sm border border-gray-200 rounded-lg text-gray-500 hover:text-blue-600 hover:border-blue-300 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
              title="在新窗口独立阅读"
              aria-label={`在新窗口打开: ${book.title}`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>

            <button
              onClick={(e) => onDelete(e, book.id)}
              className="p-2 bg-white/90 backdrop-blur-sm border border-gray-200 rounded-lg text-gray-500 hover:text-red-600 hover:border-red-300 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
              title="删除书籍"
              aria-label={`删除书籍: ${book.title}`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div onPointerDown={(e) => e.stopPropagation()}>
            {hoveredBookId === book.id ? (
              <button
                onClick={(e) => onToggleType(book.id, e)}
                className="absolute bottom-2 right-2 p-1.5 transition-all z-10 hover:scale-110"
                title={book.book_type === 'example_library' ? '取消例句库' : '设为例句库'}
              >
                <svg
                  className={`w-5 h-5 transition-colors ${
                    book.book_type === 'example_library'
                      ? 'fill-gray-400/60 text-gray-400/60'
                      : 'text-gray-400/40'
                  }`}
                  fill={book.book_type === 'example_library' ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={book.book_type === 'example_library' ? 0 : 2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                </svg>
              </button>
            ) : (
              <div className="absolute bottom-2 right-2">
                {book.book_type === 'example_library' && (
                  <div className="p-1.5">
                    <svg className="w-5 h-5 text-gray-400/40 fill-current" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                    </svg>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="p-4 flex-1">
          <h3 className="font-medium text-gray-900 group-hover:text-gray-700 truncate" title={book.title}>
            {book.title}
          </h3>
          <div className="mt-2 flex items-center justify-between text-sm">
            <div className="flex items-center gap-2 overflow-hidden">
              <span className="text-gray-500 whitespace-nowrap truncate">
                {book.format.toUpperCase()}
                {book.total_pages && ` · ${book.total_pages}页`}
              </span>
              {book.book_type === 'example_library' && hoveredBookId === book.id && (
                <span className="text-xs text-gray-400 whitespace-nowrap shrink-0">♥ 例句库</span>
              )}
            </div>
            {book.status !== 'completed' && (
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                book.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'
              }`}>
                {book.status}
              </span>
            )}
          </div>
        </div>
      </Link>
    </div>
  );
}

const log = createLogger('Home');

export default function Home() {
  const [books, setBooks] = useState<Book[]>([]);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [bookToDelete, setBookToDelete] = useState<string | null>(null);
  const { openSettings } = useSettings();
  const { openUpload } = useGlobalDialogs();
  const [pollingError, setPollingError] = useState<string | null>(null);
  const [apiUrl, setApiUrl] = useState<string>(getApiUrl());
  const [hoveredBookId, setHoveredBookId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // 当前活跃模型信息 { name: "DeepSeek", model: "deepseek-chat" }
  const [activeModelInfo, setActiveModelInfo] = useState<{ name: string; model: string } | null>(null);

  const fetchActiveModelInfo = useCallback(async () => {
    try {
      const res = await fetch(`${getApiUrl()}/api/config/suppliers-status`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.active_supplier && data.suppliers) {
        const active = data.suppliers.find((s: { type: string; name: string; model?: string }) => s.type === data.active_supplier);
        if (active) {
          setActiveModelInfo({ name: active.name, model: active.model || '' });
        }
      }
    } catch (e) {
      log.error('Failed to fetch active model info:', e);
    }
  }, []);

  // Cmd+F / Ctrl+F 打开全局搜索
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const fetchBooks = useCallback(async (isPolling = false) => {
    if (!isPolling) {
      setIsLoading(true);
      setError(null);
    }

    const maxRetries = isPolling ? 1 : 3;
    let attempt = 0;
    let success = false;

    while (attempt < maxRetries && !success) {
      try {
        const data = await getBooks();
        // 按照 localStorage 中保存的顺序重排，新书追加末位
        const savedOrder = loadBookOrder();
        if (savedOrder.length > 0) {
          const idSet = new Set(savedOrder);
          const ordered = savedOrder
            .map(id => data.find(b => b.id === id))
            .filter((b): b is Book => b !== undefined);
          const newBooks = data.filter(b => !idSet.has(b.id));
          setBooks([...ordered, ...newBooks]);
        } else {
          setBooks(data);
        }
        setPollingError(null);
        if (!isPolling) setIsLoading(false);
        success = true;
      } catch (err) {
        attempt++;
        log.error(`[Bookshelf] Load failed (attempt ${attempt}/${maxRetries}):`, err);
        
        if (attempt >= maxRetries) {
          if (isPolling) {
            setPollingError('同步失败，请刷新页面');
          } else {
            setError('连接服务器失败，请确保后台服务已启动');
            setIsLoading(false);
          }
        } else {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }
  }, []);

  const handleDelete = (e: React.MouseEvent, bookId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setBookToDelete(bookId);
    setDeleteConfirmOpen(true);
  };

  const toggleBookType = async (bookId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const book = books.find(b => b.id === bookId);
    if (!book) return;

    const newType: 'normal' | 'example_library' = book.book_type === 'example_library' ? 'normal' : 'example_library';

    try {
      await updateBookType(bookId, newType);
      await fetchBooks();
    } catch (error) {
      alert('更新失败');
      console.error(error);
    }
  };

  const confirmDelete = async () => {
    if (!bookToDelete) return;

    try {
      await deleteBook(bookToDelete);
      await fetchBooks();
      setDeleteConfirmOpen(false);
      setBookToDelete(null);
    } catch {
      alert("Failed to delete book");
    }
  };

  // ─── 拖拽事件 ──────────────────────────────────────────────────────────────
  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
    setHoveredBookId(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over || active.id === over.id) return;

    setBooks(prev => {
      const oldIndex = prev.findIndex(b => b.id === active.id);
      const newIndex = prev.findIndex(b => b.id === over.id);
      const reordered = arrayMove(prev, oldIndex, newIndex);
      saveBookOrder(reordered.map(b => b.id));
      return reordered;
    });
  };

  useEffect(() => {
    fetchBooks();
    fetchActiveModelInfo();
    
    // Listen for global book uploaded event
    const handleBookUploaded = () => {
        log.debug('Received book-uploaded event, refreshing list...');
        fetchBooks();
    };
    window.addEventListener('book-uploaded', handleBookUploaded);
    
    // 监听设置关闭事件，刷新活跃模型信息
    const handleSettingsSaved = () => fetchActiveModelInfo();
    window.addEventListener('settings-saved', handleSettingsSaved);

    return () => {
        window.removeEventListener('book-uploaded', handleBookUploaded);
        window.removeEventListener('settings-saved', handleSettingsSaved);
    };
  }, [fetchBooks, fetchActiveModelInfo]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if ((window as any).electronAPI?.getBackendUrl) {
      (window as any).electronAPI.getBackendUrl()
        .then((backendUrl: string) => {
          if (backendUrl) {
            setApiUrl(backendUrl.endsWith('/') ? backendUrl.slice(0, -1) : backendUrl);
          }
        })
        .catch(() => {
          setApiUrl(getApiUrl());
        });
      return;
    }

    setApiUrl(getApiUrl());
  }, []);

  // Poll for updates if any book is processing
  // 使用 useRef 跟踪是否有处理中的书籍，避免 books 变化导致的无限循环
  const hasProcessingBooksRef = useRef(false);

  useEffect(() => {
    const hasProcessingBooks = books.some(b => b.status === 'processing');

    // 只有当处理状态发生变化时才更新 interval
    if (hasProcessingBooks === hasProcessingBooksRef.current) {
      return;
    }
    hasProcessingBooksRef.current = hasProcessingBooks;

    // Clear existing interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (hasProcessingBooks) {
      intervalRef.current = setInterval(() => {
        fetchBooks(true); // Pass true to indicate this is a polling request
      }, 3000); // Poll every 3 seconds
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [books, fetchBooks]);

  return (
    <main role="main" className="min-h-screen bg-white py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <header role="banner" className="flex justify-between items-center">
          <div>
            <div className="flex items-center gap-3">
              <svg className="w-8 h-8 text-gray-900" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332-.477-4.5 1.253" />
              </svg>
              <h1 className="text-3xl font-bold text-gray-900">多读书</h1>
            </div>
            <p className="mt-2 text-gray-500">上传书籍，开始沉浸式阅读</p>
          </div>
          <div className="flex items-center gap-2 sm:gap-4">
            {/* 全局搜索 */}
            <button
              onClick={() => setSearchOpen(true)}
              className="w-11 h-11 inline-grid place-items-center text-gray-500 hover:text-gray-900 transition-colors hover:bg-gray-100 rounded-full shrink-0 touch-icon-btn"
              title="搜索书名/内容 (⌘F)"
              aria-label="全局搜索"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
            <button
              onClick={openUpload}
              className="w-11 h-11 inline-grid place-items-center text-gray-500 hover:text-gray-900 transition-colors group hover:bg-gray-100 rounded-full border-none outline-none shrink-0 touch-icon-btn"
              title="上传书籍"
              aria-label="上传书籍"
            >
              <svg className="w-6 h-6 transition-transform group-hover:-translate-y-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
              </svg>
            </button>
            <Link
              href="/dicts"
              className="w-11 h-11 inline-grid place-items-center text-gray-500 hover:text-gray-900 transition-colors hover:bg-gray-100 rounded-full shrink-0 touch-icon-btn"
              title="词典管理"
              aria-label="词典管理"
            >
              <svg className="w-6 h-6 outline-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.5 4h11a1 1 0 011 1v14a1 1 0 01-1 1h-11a2 2 0 01-2-2V6a2 2 0 012-2z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.5 18H18" />
                <path fill="currentColor" stroke="none" d="M13.5 15h-1.2l-.3-1.2h-2l-.3 1.2H8.5l2-6h1.5l1.5 6zm-1.8-2.4l-.7-2.6-.7 2.6h1.4z" />
              </svg>
            </Link>
            <Link
              href="/vocabulary"
              className="w-11 h-11 inline-grid place-items-center text-gray-500 hover:text-gray-900 transition-colors hover:bg-gray-100 rounded-full shrink-0 touch-icon-btn"
              title="生词本"
              aria-label="生词本"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </Link>
            <button
              onClick={openSettings}
              className="w-11 h-11 inline-grid place-items-center text-gray-500 hover:text-gray-900 transition-colors hover:bg-gray-100 rounded-full shrink-0 touch-icon-btn"
              title="API 配置"
              aria-label="设置"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37a1.724 1.724 0 002.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            {/* 当前活跃模型徽标，点击可快速打开设置 */}
            <button
              onClick={openSettings}
              title="点击切换 AI 模型"
              aria-label={activeModelInfo ? `当前模型：${activeModelInfo.name}` : '未配置 AI 模型'}
              className="hidden sm:flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-gray-200 bg-gray-50 hover:bg-gray-100 hover:border-gray-300 transition-colors shrink-0 max-w-[180px]"
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${activeModelInfo ? 'bg-green-400' : 'bg-gray-300'}`} />
              <span className="text-xs text-gray-600 truncate leading-none">
                {activeModelInfo
                  ? `${activeModelInfo.name}${activeModelInfo.model ? ' · ' + activeModelInfo.model : ''}`
                  : '未配置'}
              </span>
            </button>
          </div>
        </header>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-4">我的书架</h2>
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-500">
              <svg className="w-10 h-10 animate-spin mb-4 text-blue-600" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <p>正在加载书架...</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-500">
              <div className="w-16 h-16 bg-red-100 text-red-500 rounded-full flex items-center justify-center mb-4">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77-1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <p className="text-lg font-medium text-gray-900 mb-2">加载失败</p>
              <p className="mb-6">{error}</p>
              <button
                onClick={() => fetchBooks(false)}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                重试
              </button>
            </div>
          ) : books.length === 0 ? (
            <div className="text-center py-12 text-gray-400 bg-gray-50 border border-dashed border-gray-300 rounded-lg">
              暂无书籍，快上传一本开始阅读吧！
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={books.map(b => b.id)} strategy={rectSortingStrategy}>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4 sm:gap-6">
                  {books.map((book) => (
                    <SortableBookCard
                      key={book.id}
                      book={book}
                      apiUrl={apiUrl}
                      hoveredBookId={hoveredBookId}
                      onMouseEnter={setHoveredBookId}
                      onMouseLeave={() => setHoveredBookId(null)}
                      onDelete={handleDelete}
                      onToggleType={toggleBookType}
                    />
                  ))}
                </div>
              </SortableContext>
              <DragOverlay>
                {activeId ? (
                  <div className="rotate-2 scale-105">
                    <BookCardContent
                      book={books.find(b => b.id === activeId)!}
                      apiUrl={apiUrl}
                      hoveredBookId={null}
                      isDragging={true}
                      onMouseEnter={() => {}}
                      onMouseLeave={() => {}}
                      onDelete={() => {}}
                      onToggleType={() => {}}
                    />
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          )}
        </section>
      </div>

      {/* 全局搜索弹窗 */}
      <SearchDialog isOpen={searchOpen} onClose={() => setSearchOpen(false)} />

      {/* Menu Handler - 处理 Electron 菜单事件 (首页特定) */}
      <MenuHandler />

      {/* Upload Dialog has been moved to GlobalDialogsContext */}

      {/* Delete Confirmation Modal */}
      {deleteConfirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-confirm-title"
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
        >
            <div className="bg-white rounded-lg shadow-lg max-w-md w-full p-6 animate-in fade-in zoom-in duration-200">
                <div className="flex items-center gap-4 mb-4">
                    <div className="p-3 bg-gray-100 rounded-full">
                        <svg className="w-6 h-6 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77-1.333.192 3 1.732 3z" />
                        </svg>
                    </div>
                    <h3 id="delete-confirm-title" className="text-lg font-bold text-gray-900">确认删除</h3>
                </div>

                <p className="text-gray-600 mb-6">
                    确定要删除这本书吗？此操作不可撤销，将移除所有阅读进度和笔记。
                </p>

                <div className="flex justify-end gap-3">
                    <button
                        onClick={() => setDeleteConfirmOpen(false)}
                        className="px-4 py-2 text-gray-700 font-medium hover:bg-gray-100 rounded-lg transition-colors"
                    >
                        取消
                    </button>
                    <button
                        onClick={confirmDelete}
                        className="px-4 py-2 bg-gray-900 text-white font-medium hover:bg-gray-800 rounded-lg transition-colors"
                    >
                        删除书籍
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* Polling Error Notification */}
      {pollingError && (
        <div className="fixed bottom-4 right-4 z-50">
          <div className="bg-amber-50 border border-amber-200 rounded-lg shadow-lg p-4 max-w-sm">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77-1.333.192 3 1.732 3z" />
              </svg>
              <div className="flex-1">
                <p className="text-sm text-amber-900">{pollingError}</p>
                <button
                  onClick={() => {
                    setPollingError(null);
                    fetchBooks();
                  }}
                  className="mt-2 text-sm text-amber-700 hover:text-amber-900 underline"
                >
                  重试
                </button>
              </div>
              <button
                onClick={() => setPollingError(null)}
                className="text-amber-600 hover:text-amber-800"
                title="关闭"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
