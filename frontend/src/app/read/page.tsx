"use client";

import { useEffect, useState, useRef, useMemo, useCallback, Suspense } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import DictionarySidebar from "../../components/DictionarySidebar";
import AITeacherSidebar from "../../components/AITeacherSidebar";
import NotesSidebar, { Note } from "../../components/NotesSidebar";
import LeftSidebar from "../../components/LeftSidebar";
import SelectionToolbar from "../../components/SelectionToolbar";
import { useGlobalTextSelection } from "../../hooks/useGlobalTextSelection";

import { trackWordQuery } from "../../lib/api";
import { createLogger } from "../../lib/logger";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { createReaderShortcuts, SHORTCUT_TITLES } from "../../lib/shortcuts";

const log = createLogger('ReaderPage');

// Dynamic imports to avoid SSR issues with browser-only libraries
const PDFReader = dynamic(() => import("../../components/PDFReader"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-600"></div>
    </div>
  ),
});

const UniversalReader = dynamic(
  () => import("../../components/UniversalReader"),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-600"></div>
      </div>
    ),
  },
);

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

function ReaderContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  
  // 适配静态导出：优先从查询参数获取 ID
  const id = searchParams.get("id") || (params?.id as string) || "";

  // 优先从 URL 获取页码和搜索文本
  const initialPage = searchParams.get("page");
  const targetPage = initialPage ? parseInt(initialPage) : null;
  const searchText = searchParams.get("text");
  const targetWord = searchParams.get("word");
  const backUrl = searchParams.get("backUrl"); // 获取返回地址

  // 全局选择状态
  const { selection, clearSelection } = useGlobalTextSelection(true, [
    '[data-selection-toolbar]',
    '.react-pdf__Page__annotations',
    'button',
    'input',
    'textarea',
    'select',
  ]);

  // --- Jump Location State for EPUB ---
  const [jumpRequest, setJumpRequest] = useState<{
    dest: string | number;
    text?: string;
    word?: string; // 新增字段
    ts: number;
  } | null>(null);

  const [book, setBook] = useState<any>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [pageData, setPageData] = useState<any>(null);
  const [visibleContent, setVisibleContent] = useState<string>(""); // 新增：当前视窗可见文本
  const [isContentLoading, setIsContentLoading] = useState(false); // 新增：内容加载状态

  // 追踪 visibleContent 的变化，用于调试
  useEffect(() => {
    log.debug('visibleContent changed', {
      length: visibleContent?.length || 0,
      preview: visibleContent?.substring(0, 100) || 'empty',
      currentPage,
      isLoading: isContentLoading
    });
  }, [visibleContent, currentPage, isContentLoading]);

  // 当页面变化时，设置内容加载状态
  // 注意：需要用 ref 来追踪上一次的页面，避免初始渲染时触发
  const prevPageRef = useRef<number>(1);
  useEffect(() => {
    if (currentPage !== prevPageRef.current) {
      log.debug('Page changed', { from: prevPageRef.current, to: currentPage });
      setIsContentLoading(true);
      setVisibleContent(""); // 清空内容
      prevPageRef.current = currentPage;
    }
  }, [currentPage]);

  // Fetch Book Info and restore reading progress
  useEffect(() => {
    if (!id) return;
    fetch(`${API_URL}/api/books/${id}/status`)
      .then((res) => res.json())
      .then((data) => {
        setBook(data);
        
        // 调试日志
        log.info('Book status loaded:', { 
          format: data.format, 
          targetPage, 
          hasSearchText: !!searchText, 
          hasTargetWord: !!targetWord 
        });
        
        // 优先级：URL参数 > 历史进度 > 第一页
        if (targetPage && targetPage > 0) {
          setCurrentPage(targetPage);
          // Set jumpRequest for all formats to handle specific text highlighting
          if (['epub', 'pdf', 'txt'].includes(data.format?.toLowerCase())) {
            const newJumpRequest = {
              dest: targetPage - 1, // EPUB and PDFReader use 0-based index or equivalent logic
              text: searchText || undefined,
              word: targetWord || undefined,
              ts: Date.now()
            };
            log.info('Setting jumpRequest:', newJumpRequest);
            setJumpRequest(newJumpRequest);
          }
        } else if (data.last_page && data.last_page > 0) {
          setCurrentPage(data.last_page);
        }
      })
      .catch((err) => console.error(err));
  }, [id, targetPage, searchText, targetWord]);

  // Fetch Page Data (Words coordinates)
  useEffect(() => {
    if (!id) return;
    // Clear immediately to prevent stale data usage during race condition
    setPageData(null);
    log.debug('Fetching page data', { page: currentPage });
    fetch(`${API_URL}/api/books/${id}/pages/${currentPage}`)
      .then((res) => res.json())
      .then((data) => {
        log.debug('Page data received', {
          textContentLength: data?.text_content?.length || 0
        });
        setPageData(data);
      })
      .catch((err) => {
        log.error('Failed to fetch page data', err);
      });
  }, [id, currentPage]);

  // Save reading progress (debounced)
  const saveProgressTimeout = useRef<NodeJS.Timeout | null>(null);

  const saveProgress = useCallback(
    (page: number) => {
      if (!id) return;
      if (saveProgressTimeout.current) {
        clearTimeout(saveProgressTimeout.current);
      }
      saveProgressTimeout.current = setTimeout(() => {
        fetch(`${API_URL}/api/books/${id}/progress`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page }),
        }).catch((err) => console.error("Failed to save progress:", err));
      }, 1000);
    },
    [id],
  );

  const handlePageChange = (page: number) => {
    log.debug('Page change', { from: currentPage, to: page });
    setCurrentPage(page);
    saveProgress(page);
    // 重置可见内容，等待新页面的文本提取
    setVisibleContent("");
    setPageData(null); // Clear stale data to prevent using old coordinates
    setIsContentLoading(true); // 开始加载新页面内容
  };

  // --- Sidebar Layout State ---
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(320); // Compact for TOC/bookmarks
  const [rightSidebarWidth, setRightSidebarWidth] = useState(600); // Wider for dictionary/AI
  const [isResizingLeft, setIsResizingLeft] = useState(false);
  const [isResizingRight, setIsResizingRight] = useState(false);
  const [, setIsMobile] = useState(false);

  // Handle sidebar resize
  const handleLeftResizeStart = () => setIsResizingLeft(true);
  const handleRightResizeStart = () => setIsResizingRight(true);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingLeft) {
        setLeftSidebarWidth(Math.max(320, Math.min(600, e.clientX)));
      }
      if (isResizingRight) {
        const containerWidth = window.innerWidth;
        const newWidth = containerWidth - e.clientX;
        setRightSidebarWidth(Math.max(320, Math.min(600, newWidth)));
      }
    };

    const handleMouseUp = () => {
      setIsResizingLeft(false);
      setIsResizingRight(false);
    };

    if (isResizingLeft || isResizingRight) {
      // Prevent text selection during resize
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      return () => {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };
    }
  }, [isResizingLeft, isResizingRight]);

  // Check screen size
  useEffect(() => {
    const checkScreen = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      // Auto-collapse on mobile
      if (mobile) {
        setLeftSidebarCollapsed(true);
        setRightSidebarCollapsed(true);
      }
    };

    checkScreen();
    window.addEventListener("resize", checkScreen);
    return () => window.removeEventListener("resize", checkScreen);
  }, []);

  const fileUrl = useMemo(() => {
    if (!book?.download_url) return "";
    // Use full backend URL (CORS should be configured on backend)
    return `${API_URL}${book.download_url}`;
  }, [book?.download_url]);

  // --- AI / Dictionary Toggle ---
  const [sidebarMode, setSidebarMode] = useState<"dictionary" | "ai" | "notes">
    ("dictionary");

  // --- 键盘快捷键 ---
  const toggleSidebarMode = useCallback((mode: "dictionary" | "ai" | "notes") => {
    if (sidebarMode === mode && !rightSidebarCollapsed) {
      setRightSidebarCollapsed(true);
    } else {
      setSidebarMode(mode);
      setRightSidebarCollapsed(false);
    }
  }, [sidebarMode, rightSidebarCollapsed]);

  const handlePrevPage = useCallback(() => {
    if (currentPage > 1) {
      handlePageChange(currentPage - 1);
    }
  }, [currentPage, handlePageChange]);

  const handleNextPage = useCallback(() => {
    if (totalPages && currentPage < totalPages) {
      handlePageChange(currentPage + 1);
    }
  }, [currentPage, totalPages, handlePageChange]);

  const closeSidebar = useCallback(() => {
    setRightSidebarCollapsed(true);
  }, []);

  // 绑定键盘快捷键
  const readerShortcuts = useMemo(() => 
    createReaderShortcuts(
      handlePrevPage,
      handleNextPage,
      () => toggleSidebarMode("dictionary"),
      () => toggleSidebarMode("ai"),
      () => toggleSidebarMode("notes"),
      closeSidebar
    ),
    [handlePrevPage, handleNextPage, toggleSidebarMode, closeSidebar]
  );

  useKeyboardShortcuts(readerShortcuts, !!book);

  // --- Notes State ---
  const [notes, setNotes] = useState<Note[]>([]);

  // Load notes from localStorage
  useEffect(() => {
    if (!id) return;
    const savedNotes = localStorage.getItem(`notes-${id}`);
    if (savedNotes) {
      try {
        setNotes(JSON.parse(savedNotes));
      } catch (e) {
        console.error("Failed to parse notes:", e);
      }
    }
  }, [id]);

  // Save notes to localStorage
  useEffect(() => {
    if (!id) return;
    if (notes.length > 0) {
      localStorage.setItem(`notes-${id}`, JSON.stringify(notes));
    } else {
      // Remove localStorage when all notes are deleted
      localStorage.removeItem(`notes-${id}`);
    }
  }, [notes, id]);

  // Handle Highlight (划线)
  const handleHighlight = (text: string, arg2?: string | number, arg3?: string) => {
    let pageNum = currentPage;
    let source = arg3;

    if (typeof arg2 === 'number') {
        pageNum = arg2;
        source = arg3;
    } else if (typeof arg2 === 'string') {
        source = arg2;
    }

    let displaySource = source;
    if (source === 'pdf' || source === 'epub') {
        displaySource = book?.title || '书籍正文';
    } else if (source === 'dictionary') {
        displaySource = '词典';
    } else if (source === 'ai') {
        displaySource = 'AI老师';
    } else if (source === 'notes') {
        displaySource = '笔记列表';
    } else if (source === 'vocab') {
        displaySource = '生词本';
    }

    const newNote: Note = {
      id: `note-${Date.now()}`,
      bookId: id,
      pageNumber: pageNum,
      highlightedText: text,
      comment: "",
      createdAt: Date.now(),
      color: "#fef08a", // yellow-200
    };
    setNotes((prev) => [newNote, ...prev]);
    setSidebarMode("notes");
    setRightSidebarCollapsed(false); // 自动展开右侧栏
  };

  const handleDeleteNote = (noteId: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
  };

  const handleUpdateComment = (noteId: string, comment: string) => {
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, comment } : n)),
    );
  };

  // --- Dictionary Sidebar State ---
  const [activeWord, setActiveWord] = useState<any | null>(null);
  const [loadingDict, setLoadingDict] = useState(false);
  const [savedWords, setSavedWords] = useState<any[]>([]);

  // --- Bookmark State ---
  const [bookmarks, setBookmarks] = useState<any[]>([]);
  const [currentPageBookmarked, setCurrentPageBookmarked] = useState(false);
  const [bookmarksRefreshKey, setBookmarksRefreshKey] = useState(0);

  // --- Outline State ---
  const [outline, setOutline] = useState<any[]>([]);

  // Load vocabulary list for this book
  const loadVocabulary = useCallback(async () => {
    if (!id) return;
    try {
      const { getVocabulary } = await import("../../lib/api");
      // Fix: Pass bookId as first parameter to filter by current book
      const vocab = await getVocabulary(id);
      setSavedWords(vocab);
    } catch (e) {
      console.error("Failed to load vocabulary", e);
    }
  }, [id]);

  useEffect(() => {
    loadVocabulary();
  }, [loadVocabulary]);

  // Load bookmarks for this book
  const loadBookmarks = useCallback(async () => {
    if (!id) return;
    try {
      const { getBookmarks } = await import("../../lib/api");
      const bmarks = await getBookmarks(id);
      setBookmarks(bmarks);
      setBookmarksRefreshKey((prev) => prev + 1); // Trigger refresh in LeftSidebar
    } catch (e) {
      console.error("Failed to load bookmarks", e);
    }
  }, [id]);

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  // Check if current page is bookmarked
  useEffect(() => {
    const isBookmarked = bookmarks.some((b) => b.page_number === currentPage);
    setCurrentPageBookmarked(isBookmarked);
  }, [bookmarks, currentPage]);

  // Toggle bookmark for current page
  const toggleBookmark = async () => {
    if (!id) return;
    try {
      if (currentPageBookmarked) {
        const bookmark = bookmarks.find((b) => b.page_number === currentPage);
        if (bookmark) {
          const { deleteBookmark } = await import("../../lib/api");
          await deleteBookmark(bookmark.id);
        }
      } else {
        const { addBookmark } = await import("../../lib/api");
        await addBookmark(id, currentPage);
      }
      await loadBookmarks();
    } catch (e) {
      console.error("Failed to toggle bookmark", e);
    }
  };

  // Helper to find sentence containing the word
  const extractSentence = (text: string, word: string): string => {
    if (!text || !word) return "";

    // 1. Split into lines and merge based on casing (heuristic for PDF/Text line wraps)
    const rawLines = text.split(/\r?\n/);
    const mergedBlocks: string[] = [];
    let currentBlock = "";

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (!line) {
        if (currentBlock) {
          mergedBlocks.push(currentBlock);
          currentBlock = "";
        }
        continue;
      }

      if (currentBlock) {
        const lastChar = currentBlock[currentBlock.length - 1];
        const nextFirstChar = line[0];

        // Merge if:
        // - Previous line doesn't end with sentence terminal (.!?)
        // - AND Next line starts with lowercase letter (indicating a wrap)
        // OR if previous line ends with a comma (definite wrap)
        const isHyphenated = lastChar === "-";
        const isSentenceTerminal = /[.!?]/.test(lastChar);
        const startsWithLower = /[a-z]/.test(nextFirstChar);
        const endsWithComma = lastChar === ",";

        if (
          (!isSentenceTerminal && startsWithLower) ||
          endsWithComma ||
          isHyphenated
        ) {
          if (isHyphenated) {
            currentBlock = currentBlock.slice(0, -1) + line;
          } else {
            currentBlock += " " + line;
          }
        } else {
          mergedBlocks.push(currentBlock);
          currentBlock = line;
        }
      } else {
        currentBlock = line;
      }
    }
    if (currentBlock) mergedBlocks.push(currentBlock);

    // 2. Clean up blocks and find the one containing our word
    const target = word.toLowerCase();
    for (const block of mergedBlocks) {
      // Normalize text: fix broken drop caps (e.g., "M eteors" -> "Meteors")
      const cleanedBlock = block
        .replace(/\b([A-Z])\s+([a-z]+)\b/g, "$1$2")
        .replace(/\s+/g, " ")
        .trim();

      if (cleanedBlock.toLowerCase().includes(target)) {
        // 3. Find specific sentence within the block
        // Split by . ! ? but keep delimiters
        const sentences = cleanedBlock.match(/[^.!?]+[.!?]*/g) || [
          cleanedBlock,
        ];
        for (const s of sentences) {
          if (s.toLowerCase().includes(target)) {
            return s.trim();
          }
        }
        // Fallback to full cleaned block if word is found but sentence split failed
        return cleanedBlock;
      }
    }

    return "";
  };

  // AI Question State
  const [aiQuestion, setAiQuestion] = useState<string | undefined>(undefined);

  // Handle Ask AI
  const handleAskAI = (text: string) => {
    setSidebarMode("ai");
    setAiQuestion(`请讲解一下这段内容：\n\n"${text}"`);
    setRightSidebarCollapsed(false); // 自动展开右侧栏
  };

  // Handle Search / Lookup
  // When switching dictionaries, source is passed and we preserve the current context
  const handleLookup = useCallback(
    async (rawWord: string, sourceOrContext?: string) => {
      if (!rawWord || !rawWord.trim()) {
        setActiveWord(null);
        return;
      }

      // Auto-switch to dictionary tab
      setSidebarMode("dictionary");
      setRightSidebarCollapsed(false); // 自动展开右侧栏

      // Strip punctuation
      const word = rawWord
        .replace(/^[^\w]+|[^\w]+$/g, "")
        .replace(/[—–]/g, "-")
        .toLowerCase();

      if (!word) return;

      // Check if sourceOrContext is a dictionary source ID
      // 改进判断逻辑:如果是同一个词的查询,且参数较短(不像句子),则认为是切换词典源
      const isSwitchingSource = activeWord?.word === word && sourceOrContext && sourceOrContext.length < 50 && !sourceOrContext.includes(' ');
      const isSource = isSwitchingSource;

      // Priority for context sentence:
      // 1. If switching dictionary source, preserve current context_sentence
      // 2. If context is explicitly provided (from word list click), use it
      // 3. Check if word exists in savedWords and use its primary context
      // 4. Fallback: extract from pageData
      let contextSentence;
      if (isSource && activeWord?.context_sentence) {
        // Preserve current context when switching dictionary
        contextSentence = activeWord.context_sentence;
      } else if (
        sourceOrContext &&
        typeof sourceOrContext === "string" &&
        !isSource && 
        sourceOrContext.length > 5 // Simple check to avoid empty/short noise
      ) {
        // Assume it is context if it's not a source
        contextSentence = sourceOrContext;
      } else {
        // Fix: Try to get context from savedWords (from vocabulary list click)
        const savedWord = savedWords.find(
          (w) => w.word.toLowerCase() === word.toLowerCase(),
        );

        if (savedWord?.primary_context?.context_sentence) {
          // Use the saved primary context from when the word was collected
          contextSentence = savedWord.primary_context.context_sentence;
        } else {
          // Fallback: Extract from pageData (for direct click on text)
          contextSentence = pageData?.text_content
            ? extractSentence(pageData.text_content, word)
            : "Context not available";
        }
      }

      setLoadingDict(true);
      
      // Optimistic set with context
      // CRITICAL FIX: If querying the same word (e.g. switching tabs), 
      // preserve existing data (chinese_translation, phonetic, etc.) to prevent UI flashing
      if (activeWord?.word === word) {
        setActiveWord((prev: any) => ({
          ...prev,
          context_sentence: contextSentence,
          // We can optionally clear html_content here if we want to show loading state for just the bottom part
          // But keeping it might be better for "stable" feel until new data arrives
          // Let's keep it, the Sidebar component handles loading overlay
        }));
      } else {
        // New word: reset to basic state
        setActiveWord({ word, context_sentence: contextSentence });
      }

      try {
        const { lookupWord, lookupWordMultipleSources } = await import("../../lib/api");

        let data;

        // If switching to a specific source, query only that source
        if (isSource && sourceOrContext) {
          data = await lookupWord(word, sourceOrContext);
        } else {
          // 直接调用 lookupWord(word) 不传 source 参数
          // 后端会自动查询所有启用的词典并聚合结果,包含 chinese_translation
          data = await lookupWord(word);
        }

        // Merge backend data with local context
        // Note: data from backend will overwrite existing fields with fresh ones
        setActiveWord({
          ...(data || { word, meanings: [] }),
          context_sentence: contextSentence,
        });

        // 新增：查询跟踪（只对已收藏的单词）
        try {
          if (id) {
            await trackWordQuery({
              word: word,
              bookId: id,
              pageNumber: currentPage,
            });
          }
        } catch (e) {
          // 忽略查询跟踪失败，不影响词典查询功能
          console.warn("Failed to track word query:", e);
        }
      } catch (e) {
        console.error(e);
        setActiveWord({ // Error state
          word,
          meanings: [],
          context_sentence: contextSentence,
        });
      } finally {
        setLoadingDict(false);
      }
    },
    [pageData, activeWord?.context_sentence, savedWords, activeWord?.word, currentPage, id],
  );

  // Handle Add to Vocabulary
  const handleAddWord = useCallback(
    async (word: string, data: any) => {
      const bookId = book?.id;
      if (!bookId || !id) return;
      try {
        const { addVocabulary } = await import("../../lib/api");
        // Use the context sentence we passed in data, or fallback
        await addVocabulary({
          word: word,
          book_id: id as string, // context provided by page
          context_sentence: data.context_sentence || "",
          definition: {
            meanings: data.meanings,
            source: data.source,
            phonetic: data.phonetic,
            chinese_summary: data.chinese_translation,
          },
          translation: data.chinese_translation,
          page_number: currentPage,
        });
        await loadVocabulary(); // Refresh list
      } catch {
        alert("Failed to add word");
      }
    },
    [book?.id, loadVocabulary, id, currentPage],
  );

  const handleDeleteWord = useCallback(
    async (wordId: number) => {
      try {
        const { deleteVocabulary } = await import("../../lib/api");
        await deleteVocabulary(wordId);
        await loadVocabulary();
      } catch {
        alert("Failed to delete word");
      }
    },
    [loadVocabulary],
  );

  if (!id) return <div className="p-10 text-center">No book ID provided.</div>;
  if (!book) return <div className="p-10 text-center">Loading book...</div>;

  return (
    <>
      <div className="h-screen bg-gray-100 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="bg-white shadow-sm px-4 py-2 flex items-center justify-between z-10">
          <div className="flex items-center gap-4">
            {/* Left Sidebar Toggle */}
            <button
              onClick={() => setLeftSidebarCollapsed(!leftSidebarCollapsed)}
              className={`p-1.5 rounded-lg transition-colors ${ 
                leftSidebarCollapsed
                  ? "text-gray-400 hover:bg-gray-100"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
              title={leftSidebarCollapsed ? "打开左侧栏" : "关闭左侧栏"}
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {leftSidebarCollapsed ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M11 19l-7-7 7-7M8 14l-7-7 7-7"
                  />
                ) : (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 6h16M4 12h16M4 18h16"
                  />
                )}
              </svg>
            </button>

            <button
              onClick={() => {
                try {
                  const target = backUrl ? decodeURIComponent(backUrl) : "/";
                  router.push(target);
                } catch (e) {
                  console.error("Navigation error:", e);
                  router.push("/");
                }
              }}
              className="text-gray-500 hover:text-gray-900 text-sm font-medium"
            >
              ← {backUrl ? "返回" : "返回书架"}
            </button>
            <h1 className="font-medium text-gray-900 truncate max-w-md text-sm border-l pl-4 border-gray-200">
              {book.title}
            </h1>
          </div>
          <div className="flex items-center gap-2"></div>
        </header>

        {/* Main Content Area: Left Sidebar + PDF + Right Sidebar */}
        <main className="flex-1 flex overflow-hidden min-h-0">
          {/* Floating Left Sidebar Toggle (when collapsed) */}
          {leftSidebarCollapsed && (
            <button
              onClick={() => setLeftSidebarCollapsed(false)}
              className="fixed top-1/2 -translate-y-1/2 left-0 z-50 bg-white shadow-lg rounded-r-lg p-1.5 hover:bg-gray-50 transition-colors border border-l-0"
              title="打开左侧栏"
            >
              <svg
                className="w-4 h-4 text-gray-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </button>
          )}

          {/* Floating Right Sidebar Toggle (when collapsed) */}
          {rightSidebarCollapsed && (
            <button
              onClick={() => setRightSidebarCollapsed(false)}
              className="fixed top-1/2 -translate-y-1/2 right-0 z-50 bg-white shadow-lg rounded-l-lg p-1.5 hover:bg-gray-50 transition-colors border border-r-0"
              title="打开右侧栏"
            >
              <svg
                className="w-4 h-4 text-gray-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
          )}

          {/* Left Sidebar */}
          <LeftSidebar
            bookId={id}
            currentPage={currentPage}
            onPageJump={(location: number | string) => {
              if (typeof location === "number") {
                setCurrentPage(location);
                saveProgress(location);
              } else {
                setJumpRequest({ dest: location, ts: Date.now() });
              }
            }}
            onBookmarksChange={loadBookmarks}
            outline={outline}
            totalPages={totalPages || book.total_pages}
            bookmarksRefreshKey={bookmarksRefreshKey}
            width={leftSidebarWidth}
            collapsed={leftSidebarCollapsed}
            onCollapse={setLeftSidebarCollapsed}
            className={`${leftSidebarCollapsed ? "w-0" : ""}`}
          />

          {/* Left Resize Handle */}
          {!leftSidebarCollapsed && (
            <div
              onMouseDown={handleLeftResizeStart}
              className="w-1 hover:w-1.5 hover:bg-gray-400 cursor-col-resize bg-gray-200 transition-all z-30 shrink-0"
            />
          )}

          {/* Center: Universal Reader */}
          <div className="flex-1 relative bg-gray-50 overflow-hidden flex flex-col min-h-0">
            {book?.format?.toLowerCase() === "pdf" ? (
              <PDFReader
                fileUrl={fileUrl}
                bookId={id}
                pageNumber={currentPage}
                totalPages={totalPages || book.total_pages}
                words={pageData?.words_data}
                textContent={pageData?.text_content}
                onWordClick={handleLookup}
                onPageChange={handlePageChange}
                onTotalPagesChange={setTotalPages}
                onOutlineChange={setOutline}
                onAskAI={handleAskAI}
                onHighlight={handleHighlight}
                onContentChange={(content) => {
                  log.debug('Visible content updated (PDF)', { length: content.length });
                  setVisibleContent(content);
                  setIsContentLoading(false); // 内容加载完成
                }}
                jumpRequest={jumpRequest}
              />
            ) : book?.format?.toLowerCase() === "epub" ||
              book?.format?.toLowerCase() === "txt" ? (
              <UniversalReader
                fileUrl={fileUrl}
                format={book.format?.toLowerCase() as "pdf" | "epub" | "txt"}
                bookId={id}
                pageNumber={currentPage}
                totalPages={totalPages || book.total_pages}
                textContent={pageData?.text_content}
                onWordClick={handleLookup}
                onPageChange={handlePageChange}
                onOutlineChange={setOutline}
                jumpRequest={jumpRequest}
                onAskAI={handleAskAI}
                onHighlight={handleHighlight}
                onContentChange={(content) => {
                  log.debug('Visible content updated (EPUB/TXT)', { length: content.length });
                  // 对于 EPUB 和 PDF，优先使用实时提取的内容
                  setVisibleContent(content);
                  setIsContentLoading(false); // 内容加载完成
                }}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500">
                不支持的格式: {book?.format}
              </div>
            )}

            {/* Floating Bookmark Button (FAB) - relative to PDF container */}
            <button
              onClick={toggleBookmark}
              className={`absolute top-4 right-4 z-50 w-12 h-12 rounded-full shadow-xl transition-all duration-300 flex items-center justify-center group hover:scale-110 ${ 
                currentPageBookmarked
                  ? "bg-gray-400 hover:bg-gray-500 text-white shadow-gray-400/50"
                  : "bg-white hover:bg-gray-50 text-gray-600 border-2 border-gray-200"
              }`}
              title={currentPageBookmarked ? "移除书签" : "添加书签"}
            >
              <div className="flex items-center justify-center">
                {currentPageBookmarked ? (
                  <svg
                    className="w-5 h-5"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"></path>
                  </svg>
                ) : (
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
                    />
                  </svg>
                )}
              </div>
              {/* Tooltip - show on left side to avoid header */}
              <span className="absolute right-full mr-2 top-1/2 -translate-y-1/2 px-2 py-1 text-xs text-white bg-gray-900 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                {currentPageBookmarked ? "移除书签" : "添加书签"}
              </span>
            </button>
          </div>

          {/* Right Resize Handle */}
          {!rightSidebarCollapsed && (
            <div
              onMouseDown={handleRightResizeStart}
              className="w-1 hover:w-1.5 hover:bg-gray-400 cursor-col-resize bg-gray-200 transition-all z-30 shrink-0"
            />
          )}

          {/* Right Sidebar */}
          <div
            className={`${ 
              rightSidebarCollapsed ? "w-0" : "" 
            } shrink-0 z-20 h-full bg-white border-l shadow-xl flex flex-col`}
            style={!rightSidebarCollapsed ? { width: rightSidebarWidth } : {}}
          >
            {/* Header with close button */}
            <div className="p-2 border-b bg-gray-50 flex items-center gap-2">
              <button
                onClick={() => setRightSidebarCollapsed(true)}
                className="p-1.5 hover:bg-gray-200 rounded text-gray-600"
                title="关闭"
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

              <div className="flex gap-1 flex-1">
                <button
                  onClick={() => setSidebarMode("dictionary")}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-1 touch-target ${ 
                    sidebarMode === "dictionary"
                      ? "bg-white text-gray-900 shadow-sm"
                      : "text-gray-600 hover:bg-gray-100"
                  }`}
                  title={SHORTCUT_TITLES.dictionary}
                  aria-label="词典侧边栏"
                  aria-pressed={sidebarMode === "dictionary"}
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
                      d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                    />
                  </svg>
                  <span>词典</span>
                </button>
                <button
                  onClick={() => setSidebarMode("ai")}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-1 touch-target ${ 
                    sidebarMode === "ai"
                      ? "bg-white text-gray-900 shadow-sm"
                      : "text-gray-600 hover:bg-gray-100"
                  }`}
                  title={SHORTCUT_TITLES.ai}
                  aria-label="AI 老师侧边栏"
                  aria-pressed={sidebarMode === "ai"}
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
                      d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                    />
                  </svg>
                  <span>老师</span>
                </button>
                <button
                  onClick={() => setSidebarMode("notes")}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-1 touch-target ${ 
                    sidebarMode === "notes"
                      ? "bg-white text-gray-900 shadow-sm"
                      : "text-gray-600 hover:bg-gray-100"
                  }`}
                  title={SHORTCUT_TITLES.notes}
                  aria-label="笔记侧边栏"
                  aria-pressed={sidebarMode === "notes"}
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
                      d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                    />
                  </svg>
                  <span>
                    笔记
                    {notes.length > 0 &&
                      ` (${notes.filter((n) => n.bookId === id).length})`}
                  </span>
                </button>
              </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-hidden">
              {/* Dictionary Sidebar - Always mounted, hidden when inactive */}
              <div
                className={`h-full ${ 
                  sidebarMode === "dictionary" ? "block" : "hidden"
                }`}
              >
                <DictionarySidebar
                  wordData={activeWord}
                  loading={loadingDict}
                  onSearch={handleLookup}
                  onAdd={handleAddWord}
                  savedWords={savedWords}
                  onDeleteWord={handleDeleteWord}
                  bookId={id}
                  currentPage={currentPage}
                  onRefresh={loadVocabulary}
                  className="h-full"
                />
              </div>

              {/* AI Teacher Sidebar - Always mounted, hidden when inactive */}
              <div
                className={`h-full ${ 
                  sidebarMode === "ai" ? "block" : "hidden"
                }`}
              >
                <AITeacherSidebar
                  className="h-full"
                  // 优先级：实时可见文本 > API 返回的全页文本
                  pageContent={visibleContent}
                  currentPage={currentPage}
                  bookTitle={book?.title || ""}
                  bookId={id}
                  externalTrigger={aiQuestion}
                  onPageChange={handlePageChange}
                  isContentLoading={isContentLoading}
                />
              </div>

              {/* Notes Sidebar - Always mounted, hidden when inactive */}
              <div
                className={`h-full ${ 
                  sidebarMode === "notes" ? "block" : "hidden"
                }`}
              >
                <NotesSidebar
                  bookId={id}
                  bookTitle={book?.title}
                  notes={notes}
                  onDeleteNote={handleDeleteNote}
                  onUpdateComment={handleUpdateComment}
                  onJumpToPage={(page) => {
                    setCurrentPage(page);
                    saveProgress(page);
                  }}
                />
              </div>
            </div>
          </div>

          {/* Left Resize Handle */}
          {!leftSidebarCollapsed && (
            <div
              onMouseDown={handleLeftResizeStart}
              className="w-1 hover:w-1.5 hover:bg-gray-400 cursor-col-resize bg-gray-200 transition-all z-30 shrink-0"
            />
          )}
        </main>
      </div>

      {/* Global Selection Toolbar */}
      {selection && (
        <SelectionToolbar
          selection={selection}
          onNote={(text, source) => {
            handleHighlight(text, currentPage, source);
          }}
          onAskAI={(text) => {
            handleAskAI(text);
            setSidebarMode('ai');
          }}
          onLookup={handleLookup}
          onCopy={async (text) => {
            await navigator.clipboard.writeText(text);
          }}
          onClear={clearSelection}
        />
      )}
    </>
  );
}

export default function ReaderPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen">Loading...</div>}>
      <ReaderContent />
    </Suspense>
  );
}
