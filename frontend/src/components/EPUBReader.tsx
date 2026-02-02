"use client";

import { useEffect, useRef, useState, useCallback } from 'react';
import { useReaderGestures } from '../hooks/useReaderGestures';
import { saveEpubState, getEpubState } from '../lib/epubCache';
import { createLogger } from '../lib/logger';

const log = createLogger('EPUBReader');

interface OutlineItem {
  title: string;
  dest: string | null;
  pageNumber: number;
  level?: number;
}

interface EPUBReaderProps {
  initialProgress?: number;
  initialChapter?: number;
  fileUrl: string;
  bookId?: string;
  onWordClick?: (word: string, context?: string) => void;
  onOutlineChange?: (outline: OutlineItem[]) => void;
  onPageChange?: (progress: number) => void;
  onContentChange?: (content: string) => void; // 鏂板锛：唴瀹瑰彉鍖栧洖璋僜r
  onAskAI?: (text: string) => void;
  onHighlight?: (text: string, source?: string | number) => void;
  jumpRequest?: { dest: string | number; text?: string; word?: string; ts: number } | null;
}

export default function EPUBReader({
  fileUrl,
  bookId,
  initialProgress,
  initialChapter, // 鏂板
  onWordClick,
  onOutlineChange,
  onPageChange,
  onContentChange, // 鏂板
  onHighlight, // Add this
  jumpRequest
}: EPUBReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<any>(null);
  const renditionRef = useRef<any>(null);
  const saveProgressTimeout = useRef<NodeJS.Timeout | null>(null);
  const currentCfiRef = useRef<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [fontSize, setFontSize] = useState(100);
  const [fontFamily, setFontFamily] = useState<'serif' | 'sans'>('serif');
  const [lineHeight, setLineHeight] = useState(1.6);
  const [fitMode, setFitMode] = useState<'page' | 'width'>('page');
  const [showAppearanceMenu, setShowAppearanceMenu] = useState(false);
  const [isClient, setIsClient] = useState(false);
  const [isReadyToSave, setIsReadyToSave] = useState(false);
  const [renditionReady, setRenditionReady] = useState(false);
  const pendingJumpRef = useRef<{ dest: string | number; text?: string; word?: string; ts: number } | null>(null);
  const lastHighlightRef = useRef<{ text: string; word?: string; ts: number } | null>(null);
  const isJumpingRef = useRef<boolean>(false);
  const contentSyncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const appearanceMenuRef = useRef<HTMLDivElement>(null);
  const lastProcessedJumpTs = useRef<number>(0);
  const jumpRequestedBeforeReadyRef = useRef<{ dest: string | number; text?: string; word?: string; ts: number } | null>(null);
  
  // Ref to hold latest settings for hooks to avoid stale closures
  const settingsRef = useRef({
    fontFamily: fontFamily,
    lineHeight: lineHeight,
    fontSize: fontSize
  });

  // Sync state to ref
  useEffect(() => {
    settingsRef.current = { fontFamily, lineHeight, fontSize };
  }, [fontFamily, lineHeight, fontSize]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (appearanceMenuRef.current && !appearanceMenuRef.current.contains(event.target as Node)) {
        setShowAppearanceMenu(false);
      }
    };
    if (showAppearanceMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showAppearanceMenu]);
  


  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  // 搜索中遮罩状态
  const [isSearching, setIsSearching] = useState(false);

  // 辅助函数：安全设置 Range 边界
  const safeSetRangeStart = (range: Range, node: Node, offset: number) => {
      try {
          const maxOffset = node.nodeType === 3 
              ? (node.textContent?.length || 0) 
              : node.childNodes.length;
          range.setStart(node, Math.min(Math.max(0, offset), maxOffset));
      } catch (e) {
          log.debug('safeSetRangeStart failed:', e);
      }
  };

  const safeSetRangeEnd = (range: Range, node: Node, offset: number) => {
      try {
          const maxOffset = node.nodeType === 3 
              ? (node.textContent?.length || 0) 
              : node.childNodes.length;
          range.setEnd(node, Math.min(Math.max(0, offset), maxOffset));
      } catch (e) {
          log.debug('safeSetRangeEnd failed:', e);
      }
  };

  // 辅助函数：处理文本搜索和高亮
  const handleTextSearch = useCallback(async (text: string, word?: string, maxAttempts = 15, pageOffset = 0, retryLevel = 0) => {
      try {
          if (!renditionRef.current || !bookRef.current) return false;

          const contents = renditionRef.current.getContents()[0];
          if (!contents || !contents.window) {
              if (maxAttempts > 0) {
                  setTimeout(() => handleTextSearch(text, word, maxAttempts - 1, pageOffset, retryLevel), 200);
              }
              return false;
          }

          const win = contents.window;
          const doc = contents.document;

          // --- 策略：多级降级搜索 ---
          let query = text.trim();

          if (word) {
              const cleanText = text.trim();
              const cleanWord = word.trim();
              const index = cleanText.toLowerCase().indexOf(cleanWord.toLowerCase());

              if (retryLevel === 0) {
                   // Level 0: 严格模式 - 上下文 + 单词 + 上下文 (最准确)
                   if (index !== -1) {
                        const start = Math.max(0, index - 15);
                        const end = Math.min(cleanText.length, index + cleanWord.length + 15);
                        query = cleanText.substring(start, end).trim();
                   } else {
                        query = cleanText.substring(0, 20).trim();
                   }
              } else if (retryLevel === 1) {
                   // Level 1: 宽松模式 - 仅单词 + 后文 (解决前文跨行/截断问题)
                   if (index !== -1) {
                        const end = Math.min(cleanText.length, index + cleanWord.length + 10);
                        query = cleanText.substring(index, end).trim();
                   } else {
                        query = cleanWord;
                   }
              } else {
                   // Level 2: 兜底模式 - 仅搜索单词 (最不准确，但保证能找到)
                   query = cleanWord;
              }
          } else {
              query = text.substring(0, 20).trim();
          }

          log.debug(`Searching (Level ${retryLevel}): "${query}"`);

          win.getSelection()?.removeAllRanges();

          // 关键修复：关闭 WholeWord (第5个参数设为 false)，允许部分匹配
          if (win.find(query, false, false, true, false, true, false)) {
              log.debug('Search success!');
              const selection = win.getSelection();
              if (selection && selection.rangeCount > 0) {
                  const range = selection.getRangeAt(0);

                  // 注意：此处不再调用 rendition.display(cfi)
                  // 原因：window.find() 已经成功定位到文本位置
                  // 额外调用 display(cfi) 会触发 epub.js 内部的 IndexSizeError
                  // 错误来源于 epub.js 的 requestAnimationFrame 队列，无法被 try-catch 捕获
                  log.debug('Search positioned successfully, skipping display(cfi) to avoid IndexSizeError');

                  // --- 关键改进：手动滚动到找到的文本位置，确保准确定位 ---
                  try {
                      // 获取找到的文本的位置
                      const rect = range.getBoundingClientRect();

                      // 计算需要滚动的距离，使文本位置在视口中心
                      const viewportHeight = win.innerHeight;
                      const targetScrollY = win.scrollY + rect.top - viewportHeight / 2 + rect.height / 2;

                      // 平滑滚动到目标位置
                      win.scrollTo({
                          top: Math.max(0, targetScrollY),
                          behavior: 'smooth'
                      });

                      log.debug('Scrolled to found text position', {
                          rectTop: rect.top,
                          targetScrollY: Math.max(0, targetScrollY),
                          viewportHeight
                      });
                  } catch (scrollErr) {
                      log.debug('Manual scroll failed, relying on window.find() auto-scroll:', scrollErr);
                  }

                  // --- 关键改进：只高亮单词，不高亮整段上下文 ---
                  try {
                      const searchOverlay = doc.getElementById('search-highlight-overlay');
                      if (searchOverlay && word) {
                          // 在找到的范围内二次搜索单词
                          const foundText = range.toString();
                          const wordIndex = foundText.toLowerCase().indexOf(word.toLowerCase());

                          if (wordIndex !== -1) {
                              // 计算单词在 range 内的精确位置
                              const startNode = range.startContainer;
                              if (startNode.nodeType === 3) {
                                  try {
                                      const wordRange = doc.createRange();
                                      const textContent = startNode.textContent || '';
                                      const baseOffset = range.startOffset;
                                      const wordStart = baseOffset + wordIndex;
                                      const wordEnd = wordStart + word.length;
                                      const maxLen = textContent.length;

                                      safeSetRangeStart(wordRange, startNode, Math.min(wordStart, maxLen));
                                      safeSetRangeEnd(wordRange, startNode, Math.min(wordEnd, maxLen));

                                      const wordRect = wordRange.getBoundingClientRect();
                                      searchOverlay.style.width = `${wordRect.width + 4}px`;
                                      searchOverlay.style.height = `${wordRect.height + 4}px`;
                                      searchOverlay.style.top = `${wordRect.top + win.scrollY - 2}px`;
                                      searchOverlay.style.left = `${wordRect.left + win.scrollX - 2}px`;
                                      searchOverlay.style.display = 'block';
                                  } catch (wordRangeErr) {
                                      log.debug('Word range calculation failed, using full range:', wordRangeErr);
                                      // 降级：使用完整范围
                                      const rect = range.getBoundingClientRect();
                                      searchOverlay.style.width = `${rect.width + 4}px`;
                                      searchOverlay.style.height = `${rect.height + 4}px`;
                                      searchOverlay.style.top = `${rect.top + win.scrollY - 2}px`;
                                      searchOverlay.style.left = `${rect.left + win.scrollX - 2}px`;
                                      searchOverlay.style.display = 'block';
                                  }
                              } else {
                                  // 非文本节点，降级使用完整范围
                                  const rect = range.getBoundingClientRect();
                                  searchOverlay.style.width = `${rect.width + 4}px`;
                                  searchOverlay.style.height = `${rect.height + 4}px`;
                                  searchOverlay.style.top = `${rect.top + win.scrollY - 2}px`;
                                  searchOverlay.style.left = `${rect.left + win.scrollX - 2}px`;
                                  searchOverlay.style.display = 'block';
                              }
                          } else {
                              // 单词不在范围内，不显示高亮
                              searchOverlay.style.display = 'none';
                          }

                          // 3秒后自动隐藏
                          setTimeout(() => {
                              searchOverlay.style.display = 'none';
                          }, 3000);
                      } else if (searchOverlay) {
                          // 没有指定 word，不显示高亮
                          searchOverlay.style.display = 'none';
                      }
                  } catch (overlayErr) {
                      log.debug('Overlay positioning failed:', overlayErr);
                  }

                  lastHighlightRef.current = { text, word, ts: Date.now() };

                  // 搜索成功，隐藏遮罩
                  setIsSearching(false);
              }
              return true;
          }

          // --- 搜索失败处理逻辑 ---

          // 如果是严格模式失败，先尝试降级，不翻页
          if (retryLevel < 2) {
              log.debug(`Level ${retryLevel} failed, retrying with Level ${retryLevel + 1}...`);
              return handleTextSearch(text, word, maxAttempts, pageOffset, retryLevel + 1);
          }

          // --- 翻页搜索（用遮罩隐藏翻页过程）---
          // 关键修复：限制翻页次数，避免跨页过多导致页面位置不准确
          // 最多翻页 3 次（当前页 + 前后各 3 页），超过则放弃
          if (maxAttempts > 0 && pageOffset < 3) {
              log.debug('Text not found on current view, turning to next view...');
              // 显示搜索遮罩，隐藏翻页过程
              if (pageOffset === 0) {
                  setIsSearching(true);
              }
              renditionRef.current.next();
              setTimeout(() => {
                  handleTextSearch(text, word, maxAttempts - 1, pageOffset + 1, 0);
              }, 300); // 缩短等待时间，加快搜索
          } else {
              log.warn('Text not found after all attempts');
              setIsSearching(false);
          }
      } catch (err) {
          log.warn('Search error:', err);
          setIsSearching(false);
      }
      return false;
  }, []);

  // Ensure client-side only
  useEffect(() => {
    setIsClient(true);
  }, []);

   // 关键修复：当 renditionReady 变为 true 时，处理之前保存的 jumpRequest
  useEffect(() => {
    log.info('Jump useEffect triggered:', { 
      renditionReady, 
      hasRenditionRef: !!renditionRef.current, 
      hasBookRef: !!bookRef.current,
      savedJumpTs: jumpRequestedBeforeReadyRef.current?.ts,
      lastProcessedTs: lastProcessedJumpTs.current
    });
    
    if (renditionReady && renditionRef.current && bookRef.current) {
      const savedJump = jumpRequestedBeforeReadyRef.current;
      // 关键修复：使用 > 而不是 !==，因为可能有多个跳转请求
      if (savedJump && savedJump.ts > lastProcessedJumpTs.current) {
        log.info('Rendition ready, processing saved jump:', savedJump);
        lastProcessedJumpTs.current = savedJump.ts; // 只在实际执行时更新
        pendingJumpRef.current = savedJump;
        
        // 直接复制 tryJump 逻辑到这里
        const executeJump = async () => {
          try {
            log.info('Executing saved jump with target:', { target: savedJump.dest, type: typeof savedJump.dest });
            
            let displayTarget: string | number = savedJump.dest;
            if (typeof savedJump.dest === 'number') {
              displayTarget = savedJump.dest;
            }
            
            await renditionRef.current!.display(displayTarget);
            await new Promise(resolve => setTimeout(resolve, 500));
            
            const currentLocation = renditionRef.current!.currentLocation();
            log.debug('Saved jump - current location after first jump:', currentLocation);
            
            if (typeof savedJump.dest === 'string' && currentLocation && currentLocation.start) {
              const pageStartCfi = currentLocation.start.cfi;
              await renditionRef.current!.display(pageStartCfi);
              await new Promise(resolve => setTimeout(resolve, 200));
            }
            
            setIsReadyToSave(true);
            jumpRequestedBeforeReadyRef.current = null;
            
            if (savedJump.text) {
              setTimeout(() => {
                handleTextSearch(savedJump.text!, savedJump.word);
                setTimeout(() => isJumpingRef.current = false, 1000);
              }, 600);
            } else {
              isJumpingRef.current = false;
            }
          } catch (err) {
            log.error('Saved jump execution failed:', err);
            jumpRequestedBeforeReadyRef.current = null;
            isJumpingRef.current = false;
          }
        };
        
        isJumpingRef.current = true;
        executeJump();
      }
    }
  }, [renditionReady, handleTextSearch]);

  // Handle jump requests (注意：refs 已在文件顶部定义)
  useEffect(() => {
    if (jumpRequest?.dest) {
      // 关键修复：不要在这里更新 lastProcessedJumpTs，否则 savedJump > lastProcessed 会失败
      // lastProcessedJumpTs 只在实际执行跳转时更新

      log.info('Jump request received:', { 
        dest: jumpRequest.dest, 
        text: jumpRequest.text, 
        word: jumpRequest.word,
        renditionReady,
        lastProcessedTs: lastProcessedJumpTs.current
      });

      pendingJumpRef.current = jumpRequest;
      
      // 如果 rendition 还没准备好，保存 jumpRequest 供后续处理
      if (!renditionReady) {
        log.info('Rendition not ready yet, saving jump request for later');
        jumpRequestedBeforeReadyRef.current = jumpRequest;
        return;
      }
      
      // 关键修复：如果 jumpRequestedBeforeReadyRef 存在，说明已经由 renditionReady useEffect 处理
      if (jumpRequestedBeforeReadyRef.current) {
        log.info('Jump already handled by renditionReady useEffect, skipping');
        jumpRequestedBeforeReadyRef.current = null; // 清除标记
        return;
      }
      
      if (renditionRef.current && bookRef.current) {
        const jump = jumpRequest;
        log.info('Jumping now to:', { dest: jump.dest, text: jump.text, word: jump.word });
        isJumpingRef.current = true; // 标记开始跳转
        
        // 1. Jump to destination (Chapter)
        const tryJump = async (target: string | number, retry: boolean = true) => {
            try {
                log.debug('Jumping with target:', { target, type: typeof target });
                
                // 关键修复：正确处理数字和字符串类型的目标
                // 如果 target 是数字，需要转换为章节索引或生成位置
                let displayTarget: string | number = target;
                if (typeof target === 'number') {
                    // 数字类型：尝试作为章节索引，或生成 CFI
                    log.debug('Target is number, using as chapter index:', target);
                    displayTarget = target;
                }
                
                // 第一次跳转：到达目标
                await renditionRef.current!.display(displayTarget);
                
                // 等待渲染稳定
                await new Promise(resolve => setTimeout(resolve, 500));
                
                // 获取当前位置
                const currentLocation = renditionRef.current!.currentLocation();
                log.debug('Current location after first jump:', currentLocation);
                
                // 注意：对于数字索引跳转，不要进行第二次对齐跳转
                // 因为数字索引通常指向章节开始，已经在边界上
                // 只有字符串 CFI 跳转才需要对齐
                if (typeof target === 'string' && currentLocation && currentLocation.start) {
                    const pageStartCfi = currentLocation.start.cfi;
                    log.debug('String target - aligning to page start:', pageStartCfi);
                    await renditionRef.current!.display(pageStartCfi);
                    
                    // 再等待一次确保第二次跳转完成
                    await new Promise(resolve => setTimeout(resolve, 200));
                    const finalLocation = renditionRef.current!.currentLocation();
                    log.debug('Final location after alignment:', finalLocation);
                }
                
                setIsReadyToSave(true);
                // 2. If text provided, search and refine jump
                if (jump.text) {
                    setTimeout(() => {
                        handleTextSearch(jump.text!, jump.word);
                        setTimeout(() => isJumpingRef.current = false, 1000);
                    }, 600);
                } else {
                    isJumpingRef.current = false;
                }
            } catch (err: any) {
                if (retry && typeof target === 'string') {
                     // 1. Try decoding
                     const decoded = decodeURIComponent(target);
                     if (decoded !== target) {
                         log.warn(`Jump to ${target} failed, retrying with decoded ${decoded}`);
                         return tryJump(decoded, false);
                     }
                     
                     // 2. Try finding by spine item (fuzzy match)
                     if (bookRef.current) {
                        try {
                            const book = bookRef.current;
                            // Clean target (remove hash)
                            const targetPath = target.split('#')[0];
                            const targetHash = target.includes('#') ? target.split('#')[1] : '';
                            
                            // Iterate spine to find match
                            let foundHref = '';
                            // @ts-ignore - spine is iterable/has each
                            book.spine.each((item: any) => {
                                if (!foundHref) {
                                    // Check if item.href ends with targetPath or vice versa
                                    // This handles ../Text/Chapter.xhtml vs Chapter.xhtml
                                    if (item.href.endsWith(targetPath) || targetPath.endsWith(item.href)) {
                                        foundHref = item.href;
                                    }
                                }
                            });
                            
                            if (foundHref) {
                                const newTarget = targetHash ? `${foundHref}#${targetHash}` : foundHref;
                                if (newTarget !== target) {
                                    log.info(`Resolved "${target}" to spine item "${newTarget}", retrying jump...`);
                                    return tryJump(newTarget, false);
                                }
                            }
                        } catch (e) {
                            log.warn('Spine lookup failed:', e);
                        }
                     }
                }
                log.error("Jump failed:", err);
                isJumpingRef.current = false;
            }
        };

        tryJump(jump.dest);
      }
    }
  }, [jumpRequest, renditionReady, handleTextSearch]);

  // Process pending jump
  useEffect(() => {
    if (renditionReady && pendingJumpRef.current && renditionRef.current && bookRef.current) {
      const jump = pendingJumpRef.current;
      log.debug('Processing pending jump to:', { dest: jump.dest, text: jump.text, word: jump.word });
      isJumpingRef.current = true;
      
      
      // 1. Jump to destination
      const tryJump = async (target: string | number, retry: boolean = true) => {
        try {
            log.debug('Pending jump with target:', { target, type: typeof target });
            
            // 关键修复：正确处理数字和字符串类型的目标
            let displayTarget: string | number = target;
            if (typeof target === 'number') {
                log.debug('Pending jump - target is number:', target);
                displayTarget = target;
            }
            
            // 第一次跳转
            await renditionRef.current!.display(displayTarget);
            
            // 等待渲染稳定
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // 获取当前位置
            const currentLocation = renditionRef.current!.currentLocation();
            log.debug('Pending jump - current location after first jump:', currentLocation);
            
            // 只有字符串 CFI 跳转才需要对齐，数字索引不需要
            if (typeof target === 'string' && currentLocation && currentLocation.start) {
                const pageStartCfi = currentLocation.start.cfi;
                log.debug('Pending jump - aligning to page start:', pageStartCfi);
                await renditionRef.current!.display(pageStartCfi);
                
                await new Promise(resolve => setTimeout(resolve, 200));
                const finalLocation = renditionRef.current!.currentLocation();
                log.debug('Pending jump - final location after alignment:', finalLocation);
            }
            
            setIsReadyToSave(true);
            pendingJumpRef.current = null;
            // 2. If text provided, search and refine jump
            if (jump.text) {
                setTimeout(() => {
                    handleTextSearch(jump.text!, jump.word);
                    setTimeout(() => isJumpingRef.current = false, 1000);
                }, 500);
            } else {
                isJumpingRef.current = false;
            }
        } catch (err: any) {
             if (retry && typeof target === 'string') {
                 // 1. Try decoding
                 const decoded = decodeURIComponent(target);
                 if (decoded !== target) {
                     log.warn(`Pending jump to ${target} failed, retrying with decoded ${decoded}`);
                     return tryJump(decoded, false);
                 }
                 
                 // 2. Try finding by spine item (fuzzy match)
                 if (bookRef.current) {
                    try {
                        const book = bookRef.current;
                        const targetPath = target.split('#')[0];
                        const targetHash = target.includes('#') ? target.split('#')[1] : '';
                        
                        let foundHref = '';
                        // @ts-ignore
                        book.spine.each((item: any) => {
                            if (!foundHref) {
                                if (item.href.endsWith(targetPath) || targetPath.endsWith(item.href)) {
                                    foundHref = item.href;
                                }
                            }
                        });
                        
                        if (foundHref) {
                            const newTarget = targetHash ? `${foundHref}#${targetHash}` : foundHref;
                            if (newTarget !== target) {
                                log.info(`Resolved pending "${target}" to spine item "${newTarget}", retrying jump...`);
                                return tryJump(newTarget, false);
                            }
                        }
                    } catch (e) {
                        log.warn('Spine lookup failed:', e);
                    }
                 }
            }
            log.error("Pending jump failed:", err);
            isJumpingRef.current = false;
            pendingJumpRef.current = null;
        }
      };

      tryJump(jump.dest);
    }
  }, [renditionReady, handleTextSearch]);

  const [forceSave, setForceSave] = useState(0);

  // Save progress
  useEffect(() => {
    if (!bookId || loading || !isReadyToSave) return;
    if (saveProgressTimeout.current) clearTimeout(saveProgressTimeout.current);

    saveProgressTimeout.current = setTimeout(() => {
      const percentage = progress;
      const cfi = currentCfiRef.current;
      log.debug('Saving state', { progress: percentage, font: fontSize });
      
      const stateToSave: any = { 
        percentage, 
        settings: { 
          fontSize,
          fontFamily,
          lineHeight,
          fitMode
        } 
      };
      if (cfi) stateToSave.cfi = cfi;
      
      saveEpubState(bookId, stateToSave);
      
      fetch(`${API_URL}/api/books/${bookId}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: percentage }),
      }).catch((err) => log.error("Failed to save progress:", err));
    }, 500);

    return () => { if (saveProgressTimeout.current) clearTimeout(saveProgressTimeout.current); };
  }, [progress, fontSize, fontFamily, lineHeight, bookId, API_URL, loading, forceSave, isReadyToSave, fitMode]);

  // Initialize epub.js
  useEffect(() => {
    if (!isClient || !fileUrl) return;
    if (!containerRef.current) return;

    let book: any = null;
    let rendition: any = null;
    let isCancelled = false;
    let stableTimeout: NodeJS.Timeout;

    const initBook = async () => {
      setIsReadyToSave(false);
      setRenditionReady(false);
      log.debug('Starting init', { fileUrl });

      const ePub = (await import('epubjs')).default;
      if (isCancelled) return;

      if (bookRef.current) {
        try { bookRef.current.destroy(); } catch (e) { log.warn('Error destroying previous book:', e); }
      }

      const { getCachedEpub, cacheEpub } = await import('../lib/epubCache');
      let arrayBuffer = await getCachedEpub(fileUrl);
      
      if (!arrayBuffer) {
        log.debug('Fetching EPUB file...');
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`Failed to fetch EPUB: ${response.status} ${response.statusText}`);
        arrayBuffer = await response.arrayBuffer();
        await cacheEpub(fileUrl, arrayBuffer);
      }

      book = ePub(arrayBuffer);
      bookRef.current = book;
      await book.ready;
      if (isCancelled) return;

      rendition = book.renderTo(containerRef.current!, {
        width: '100%',
        height: '100%',
        spread: 'none',
        flow: 'paginated',
      });
      renditionRef.current = rendition;
      rendition.themes.fontSize(`${fontSize}%`);
      


  // ... (inside initBook)
      const applyUserStyles = (contents: any) => {
         const doc = contents.document;
         if (!doc) return;
         
         // Use ref to get latest settings
         const currentSettings = settingsRef.current;
         const currentFont = currentSettings.fontFamily;
         const currentLineHeight = currentSettings.lineHeight;

         let style = doc.getElementById('user-appearance-overrides');
         if (!style) {
             style = doc.createElement('style');
             style.id = 'user-appearance-overrides';
             doc.head.appendChild(style);
         }
         
         const fontStack = currentFont === 'serif' 
            ? 'Georgia, "Times New Roman", serif' 
            : 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

         style.innerHTML = `
            body, p, div, span, li, blockquote {
                font-family: ${fontStack} !important;
                line-height: ${currentLineHeight} !important;
            }
         `;
      };
      
      // Inject on new content
      rendition.hooks.content.register(applyUserStyles);
      
      // Apply to existing content immediately
      rendition.getContents().forEach(applyUserStyles);


      // Inject global styles for selection state
      rendition.hooks.content.register((contents: any) => {
          const doc = contents.document;
          const win = contents.window;

          const style = doc.createElement('style');
          style.innerHTML = `
            body.selecting, body.selecting * {
                cursor: text !important;
            }
            /* 临时高亮样式 */
            .hl-temp {
                fill: yellow !important;
                fill-opacity: 0.4 !important;
                background-color: #fff59a !important;
                box-shadow: 0 0 2px rgba(255, 193, 7, 0.12);
                mix-blend-mode: multiply;
            }
          `;
          doc.head.appendChild(style);

          // Create Highlight Overlay
          const overlay = doc.createElement('div');
          overlay.id = 'word-highlight-overlay';
          overlay.style.position = 'absolute';
          overlay.style.backgroundColor = 'rgba(255, 235, 100, 0.4)'; // Slightly warmer yellow
          overlay.style.pointerEvents = 'none'; // Click-through
          overlay.style.zIndex = '0'; // Behind text if possible, but standard flow puts it on top usually unless z-index managed. 
          // Since text is static, we can use mix-blend-mode to make it look like a highlighter
          overlay.style.mixBlendMode = 'multiply'; 
          overlay.style.borderRadius = '3px';
          overlay.style.display = 'none';
          overlay.style.transition = 'all 0.05s ease-out'; // Smooth movement
          doc.body.appendChild(overlay);

          // Create Search Highlight Overlay (Solid underline or box)
          const searchOverlay = doc.createElement('div');
          searchOverlay.id = 'search-highlight-overlay';
          searchOverlay.style.position = 'absolute';
          searchOverlay.style.backgroundColor = 'rgba(255, 150, 0, 0.2)';
          searchOverlay.style.borderBottom = '2px solid #ff9800';
          searchOverlay.style.pointerEvents = 'none';
          searchOverlay.style.zIndex = '5';
          searchOverlay.style.display = 'none';
          searchOverlay.style.borderRadius = '2px';
          doc.body.appendChild(searchOverlay);

          // Event Listeners for Drag-to-Select interaction & Word Highlighting
          let isDragging = false;

          doc.addEventListener('mousedown', (e: MouseEvent) => {
             // Only left click triggers selection mode
             if (e.button === 0) {
                 isDragging = true;
                 overlay.style.display = 'none'; // Hide highlight while selecting
             }
          });

          doc.addEventListener('mousemove', (e: MouseEvent) => {
              if (isDragging) {
                  doc.body.classList.add('selecting');
                  return;
              }

              // Word Highlighting Logic
              // Use standard browser API to get range at point
              let range;
              if (doc.caretRangeFromPoint) {
                  range = doc.caretRangeFromPoint(e.clientX, e.clientY);
              } else if (doc.caretPositionFromPoint) {
                  const pos = doc.caretPositionFromPoint(e.clientX, e.clientY);
                  range = doc.createRange();
                  try {
                      const maxOff = pos.offsetNode.nodeType === 3 ? (pos.offsetNode.textContent?.length || 0) : pos.offsetNode.childNodes.length;
                      range.setStart(pos.offsetNode, Math.min(pos.offset, maxOff));
                      range.collapse(true);
                  } catch (reErr) {
                      log.debug('Caret position range failed:', reErr);
                  }
              }

              if (range && range.startContainer && range.startContainer.nodeType === 3) { // Ensure it's a text node
                  // Expand to word
                  try {
                       // Custom expansion since range.expand('word') is non-standard/flaky
                       const textNode = range.startContainer;
                       const offset = range.startOffset;
                       const text = textNode.textContent || '';
                       
                       // Find word boundaries
                       let start = offset;
                       let end = offset;
                       
                       // Search backward
                       while (start > 0 && /[\w\u00C0-\u00FF\u4e00-\u9fa5'-]/.test(text[start - 1])) {
                           start--;
                       }
                       // Search forward
                       while (end < text.length && /[\w\u00C0-\u00FF\u4e00-\u9fa5'-]/.test(text[end])) {
                           end++;
                       }

                       if (end > start) {
                           try {
                               const maxOffset = textNode.textContent?.length || 0;
                               range.setStart(textNode, Math.min(start, maxOffset));
                               range.setEnd(textNode, Math.min(end, maxOffset));
                           } catch (reErr) {
                               log.debug('MouseMove expansion range failed:', reErr);
                           }
                           
                           const word = range.toString();
                           // Only highlight if it looks like a real word (skip empty or just punctuation)
                           if (word.trim().length > 0) {
                               const rect = range.getBoundingClientRect();
                               
                               // Convert rect to document coordinates (since overlay is absolute in body)
                               // Note: getBoundingClientRect is relative to viewport. 
                               // If iframe scrolls, we usually need window.scrollX/Y, but epub.js might handle flow differently.
                               // In 'paginated' flow, body usually doesn't scroll standardly, but pages are swapped.
                               // We'll trust absolute positioning relative to viewport for now or check scroll.
                               
                               overlay.style.width = `${rect.width}px`;
                               overlay.style.height = `${rect.height}px`;
                               overlay.style.top = `${rect.top + win.scrollY}px`;
                               overlay.style.left = `${rect.left + win.scrollX}px`;
                               overlay.style.display = 'block';
                               return;
                           }
                        }
                   } catch {
                       // processing error, ignore
                   }
               }
               // If we didn't return above, hide overlay
               overlay.style.display = 'none';
           });

          doc.addEventListener('mouseup', () => {
              isDragging = false;
              // Delay slightly to ensure selection is final and to allow UI to update
              setTimeout(() => {
                  doc.body.classList.remove('selecting');

                  const selection = win.getSelection();
                  if (selection && !selection.isCollapsed) {
                      const text = selection.toString().trim();
                      if (text.length > 0) {
                          try {
                              const range = selection.getRangeAt(0);
                              const rect = range.getBoundingClientRect();
                              
                              // We need to translate iframe-relative coordinates to viewport coordinates
                              const iframe = containerRef.current?.querySelector('iframe');
                              if (iframe) {
                                  const iframeRect = iframe.getBoundingClientRect();
                                  const x = iframeRect.left + rect.left + rect.width / 2;
                                  const y = iframeRect.top + rect.top;
                                  
                                  log.debug('Dispatching selection:', { text, x, y });
                                  document.dispatchEvent(new CustomEvent('epub-text-selected', {
                                      detail: { text, x, y, rect },
                                      bubbles: true
                                  }));
                              }
                          } catch (e) {
                              log.warn('Selection dispatch error:', e);
                          }
                      }
                  }
              }, 100);
          });

          // Clear selection on click if no text is selected
          doc.addEventListener('click', (_e: MouseEvent) => {
              const selection = win.getSelection();
              if (!selection || selection.isCollapsed) {
                   document.dispatchEvent(new CustomEvent('epub-clear-selection', { bubbles: true }));
              }
          });

          // Mouse leave iframe
          doc.addEventListener('mouseleave', () => {
              overlay.style.display = 'none';
          });

          log.debug('Selection listeners & Word Highlighting set up');
      });
      let startLocation = undefined;
      if (bookId) {
        try {
          const cached = await getEpubState(bookId);
          if (cached) {
            if (cached.settings?.fontSize) {
                setFontSize(cached.settings.fontSize);
                rendition.themes.fontSize(`${cached.settings.fontSize}%`);
            }
            if (cached.settings?.fontFamily) setFontFamily(cached.settings.fontFamily);
            if (cached.settings?.lineHeight) setLineHeight(cached.settings.lineHeight);
            if (cached.settings?.fitMode) setFitMode(cached.settings.fitMode);
            
            // Re-apply theme with loaded settings
             rendition.themes.default({
              body: {
                'font-family': (cached.settings?.fontFamily || fontFamily) === 'serif' 
                  ? 'Georgia, "Times New Roman", serif' 
                  : 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
                'line-height': `${cached.settings?.lineHeight || lineHeight}`,
                'padding': '20px 40px',
                'color': '#333',
                'cursor': 'default !important',
              },
              'p': { 'margin-bottom': '1em' },
            });
            
            // 只有当没有指定 jumpRequest 时，才使用缓存的 CFI
            // 注意：UniversalReader 现在将 pageNumber 转换为 jumpRequest
            if (cached.cfi && (!jumpRequest || !jumpRequest.dest)) {
                startLocation = cached.cfi;
                if (cached.percentage) setProgress(cached.percentage);
            }
          }
        } catch (e) { log.warn('Failed to load cached state:', e); }
      }

      // 如果有 initialChapter (遗留逻辑) 或 jumpRequest，不在此处处理
      // 它们会通过 useEffect 或 pendingJumpRef 处理
      
      // 如果没有 startLocation 且没有 jumpRequest，尝试使用 initialChapter (fallback)
      if (!startLocation && !jumpRequest && initialChapter && initialChapter > 0) {
          startLocation = initialChapter - 1;
      }

      // 如果还没有 startLocation，尝试使用 initialProgress
      if (!startLocation && !jumpRequest && initialProgress && initialProgress > 0) {
          try {
            await book.locations.generate(500); 
            startLocation = book.locations.cfiFromPercentage(initialProgress / 100);
          } catch (e) { log.warn('Failed to generate locations for initial pos:', e); }
      }

      try {
        await rendition.display(startLocation);
      } catch (err) {
        log.warn("Initial display failed (invalid CFI?), resetting startLocation:", err);
        // Fallback: try displaying the beginning
        try {
            await rendition.display();
        } catch (fallbackErr) {
            log.debug('Fallback display to beginning also failed:', fallbackErr);
        }
      }

      

      if (!isCancelled) {
        log.info('Setting renditionReady to true');
        setRenditionReady(true);
      } else {
        log.warn('EPUB initialization was cancelled, renditionReady will not be set');
      }
      
      // 新增：初始化完成后立即同步一次内容
      if (!isCancelled && onContentChange && rendition) {
          // Use IIFE or simple promise chain for init sync
          Promise.resolve().then(async () => {
             try {
                const loc = rendition.currentLocation();
                if (loc && loc.start) {
                    const start = loc.start.cfi;
                    const end = loc.end.cfi;
                   // FIX: await range extraction with try-catch for epub.js internal errors
                   try {
                     let rangeStart, rangeEnd;
                     try {
                       rangeStart = await book.getRange(start);
                     } catch (e) {
                       log.debug('INIT SYNC - getRange(start) failed (IndexSizeError from epub.js):', e);
                     }
                     try {
                       rangeEnd = await book.getRange(end);
                     } catch (e) {
                       log.debug('INIT SYNC - getRange(end) failed (IndexSizeError from epub.js):', e);
                     }
                     
                     if (rangeStart && rangeEnd) {
                         const startContainer = rangeStart.startContainer;
                         const endContainer = rangeEnd.endContainer;
                         const doc = startContainer.ownerDocument;
                         
                         // Check if same document and nodes are still in DOM
                         if (doc && doc === endContainer.ownerDocument && doc.contains(startContainer) && doc.contains(endContainer)) {
                             const range = doc.createRange();
                             try {
                                 const startMax = startContainer.nodeType === 3 ? (startContainer.textContent?.length || 0) : startContainer.childNodes.length; range.setStart(startContainer, Math.min(rangeStart.startOffset, startMax));
                                 // Verify offset is within bounds to avoid IndexSizeError
                                 const endOffset = Math.min(rangeEnd.endOffset, endContainer.nodeType === 3 ? (endContainer.textContent?.length || 0) : endContainer.childNodes.length);
                                 range.setEnd(endContainer, endOffset);
                                 
                                 const text = range.toString().trim();
                                 log.debug('INIT SYNC - Text length:', text.length);
                                 onContentChange(text);
                             } catch (rangeOpErr) {
                                 log.debug('INIT SYNC - Range operation failed (offsets may be stale):', rangeOpErr);
                                 onContentChange(rangeStart.toString()); // Fallback to start point only
                             }
                         } else {
                             // Fallback for cross-chapter or detached nodes
                             const text = (rangeStart.toString() + "\n...\n" + rangeEnd.toString()).trim();
                             log.debug('INIT SYNC (Fallback) - Text length:', text.length);
                             onContentChange(text);
                         }
                     } else if (rangeStart) {
                         // 只有 start 成功
                         onContentChange(rangeStart.toString());
                     }
                   } catch (err) {
                     log.debug('Manual range construction failed (likely IndexSizeError from epub.js):', err);
                     // Simple fallback - 最后尝试
                     try {
                       const range = await book.getRange(start);
                       if (range) onContentChange(range.toString());
                     } catch (finalErr) {
                       log.debug('Final getRange fallback failed:', finalErr);
                     }
                   }
                }
             } catch (e) {
                log.debug('Init sync failed:', e);
             }
          });
      }

      if (!isCancelled) {
          setLoading(false);
          if (stableTimeout) clearTimeout(stableTimeout);
          stableTimeout = setTimeout(() => {
              if (!isCancelled) setIsReadyToSave(true);
          }, 1000);
      }
      
      if (startLocation) currentCfiRef.current = startLocation;

      try {
        let locationsReady = false;
        setTimeout(() => {
            if (isCancelled || !bookRef.current) return;
            book.locations.generate(1000).then(() => {
              if (isCancelled) return;
              locationsReady = true;
               if (currentCfiRef.current) {
                    try {
                        const currentProgress = book.locations.percentageFromCfi(currentCfiRef.current);
                        setProgress(Math.round(currentProgress * 100));
                    } catch {}
               }

            }).catch((_err: any) => {
               if (!isCancelled) {
                 setLoading(false);
                 setIsReadyToSave(true);
               }
            });
        }, 200);

        rendition.on('relocated', async (location: any) => {
          if (location && location.start) {
            const cfi = location.start.cfi;
            currentCfiRef.current = cfi;
            if (locationsReady && book.locations.length() > 0) {
              const currentProgress = book.locations.percentageFromCfi(cfi);
              setProgress(Math.round(currentProgress * 100));
            }
            setForceSave(prev => prev + 1);

            // Sync page number (chapter index + 1) to parent for accurate context saving
            if (onPageChange && typeof location.start.index === 'number') {
                onPageChange(location.start.index + 1);
            }

            // 新增：提取并回传当前页可见内容（带防抖）
            if (onContentChange) {
              if (contentSyncTimeoutRef.current) clearTimeout(contentSyncTimeoutRef.current);
              
              contentSyncTimeoutRef.current = setTimeout(async () => {
                try {
                  const start = location.start.cfi;
                  const end = location.end.cfi;
                  
                  // 1. 尝试主提取方式：基于范围的提取
                  let text = "";
                  try {
                    let rangeStart, rangeEnd;
                    // 分别 try-catch 每个 getRange，因为 epub.js 内部可能抛出 IndexSizeError
                    try {
                      rangeStart = await book.getRange(start);
                    } catch (e) {
                      log.debug('Relocated sync - getRange(start) failed (IndexSizeError from epub.js):', e);
                    }
                    try {
                      rangeEnd = await book.getRange(end);
                    } catch (e) {
                      log.debug('Relocated sync - getRange(end) failed (IndexSizeError from epub.js):', e);
                    }
                    
                    if (rangeStart && rangeEnd) {
                         const startContainer = rangeStart.startContainer;
                         const endContainer = rangeEnd.endContainer;
                         const doc = startContainer.ownerDocument;

                         if (doc && doc === endContainer.ownerDocument && doc.contains(startContainer) && doc.contains(endContainer)) {
                             const range = doc.createRange();
                             try {
                                 const maxStart = startContainer.nodeType === 3 ? (startContainer.textContent?.length || 0) : startContainer.childNodes.length;
                                 range.setStart(startContainer, Math.min(rangeStart.startOffset, maxStart));
                                 // Verify offset is within bounds
                                 const maxEnd = endContainer.nodeType === 3 ? (endContainer.textContent?.length || 0) : endContainer.childNodes.length;
                                 const endOffset = Math.min(rangeEnd.endOffset, maxEnd);
                                 range.setEnd(endContainer, endOffset);
                                 text = range.toString().trim();
                             } catch (rangeOpErr) {
                                 log.debug('Relocated sync - Range operation failed:', rangeOpErr);
                                 text = rangeStart.toString().trim();
                             }
                         } else {
                             text = (rangeStart.toString() + "\n...\n" + rangeEnd.toString()).trim();
                         }
                    } else if (rangeStart) {
                         text = rangeStart.toString().trim();
                    }
                  } catch (rangeErr) {
                    log.debug('Range extraction failed, trying fallback...');
                  }
                  
                  // 2. 如果主方式失败或结果为空，尝试兜底方式：单点提取
                  if (!text) {
                    try {
                      text = rendition.getRange(start).toString().trim();
                    } catch (fallbackErr) {
                      log.debug('Fallback extraction failed');
                    }
                  }
                  
                  if (text) {
                    log.debug('Extracted visible text:', { length: text.length, preview: text.substring(0, 50) + '...' });
                    onContentChange(text);
                  } else {
                    // 降级为 debug，通常是由于处于加载中间态或图片页
                    log.debug('Extracted text is empty (possibly image page or loading)');
                  }
                } catch (e) {
                  log.debug('Content extraction logic encounter error:', e);
                }
              }, 300); // 300ms 防抖，等待排版稳定
            }
          }
        });


        // Handle click (Lookup Word)
        rendition.on('click', (e: MouseEvent, contents: any) => {
            // Click-to-lookup logic
            const selection = contents.window.getSelection();
            if (onWordClick && (!selection || selection.isCollapsed)) {
                // Try to identify word at click position
                // Note: We access the document inside the iframe
                const doc = contents.document;
                // Use standard browser caretRangeFromPoint or caretPositionFromPoint
                let range;
                if (doc.caretRangeFromPoint) {
                    range = doc.caretRangeFromPoint(e.clientX, e.clientY);
                } else if (doc.caretPositionFromPoint) {
                    const pos = doc.caretPositionFromPoint(e.clientX, e.clientY);
                    range = doc.createRange();
                    range.setStart(pos.offsetNode, Math.min(pos.offset, pos.offsetNode.nodeType === 3 ? (pos.offsetNode.textContent?.length || 0) : pos.offsetNode.childNodes.length));
                    range.collapse(true);
                }

                if (range) {
                    // Expand to word
                    // Some browsers/epub.js contexts might handle this differently
                    // Simple heuristic: expand until whitespace
                    // But range.expand('word') is non-standard / experimental
                    // We'll try to use a safer heuristic if range.expand throws or fails
                    try {
                        // Check if range.expand exists (it's non-standard but often available in this context)
                        if ((range as any).expand) {
                            (range as any).expand('word');
                            const word = range.toString().trim();
                             // Simple regex to clean the word
                            const cleanWord = word.replace(/[^a-zA-ZÀ-ÿ'-]/g, '').toLowerCase();
                            if (cleanWord && cleanWord.length > 1) {
                                log.debug('Looked up word:', cleanWord);
                                
                                // Extract context sentence from iframe
                                let contextSentence = '';
                                try {
                                    // Get text content around the clicked word
                                    const node = range.commonAncestorContainer;
                                    // Walk up to find a paragraph or div
                                    let contextNode = node.nodeType === 3 ? node.parentElement : node as Element;
                                    while (contextNode && !['P', 'DIV', 'SECTION', 'ARTICLE', 'BODY'].includes(contextNode.tagName)) {
                                        contextNode = contextNode.parentElement;
                                    }
                                    if (contextNode) {
                                        const fullText = contextNode.textContent || '';
                                        // Try to extract the sentence containing the word
                                        const sentences = fullText.match(/[^.!?]+[.!?]*/g) || [];
                                        const target = cleanWord.toLowerCase();
                                        for (const s of sentences) {
                                            if (s.toLowerCase().includes(target)) {
                                                contextSentence = s.trim();
                                                break;
                                            }
                                        }
                                        // Fallback: use first 200 chars if no sentence found
                                        if (!contextSentence && fullText) {
                                            contextSentence = fullText.substring(0, 200).trim() + '...';
                                        }
                                    }
                                } catch (e) { 
                                    log.warn('Context extraction failed:', e); 
                                }
                                
                                onWordClick(cleanWord, contextSentence || undefined);
                                return; // Success
                            }
                        }
                    } catch(e) { log.warn('Word expansion failed', e); }
                }
            }
        });
        
        // Also listen to 'markClicked' if epub.js emits it, but 'click' above covers most

        const nav = book.navigation;
        if (nav && nav.toc && onOutlineChange) {
          const outline = flattenToc(nav.toc, 0);
          onOutlineChange(outline);
        }
      } catch (err: any) {
        log.error('[EPUBReader] Init error:', err);
        if (!isCancelled) {
          setError(err.message || 'Failed to load EPUB');
          setLoading(false);
        }
      }
    };

    initBook();

    return () => {
      isCancelled = true;
      if (stableTimeout) clearTimeout(stableTimeout);
      setRenditionReady(false);
      if (bookRef.current) {
        try { bookRef.current.destroy(); } catch {}
        bookRef.current = null;
        renditionRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isClient, fileUrl]); 


  const flattenToc = (toc: any[], level: number): OutlineItem[] => {
    const result: OutlineItem[] = [];
    for (const item of toc) {
      result.push({ title: item.label, dest: item.href, pageNumber: 0, level });
      if (item.subitems && item.subitems.length > 0) result.push(...flattenToc(item.subitems, level + 1));
    }
    return result;
  };

  const goNext = useCallback(() => { renditionRef.current?.next(); }, []);
  const goPrev = useCallback(() => { renditionRef.current?.prev(); }, []);
  const changeFontSize = useCallback((delta: number) => {
    const newSize = Math.max(80, Math.min(150, fontSize + delta));
    setFontSize(newSize);
    renditionRef.current?.themes.fontSize(`${newSize}%`);
  }, [fontSize]);

  useEffect(() => {
    if (renditionReady && renditionRef.current) {
        const applyUserStyles = (contents: any) => {
             const doc = contents.document;
             if (!doc) return;
             
             let style = doc.getElementById('user-appearance-overrides');
             if (!style) {
                 style = doc.createElement('style');
                 style.id = 'user-appearance-overrides';
                 doc.head.appendChild(style);
             }
             
             const fontStack = fontFamily === 'serif' 
                ? 'Georgia, "Times New Roman", serif' 
                : 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

             style.innerHTML = `
                body, p, div, span, li, blockquote {
                    font-family: ${fontStack} !important;
                    line-height: ${lineHeight} !important;
                }
             `;
        };
        renditionRef.current.getContents().forEach(applyUserStyles);
    }
  }, [fontFamily, lineHeight, renditionReady]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goNext, goPrev]);

  // Handle Container Resize (e.g. Sidebar toggle or Window resize)
  useEffect(() => {
    if (!renditionReady || !containerRef.current) return;

    let resizeTimeout: NodeJS.Timeout;

    const resizeObserver = new ResizeObserver(() => {
      // Clear previous timeout
      if (resizeTimeout) clearTimeout(resizeTimeout);
      
      // Debounce resize to avoid layout thrashing during transitions
      // Sidebar transition is 300ms, so we wait slightly longer
      resizeTimeout = setTimeout(() => {
        if (isJumpingRef.current) {
            log.debug('Skipping resize during jump');
            return;
        }

        if (renditionRef.current && containerRef.current) {
          const { width, height } = containerRef.current.getBoundingClientRect();
          log.debug('Resizing to:', { width, height });
          
          // Save current location
          let currentCfi = null;
          try {
              const location = renditionRef.current.currentLocation();
               if (location && location.start) {
                   currentCfi = location.start.cfi;
               }
           } catch {}

           renditionRef.current.resize(width, height);
          
          // Restore location priority:
          // 1. If there's a highlight (from window.find), scroll to it
          // 2. Else restore epub.js location
          try {
              const iframe = containerRef.current.querySelector('iframe');
              const hl = iframe?.contentWindow?.document.querySelector('.hl-temp');
              if (hl && iframe?.contentWindow) {
                  log.debug('Restoring to highlight after resize');
                  // 手动计算滚动位置，避免跨页
                  const win = iframe.contentWindow;
                  const viewportHeight = win.innerHeight;
                  const elementRect = hl.getBoundingClientRect();
                  const elementCenter = elementRect.top + elementRect.height / 2;
                  const targetY = win.scrollY + elementCenter - viewportHeight * 0.4;
                  win.scrollTo({ top: targetY });
              } else if (currentCfi) {
                  try {
                      renditionRef.current.display(currentCfi);
                  } catch (displayErr) {
                      log.debug('Resize restore display failed:', displayErr);
                  }
              }
          } catch (e) {
              if (currentCfi) {
                  try {
                      renditionRef.current.display(currentCfi);
                  } catch (displayErr) {
                      log.debug('Resize fallback display failed:', displayErr);
                  }
              }
          }
        }
      }, 150); // 150ms debounce (响应更迅速)
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      if (resizeTimeout) clearTimeout(resizeTimeout);
    };
  }, [renditionReady]);

  // 绑定手势翻页
  const gestureBind = useReaderGestures(goPrev, goNext, !loading);

  if (!isClient) return <div className="flex items-center justify-center h-full bg-gray-50"><p>初始化...</p></div>;

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50">
        <div className="text-center text-red-500">
          <p className="mb-2">加载失败: {error}</p>
          <button onClick={() => window.location.reload()} className="px-4 py-2 bg-gray-600 text-white rounded">重试</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-100" data-reader-type="epub" {...gestureBind()}>
      <div className="flex-1 relative overflow-hidden">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white z-20">
            <div className="text-center"><p className="text-gray-500">加载 EPUB...</p></div>
          </div>
        )}
        {/* 搜索遮罩层 - 隐藏翻页搜索过程 */}
        {isSearching && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/95 z-30 backdrop-blur-sm">
            <div className="text-center">
              <div className="inline-block w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mb-2"></div>
              <p className="text-gray-600 text-sm">正在定位原文...</p>
            </div>
          </div>
        )}
        <div ref={containerRef} className={`h-full bg-white mx-auto shadow-sm transition-all duration-300 ${fitMode === 'page' ? 'max-w-5xl w-full' : 'w-full px-2 sm:px-4'}`} />
        

      </div>

      {/* Toolbar - Fixed at bottom (Static flow) */}
      <div 
        className="w-full z-40 flex items-center justify-between gap-6 px-6 py-2 bg-white/90 backdrop-blur-md border-t border-gray-200/50 text-sm shrink-0"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Progress Info */}
        <div className="flex items-center gap-2 text-gray-500 font-medium tabular-nums text-xs min-w-[3ch] justify-center">
             <span>{progress || 0}%</span>
        </div>

        <div className="w-px h-4 bg-gray-300/50"></div>

        {/* Navigation */}
        <div className="flex items-center gap-4">
          <button
            onClick={goPrev}
            className="p-1.5 hover:bg-black/5 rounded-full text-gray-600 transition-colors"
            title="上一页"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          
          <button
            onClick={goNext}
            className="p-1.5 hover:bg-black/5 rounded-full text-gray-600 transition-colors"
            title="下一页"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
        </div>

        <div className="w-px h-4 bg-gray-300/50"></div>

        {/* Appearance Settings */}
        <div className="relative">
             <button
                onClick={() => setShowAppearanceMenu(!showAppearanceMenu)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${showAppearanceMenu ? "bg-black/5 text-gray-900" : "hover:bg-black/5 text-gray-700"}`}
                title="外观设置"
             >
                <span className="font-serif italic text-base leading-none">Aa</span>
                <span>外观</span>
             </button>
             
             {showAppearanceMenu && (
                <div ref={appearanceMenuRef} className="absolute bottom-full right-0 mb-4 w-72 bg-white/95 backdrop-blur-xl border border-gray-100/50 rounded-2xl shadow-[0_10px_40px_rgba(0,0,0,0.15)] p-4 z-50 flex flex-col gap-4 origin-bottom-right animate-in fade-in zoom-in-95 duration-200">
                  {/* View Settings */}
                  <div>
                    <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">视图设置</div>
                    <div className="flex bg-gray-100/50 p-1 rounded-xl">
                      <button 
                        onClick={() => setFitMode('page')}
                        className={`flex-1 py-2 px-3 text-xs rounded-lg transition-all ${fitMode === 'page' ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-500 hover:text-gray-700'}`}
                      >
                         <div className="flex items-center justify-center gap-1.5">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                            适合页面
                         </div>
                      </button>
                      <button 
                        onClick={() => setFitMode('width')}
                        className={`flex-1 py-2 px-3 text-xs rounded-lg transition-all ${fitMode === 'width' ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-500 hover:text-gray-700'}`}
                      >
                         <div className="flex items-center justify-center gap-1.5">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" /></svg>
                            适合宽度
                         </div>
                      </button>
                    </div>
                  </div>

                  <div className="h-px bg-gray-100/80 scale-x-90"></div>

                  {/* Font Family */}
                  <div>
                    <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">字体样式</div>
                    <div className="flex bg-gray-100/50 p-1 rounded-xl">
                      <button 
                        onClick={() => setFontFamily('serif')}
                        className={`flex-1 py-2 px-3 text-xs rounded-lg transition-all ${fontFamily === 'serif' ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-500 hover:text-gray-700'}`}
                      >
                        <span className="font-serif text-lg">衬线</span>
                      </button>
                      <button 
                        onClick={() => setFontFamily('sans')}
                        className={`flex-1 py-2 px-3 text-xs rounded-lg transition-all ${fontFamily === 'sans' ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-500 hover:text-gray-700'}`}
                      >
                        <span className="font-sans text-lg">无衬线</span>
                      </button>
                    </div>
                  </div>

                  <div className="h-px bg-gray-100/80 scale-x-90"></div>

                  {/* Font Size & Line Height Grid */}
                  <div className="grid grid-cols-2 gap-4">
                      {/* Font Size */}
                      <div className="flex flex-col gap-2">
                         <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest text-center">字号</div>
                         <div className="flex items-center bg-gray-100/50 rounded-xl p-1">
                            <button onClick={() => changeFontSize(-10)} className="w-8 h-8 flex items-center justify-center hover:bg-white hover:shadow-sm rounded-lg transition-all text-gray-600"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" /></svg></button>
                            <span className="flex-1 text-center text-xs font-medium tabular-nums text-gray-700">{fontSize}%</span>
                            <button onClick={() => changeFontSize(10)} className="w-8 h-8 flex items-center justify-center hover:bg-white hover:shadow-sm rounded-lg transition-all text-gray-600"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg></button>
                         </div>
                      </div>

                      {/* Line Height */}
                      <div className="flex flex-col gap-2">
                         <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest text-center">行距</div>
                         <div className="flex items-center bg-gray-100/50 rounded-xl p-1">
                             <button 
                                onClick={() => setLineHeight(prev => Math.max(1.2, parseFloat((prev - 0.1).toFixed(1))))}
                                disabled={lineHeight <= 1.2}
                                className="w-8 h-8 flex items-center justify-center hover:bg-white hover:shadow-sm rounded-lg transition-all text-gray-600 disabled:opacity-30"
                             >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
                             </button>
                             <span className="flex-1 text-center text-xs font-medium tabular-nums text-gray-700">{lineHeight.toFixed(1)}</span>
                             <button 
                                onClick={() => setLineHeight(prev => Math.min(2.0, parseFloat((prev + 0.1).toFixed(1))))}
                                disabled={lineHeight >= 2.0}
                                className="w-8 h-8 flex items-center justify-center hover:bg-white hover:shadow-sm rounded-lg transition-all text-gray-600 disabled:opacity-30"
                             >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" /></svg>
                             </button>
                         </div>
                      </div>
                  </div>
                </div>
             )}
        </div>
      </div>
    </div>
  );
}

