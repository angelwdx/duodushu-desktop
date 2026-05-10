"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import DictionarySidebar from "./DictionarySidebar";
import AITeacherSidebar from "./AITeacherSidebar";
import NotesSidebar, { Note } from "./NotesSidebar";
import SelectionToolbar from "./SelectionToolbar";
import { ArrowLeftIcon } from "./Icons";
import { useMediaQuery } from "../hooks/useMediaQuery";

interface ContextAwareLayoutProps {
  children: React.ReactNode;
  title?: string;
  backUrl?: string;
  onWordClick?: (word: string, context?: string) => void;
  onAskAI?: (text: string) => void;
  externalTrigger?: string;
  onHighlight?: (text: string, source?: string) => void;
  bookId?: string;
  currentPage?: number;
  pageContent?: string;
  bookTitle?: string;
  bookLanguage?: string | null;
  rightSidebarMode?: 'dictionary' | 'ai' | 'notes';
  onSidebarModeChange?: (mode: 'dictionary' | 'ai' | 'notes') => void;
  savedWords?: any[];
  onDeleteWord?: (wordId: number) => Promise<void>;
  onAddWord?: (word: string, data: any) => Promise<void>;
  notes?: Note[];
  onDeleteNote?: (noteId: string) => void;
  onUpdateComment?: (noteId: string, comment: string) => void;
  onJumpToPage?: (page: number) => void;
  activeWord?: any | null;
  loadingDict?: boolean;
  onRefresh?: () => void;
  rightSidebarWidth?: number;
  onRightSidebarWidthChange?: (width: number) => void;
  enableGlobalSelection?: boolean;
  selection?: { text: string; x: number; y: number; source?: string } | null;
  onSelectionNote?: (text: string, source?: string) => void;
  onSelectionAskAI?: (text: string, source?: string) => void;
  onSelectionLookup?: (text: string) => void;
  onClearSelection?: () => void;
  rightSidebarExpanded?: boolean;
  onRightSidebarExpand?: (expanded: boolean) => void;
}

export default function ContextAwareLayout({
  children,
  title,
  backUrl,
  onWordClick,
  bookId,
  currentPage = 1,
  pageContent = "",
  bookTitle = "",
  bookLanguage,
  rightSidebarMode = 'dictionary',
  onSidebarModeChange,
  savedWords = [],
  onDeleteWord,
  onAddWord,
  notes = [],
  onDeleteNote,
  onUpdateComment,
  onJumpToPage,
  activeWord = null,
  loadingDict = false,
  onRefresh,
  rightSidebarWidth = 600,
  onRightSidebarWidthChange,
  enableGlobalSelection = true,
  selection,
  onSelectionNote,
  onSelectionAskAI,
  onSelectionLookup,
  externalTrigger = undefined,
  onClearSelection,
  className = "h-screen", // 默认 h-screen，但允许覆盖
  bottomBar, // 新增：底部悬浮栏
  rightSidebarExpanded, // Optional controlled state
  onRightSidebarExpand, // Optional controlled state handler
}: ContextAwareLayoutProps & { className?: string; bottomBar?: React.ReactNode }) {
  const router = useRouter();
  const { isMobile } = useMediaQuery();
  const [internalSidebarCollapsed, setInternalSidebarCollapsed] = useState(true);

  // 移动端默认折叠侧边栏，桌面端默认展开
  const [hasInitialized, setHasInitialized] = useState(false);

  useEffect(() => {
    if (!hasInitialized) {
      setInternalSidebarCollapsed(isMobile);
      setHasInitialized(true);
    }
  }, [isMobile, hasInitialized]);

  // 监听屏幕尺寸变化，当切换到移动端时自动折叠侧边栏
  useEffect(() => {
    if (isMobile && !internalSidebarCollapsed && hasInitialized) {
      setInternalSidebarCollapsed(true);
    }
  }, [isMobile, internalSidebarCollapsed, hasInitialized]);

  // Determine if sidebar is collapsed based on props (controlled) or state (uncontrolled)
  const isSidebarCollapsed = rightSidebarExpanded !== undefined 
    ? !rightSidebarExpanded 
    : internalSidebarCollapsed;

  const setSidebarCollapsed = (collapsed: boolean) => {
    if (rightSidebarExpanded !== undefined) {
      onRightSidebarExpand?.(!collapsed);
    } else {
      setInternalSidebarCollapsed(collapsed);
    }
  };

  const handleDictionarySearch = useCallback((word: string, source?: string) => {
    onWordClick?.(word, source);
  }, [onWordClick]);

  const handleDictionaryAdd = useCallback(async (word: string, data: any) => {
    await onAddWord?.(word, data);
  }, [onAddWord]);

  return (
    <div className={`${className} bg-white flex flex-col overflow-hidden`} data-page-type="vocab-detail">
      {/* 顶部导航 */}
      {title && (
        <header className="border-b border-gray-200 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {backUrl && (
                <button
                  onClick={() => router.push(backUrl)}
                  className="text-gray-600 hover:text-gray-900 flex items-center gap-1.5 transition-colors"
                >
                  <ArrowLeftIcon className="w-4 h-4" />
                  返回
                </button>
              )}
              <h1 className="text-xl font-semibold text-gray-900">
                {title}
              </h1>
            </div>
          </div>
        </header>
      )}

      {/* 主内容区 */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* 左侧内容区 */}
        <div className="flex-1 overflow-auto p-6">
          {children}
        </div>

        {/* 底部悬浮栏 - 相对于左侧内容区居中 */}
        {bottomBar && (
          <div 
            className="absolute bottom-8 left-0 z-40 flex justify-center pointer-events-none transition-all duration-300"
            style={{ width: isSidebarCollapsed ? '100%' : `calc(100% - ${rightSidebarWidth}px)` }}
          >
            <div className="pointer-events-auto">
              {bottomBar}
            </div>
          </div>
        )}

        {/* 右侧边栏 - 调整大小手柄（移动端隐藏） */}
        {!isSidebarCollapsed && onRightSidebarWidthChange && !isMobile && (
          <div
            onMouseDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startWidth = rightSidebarWidth;

              const handleMouseMove = (e: MouseEvent) => {
                const newWidth = Math.max(320, Math.min(800, startWidth + (startX - e.clientX)));
                onRightSidebarWidthChange(newWidth);
              };

              const handleMouseUp = () => {
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
              };

              document.addEventListener('mousemove', handleMouseMove);
              document.addEventListener('mouseup', handleMouseUp);
            }}
            className="w-1 hover:w-1.5 hover:bg-gray-400 cursor-col-resize bg-gray-200 transition-all z-30 shrink-0"
          />
        )}

        {/* 右侧边栏 - 移动端全屏覆盖 */}
        {!isSidebarCollapsed ? (
          <div
            className={`
              shrink-0 z-20 h-full bg-white border-l shadow-xl flex flex-col
              transition-transform duration-300 ease-out
              ${isMobile ? 'fixed inset-0' : ''}
            `}
            style={{
              width: isMobile ? '100%' : `${rightSidebarWidth}px`,
              right: 0,
              top: 0
            }}
          >
            {/* 标签切换 */}
            <div className="p-2 border-b bg-gray-50 flex items-center gap-1">
              <button
                onClick={() => setSidebarCollapsed(true)}
                className="p-2 hover:bg-gray-200 rounded text-gray-600 mr-1 touch-icon-btn"
                title="关闭侧边栏"
                aria-label="关闭侧边栏"
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

              <button
                onClick={() => onSidebarModeChange?.('dictionary')}
                className={`flex-1 px-4 py-2.5 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1.5 touch-target ${
                  rightSidebarMode === 'dictionary'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:bg-gray-100'
                }`}
                aria-label="词典侧边栏"
                aria-pressed={rightSidebarMode === 'dictionary'}
                title="词典"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332-.477-4.5-1.253M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13" />
                </svg>
                词典
              </button>
              <button
                onClick={() => onSidebarModeChange?.('ai')}
                className={`flex-1 px-4 py-2.5 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1.5 touch-target ${
                  rightSidebarMode === 'ai'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:bg-gray-100'
                }`}
                aria-label="AI 老师侧边栏"
                aria-pressed={rightSidebarMode === 'ai'}
                title="AI 老师"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                老师
              </button>
              <button
                onClick={() => onSidebarModeChange?.('notes')}
                className={`flex-1 px-4 py-2.5 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1.5 touch-target ${
                  rightSidebarMode === 'notes'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:bg-gray-100'
                }`}
                aria-label="笔记侧边栏"
                aria-pressed={rightSidebarMode === 'notes'}
                title="笔记"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
                笔记
              </button>
            </div>

            {/* 内容区 */}
            <div className="flex-1 overflow-hidden relative">
              <div 
                className={`h-full absolute inset-0 ${rightSidebarMode === 'dictionary' ? 'block' : 'hidden'}`}
                style={{ contentVisibility: rightSidebarMode === 'dictionary' ? 'auto' : 'hidden' }}
              >
                <DictionarySidebar
                  wordData={activeWord}
                  loading={loadingDict}
                  onSearch={handleDictionarySearch}
                  onAdd={handleDictionaryAdd}
                  savedWords={savedWords}
                  onDeleteWord={onDeleteWord}
                  bookId={bookId}
                  currentPage={currentPage}
                  bookLanguage={bookLanguage}
                  onRefresh={onRefresh}
                  className="h-full"
                />
              </div>
              <div 
                className={`h-full absolute inset-0 ${rightSidebarMode === 'ai' ? 'block' : 'hidden'}`}
                style={{ contentVisibility: rightSidebarMode === 'ai' ? 'auto' : 'hidden' }}
              >
                <AITeacherSidebar
                  className="h-full"
                  pageContent={pageContent}
                  currentPage={currentPage}
                  bookTitle={bookTitle}
                  bookId={bookId}
                  externalTrigger={externalTrigger}
                  onPageChange={onJumpToPage}
                />
              </div>
              <div 
                className={`h-full absolute inset-0 ${rightSidebarMode === 'notes' ? 'block' : 'hidden'}`}
                style={{ contentVisibility: rightSidebarMode === 'notes' ? 'auto' : 'hidden' }}
              >
                <NotesSidebar
                  bookId={bookId || ''}
                  notes={notes}
                  onDeleteNote={onDeleteNote || (() => {})}
                  onUpdateComment={onUpdateComment || (() => {})}
                  onJumpToPage={onJumpToPage}
                />
              </div>
            </div>
          </div>
        ) : (
          // 收起状态下的展开按钮
          <button
            onClick={() => setSidebarCollapsed(false)}
            className="fixed top-1/2 -translate-y-1/2 right-0 z-50 bg-white shadow-lg rounded-l-lg p-2 hover:bg-gray-50 transition-colors border border-r-0 touch-icon-btn"
            title="打开侧边栏"
            aria-label="打开侧边栏"
          >
            <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}

        {/* 关闭按钮 - 移动端隐藏（因为移动端有顶部关闭按钮） */}
        {!isSidebarCollapsed && !isMobile && (
          <button
            onClick={() => setSidebarCollapsed(true)}
            className="absolute top-1/2 -translate-y-1/2 right-0 z-50 bg-white shadow-lg rounded-l-lg p-2 hover:bg-gray-50 transition-colors border border-r-0 touch-icon-btn"
            style={{ right: `${rightSidebarWidth}px` }}
            title="关闭侧边栏"
            aria-label="关闭侧边栏"
          >
            <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}
      </div>

      {/* 全局选择工具栏 */}
      {enableGlobalSelection && selection && (
        <SelectionToolbar
          selection={selection}
          onNote={onSelectionNote}
          onAskAI={onSelectionAskAI}
          onLookup={onSelectionLookup}
          onCopy={async (text) => {
            await navigator.clipboard.writeText(text);
          }}
          onClear={onClearSelection}
          hidden={!selection}
        />
      )}
    </div>
  );
}
