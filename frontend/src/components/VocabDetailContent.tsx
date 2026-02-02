"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  updateVocabularyMastery,
  translateText,
  lookupWord,
  extractExamplesManual,
  checkTranslationConfigured,
} from "../lib/api";
import ContextAwareLayout from "./ContextAwareLayout";
import ClickableText from "./ClickableText";
import { useGlobalTextSelection } from "../hooks/useGlobalTextSelection";

interface VocabularyDetail {
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
    source_type?: 'user_collected' | 'example_library';
  }>;
  review_count: number;
  query_count: number;
  mastery_level: number;
  difficulty_score: number;
  priority_score: number;
  learning_status: string;
  created_at: string;
  last_queried_at?: string;
}

interface VocabDetailContentProps {
  vocabId: number;
  showBackButton?: boolean;
  backUrl?: string;
  onWordClick?: (word: string) => void;
  onLearnModeNext?: () => void;
  onLearnModePrev?: () => void;
  isLearnMode?: boolean;
  bottomBar?: React.ReactNode; // 新增
}

const TRANSLATION_CACHE_KEY = "translation_cache";

const cleanSentenceForSearch = (sentence: string) => {
  if (!sentence) return "";
  // 去除首尾的引号、空白
  return sentence.replace(/^["'“‘]+|["'”’]+$/g, "").trim();
};

export default function VocabDetailContent({
  vocabId,
  showBackButton = true,
  backUrl = "/vocabulary",
  onWordClick: _onWordClick,
  onLearnModeNext: _onLearnModeNext,
  onLearnModePrev: _onLearnModePrev,
  isLearnMode = false,
  bottomBar,
}: VocabDetailContentProps) {
  const router = useRouter();
  const [vocab, setVocab] = useState<VocabularyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [markingMastered, setMarkingMastered] = useState(false);
  const [translationMap, setTranslationMap] = useState<{ [key: string]: string }>({});
  const [translatingSet, setTranslatingSet] = useState<Set<string>>(new Set());
  const [failedSet, setFailedSet] = useState<Set<string>>(new Set());
  const [extracting, setExtracting] = useState(false);
  const [recentlyAddedWords, setRecentlyAddedWords] = useState<any[]>([]);

  // 侧边栏状态
  const [rightSidebarMode, setRightSidebarMode] = useState<'dictionary' | 'ai' | 'notes'>('dictionary');
  const [rightSidebarWidth, setRightSidebarWidth] = useState(600);
  const [rightSidebarExpanded, setRightSidebarExpanded] = useState(false); // 新增：控制侧边栏展开
  const [activeWord, setActiveWord] = useState<any | null>(null);
  const [loadingDict, setLoadingDict] = useState(false);
  const [notes, setNotes] = useState<any[]>([]);
  const [aiQuestion, setAiQuestion] = useState<string | undefined>(undefined);

  // Load notes from localStorage
  useEffect(() => {
    const savedNotes = localStorage.getItem(`notes-vocab-${vocabId}`);
    if (savedNotes) {
      try {
        setNotes(JSON.parse(savedNotes));
      } catch (e) {
        console.error("Failed to parse notes:", e);
      }
    }
  }, [vocabId]);

  // Save notes to localStorage
  useEffect(() => {
    if (notes.length > 0) {
      localStorage.setItem(`notes-vocab-${vocabId}`, JSON.stringify(notes));
    } else if (vocabId) {
      // Remove localStorage when all notes are deleted, but check vocabId first to avoid clearing on initial empty load
      const key = `notes-vocab-${vocabId}`;
      if (localStorage.getItem(key)) {
         localStorage.removeItem(key);
      }
    }
  }, [notes, vocabId]);

  // 全局选择
  const { selection, clearSelection } = useGlobalTextSelection(true, [
    '[data-selection-toolbar]',
    'button',
  ]);

  // 合并主单词和临时添加的单词
  const savedWords = useMemo(() => {
    const mainList = vocab ? [vocab] : [];
    const addedList = recentlyAddedWords.filter(w => !mainList.some(m => m.id === w.id));
    return [...mainList, ...addedList];
  }, [vocab, recentlyAddedWords]);

  // 构造发送给 AI 老师的完整上下文
  const fullPageContent = useMemo(() => {
    if (!vocab) return "";
    
    let content = `[当前学习单词]: ${vocab.word}\n`;
    if (vocab.phonetic) content += `[音标]: /${vocab.phonetic}/\n`;
    if (vocab.translation) content += `[释义]: ${vocab.translation}\n`;
    
    if (vocab.primary_context?.context_sentence) {
      content += `\n[主要语境]:\n"${vocab.primary_context.context_sentence}"\n(出自: ${vocab.primary_context.book_title || "未知来源"})\n`;
    }
    
    if (vocab.example_contexts && vocab.example_contexts.length > 0) {
      content += `\n[其他参考例句]:\n`;
      vocab.example_contexts.slice(0, 5).forEach((ctx, index) => {
        if (ctx.context_sentence) {
          content += `${index + 1}. "${ctx.context_sentence}"\n`;
        }
      });
    }
    
    return content;
  }, [vocab]);

  // 查词典
  const handleLookup = useCallback(async (word: string, sourceOrContext?: string) => {
    if (!word || !word.trim()) return;

    setRightSidebarMode("dictionary");
    setRightSidebarExpanded(true); // 自动展开侧边栏
    setLoadingDict(true);
    
    // Check if sourceOrContext is a dictionary source ID (short) or a context sentence (long)
    // Known sources are usually 2-4 chars like "韦氏", "牛津", "朗文当代"
    const isSourceId = sourceOrContext && sourceOrContext.length < 10;
    const source = isSourceId ? sourceOrContext : undefined;
    const context = !isSourceId ? sourceOrContext : vocab?.primary_context?.context_sentence || '';

    setActiveWord({ word, context_sentence: context, source });

    try {
      const data = await lookupWord(word, source);
      setActiveWord({
        ...(data || { word, meanings: [] }),
        context_sentence: context,
        source: data?.source || source, // Ensure source is preserved if returned or fallback
      });
    } catch (e) {
      console.error(e);
      setActiveWord({
        word,
        meanings: [],
        context_sentence: context,
        source,
      });
    } finally {
      setLoadingDict(false);
    }
  }, [vocab]);

  // 加载翻译缓存
  useEffect(() => {
    try {
      const cached = localStorage.getItem(TRANSLATION_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        const validCache: {[key: string]: string} = {};
        let hasInvalid = false;

        Object.keys(parsed).forEach(key => {
          if (typeof parsed[key] === 'string') {
            validCache[key] = parsed[key];
          } else {
            hasInvalid = true;
          }
        });

        setTranslationMap(validCache);

        if (hasInvalid) {
          localStorage.setItem(TRANSLATION_CACHE_KEY, JSON.stringify(validCache));
        }
      }
    } catch (e) {
      console.error("Failed to load translation cache:", e);
      localStorage.removeItem(TRANSLATION_CACHE_KEY);
    }
  }, []);

  // 自动翻译
  const autoTranslate = useCallback(
    async (sentence: string) => {
      if (!sentence) return;

      setTranslatingSet((prev) => {
        if (prev.has(sentence)) return prev;
        const next = new Set(prev);
        next.add(sentence);
        return next;
      });

      try {
        const transResult = await translateText(sentence);
        const trans = transResult?.translation;

        if (trans) {
          setTranslationMap((prev) => {
            const updated = { ...prev, [sentence]: trans };
            try {
              localStorage.setItem(TRANSLATION_CACHE_KEY, JSON.stringify(updated));
            } catch (e) {
              console.error("Failed to save translation cache:", e);
            }
            return updated;
          });
        }
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.error(`翻译失败 [${sentence.substring(0, 30)}...]:`, errorMessage);
        // 记录失败，避免无限重试
        setFailedSet((prev) => {
            if (prev.has(sentence)) return prev;
            const next = new Set(prev);
            next.add(sentence);
            return next;
        });
      } finally {
        setTranslatingSet((prev) => {
          if (!prev.has(sentence)) return prev;
          const next = new Set(prev);
          next.delete(sentence);
          return next;
        });
      }
    },
    [],
  );

  const [isTranslationConfigured, setIsTranslationConfigured] = useState<boolean>(false);

  // 检查翻译服务配置
  useEffect(() => {
    const checkConfig = async () => {
        const configured = await checkTranslationConfigured();
        setIsTranslationConfigured(configured);
    };
    checkConfig();
  }, []);

  // 自动翻译所有句子
  useEffect(() => {
    // 只有在明确检测到已配置的情况下才进行自动翻译
    if (!vocab || loading || !isTranslationConfigured) return;

    const sentences: string[] = [];
    if (vocab.primary_context?.context_sentence) {
      sentences.push(vocab.primary_context.context_sentence);
    }
    vocab.example_contexts.forEach((ctx) => {
      if (ctx.context_sentence) {
        sentences.push(ctx.context_sentence);
      }
    });

    const nextToTranslate = sentences.find(s => !translationMap[s] && !translatingSet.has(s) && !failedSet.has(s));

    if (nextToTranslate) {
      const timer = setTimeout(() => {
        autoTranslate(nextToTranslate);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [vocab, translationMap, translatingSet, failedSet, autoTranslate, loading, isTranslationConfigured]);

  const loadVocab = useCallback(async () => {
    try {
      setLoading(true);
      const { getVocabularyDetail } = await import("../lib/api");
      const data = await getVocabularyDetail(vocabId);
      setVocab(data);
    } catch (e) {
      console.error(e);
      setVocab(null);
    } finally {
      setLoading(false);
    }
  }, [vocabId]);

  // 加载单词详情
  useEffect(() => {
    loadVocab();
  }, [loadVocab]);

  const handleMarkMastered = async () => {
    if (!vocab) return;
    setMarkingMastered(true);
    try {
      await updateVocabularyMastery(vocab.id, {
        mastery_level: 5,
        review_count: vocab.review_count + 1,
        last_reviewed_at: new Date().toISOString(),
      });
      alert("已标记为掌握");
      loadVocab();
    } catch (e) {
      console.error(e);
      alert("操作失败");
    } finally {
      setMarkingMastered(false);
    }
  };

  const handleAskAI = useCallback((text: string) => {
    setAiQuestion(text);
    setRightSidebarMode("ai");
    setRightSidebarExpanded(true); // 自动展开侧边栏
  }, []);

  const handleHighlight = useCallback((text: string, source?: string) => {
    const newNote = {
      id: `note-${Date.now()}`,
      bookId: `vocab-${vocabId}`, // Fixed: Ensure ID matches ContextAwareLayout's bookId prop
      pageNumber: 1,
      highlightedText: text,
      comment: source ? `来源: ${source}` : "",
      createdAt: Date.now(),
      color: "#fef08a",
    };
    setNotes(prev => [newNote, ...prev]);
    setRightSidebarMode("notes");
    setRightSidebarExpanded(true); // 自动展开侧边栏
  }, [vocabId]);

  const handleDeleteWord = useCallback(async (wordId: any) => {
    try {
      if (vocab && vocab.id === wordId) {
        const { deleteVocabulary } = await import("../lib/api");
        await deleteVocabulary(wordId);
        router.push("/vocabulary");
      } else {
        const { deleteVocabulary } = await import("../lib/api");
        await deleteVocabulary(wordId);
        setRecentlyAddedWords(prev => prev.filter(w => w.id !== wordId));
      }
    } catch (e) {
      console.error(e);
      alert("删除失败");
    }
  }, [router, vocab]);

  const handleAddWord = useCallback(async (word: any, data: any) => {
    try {
      const { addVocabulary } = await import("../lib/api");
      const newItem = await addVocabulary({
        word: word,
        book_id: vocab?.primary_context?.book_id,
        context_sentence: data.context_sentence || vocab?.primary_context?.context_sentence || "",
        definition: {
          meanings: data.meanings,
          source: data.source,
          phonetic: data.phonetic,
          chinese_summary: data.chinese_translation,
        },
        translation: data.chinese_translation,
        page_number: vocab?.primary_context?.page_number || 0,
      });
      setRecentlyAddedWords(prev => [...prev, newItem]);
    } catch (e) {
      console.error(e);
      alert("添加失败");
    }
  }, [vocab]);

  const handleDeleteNote = useCallback((noteId: any) =>
    setNotes(prev => prev.filter(note => note.id !== noteId)), []);

  const handleUpdateComment = useCallback((noteId: any, comment: any) =>
    setNotes(prev => prev.map(note => note.id === noteId ? {...note, comment} : note)), []);

  const handleJumpToPage = useCallback((page: number) => {
    if (vocab?.primary_context?.book_id) {
      router.push(`/read?id=${vocab.primary_context.book_id}&page=${page}`);
    }
  }, [vocab?.primary_context?.book_id, router]);

  const handleSelectionNote = useCallback((text: string, source?: string) => {
    const newNote = {
      id: `note-${Date.now()}`,
      bookId: `vocab-${vocabId}`, // Fixed: Ensure ID matches ContextAwareLayout's bookId prop
      pageNumber: 1,
      highlightedText: text,
      comment: source ? `来源: ${source}` : "",
      createdAt: Date.now(),
      color: "#fef08a",
    };
    setNotes(prev => [newNote, ...prev]);
    setRightSidebarMode("notes");
    setRightSidebarExpanded(true); // 自动展开侧边栏
  }, [vocabId]);

  const handleSelectionAskAI = useCallback((text: string, _source?: string) => {
    setAiQuestion(`请讲解一下这段内容：\n\n"${text}"`);
    setRightSidebarMode("ai");
    setRightSidebarExpanded(true); // 自动展开侧边栏
  }, []);

  const handleExtractExamples = useCallback(async () => {
    if (!vocab) return;
    setExtracting(true);
    try {
      const result = await extractExamplesManual(vocab.id);

      if (result.status === "skipped") {
        alert(result.message || "已达到例句上限");
      } else {
        // 等待至少1秒，让后台任务有时间开始
        await new Promise(resolve => setTimeout(resolve, 1000));
        loadVocab();
      }
    } catch (e) {
      console.error(e);
      alert("无法启动提取任务");
    } finally {
      setExtracting(false);
    }
  }, [vocab, loadVocab]);

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-gray-500">加载中...</div>
      </div>
    );
  }

  if (!vocab) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-gray-500">生词不存在</div>
      </div>
    );
  }

  const renderContent = () => (
    <main className="max-w-4xl mx-auto pb-24">
      <div className="mb-10 text-center md:text-left pl-8">
        <div className="flex flex-col md:flex-row md:items-baseline md:gap-4 mb-4">
          <h2 className="text-5xl md:text-6xl font-bold text-gray-900 tracking-tight">
            {vocab.word}
          </h2>
          {vocab.phonetic && (
            <span className="text-2xl text-gray-400 font-mono font-light">
              /{vocab.phonetic}/
            </span>
          )}
        </div>
        
        <p className="text-xl md:text-2xl text-gray-700 leading-relaxed font-medium mb-6">
          {vocab.translation ||
            vocab.definition?.meanings?.[0]?.definition ||
            "暂无释义"}
        </p>

        <div className="flex flex-wrap gap-2 justify-center md:justify-start">
          <div className="px-3 py-1 bg-gray-100 rounded-full text-xs font-medium text-gray-500">
            查询 {vocab.query_count}
          </div>
          <div className="px-3 py-1 bg-gray-100 rounded-full text-xs font-medium text-gray-500">
            复习 {vocab.review_count}
          </div>
          <div className="px-3 py-1 bg-gray-100 rounded-full text-xs font-medium text-gray-500">
            权重 {vocab.priority_score.toFixed(0)}
          </div>
        </div>
      </div>

      {vocab.primary_context && (
        <div className="mb-10 relative group pl-8">
          <div className="">
            <p className="text-xl md:text-2xl text-gray-900 font-serif italic leading-relaxed mb-4">
                &ldquo;<ClickableText text={vocab.primary_context.context_sentence || ""} onWordClick={handleLookup} />&rdquo;
              </p>

            {vocab.primary_context.context_sentence &&
              (translationMap[vocab.primary_context.context_sentence] ? (
                <p className="text-gray-500 text-base mb-4 leading-relaxed">
                  {translationMap[vocab.primary_context.context_sentence]}
                </p>
              ) : translatingSet.has(vocab.primary_context.context_sentence) ? (
                <p className="text-gray-400 text-sm mb-4 flex items-center gap-2">
                  <span className="animate-spin rounded-full h-3 w-3 border-b border-gray-400"></span>
                  翻译中...
                </p>
              ) : null)}

            <div className="flex items-center gap-2 text-xs text-gray-400 font-medium pt-3 mt-4">
              <span className="truncate max-w-[200px]" title={vocab.primary_context.book_title}>
                {vocab.primary_context.book_title}
              </span>
              <span className="w-1 h-1 rounded-full bg-gray-300"></span>
              <span>第{vocab.primary_context.page_number}页</span>
              
              <button
                onClick={() =>
                  router.push(
                    `/read?backUrl=${encodeURIComponent(window.location.pathname + window.location.search)}&id=${vocab.primary_context!.book_id}&page=${vocab.primary_context!.page_number}&text=${encodeURIComponent(cleanSentenceForSearch(vocab.primary_context!.context_sentence || ""))}&word=${encodeURIComponent(vocab.word)}`
                  )
                }
                className="ml-auto text-gray-400 hover:text-blue-600 transition-colors p-1"
                title="查看原文"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}


      <div className="mt-12">
        <div className="flex items-center justify-between mb-8 border-b border-gray-100 pb-2">
          <div className="text-xs font-mono text-gray-300 tracking-widest uppercase pl-8">
            EXAMPLES
            <span className="ml-2 text-gray-400 font-sans normal-case">
              ({vocab.example_contexts?.length || 0}/20)
            </span>
          </div>
          {vocab.example_contexts && vocab.example_contexts.length < 20 && (
            <button
              onClick={handleExtractExamples}
              disabled={extracting}
              className="p-1.5 text-gray-400 hover:text-gray-600 disabled:text-gray-300 transition-colors rounded-full hover:bg-gray-100"
              title={extracting ? "提取中..." : "从书库中查找更多例句"}
            >
              <svg className={`w-4 h-4 ${extracting ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          )}
        </div>

        {vocab.example_contexts && vocab.example_contexts.length > 0 ? (
          <div className="space-y-10">
            {vocab.example_contexts.map((ctx, index) => (
              <div key={`${ctx.book_id}-${ctx.page_number}-${index}`} className="group relative pl-8">
                <span className="absolute left-0 top-1 text-xs font-mono text-gray-300 group-hover:text-gray-400 transition-colors select-none">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <p className="text-lg text-gray-800 font-serif italic mb-3 leading-relaxed group-hover:text-gray-900 transition-colors">
                  &ldquo;<ClickableText text={ctx.context_sentence || ""} onWordClick={handleLookup} />&rdquo;
                </p>

                {ctx.context_sentence &&
                  (translationMap[ctx.context_sentence] ? (
                    <p className="text-gray-500 text-sm mb-3 leading-relaxed">
                      {translationMap[ctx.context_sentence]}
                    </p>
                  ) : translatingSet.has(ctx.context_sentence) ? (
                    <p className="text-gray-400 text-xs mb-3">翻译中...</p>
                  ) : null)}

                <div className="flex items-center justify-between text-xs text-gray-400 mt-2">
                  <div className="flex items-center gap-2 truncate">
                    <span className="font-medium text-gray-500 truncate max-w-[300px]">{ctx.book_title}</span>
                    <span className="shrink-0">· 第{ctx.page_number}页</span>
                  </div>
                                      <button
                                          onClick={() =>
                                            router.push(
                                              `/read?backUrl=${encodeURIComponent(window.location.pathname + window.location.search)}&id=${ctx.book_id}&page=${ctx.page_number}&text=${encodeURIComponent(cleanSentenceForSearch(ctx.context_sentence || ""))}&word=${encodeURIComponent(vocab.word)}`
                                            )
                                          }                    className="ml-2 text-gray-400 hover:text-blue-600 transition-colors p-1 shrink-0"
                    title="查看原文"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="pl-8 py-8 text-center md:text-left">
            <p className="text-gray-400 text-sm italic">
              {vocab.example_contexts && vocab.example_contexts.length >= 20
                ? "已达到例句上限（20个）。"
                : "暂无更多例句。点击上方刷新按钮从书库中提取更多例句。"}
            </p>
          </div>
        )}
      </div>

    </main>
  );

  // 学习模式的特殊布局
  if (isLearnMode) {
    return (
      <ContextAwareLayout
        className={isLearnMode ? "h-full" : "h-screen"}
        title={showBackButton ? vocab.word : undefined}
        backUrl={backUrl}
        bookId={`vocab-${vocab.id}`}
        currentPage={vocab.primary_context?.page_number || 1}
        pageContent={fullPageContent}
        bookTitle={vocab.primary_context?.book_title || ""}
        rightSidebarMode={rightSidebarMode}
        onSidebarModeChange={setRightSidebarMode}
        onWordClick={handleLookup}
        onAskAI={handleAskAI}
        onHighlight={handleHighlight}
        savedWords={savedWords}
        onDeleteWord={handleDeleteWord}
        onAddWord={handleAddWord}
        notes={notes}
        onDeleteNote={handleDeleteNote}
        onUpdateComment={handleUpdateComment}
        onJumpToPage={handleJumpToPage}
        activeWord={activeWord}
        loadingDict={loadingDict}
        rightSidebarWidth={rightSidebarWidth}
        onRightSidebarWidthChange={setRightSidebarWidth}
        rightSidebarExpanded={rightSidebarExpanded}
        onRightSidebarExpand={setRightSidebarExpanded}
        enableGlobalSelection={true}
        selection={selection}
        onSelectionLookup={handleLookup}
        onSelectionNote={handleSelectionNote}
        onSelectionAskAI={handleSelectionAskAI}
        onClearSelection={clearSelection}
        externalTrigger={aiQuestion}
        bottomBar={bottomBar}
      >
        {renderContent()}
      </ContextAwareLayout>
    );
  }

  // 普通模式的完整布局
  return (
    <ContextAwareLayout
      title={vocab.word}
      backUrl={backUrl}
      bookId={`vocab-${vocab.id}`}
      currentPage={vocab.primary_context?.page_number || 1}
      pageContent={fullPageContent}
      bookTitle={vocab.primary_context?.book_title || ""}
      rightSidebarMode={rightSidebarMode}
      onSidebarModeChange={setRightSidebarMode}
      onWordClick={handleLookup}
      onAskAI={handleAskAI}
      onHighlight={handleHighlight}
      savedWords={savedWords}
      onDeleteWord={handleDeleteWord}
      onAddWord={handleAddWord}
      notes={notes}
      onDeleteNote={handleDeleteNote}
      onUpdateComment={handleUpdateComment}
      onJumpToPage={handleJumpToPage}
        activeWord={activeWord}
        loadingDict={loadingDict}
        rightSidebarWidth={rightSidebarWidth}
        onRightSidebarWidthChange={setRightSidebarWidth}
        rightSidebarExpanded={rightSidebarExpanded}
        onRightSidebarExpand={setRightSidebarExpanded}
        enableGlobalSelection={true}
      selection={selection}
      onSelectionLookup={handleLookup}
      onSelectionNote={handleSelectionNote}
      onSelectionAskAI={handleSelectionAskAI}
      onClearSelection={clearSelection}
      externalTrigger={aiQuestion}
      bottomBar={bottomBar}
    >
      {renderContent()}
    </ContextAwareLayout>
  );
}
