/* eslint-disable @next/next/no-img-element */
"use client";

import React, { useEffect, useState, useRef } from 'react';
import { getBooks, deleteBook, updateBookType, Book } from '../lib/api';
// import UploadDialog from '../components/UploadDialog'; // Removed, handled globally
import MenuHandler from '../components/MenuHandler';
import Link from 'next/link';
import { useSettings } from '../contexts/SettingsContext';
import { useGlobalDialogs } from '../contexts/GlobalDialogsContext';

export default function Home() {
  const [books, setBooks] = useState<Book[]>([]);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [bookToDelete, setBookToDelete] = useState<string | null>(null);
  const { openSettings } = useSettings();
  const { openUpload } = useGlobalDialogs();
  const [pollingError, setPollingError] = useState<string | null>(null);
  
  const [hoveredBookId, setHoveredBookId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchBooks = React.useCallback(async (isPolling = false) => {
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
        setBooks(data);
        setPollingError(null);
        if (!isPolling) setIsLoading(false);
        success = true;
      } catch (err) {
        attempt++;
        console.error(`[Bookshelf] Load failed (attempt ${attempt}/${maxRetries}):`, err);
        
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
    // e.stopPropagation() is effectively handled by positioning, but keeping it safe
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

  useEffect(() => {
    fetchBooks();
    
    // Listen for global book uploaded event
    const handleBookUploaded = () => {
        console.log('[Home] Received book-uploaded event, refreshing list...');
        fetchBooks();
    };
    window.addEventListener('book-uploaded', handleBookUploaded);
    
    return () => {
        window.removeEventListener('book-uploaded', handleBookUploaded);
    };
  }, [fetchBooks]);

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
          </div>
        </header>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-4">我的书架</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4 sm:gap-6">
            {isLoading ? (
              <div className="col-span-full flex flex-col items-center justify-center py-20 text-gray-500">
                <svg className="w-10 h-10 animate-spin mb-4 text-blue-600" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <p>正在加载书架...</p>
              </div>
            ) : error ? (
              <div className="col-span-full flex flex-col items-center justify-center py-20 text-gray-500">
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
            ) : (
              <>
                {books.map((book) => (
                  <div
                    key={book.id}
                    className="bg-white border border-gray-200 rounded-lg hover:border-gray-300 hover:shadow-md transition-all h-full flex flex-col relative group"
                    onMouseEnter={() => setHoveredBookId(book.id)}
                    onMouseLeave={() => setHoveredBookId(null)}
                  >
                    <Link href={`/read?id=${book.id}`} className="h-full flex flex-col flex-1">
                      <div className="relative w-full pb-[133.33%] bg-gray-100 overflow-hidden">
                        {book.cover_image ? (
                            <img
                                src={`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/books/cover/${book.cover_image}`}
                                alt={book.title}
                                className="absolute inset-0 w-full h-full object-cover"
                            />
                        ) : (
                            <div className="absolute inset-0 w-full h-full flex items-center justify-center text-gray-400 text-sm">
                            No Cover
                            </div>
                        )}
    
                        {/* 右上角删除按钮（移动端始终显示，桌面端hover显示） */}
                        <button
                          onClick={(e) => handleDelete(e, book.id)}
                          className="absolute top-2 right-2 p-2 bg-white/90 backdrop-blur-sm border border-gray-200 rounded-lg text-gray-500 hover:text-gray-900 hover:border-gray-400 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity z-10 touch-icon-btn"
                          title="删除书籍"
                          aria-label={`删除书籍: ${book.title}`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
    
                        {/* 右下角心形图标 */}
                        {hoveredBookId === book.id ? (
                          <button
                            onClick={(e) => toggleBookType(book.id, e)}
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
                          // 非hover状态，只显示静态图标（例句库显示红色心）
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
                      <div className="p-4 flex-1">
                        <h3 className="font-medium text-gray-900 group-hover:text-gray-700 truncate" title={book.title}>
                          {book.title}
                        </h3>
                        {/* 书籍信息 */}
                        <div className="mt-2 flex items-center justify-between text-sm">
                          <div className="flex items-center gap-2 overflow-hidden">
                            <span className="text-gray-500 whitespace-nowrap truncate">
                              {book.format.toUpperCase()}
                              {book.total_pages && ` · ${book.total_pages}页`}
                            </span>
                            {book.book_type === 'example_library' && hoveredBookId === book.id && (
                              <span className="text-xs text-gray-400 whitespace-nowrap shrink-0">
                                ♥ 例句库
                              </span>
                            )}
                          </div>
                          {book.status !== 'completed' && (
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium
                              ${book.status === 'failed' ? 'bg-red-100 text-red-700' :
                                'bg-blue-100 text-blue-700'}`}>
                              {book.status}
                            </span>
                          )}
                        </div>
                      </div>
                    </Link>
                  </div>
                ))}
                {books.length === 0 && (
                  <div className="col-span-full text-center py-12 text-gray-400 bg-gray-50 border border-dashed border-gray-300 rounded-lg">
                    暂无书籍，快上传一本开始阅读吧！
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>

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
