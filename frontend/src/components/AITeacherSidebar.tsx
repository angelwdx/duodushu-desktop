"use client";

import { useState, useRef, useEffect, memo, useMemo, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import { createLogger } from "../lib/logger";

const log = createLogger('AITeacherSidebar');

// 注意：API_URL 已在 frontend/src/lib/api.ts 中正确处理
// 使用从 api.ts 导入的 getApiUrl() 函数来获取后端 URL
// 这样可以确保便携版和开发环境都使用正确的后端地址

import { getApiUrl } from '../lib/api';

const API_URL = getApiUrl();
  role: "user" | "assistant";
  content: string;
  recommendedQuestions?: string[];
  sources?: Source[];
  intent?: string;
  page?: number;
}

interface Source {
  book_id: string;
  book_title: string;
  page_number: number;
  chunk_index: number;
  distance: number;
}

interface AITeacherSidebarProps {
  className?: string;
  pageContent?: string;
  currentPage?: number;
  bookTitle?: string;
  bookId?: string;
  externalTrigger?: string;
  onPageChange?: (page: number) => void;
  isContentLoading?: boolean;
}

// Chat data structure for localStorage
interface ChatData {
  [pageNumber: number]: Message[];
}

function AITeacherSidebar({
  className = "",
  pageContent = "",
  currentPage = 1,
  bookTitle = "",
  bookId = "",
  externalTrigger,
  onPageChange,
  isContentLoading = false,
}: AITeacherSidebarProps) {
  // Render 日志已移除（过于频繁）

  const [allChats, setAllChats] = useState<ChatData>({});
  const [viewMode, setViewMode] = useState<'page' | 'all'>('page');
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [lastProcessedTrigger, setLastProcessedTrigger] = useState<string | undefined>(undefined);
  const [currentSources, setCurrentSources] = useState<Source[]>([]);

  // AbortController ref for canceling requests on unmount
  const abortControllerRef = useRef<AbortController | null>(null);

  // Get current page messages
  const messages = useMemo(() => viewMode === 'page'
    ? (allChats[currentPage] || [])
    : Object.entries(allChats).flatMap(([page, msgs]) =>
        msgs.map((m: Message) => ({ ...m, page: parseInt(page) }))
      ), [viewMode, allChats, currentPage]);

  // Load all chats from localStorage on mount
  useEffect(() => {
    if (bookId) {
      try {
        const savedChats = localStorage.getItem(`ai-chat-v2-${bookId}`);
        if (savedChats) {
          setAllChats(JSON.parse(savedChats));
        }
      } catch (e) {
        console.error('Failed to parse AI chat history:', e);
      }
    }
  }, [bookId]);

  // Save all chats to localStorage when they change
  useEffect(() => {
    if (bookId) {
      try {
        if (Object.keys(allChats).length > 0) {
          localStorage.setItem(`ai-chat-v2-${bookId}`, JSON.stringify(allChats));
        } else {
          // Remove localStorage when all chats are cleared
          localStorage.removeItem(`ai-chat-v2-${bookId}`);
        }
      } catch (e) {
        console.error('Failed to save AI chat history:', e);
      }
    }
  }, [allChats, bookId]);

  // Cleanup: cancel any pending requests on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Helper to update messages for current page
  const setMessages = (updater: (prev: Message[]) => Message[]) => {
    setAllChats(prev => ({
      ...prev,
      [currentPage]: updater(prev[currentPage] || [])
    }));
  };

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, currentPage]);

  // 检查页面内容是否可用
  const hasValidPageContent = useMemo(() => {
    const isValid = !isContentLoading && pageContent && pageContent.trim().length > 10; // 至少需要10个字符，且不在加载中
    log.debug('hasValidPageContent check', {
      hasPageContent: !!pageContent,
      contentLength: pageContent?.length || 0,
      isContentLoading,
      isValid,
    });
    return isValid;
  }, [pageContent, isContentLoading]);

  // 追踪 prop 变化
  useEffect(() => {
    log.debug('pageContent prop updated', {
      length: pageContent?.length || 0,
      currentPage,
      isContentLoading,
    });
  }, [pageContent, currentPage, isContentLoading]);

  const handleSendMessage = useCallback(async (overrideContent?: string) => {
    const textToSend = overrideContent || inputValue.trim();

    if (!textToSend || isLoading) return;

    // 验证页面内容状态
    log.debug('handleSendMessage called', {
      hasValidPageContent,
      textLength: textToSend.length,
    });

    if (!hasValidPageContent) {
      log.warn('Rejecting request: no valid page content', { isContentLoading });
      setMessages((prev) => [...prev, { role: "user", content: textToSend }]);
      // 根据是否在加载中显示不同的错误消息
      const errorMessage = isContentLoading
        ? "正在提取页面内容，请稍候片刻再试..."
        : "抱歉，我无法获取当前页面的文本内容。请尝试刷新页面或切换到其他页面。";
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: errorMessage,
        },
      ]);
      return;
    }

    log.debug('Sending request with valid page content', {
      textLength: textToSend.length,
      pageContentLength: pageContent?.length || 0,
    });

    const userMessage: Message = { role: "user", content: textToSend };
    setMessages((prev) => [...prev, userMessage]);

    // Only clear input if we sent manually (no override)
    if (!overrideContent) {
      setInputValue("");
    }

    setIsLoading(true);

    // Cancel any previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    try {
      const requestBody = {
        message: textToSend,
        history: messages.map((m) => ({ role: m.role, content: m.content })),
        page_content: pageContent,
        current_page: currentPage,
        book_title: bookTitle,
        book_id: bookId,
      };

      log.debug('Fetching AI response', {
        url: `${API_URL}/api/ai/chat`,
        messageLength: textToSend.length,
        pageContentLength: pageContent?.length || 0,
      });

      const response = await fetch(`${API_URL}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: abortControllerRef.current.signal,
      });

      log.debug('AI response status', { status: response.status });

      if (!response.ok) throw new Error("Failed to get response");

      const data = await response.json();

      log.debug('AI response received', { replyLength: data?.reply?.length || 0 });

      // 保存来源引用
      if (data.sources && data.sources.length > 0) {
        setCurrentSources(data.sources);
      } else {
        setCurrentSources([]);
      }

      const parsed = parseRecommendedQuestions(data.reply);
      const assistantMessage: Message = {
        role: "assistant",
        content: parsed.content,
        recommendedQuestions: parsed.recommendedQuestions,
        sources: data.sources,
        intent: data.intent
      };

      log.debug('Setting assistant message', {
        contentLength: parsed.content.length,
        sourcesCount: data.sources?.length || 0
      });

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      // Ignore abort errors
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      console.error("Chat Error:", error);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "抱歉，我遇到了一点问题。请稍后再试。🙏" },
      ]);
      setCurrentSources([]);
    } finally {
      setIsLoading(false);
    }
  }, [inputValue, isLoading, messages, pageContent, currentPage, bookTitle, bookId, hasValidPageContent, setMessages]);

  // 处理外部触发的问题
  useEffect(() => {
    if (externalTrigger && externalTrigger !== lastProcessedTrigger) {
      setLastProcessedTrigger(externalTrigger);
      setViewMode('page');
      handleSendMessage(externalTrigger);
    }
  }, [externalTrigger, lastProcessedTrigger, handleSendMessage]);

  /* Moved handleSendMessage up */

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleClearChat = () => {
    const modeText = viewMode === 'page' ? `第 ${currentPage} 页` : '整本书';
    if (window.confirm(`确定要清空${modeText}的所有对话记录吗？`)) {
      if (viewMode === 'page') {
        setAllChats(prev => {
          const next = { ...prev };
          delete next[currentPage];
          return next;
        });
      } else {
        setAllChats({});
      }
    }
  };

  const handleQuickQuestion = useCallback(async (question: string) => {
    log.debug('handleQuickQuestion called', { question });

    if (isLoading) return;

    // 验证页面内容是否可用
    if (!hasValidPageContent) {
      log.warn('Rejecting quick question: no valid page content');
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "抱歉，我无法获取当前页面的文本内容。请尝试刷新页面或切换到其他页面后再试。",
        },
      ]);
      return;
    }

    log.debug('Sending quick question request', { question });
    const userMessage: Message = { role: "user", content: question };
    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);

    // Cancel any previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch(`${API_URL}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: question,
          history: messages.map((m) => ({ role: m.role, content: m.content })),
          page_content: pageContent,
          current_page: currentPage,
          book_title: bookTitle,
          book_id: bookId,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) throw new Error("Failed to get response");

      const data = await response.json();

      log.debug('Quick question response parsed', {
        replyLength: data?.reply?.length || 0,
        hasSources: data?.sources ? data.sources.length : 0,
      });

      // 保存来源引用
      if (data.sources && data.sources.length > 0) {
        setCurrentSources(data.sources);
      } else {
        setCurrentSources([]);
      }

      const parsed = parseRecommendedQuestions(data.reply);
      const assistantMessage: Message = {
        role: "assistant",
        content: parsed.content,
        recommendedQuestions: parsed.recommendedQuestions,
        sources: data.sources,
        intent: data.intent
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      // Ignore abort errors
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      console.error("Chat Error:", error);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "抱歉，我遇到了一点问题。请稍后再试。🙏" },
      ]);
      setCurrentSources([]);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, hasValidPageContent, pageContent, currentPage, bookTitle, bookId, setMessages, abortControllerRef, API_URL]);

  const parseRecommendedQuestions = (reply: string): { content: string; recommendedQuestions: string[] } => {
    const recommendedQuestions: string[] = [];
    let cleanedContent = reply;

    // 支持多种格式的推荐问题解析
    const patterns = [
      /【推荐问题】?\s*\n((?:[-•]\s*.+(?:\n|$))+)/i,
      /【推荐问题】?\s*\n((?:\d+\.\s*.+(?:\n|$))+)/i,
    ];

    for (const pattern of patterns) {
      const match = reply.match(pattern);
      if (match) {
        const questionsSection = match[1];
        const questions = questionsSection.match(/(?:[-•]|\d+\.)\s*.+/g);
        if (questions && questions.length >= 1) {
          const validQuestions = questions
            .slice(0, 3)
            .map((q) => q.replace(/^(?:[-•]|\d+\.)\s*/, "").trim())
            .filter((q) => q.length > 0);

          if (validQuestions.length > 0) {
            recommendedQuestions.push(...validQuestions);
            cleanedContent = reply.replace(match[0], "").trim();
            break;
          }
        }
      }
    }

    return {
      content: cleanedContent,
      recommendedQuestions,
    };
  };

  const quickQuestions = [
    {
      id: "page_summary",
      label: "本页总结",
      text: "请帮我总结一下这一页的核心内容",
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      )
    },
    {
      id: "key_points",
      label: "重难点解析",
      text: "请解析本页的重难点，包括长难句分析",
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      )
    },
    {
      id: "idiomatic",
      label: "地道表达",
      text: "本页中有哪些值得学习的地道表达或短语？",
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-7.714 2.143L11 21l-2.286-6.857L1 12l7.714-2.143L11 3z" />
        </svg>
      )
    },
  ];

  return (
    <div className={`h-full flex flex-col bg-gray-50 ${className}`}>
      {/* Content Warning */}
      {!hasValidPageContent && (
        <div className="p-3 bg-yellow-50 border-b border-yellow-200 text-xs text-yellow-700 flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3.464L13.464 5.464C12.998 4.998 12.5 4.75 12 4.75s-.998.248-1.464.714L7.144 9.536C6.598 9.998 6.5 10.496 6.5 11v6.998c0 .554.098 1.002.644 1.464l3.392 3.392c.466.466.964.714 1.464.714s.998-.248 1.464-.714l3.392-3.392c.546-.462.644-.96.644-1.464V11c0-.504-.098-1.002-.644-1.464L13.464 5.464z" />
          </svg>
          <span>无法获取页面内容，AI功能可能受限。请尝试刷新页面。</span>
        </div>
      )}

      {/* Header */}
      <div className="p-2 border-b bg-white">
        <div className="flex items-center justify-between px-2">
          <div className="flex items-center gap-2.5 px-2">
            {quickQuestions.map((qq) => (
              <button
                key={qq.id}
                onClick={() => handleQuickQuestion(qq.text)}
                disabled={isLoading || !hasValidPageContent}
                className={`flex items-center gap-1.5 text-[11px] transition-colors disabled:opacity-50 ${
                  !hasValidPageContent
                    ? 'text-gray-300 cursor-not-allowed'
                    : 'text-gray-400 hover:text-gray-800'
                }`}
                title={!hasValidPageContent ? '页面内容不可用' : undefined}
              >
                <span>{qq.label}</span>
              </button>
            ))}
          </div>
 
          {/* 对话历史切换器 */}
          <div className="flex gap-2.5 items-center">
            <div className="flex gap-1 bg-gray-50 rounded-lg p-0.5">
              {[
                { id: 'page' as const, label: '本页' },
                { id: 'all' as const, label: '全书' }
              ].map(mode => (
                <button
                  key={mode.id}
                  onClick={() => setViewMode(mode.id)}
                  className={`px-3 py-1 text-[11px] font-medium rounded-md transition-all ${
                    viewMode === mode.id
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-400 hover:text-gray-600'
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            <button
              onClick={handleClearChat}
              className="p-1.5 text-gray-300 hover:text-red-400 hover:bg-gray-50 rounded-lg transition-all"
              title={viewMode === 'page' ? `清空第 ${currentPage} 页对话` : '清空全部对话'}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>
      </div>


      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.map((msg, index) => (
          <div key={index} className="group relative">
            {msg.role === "user" ? (
              <div className="flex gap-3 flex-row-reverse">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center text-sm shrink-0 bg-gray-50 border border-gray-100">
                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
                <div className="flex flex-col items-end gap-1.5 max-w-[80%]">
                  <div className="rounded-2xl px-4 py-2 bg-gray-50 text-gray-800 border border-gray-100/50 rounded-tr-none">
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">
                      {msg.content}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      if (viewMode === 'page') {
                        setMessages(prev => prev.filter((_, i) => i !== index));
                      } else {
                        const targetPage = msg.page;
                        setAllChats(prev => {
                          const pageMsgs = prev[targetPage!] || [];
                          const originalIndex = messages.filter((m: any) => m.page === targetPage).indexOf(msg);
                          if (originalIndex !== -1) {
                            const next = { ...prev };
                            next[targetPage!] = pageMsgs.filter((_, i) => i !== originalIndex);
                            return next;
                          }
                          return prev;
                        });
                      }
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 transition-all"
                    title="删除"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-3">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center text-sm shrink-0 bg-gray-50 border border-gray-100">
                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                </div>
                <div className="flex flex-col gap-2 max-w-[80%]">
                  <div className="relative rounded-2xl px-4 py-2 bg-white text-gray-800 border border-gray-100 shadow-sm/5 rounded-tl-none">
                    <div className="text-sm max-w-none">
                      <ReactMarkdown
                        components={{
                          p: ({ children }) => (
                            <p className="mb-2 last:mb-0 leading-relaxed text-gray-800">
                              {children}
                            </p>
                          ),
                          strong: ({ children }) => (
                            <strong className="font-semibold text-gray-900 border-b border-gray-100 pb-px">
                              {children}
                            </strong>
                          ),
                          em: ({ children }) => (
                            <em className="italic text-gray-500">{children}</em>
                          ),
                          ul: ({ children }) => (
                            <ul className="mb-3 space-y-1.5 list-none">
                              {children}
                            </ul>
                          ),
                          ol: ({ children }) => (
                            <ol className="mb-3 space-y-1.5 list-none">
                              {children}
                            </ol>
                          ),
                          li: ({ children }) => (
                            <li className="relative pl-3 before:absolute before:left-0 before:top-[0.6em] before:w-1 before:h-1 before:bg-gray-300 before:rounded-full">
                              {children}
                            </li>
                          ),
                        }}
                      >
                        {msg.content}
                      </ReactMarkdown>
                    </div>

                    {/* 来源引用显示 */}
                    {msg.sources && msg.sources.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-gray-100">
                        <div className="flex flex-wrap gap-1">
                          {msg.sources.map((src: Source, i: number) => (
                            <button
                              key={i}
                              onClick={() => {
                                if (onPageChange) {
                                  onPageChange(src.page_number);
                                }
                              }}
                              className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors flex items-center gap-1"
                            >
                              <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                              </svg>
                              第 {src.page_number} 页
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Delete Icon for Assistant */}
                    <button
                      onClick={() => {
                        if (viewMode === 'page') {
                          setMessages(prev => prev.filter((_, i) => i !== index));
                        } else {
                          const targetPage = msg.page;
                          setAllChats(prev => {
                            const pageMsgs = prev[targetPage!] || [];
                            const originalIndex = messages.filter((m: any) => m.page === targetPage).indexOf(msg);
                            if (originalIndex !== -1) {
                              const next = { ...prev };
                              next[targetPage!] = pageMsgs.filter((_, i) => i !== originalIndex);
                              return next;
                            }
                            return prev;
                          });
                        }
                      }}
                      className="absolute -right-8 top-2 opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 transition-all"
                      title="删除"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>

                  {msg.recommendedQuestions && msg.recommendedQuestions.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      {msg.recommendedQuestions!.map((question: string, idx: number) => (
                        <button
                          key={idx}
                          onClick={() => handleQuickQuestion(question)}
                          disabled={isLoading}
                          className="text-left px-3 py-2 bg-gray-50 hover:bg-gray-100 border border-gray-200 hover:border-gray-300 rounded-lg transition-colors text-xs text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 hover:shadow-sm"
                        >
                          <svg className="w-3 h-3 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                          </svg>
                          <span className="flex-1">{question}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="flex gap-2">
            <div className="w-8 h-8 rounded-lg border border-gray-100 flex items-center justify-center bg-gray-50 text-sm">
              <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </div>
            <div className="bg-white rounded-2xl px-4 flex items-center h-8 border border-gray-100 shadow-sm/5">
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"></div>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-3 bg-white border-t">
        <div className="flex gap-2.5">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder="输入问题..."
            className="flex-1 px-4 py-2 bg-gray-50 border border-transparent rounded-xl focus:outline-none focus:bg-white focus:border-gray-200 transition-all text-sm"
            disabled={isLoading}
          />
          <button
            onClick={() => handleSendMessage()}
            disabled={!inputValue.trim() || isLoading}
            className="px-5 py-2 bg-gray-900 hover:bg-black disabled:bg-gray-100 disabled:text-gray-400 text-white rounded-xl font-medium transition-all text-[13px] flex items-center gap-2 shadow-sm"
          >
            {isLoading ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent animate-spin rounded-full"></div>
                发送中
              </>
            ) : (
              <>
                发送
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0l-9 2-9-18-9 18 9-2zm0 0c-2 0-4 0-6 0s-4 0-6 0v8s4 0 6 0v-8z" />
                </svg>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default memo(AITeacherSidebar);
