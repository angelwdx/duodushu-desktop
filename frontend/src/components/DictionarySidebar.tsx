"use client";

import { useEffect, useState, useRef, useMemo, memo, useCallback } from "react";
import DictionaryContent from "./DictionaryContent";

interface Definition {
  definition: string;
  example?: string;
}

interface Meaning {
  partOfSpeech: string;
  definitions: Definition[];
}

interface DictionaryData {
  word: string;
  phonetic?: string;
  audio_url?: string;
  meanings?: Meaning[];
  html_content?: string;
  source?: string;
  chinese_summary?: string;
  chinese_translation?: string;
  has_audio?: boolean;
  context_sentence?: string;
}

interface DictionarySidebarProps {
  wordData: DictionaryData | null;
  loading: boolean;
  onSearch: (word: string, source?: string) => void;
  onAdd: (word: string, data: DictionaryData) => Promise<void>;
  savedWords?: any[];
  onDeleteWord?: (wordId: number) => Promise<void>;
  className?: string;
  bookId?: string;
  currentPage?: number;
  onRefresh?: () => void;
}

function DictionarySidebar({
  wordData,
  loading,
  onSearch,
  onAdd,
  savedWords = [],
  onDeleteWord,
  className = "",
  bookId: _bookId,
  currentPage: _currentPage,
  onRefresh: _onRefresh,
}: DictionarySidebarProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [translationMap, setTranslationMap] = useState<{
    [key: string]: string;
  }>({});
  const [isTranslating, setIsTranslating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const translateAbortControllerRef = useRef<AbortController | null>(null);
  const translateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 播放单词发音（使用Edge TTS）
  const playWordAudio = async () => {
    if (!wordData?.word) return;

    try {
      const { streamSpeech } = await import("../lib/api");
      // 随机美音voice列表（与playTTSFallback保持一致）
      const usVoices = [
        "en-US-MichelleNeural",
        "en-US-AriaNeural",
        "en-US-JennyNeural",
        "en-US-GuyNeural",
        "en-US-ChristopherNeural",
        "en-US-EricNeural",
        "en-US-RogerNeural",
      ];
      const randomVoice = usVoices[Math.floor(Math.random() * usVoices.length)];
      const blobUrl = await streamSpeech(wordData.word, randomVoice);
      const audio = new Audio(blobUrl);
      audio.onended = () => URL.revokeObjectURL(blobUrl);
      await audio.play();
    } catch (err) {
      console.error("Failed to play word audio:", err);
    }
  };

  // 从 localStorage 加载翻译缓存
  const loadTranslationCache = useCallback((): { [key: string]: string } => {
    try {
      const cached = localStorage.getItem("translation_cache");
      if (!cached) return {};
      
      const parsed = JSON.parse(cached);
      const sanitized: { [key: string]: string } = {};
      
      // Sanitize: ensure all values are strings
      Object.entries(parsed).forEach(([key, value]) => {
        if (typeof value === "string") {
          sanitized[key] = value;
        } else if (value && typeof value === "object" && "translation" in value) {
          // Handle { translation: "...", source: "..." } structure
          sanitized[key] = (value as any).translation;
        }
      });
      
      return sanitized;
    } catch (e) {
      console.error("Failed to load translation cache:", e);
      return {};
    }
  }, []);

  // 保存翻译缓存到 localStorage
  const saveTranslationCache = useCallback(
    (cache: { [key: string]: string }) => {
      try {
        localStorage.setItem("translation_cache", JSON.stringify(cache));
      } catch (e) {
        console.error("Failed to save translation cache:", e);
      }
    },
    [],
  );

  // 初始化缓存
  useEffect(() => {
    const cached = loadTranslationCache();
    setTranslationMap(cached);
  }, [loadTranslationCache]);

  // 清理过期的缓存（保留最近 500 条）
  useEffect(() => {
    const cleanExpiredCache = () => {
      const cached = loadTranslationCache();
      const entries = Object.entries(cached);
      if (entries.length > 500) {
        const trimmed = Object.fromEntries(entries.slice(-500));
        saveTranslationCache(trimmed);
      }
    };

    cleanExpiredCache();
  }, [loadTranslationCache, saveTranslationCache]);

  // 自动翻译逻辑
  const [isTranslationConfigured, setIsTranslationConfigured] = useState<boolean>(false);

  // 检查翻译服务配置
  useEffect(() => {
    const checkConfig = async () => {
       try {
        const { checkTranslationConfigured } = await import("../lib/api");
        const configured = await checkTranslationConfigured();
        setIsTranslationConfigured(configured);
       } catch (e) {
         console.error("Failed to check translation config:", e);
       }
    };
    checkConfig();
  }, []);

  const autoTranslateSentence = useCallback(
    async (sentence: string) => {
      if (!sentence || !sentence.trim()) return;

      // 如果未配置翻译服务，直接跳过，避免报错
      if (!isTranslationConfigured) return;

      // 检查缓存
      if (translationMap[sentence]) {
        return;
      }

      // 取消之前的请求和定时器
      if (translateAbortControllerRef.current) {
        translateAbortControllerRef.current.abort();
      }
      if (translateTimeoutRef.current) {
        clearTimeout(translateTimeoutRef.current);
      }

      // 设置延迟执行
      translateTimeoutRef.current = setTimeout(async () => {
        const controller = new AbortController();
        translateAbortControllerRef.current = controller;

        setIsTranslating(true);

        try {
          const { translateText } = await import("../lib/api");
          const transResult = await translateText(sentence);
          
          // transResult is { translation: string, source: string }
          const trans = transResult?.translation;

          // 保存到状态和缓存
          if (trans) {
            setTranslationMap((prev) => {
               const newCache = { ...prev, [sentence]: trans };
               saveTranslationCache(newCache);
               return newCache;
            });
          }
        } catch (e) {
          // 如果是取消操作，不显示错误
          if ((e as Error).name !== "AbortError") {
            const msg = (e as Error).message;
            // 忽略特定的 500 错误，避免控制台刷屏
            if (!msg.includes("500") && !msg.includes("Translation returned empty")) {
                 console.error("Translation failed:", e);
            }
          }
        } finally {
          setIsTranslating(false);
          translateAbortControllerRef.current = null;
        }
      }, 500);
    },
    [translationMap, saveTranslationCache, isTranslationConfigured],
  );

  // 监听 context_sentence 变化，触发自动翻译
  useEffect(() => {
    if (wordData?.context_sentence) {
      autoTranslateSentence(wordData.context_sentence);
    }

    // Cleanup: 清理定时器和请求
    return () => {
      if (translateTimeoutRef.current) {
        clearTimeout(translateTimeoutRef.current);
      }
      if (translateAbortControllerRef.current) {
        translateAbortControllerRef.current.abort();
      }
    };
  }, [wordData?.context_sentence, autoTranslateSentence]);

  // 跟踪当前单词是否在 savedWords 中（用于图标状态更新）
  const isCurrentWordSaved = useMemo(() => {
    // 统一转换为小写并去空，确保比较的稳健性
    const currentWord = wordData?.word?.trim().toLowerCase();
    if (!currentWord) return false;
    
    // 遍历检查，同时对 savedWords 中的单词也做同样的标准化处理
    return savedWords.some((w) => {
        const savedWord = w.word?.trim().toLowerCase();
        return savedWord === currentWord;
    });
  }, [savedWords, wordData?.word]);

  // 词典源状态
  const [sources, setSources] = useState<{ id: string; label: string }[]>([]);

  const [activeTab, setActiveTab] = useState<string>("");

  // 加载词典列表
  useEffect(() => {
    const fetchDicts = async () => {
      try {
        // 使用正确的 API URL
        const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
        const res = await fetch(`${API_URL}/api/dicts/?_t=${Date.now()}`);
        if (res.ok) {
          const dicts = await res.json();
          
          // 只过滤出用户导入的词典(不包括ECDICT内置词典)
          const importedDicts = dicts
            .filter((d: any) => d.type === "imported" && d.is_active)
            .map((d: any) => ({ id: d.name, label: d.name }));

          setSources(importedDicts);

          if (importedDicts.length > 0) {
            // 默认选择第一个词典
            if (!activeTab || !importedDicts.some((s: any) => s.id === activeTab)) {
              setActiveTab(importedDicts[0].id);
            }
          } else {
             setActiveTab("");
          }
        }
      } catch (e) {
        console.error("Failed to load dicts:", e);
      }
    };

    fetchDicts();

    // 每 2 秒刷新一次词典列表，确保能及时显示启用/禁用的词典
    const interval = setInterval(fetchDicts, 2000);

    return () => clearInterval(interval);
  }, []);

  // 同步 activeTab
  useEffect(() => {
    // 单词典结果时,同步到对应的词典标签
    if (wordData?.source && sources.some((s) => s.id === wordData.source)) {
      setActiveTab(wordData.source);
    }
    // 注意:不再在 multiple_sources 时清空 activeTab,保持用户选择
  }, [wordData?.source, sources]);

  // 同步 Search Term
  useEffect(() => {
    if (wordData?.word) {
      setSearchTerm(wordData.word);
    }
  }, [wordData]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchTerm.trim()) {
      onSearch(searchTerm.trim(), activeTab);
    }
  };

  const isMdxContent = wordData?.html_content || (wordData as any)?.is_ecdict;

  return (
    <div
      className={`flex flex-col bg-white border-l h-full shadow-lg ${className}`}
    >
      {/* Header: Search */}
      <div className="p-3 border-b bg-white">
        <form onSubmit={handleSearch} className="relative">
          <input
            ref={inputRef}
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="搜索词典..."
            className="w-full px-4 py-2 pr-10 bg-gray-50 border border-transparent rounded-xl focus:outline-none focus:bg-white focus:border-gray-200 transition-all text-xs"
          />
          <button
            type="submit"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
            title="搜索"
          >
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
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </button>
        </form>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-auto custom-scrollbar relative">
        {/* 
          Loading Logic:
          1. If wordData exists: Always show it (optimistic UI). 
             If loading is ALSO true, we show a spinner ONLY in the bottom content area.
          2. If NO wordData and loading is true: Show full screen spinner.
          3. Else: Show empty state / list.
        */}
        {wordData ? (
          <div className="p-5">
            <button
              onClick={() => onSearch("")}
              className="mb-4 text-xs font-medium text-gray-400 hover:text-blue-600 flex items-center gap-1 transition-colors"
            >
              <span>←</span> Back to List
            </button>

            {/* Word Header */}
            <div className="mb-6">
              <div className="flex justify-between items-start gap-4">
                <div className="flex-1">
                  <h2 className="text-2xl font-bold text-gray-900 leading-tight">
                    {wordData.word}
                  </h2>
                  {wordData.phonetic && (
                    <div
                      className="ipa-phonetic text-slate-500 font-medium tracking-wide text-sm mt-1"
                    >
                      /{wordData.phonetic}/
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {wordData.word ? (
                    <button
                      onClick={
                        wordData.audio_url
                          ? () => new Audio(wordData.audio_url).play()
                          : playWordAudio
                      }
                      className="p-2 hover:bg-gray-100 rounded-full text-gray-600 transition-colors"
                      title="Play Pronunciation"
                    >
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
                          d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"
                        />
                      </svg>
                    </button>
                  ) : null}
                  <button
                    onClick={async () => {
                      // 这里主要依赖 savedWords prop 的更新来驱动 UI 变化
                      // 由于 DictionaryContent 是 memo 的，所以即使父组件重渲染，内容部分也不会重置
                      const existingWord = savedWords.find(
                        (w) =>
                          w.word.toLowerCase() === wordData.word.toLowerCase(),
                      );
                      if (existingWord) {
                        await onDeleteWord?.(existingWord.id);
                      } else {
                        try {
                          await onAdd(wordData.word, wordData);
                        } catch (e) {
                          const errorMessage = e instanceof Error ? e.message : "未知错误";
                          alert(`收藏失败: ${errorMessage}`);
                        }
                      }
                    }}
                    className={`p-2 rounded-full transition-colors outline-none focus:outline-none ${
                      isCurrentWordSaved
                        ? "text-yellow-500 hover:bg-yellow-50"
                        : "text-gray-400 hover:text-yellow-500 hover:bg-gray-50"
                    }`}
                    title={
                      isCurrentWordSaved
                        ? "Remove from Vocabulary"
                        : "Add to Vocabulary"
                    }
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={
                        isCurrentWordSaved
                          ? "fill-yellow-400 stroke-yellow-400"
                          : "fill-none"
                      }
                    >
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            {/* Chinese Translation (from ECDICT) */}
            {wordData.chinese_translation && (
              <div className="mb-4 p-3 bg-linear-to-br from-blue-50 to-indigo-50 text-gray-800 rounded-lg text-sm leading-relaxed border border-blue-100 shadow-sm">
                {wordData.chinese_translation}
              </div>
            )}

            {/* Context Sentence */}
            {wordData.context_sentence && (
              <div className="mb-4 px-3 py-2 bg-amber-50/70 text-gray-700 rounded-lg border border-amber-100/80 text-sm group shadow-sm">
                <div className="flex gap-2 items-start">
                  <div className="flex-1 min-w-0">
                    <p className="italic leading-relaxed font-serif text-gray-700 text-base">
                      &quot;{wordData.context_sentence}&quot;
                    </p>
                    {/* 翻译结果内嵌显示 */}
                    {translationMap[wordData.context_sentence] && (
                      <p className="text-gray-500 text-sm mt-1 leading-relaxed">
                        {translationMap[wordData.context_sentence]}
                      </p>
                    )}
                    {isTranslating &&
                      !translationMap[wordData.context_sentence] && (
                        <p className="text-gray-400 text-xs mt-1 flex items-center gap-1">
                          <span className="animate-spin rounded-full h-2.5 w-2.5 border-b border-blue-400"></span>
                          翻译中...
                        </p>
                      )}
                  </div>
                  {/* 朗读按钮 */}
                  <div className="shrink-0 opacity-40 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={async () => {
                        try {
                          const { streamSpeech } = await import("../lib/api");
                          // Random American English voices
                          const voices = [
                            "en-US-AriaNeural",
                            "en-US-GuyNeural",
                            "en-US-JennyNeural",
                            "en-US-ChristopherNeural",
                            "en-US-EricNeural",
                            "en-US-MichelleNeural",
                            "en-US-RogerNeural",
                            "en-US-SteffanNeural",
                          ];
                          const randomVoice =
                            voices[Math.floor(Math.random() * voices.length)];

                          const blobUrl = await streamSpeech(
                            wordData.context_sentence!,
                            randomVoice,
                          );
                          const audio = new Audio(blobUrl);
                          audio.onended = () => URL.revokeObjectURL(blobUrl);
                          await audio.play();
                        } catch (e) {
                          console.error(e);
                        }
                      }}
                      className="p-1 text-gray-500 hover:text-gray-700 hover:bg-amber-100 rounded transition-colors"
                      title="朗读句子"
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
                          d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            )}


            {/* 词典切换 Tabs - 始终显示可点击的标签 */}
            {sources.length > 0 && (
              <div className="flex items-center gap-2 mb-4 border-b pb-2 overflow-x-auto no-scrollbar">
                {sources.map((source) => (
                  <button
                    key={source.id}
                    onClick={() => {
                      if (activeTab === source.id) return;
                      setActiveTab(source.id);
                      if (wordData?.word) {
                        onSearch(wordData.word, source.id);
                      }
                    }}
                    disabled={loading}
                    className={`
                      px-3 py-1.5 text-xs font-medium rounded-full transition-all whitespace-nowrap
                      ${
                        activeTab === source.id
                          ? "bg-gray-900 text-white shadow-sm"
                          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                      }
                      ${loading ? "opacity-50 cursor-not-allowed" : ""}
                    `}
                  >
                    {source.label}
                  </button>
                ))}
              </div>
            )}



            {/* Content Display */}
            {/* 当没有启用的导入词典时，显示提示 */}
            {sources.length === 0 && !(wordData as any)?.multiple_sources ? (
              <div className="min-h-[200px] flex flex-col items-center justify-center text-center py-12">
                <div className="w-16 h-16 mb-4 text-gray-300">
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                  </svg>
                </div>
                <p className="text-gray-500 text-sm mb-2">暂无启用的导入词典</p>
                <p className="text-gray-400 text-xs">
                  前往 <a href="/dicts" className="text-blue-500 hover:underline">词典管理</a> 导入并启用词典
                </p>
              </div>
            ) : (wordData as any)?.multiple_sources ? (
              // 多词典模式：只显示当前选中标签对应的词典内容
              <div className="min-h-[200px] relative">
                {loading ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 z-10">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gray-400"></div>
                  </div>
                ) : null}
                {/* 找到当前选中的词典结果 */}
                {(() => {
                  const selectedResult = (wordData as any)?.results?.find((r: any) => r.source_label === activeTab);
                  if (!selectedResult) {
                    return (
                      <div className="text-center text-gray-400 py-8">
                        <p>请选择词典标签查看释义</p>
                      </div>
                    );
                  }
                  return (
                    <div className="pb-6">
                      {/* 检查是否是 MDX 内容 */}
                      {selectedResult.html_content ? (
                        <div className="prose prose-sm max-w-none">
                          <DictionaryContent
                            word={wordData.word}
                            source={selectedResult.source_label}
                            htmlContent={selectedResult.html_content}
                            rawData={selectedResult.raw_data}
                          />
                        </div>
                      ) : selectedResult.meanings && selectedResult.meanings.length > 0 ? (
                        // 结构化内容
                        <div className="space-y-4">
                          {selectedResult.meanings.map((m: any, i: number) => (
                            <div key={i}>
                              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-2">
                                {m.partOfSpeech}
                              </span>
                              <ul className="space-y-3">
                                {m.definitions.map((def: any, j: number) => (
                                  <li
                                    key={j}
                                    className="text-sm pl-4 relative before:absolute before:left-0 before:top-1.5 before:w-1 before:h-1 before:bg-gray-300 before:rounded-full"
                                  >
                                    <div className="text-gray-800 leading-relaxed">
                                      {def.definition}
                                    </div>
                                    {def.example && (
                                      <div className="text-gray-400 text-xs mt-1 italic">
                                        &quot;{def.example}&quot;
                                      </div>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-center text-gray-400 py-8">
                          <p>该词典暂无此词条</p>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            ) : isMdxContent ? (
              <div className="min-h-[200px] relative">
                {loading ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 z-10">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gray-400"></div>
                  </div>
                ) : null}

                <DictionaryContent
                  word={wordData.word}
                  source={wordData.source || activeTab}
                  htmlContent={wordData.html_content!}
                  rawData={wordData.source?.toLowerCase() === 'ecdict' || (wordData as any).is_ecdict ? (wordData as any).raw_data : undefined}
                />
              </div>
            ) : wordData.meanings && wordData.meanings.length > 0 ? (
              <div className="min-h-[200px] relative">
                {loading ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 z-10">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gray-400"></div>
                  </div>
                ) : null}
                {/* Structured Content (Fallback for non-ECDICT sources without HTML) */}
                <div className="space-y-6">
                  {wordData.meanings?.map((m, i) => (
                    <div key={i}>
                      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-3">
                        {m.partOfSpeech}
                      </span>
                      <ul className="space-y-4">
                        {m.definitions.map((def, j) => (
                          <li
                            key={j}
                            className="text-sm pl-4 relative before:absolute before:left-0 before:top-1.5 before:w-1 before:h-1 before:bg-gray-300 before:rounded-full"
                          >
                            <div className="text-gray-800 leading-relaxed">
                              {def.definition}
                            </div>
                              {def.example && (
                                <div className="text-gray-400 text-xs mt-1.5 italic">
                                  &quot;{def.example}&quot;
                                </div>
                              )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Bottom Actions (Sticky) */}
            <div className="mt-8 pt-4 border-t sticky bottom-0 bg-white/95 backdrop-blur py-4 -mx-5 px-5 z-10">
              {isCurrentWordSaved ? (
                <button
                  onClick={async () => {
                    const existingWord = savedWords.find(
                      (w) =>
                        w.word.toLowerCase() === wordData.word.toLowerCase(),
                    );
                    if (existingWord && onDeleteWord) {
                      await onDeleteWord(existingWord.id);
                    }
                  }}
                  className="w-full py-2.5 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-lg transition-colors text-sm font-medium shadow-inner flex items-center justify-center gap-2 group border border-gray-300"
                >
                  <span className="group-hover:hidden">✓</span>
                  <span className="hidden group-hover:inline">✕</span>
                  <span className="group-hover:hidden">Saved</span>
                  <span className="hidden group-hover:inline">Remove</span>
                </button>
              ) : (
                <button
                  onClick={async () => {
                    await onAdd(wordData.word, wordData);
                  }}
                  className="w-full py-2.5 bg-white hover:bg-gray-50 text-gray-700 border border-gray-300 rounded-lg transition-colors text-sm font-medium shadow-sm flex items-center justify-center gap-2"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="w-5 h-5 text-gray-400"
                  >
                    <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
                  </svg>
                  Add to Vocabulary
                </button>
              )}
            </div>
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center h-40 text-gray-500 gap-2">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
            Searching...
          </div>
        ) : (
          // Empty State / Vocabulary List
          <div className="p-0">
            {savedWords.length > 0 ? (
              <div className="divide-y divide-gray-100">
                {/* List Header */}
                <div className="px-3 py-2 border-b text-[10px] font-semibold text-gray-400 uppercase tracking-wider flex justify-between items-center bg-gray-50/50">
                  <span>Vocabulary List ({savedWords.length})</span>
                </div>

                {savedWords.map((item) => (
                  <div
                    key={item.id}
                    className="group relative p-3.5 hover:bg-gray-50 transition-all cursor-pointer border-b border-gray-100/50"
                    onClick={() => {
                      // Fix: Pass the saved primary context to use original collected sentence
                      const context = item.primary_context?.context_sentence;
                      if (context && context.length > 5) {
                        onSearch(item.word, context);
                      } else {
                        onSearch(item.word);
                      }
                    }}
                  >
                    <div className="flex justify-between items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="font-semibold text-gray-900 text-[13px]">
                            {item.word}
                          </span>
                          {item.definition?.meanings?.[0]?.partOfSpeech && (
                            <span className="text-[10px] text-gray-400 italic">
                              {item.definition.meanings[0].partOfSpeech}
                            </span>
                          )}
                        </div>
 
                        {item.translation ? (
                          <div className="text-[11px] text-gray-500 mt-1 truncate">
                            {item.translation}
                          </div>
                        ) : item.definition?.meanings?.[0]?.definition ? (
                          <div className="text-[11px] text-gray-400 mt-1 truncate">
                            {item.definition.meanings[0].definition}
                          </div>
                        ) : (
                          <div className="text-[10px] text-gray-300 mt-1 italic">
                            无释义
                          </div>
                        )}
                      </div>

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteWord?.(item.id);
                        }}
                        className="shrink-0 text-gray-300 hover:text-red-500 p-1.5 rounded-full hover:bg-white transition-all opacity-0 group-hover:opacity-100"
                        title="Remove"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <line x1="18" y1="6" x2="6" y2="18"></line>
                          <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}

                <div className="p-4 text-center text-[10px] text-gray-300 italic">
                  — End of list —
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-24 text-gray-300 gap-4">
                <div className="p-4 border-2 border-dashed border-gray-200 rounded-full text-gray-200">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                  </svg>
                </div>
                <div className="text-sm">No words saved</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// 使用 memo 确保 Sidebar 只在 props 变化时重渲染
export default memo(DictionarySidebar);
