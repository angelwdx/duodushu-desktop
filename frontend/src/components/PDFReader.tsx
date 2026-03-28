"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useReaderGestures } from "../hooks/useReaderGestures";
import { useFullTextTTS } from "../hooks/useFullTextTTS";
import TTSLoadingDots from "./TTSLoadingDots";
import { preprocessTTSPlainText } from "../lib/ttsText";
import { Document, Page as PDFPage, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

// Configure PDF.js worker - using CDN version
const pdfWorkerUrl = `https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.296/build/pdf.worker.min.mjs`;
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// 注意：PDF 阅读需要联网加载 PDF.js worker 文件（约 700KB）
// 首次加载后会缓存到浏览器，后续使用缓存版本

const TTS_SPEED_OPTIONS = [
  { value: 1, label: "1.0x" },
  { value: 1.1, label: "1.1x" },
  { value: 1.2, label: "1.2x" },
  { value: 1.3, label: "1.3x" },
  { value: 1.4, label: "1.4x" },
  { value: 1.5, label: "1.5x" },
] as const;

interface WordData {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  block_id?: number;
}

interface OutlineItem {
  title: string;
  dest: any;
  items?: OutlineItem[];
  pageNumber?: number;
}

async function resolveOutlinePageNumbers(
  outline: any[],
  pdfDoc: any,
): Promise<OutlineItem[]> {
  if (!pdfDoc || !outline) return [];
  const resolveItem = async (item: any): Promise<OutlineItem> => {
    let pageNumber: number | undefined;
    try {
      let dest = item.dest;
      // 1. If dest is a string (Named Destination), resolve it to an explicit array first
      if (typeof dest === "string") {
        dest = await pdfDoc.getDestination(dest);
      }

      // 2. If dest is an array [Ref, View, ...], extract the Ref (index 0)
      if (Array.isArray(dest) && dest.length > 0) {
        const ref = dest[0]; // The Ref object {num, gen}
        // 3. Get page index from Ref
        const pageIndex = await pdfDoc.getPageIndex(ref);
        // Page numbers are 1-based
        if (pageIndex !== -1) {
          pageNumber = pageIndex + 1;
        }
      }
    } catch (e) {
      console.warn(
        "Failed to resolve page number for outline item:",
        item.title,
        e,
      );
    }

    // Sanitize title: remove null bytes and other control characters that show as "tofu"
    // Also remove excessive proprietary spaces or padding
    const cleanTitle = (str: string) => {
      if (!str) return "";
      return str
        .replace(/[\x00-\x1F\x7F-\x9F]/g, "") // Remove control chars
        .replace(/\uFFFD/g, "") // Remove replacement char
        .replace(/\s+/g, " ") // Normalize spaces
        .trim();
    };

    const result: OutlineItem = {
      title: cleanTitle(item.title),
      dest: item.dest,
      pageNumber,
    };
    if (item.items && item.items.length > 0) {
      const resolvedItems = await Promise.all(item.items.map(resolveItem));
      result.items = resolvedItems;
    }
    return result;
  };
  return Promise.all(outline.map(resolveItem));
}

interface ReaderProps {
  fileUrl: string;
  bookId?: string;
  pageNumber: number;
  totalPages?: number;
  words?: WordData[];
  textContent?: string;
  onWordClick?: (word: string, context?: string) => void;
  onPageChange?: (page: number) => void;
  onTotalPagesChange?: (pages: number) => void;
  onOutlineChange?: (outline: OutlineItem[]) => void;
  jumpRequest?: { dest: any; text?: string; word?: string; ts: number } | null;
  onAskAI?: (text: string) => void;
  onHighlight?: (text: string, pageNumber: number) => void;
  onContentChange?: (content: string) => void; // 新增回调
}

  export default function PDFReader({
    fileUrl,
    bookId,
    pageNumber,
    totalPages,
    words,
    textContent,
    onWordClick,
    onPageChange,
    onTotalPagesChange,
    onOutlineChange,
    jumpRequest,
    onAskAI: _onAskAI,
    onHighlight: _onHighlight,
    onContentChange, // 新增
  }: ReaderProps) {
  // Inject CSS to narrow the text layer selection blocks
  useEffect(() => {
    const styleId = "pdf-reader-selection-style";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.innerHTML = `
            .react-pdf__Page__textContent span {
                line-height: 1.0 !important;
                cursor: text !important;
                margin: 0 !important;
                padding: 0 !important;
                box-sizing: border-box !important;
            }
            .react-pdf__Page__textContent br {
                display: none;
            }
            .react-pdf__Page__textContent span:empty {
                display: none !important;
            }
            .react-pdf__Page__textContent span::selection {
                background: rgba(0, 100, 255, 0.2) !important;
            }
        `;
      document.head.appendChild(style);
    }
  }, []);

  // State for cursor management
  const [isSelecting, setIsSelecting] = useState(false);

  useEffect(() => {
    const handleGlobalMouseUp = () => {
        setIsSelecting(false);
        mouseDownPosRef.current = null;
    };
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => window.removeEventListener("mouseup", handleGlobalMouseUp);
  }, []);

  const [numPages, setNumPages] = useState<number | null>(null);
  const [scale, setScale] = useState<number>(1.0);
  const [fitMode, setFitMode] = useState<"none" | "width" | "height" | "page">(
    "page",
  );
  const [pageDimensions, setPageDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [pageOffset, setPageOffset] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });

  // Reset dimensions when page changes to prevent stale data usage
  // 注意：滚动位置重置移至 handlePageLoad，确保 PDF 页面完全渲染后再重置
  useEffect(() => {
    setPageDimensions(null);
    setPageOffset({ x: 0, y: 0 });
    // 不要在这里重置 scrollTop，因为此时新页面尚未加载完成
    // 滚动重置将在 handlePageLoad 中执行
  }, [pageNumber]);

  // Manual Calibration State
  const [manualOffset, setManualOffset] = useState<{ x: number; y: number }>(
    () => {
      // Load from localStorage on init
      if (typeof window !== "undefined" && bookId) {
        const saved = localStorage.getItem(`pdf-calibration-${bookId}`);
        if (saved) {
          try {
            return JSON.parse(saved);
          } catch {
            /* ignore */
          }
        }
      }
      return { x: 0, y: 0 };
    },
  );
  const [showDebug, setShowDebug] = useState(false);

  // Save manual offset to localStorage when it changes
  useEffect(() => {
    if (bookId && (manualOffset.x !== 0 || manualOffset.y !== 0)) {
      localStorage.setItem(
        `pdf-calibration-${bookId}`,
        JSON.stringify(manualOffset),
      );
    }
  }, [manualOffset, bookId]);

  const [pageInputValue, setPageInputValue] = useState(String(pageNumber));
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [showOutline] = useState(false);
  const [showZoomMenu, setShowZoomMenu] = useState(false);
  const [isEditingZoom, setIsEditingZoom] = useState(false);
  const [zoomInputValue, setZoomInputValue] = useState("100");
  const [pageTextForTTS, setPageTextForTTS] = useState("");
  const [containerSize, setContainerSize] = useState<{
    width: number;
    height: number;
  }>({ width: 800, height: 600 });
  const pdfDocRef = useRef<any>(null);
  const [viewMode, setViewMode] = useState<"pdf" | "text">("pdf");

  const [hoveredWord, setHoveredWord] = useState<{
    data: WordData;
    rect: { left: number; top: number; width: number; height: number };
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pageContainerRef = useRef<HTMLDivElement>(null);
  const zoomMenuRef = useRef<HTMLDivElement>(null);
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);

  const goToPage = useCallback((page: number) => {
    const validPage = Math.max(1, Math.min(page, numPages || totalPages || 1));
    onPageChange?.(validPage);
  }, [numPages, totalPages, onPageChange]);

  // Pending highlight state for scrolling
  const [pendingHighlight, setPendingHighlight] = useState<{
    text?: string;
    word?: string;
  } | null>(null);
  const [shouldScrollToHighlight, setShouldScrollToHighlight] = useState(false);

  // Handle jump requests (e.g. from TOC or View Original)
  useEffect(() => {
    if (!jumpRequest) return;

    if (jumpRequest.text || jumpRequest.word) {
      setPendingHighlight({ text: jumpRequest.text, word: jumpRequest.word });
    }

    if (!pdfDocRef.current) return;

    const jumpToDest = async () => {
      try {
        let dest = jumpRequest.dest;
        if (typeof dest === "string") {
          // Resolve named destination string to explicit dest array
          dest = await pdfDocRef.current.getDestination(dest);
        }

        if (Array.isArray(dest)) {
          const destRef = dest[0];
          const pageIndex = await pdfDocRef.current.getPageIndex(destRef);
          if (pageIndex !== -1) {
            goToPage(pageIndex + 1);
          }
        } else if (typeof dest === "number") {
          goToPage(dest + 1);
        }
      } catch (e) {
        console.warn("Failed to jump to destination:", e);
      }
    };

    jumpToDest();
  }, [jumpRequest, goToPage]);



  const getActualWidth = useCallback(() => {
    if (!pageDimensions) return 600;
    const PADDING = 32;
    const SAFETY_MARGIN = 16;
    const TOOLBAR_HEIGHT = 48; // Reserve space for the bottom toolbar
    const containerWidth = containerSize.width - PADDING - SAFETY_MARGIN;
    const containerHeight = containerSize.height - PADDING - SAFETY_MARGIN - TOOLBAR_HEIGHT;

    if (fitMode === "width") return containerWidth;
    if (fitMode === "height") {
      const heightScale = containerHeight / pageDimensions.height;
      return pageDimensions.width * heightScale;
    }
    if (fitMode === "page") {
      const widthScale = containerWidth / pageDimensions.width;
      const heightScale = containerHeight / pageDimensions.height;
      return pageDimensions.width * Math.min(widthScale, heightScale);
    }
    return pageDimensions.width * scale;
  }, [fitMode, scale, pageDimensions, containerSize]);

  const renderWidth = getActualWidth();

  const processedWords = useMemo(() => {
    if (!words) return [];

    // Phase 1: Identify Drop Caps and find their matching words
    const dropCapIndices = new Set<number>();
    const matchedPairs: Map<number, number> = new Map(); // dropCapIndex -> matchIndex

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!/^[A-Z]$/.test(w.text)) continue;

      // A and I need stricter distance check since they're often independent words
      const isAorI = /^[AI]$/.test(w.text);

      // Find the closest matching lowercase-starting word
      let bestMatch = -1;
      let bestDistance = Infinity;

      // Optimize: Only check nearby words (window-based search)
      // Drop caps must be physically close to their matched words
      // Search BOTH directions since word order may vary
      const SEARCH_WINDOW = 15;
      const startJ = Math.max(0, i - SEARCH_WINDOW);
      const endJ = Math.min(i + SEARCH_WINDOW, words.length);

      for (let j = startJ; j < endJ; j++) {
        if (i === j) continue;
        const candidate = words[j];
        if (!/^[a-z]/.test(candidate.text)) continue;

        const dx = candidate.x - (w.x + w.width);
        const dy = Math.abs(candidate.y - w.y);

        // Calculate height ratio
        const heightRatio = w.height / candidate.height;

        // For A/I, they are often independent words.
        // ONLY merge if:
        // 1. It's a real drop cap (heightRatio > 1.2) -> standard logic
        // 2. It's roughly same height (heightRatio <= 1.2) -> DO NOT MERGE unless strictly overlapping (negative gap)
        // Some PDFs might have kerning making gap extremely small, but usually space > 0.
        // We set maxDx = 0 for same-height A/I to be safe against "A casual".
        const maxDx = isAorI 
          ? (heightRatio > 1.2 ? 10 : -1) // -1 means they must overlap significantly to merge
          : 50;
        const maxDy = isAorI ? 30 : 60;

        if (dx < -10 || dx > maxDx || dy > maxDy) continue;

        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDistance) {
          bestDistance = dist;
          bestMatch = j;
        }
      }

      if (bestMatch !== -1) {
        dropCapIndices.add(i);
        matchedPairs.set(i, bestMatch);
      }
    }

    // Phase 2: Build merged word list
    // Strategy: Keep original order, but replace matched words with merged versions
    // and skip the drop cap letters
    const merged: WordData[] = [];

    for (let i = 0; i < words.length; i++) {
      // Skip drop cap letters (they'll be merged into their matched words)
      if (dropCapIndices.has(i)) continue;

      const current = words[i];

      // Check if this word is a match target - if so, merge with its drop cap
      let foundDropCap = -1;
      for (const [dropIdx, matchIdx] of matchedPairs.entries()) {
        if (matchIdx === i) {
          foundDropCap = dropIdx;
          break;
        }
      }

      if (foundDropCap !== -1) {
        const dropCapWord = words[foundDropCap];
        const nextWord = words[i + 1];
        merged.push({
          text: dropCapWord.text + current.text,
          x: Math.min(dropCapWord.x, current.x),
          // Use body text y position for consistent context extraction
          y: current.y,
          width:
            Math.max(
              dropCapWord.x + dropCapWord.width,
              current.x + current.width,
            ) - Math.min(dropCapWord.x, current.x),
          // Use body text height for consistent height ratio checks
          height: current.height,
          // Inherit block_id from the NEXT word if available (to match the rest of the sentence)
          block_id: nextWord?.block_id ?? current.block_id,
        });
      } else {
        merged.push(current);
      }
    }

    return merged;
  }, [words]);

  useEffect(() => {
    const isExpanding = false;
    const handleSelectionChange = () => {
      // 禁用自定义选择逻辑，完全交给浏览器原生处理
      return; 
    };


    document.addEventListener("selectionchange", handleSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", handleSelectionChange);
  }, [processedWords, pageDimensions, renderWidth, pageOffset, manualOffset.x, manualOffset.y]);

  // Effect to perform scroll when words are loaded and we have a pending highlight
  useEffect(() => {
    if (
      !pendingHighlight ||
      !processedWords ||
      processedWords.length === 0 ||
      !pageDimensions ||
      !contentRef.current // Fixed: was scrollContainerRef, should be contentRef
    )
      return;

    const targetWord = pendingHighlight.word?.toLowerCase() || "";
    // Clean target context: remove punctuation for fuzzy matching
    const targetContext = pendingHighlight.text
      ? pendingHighlight.text.toLowerCase().replace(/[^\w\s]/g, "")
      : "";

    if (!targetWord && !targetContext) return;

    let bestMatch: WordData | null = null;
    let bestScore = -1;

    // Candidate matches: all words that match the targetWord (or partial match)
    const candidates = processedWords
      .map((w, i) => ({ w, i }))
      .filter(
        ({ w }) =>
          targetWord &&
          (w.text.toLowerCase() === targetWord ||
            w.text.toLowerCase().includes(targetWord)),
      );

    if (candidates.length > 0) {
      if (targetContext && candidates.length > 1) {
        // Disambiguate using context
        for (const { w, i } of candidates) {
          // Extract a window of words around the candidate
          const windowSize = 20;
          const start = Math.max(0, i - windowSize);
          const end = Math.min(processedWords.length, i + windowSize);
          const contextWindow = processedWords
            .slice(start, end)
            .map((pw) => pw.text.toLowerCase().replace(/[^\w\s]/g, ""))
            .join(" ");

          // Simple scoring: check if targetContext is roughly in contextWindow
          // We can check overlap tokens
          const contextTokens = targetContext.split(/\s+/);
          const windowTokens = contextWindow.split(/\s+/);
          
          let overlap = 0;
          for (const token of contextTokens) {
             if (windowTokens.includes(token)) overlap++;
          }
           
          // Normalize score by length
          const score = overlap / (contextTokens.length || 1);
          
          if (score > bestScore) {
            bestScore = score;
            bestMatch = w;
          }
        }
      } else {
        // Only one match or no context, pick the first/only one
        bestMatch = candidates[0].w;
      }
    } else if (targetContext) {
       // If no word match (maybe word segmentation diff), try to match context globally?
       // Harder with ProcessedWords. Fallback: don't scroll.
    }

    if (bestMatch) {
      const totalOffsetX = pageOffset.x + manualOffset.x;
      const totalOffsetY = pageOffset.y + manualOffset.y;
      const scaleFactor = renderWidth / pageDimensions.width;

      // Highlight the word visually
      setHoveredWord({
        data: bestMatch,
        rect: {
            left: (bestMatch.x - totalOffsetX) * scaleFactor,
            top: (bestMatch.y - totalOffsetY) * scaleFactor,
            width: bestMatch.width * scaleFactor,
            height: bestMatch.height * scaleFactor,
        },
      });
      
      // Trigger scroll on next render
      setShouldScrollToHighlight(true);
      setPendingHighlight(null);
    }
  }, [
    pendingHighlight,
    processedWords,
    pageDimensions,
    renderWidth,
    pageOffset,
    manualOffset,
  ]);

  // Execute scroll when highlight is ready
  useEffect(() => {
    if (shouldScrollToHighlight && hoveredWord) {
        // Use setTimeout to ensure the page is fully rendered and painted
        // requestAnimationFrame alone is not sufficient for complex PDF renders
        const timeoutId = setTimeout(() => {
            const container = contentRef.current;
            const el = document.getElementById("pdf-curr-highlight");
            
            if (el && container) {
                // Manual calculation to strictly control vertical scroll only
                // This avoids any horizontal shifting that might occur with scrollIntoView
                const containerRect = container.getBoundingClientRect();
                const elRect = el.getBoundingClientRect();
                
                const relativeTop = elRect.top - containerRect.top;
                const currentScrollTop = container.scrollTop;
                
                // Target: Center the element in the container
                // New ScrollTop = Current ScrollTop + Relative Top - (Container Height / 2) + (Element Height / 2)
                const targetScrollTop = currentScrollTop + relativeTop - (containerRect.height / 2) + (elRect.height / 2);
                
                container.scrollTo({
                    top: Math.max(0, targetScrollTop),
                    behavior: "smooth"
                });
            }
            setShouldScrollToHighlight(false);
        }, 150); // 150ms delay to ensure PDF page is fully painted
        
        return () => clearTimeout(timeoutId);
    }
  }, [shouldScrollToHighlight, hoveredWord]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        zoomMenuRef.current &&
        !zoomMenuRef.current.contains(e.target as Node)
      )
        setShowZoomMenu(false);
    };
    if (showZoomMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showZoomMenu]);

  useEffect(() => {
    setPageInputValue(String(pageNumber));
  }, [pageNumber]);

  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const updateSize = () => {
      setContainerSize({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    };
    updateSize();
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [viewMode]);

  async function onDocumentLoadSuccess(pdf: any) {
    pdfDocRef.current = pdf;
    const numPages = pdf.numPages;
    setNumPages(numPages);
    onTotalPagesChange?.(numPages);
    try {
      const pdfOutline = await pdf.getOutline();
      if (pdfOutline && pdfOutline.length > 0) {
        const resolvedOutline = await resolveOutlinePageNumbers(
          pdfOutline,
          pdf,
        );
        setOutline(resolvedOutline);
        onOutlineChange?.(resolvedOutline);
      }
    } catch (e) {
      console.warn("Failed to extract PDF outline:", e);
    }
  }

  function handlePageLoad(page: any) {
    // Use PDF.js getViewport for accurate dimensions handling CropBox and Rotation
    const viewport = page.getViewport({ scale: 1 });

    const width: number = viewport.width;
    const height: number = viewport.height;

    // Use viewport's calculated offsets.
    // PDF.js calculates these to align with specific ViewBox to (0,0) of canvas.
    // This should handle negative cropbox coordinates correctly.
    setPageOffset({ x: viewport.offsetX, y: viewport.offsetY });
    setPageDimensions({ width, height });

    // 关键修复：只有在没有待处理的高亮时才重置滚动位置
    // 如果有 pendingHighlight，让其处理滚动，避免竞态条件导致页面停在两页中间
    if (!pendingHighlight) {
      setTimeout(() => {
        if (contentRef.current) {
          contentRef.current.scrollTop = 0;
        }
      }, 0);
    }

    // PDF 朗读优先使用后端解析得到的 textContent。
    // 只有当后端该页文本为空时，才回退到 PDF.js 的实时提取结果。
    const extractPageText = async () => {
      if (textContent && textContent.trim().length > 0) {
        setPageTextForTTS(textContent);
        if (onContentChange) {
          try {
            onContentChange(textContent);
          } catch (err) {
            // 静默处理
          }
        }
        return;
      }

      try {
        const textContentFromPDF = await page.getTextContent();
        if (textContentFromPDF && textContentFromPDF.items && textContentFromPDF.items.length > 0) {
          const pageWidth = page.view?.[2] || 0;
          const pageHeight = page.view?.[3] || 0;

          // 过滤空字符串并连接所有文本项
          const extractedText = textContentFromPDF.items
            .filter((item: any) => {
              const text = String(item?.str || "").trim();
              if (!text) return false;

              const x = Number(item?.transform?.[4] || 0);
              const y = Number(item?.transform?.[5] || 0);
              const textLength = text.length;
              const isNearLeftOrRightEdge =
                pageWidth > 0 &&
                (x <= pageWidth * 0.2 || x >= pageWidth * 0.8);

              // 过滤页脚区域常见的孤立页码，如左下角或右下角的 "162"
              const isStandalonePageNumber = /^\d{1,4}$/.test(text);
              const isNearBottomFooter =
                pageWidth > 0 &&
                pageHeight > 0 &&
                y <= pageHeight * 0.12;
              if (isStandalonePageNumber && isNearBottomFooter && isNearLeftOrRightEdge) {
                return false;
              }

              // 过滤边缘处较短的页眉/页脚碎片，如书名、章名、页脚标签。
              const isShortEdgeHeaderFooter =
                pageWidth > 0 &&
                pageHeight > 0 &&
                isNearLeftOrRightEdge &&
                textLength <= 24 &&
                (y <= pageHeight * 0.08 || y >= pageHeight * 0.9);

              return !isShortEdgeHeaderFooter;
            })
            .map((item: any) => item.str || "")
            .filter((str: string) => str.trim() !== "")
            .join(" ");

          if (extractedText && extractedText.trim().length > 0) {
            setPageTextForTTS(extractedText);
            if (onContentChange) {
              try {
                onContentChange(extractedText);
              } catch (err) {
                // 静默处理
              }
            }
          }
        }
      } catch (error) {
        console.error(`[PDFReader] Failed to extract text from page ${pageNumber}:`, error);
      }
    };

    // 调用文本提取函数（不等待，避免阻塞页面渲染）
    extractPageText().catch(err => {
      console.error(`[PDFReader] extractPageText failed:`, err);
    });
  }

  const zoomIn = () => {
    setFitMode("none");
    setScale((s) => Math.min(s + 0.1, 3));
  };
  const zoomOut = () => {
    setFitMode("none");
    setScale((s) => Math.max(s - 0.1, 0.25));
  };
  const setZoomPreset = (value: number) => {
    setFitMode("none");
    setScale(value);
    setShowZoomMenu(false);
  };
  const setFitModeOption = (mode: "width" | "height" | "page") => {
    setFitMode(mode);
    setShowZoomMenu(false);
  };

  // Sync zoom input when scale changes (e.g. from buttons)
  useEffect(() => {
    setZoomInputValue(String(Math.round(scale * 100)));
  }, [scale]);

  const handleZoomInputSubmit = () => {
    const value = parseInt(zoomInputValue, 10);
    if (!isNaN(value) && value >= 25 && value <= 300) {
      setFitMode("none");
      setScale(value / 100);
    }
    setIsEditingZoom(false);
  };

  const getZoomDisplayText = () => {
    if (fitMode === "width") return "适合宽度";
    if (fitMode === "height") return "适合高度";
    if (fitMode === "page") return "适合页面";
    return `${Math.round(scale * 100)}%`;
  };

  useEffect(() => {
    setPageTextForTTS(textContent || "");
  }, [pageNumber, textContent]);

  /* Moved goToPage up */

  const repairDropCapParagraphs = (text: string) => {
    if (!text) return "";

    const paragraphs = text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean);

    const isDropCap = (part: string) => /^[A-Z]$/.test(part);
    const startsWithLowercase = (part: string) => /^[a-z]/.test(part);
    const isLikelyHeadingOrCaption = (part: string) => {
      if (!part || startsWithLowercase(part)) return false;
      const lines = part
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (lines.length === 0 || lines.length > 4) return false;
      if (lines.some((line) => line.length > 48)) return false;
      if (/[.!?]\s*$/.test(part)) return false;

      return true;
    };

    const repaired: string[] = [];

    for (let i = 0; i < paragraphs.length; i += 1) {
      const current = paragraphs[i];
      if (!isDropCap(current)) {
        repaired.push(current);
        continue;
      }

      const prefixBlocks: string[] = [];
      let bodyIndex = i + 1;

      while (bodyIndex < paragraphs.length && isLikelyHeadingOrCaption(paragraphs[bodyIndex])) {
        prefixBlocks.push(paragraphs[bodyIndex]);
        bodyIndex += 1;
      }

      if (bodyIndex < paragraphs.length && startsWithLowercase(paragraphs[bodyIndex])) {
        repaired.push(...prefixBlocks);
        repaired.push(`${current}${paragraphs[bodyIndex]}`);
        i = bodyIndex;
        continue;
      }

      repaired.push(current);
    }

    return repaired.join("\n\n");
  };

  const normalizeText = (text: string) => {
    if (!text) return "";
    let refined = repairDropCapParagraphs(text);
    refined = refined.replace(/(?:^|\n)\s*[-–—]?\s*Page\s+\d+\s*[-–—]?\s*(?=\n|$)/gim, "\n");
    refined = refined.replace(/(?:^|\n)\s*第\s*\d+\s*页\s*(?=\n|$)/gim, "\n");
    refined = refined.replace(/(?:^|\n)\s*\d{1,4}\s*(?=\n|$)/gm, "\n");
    refined = refined.replace(/([A-Z])\s*[\r\n]+\s*([a-z])/g, "$1$2");
    refined = refined.replace(/-\s*[\r\n]+\s*/g, "");
    refined = refined.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    refined = refined.replace(/\n\s*\n/g, "___PARAGRAPH___");
    refined = refined.replace(/\n/g, " ");
    refined = refined.replace(/___PARAGRAPH___/g, "\n\n");
    refined = refined.replace(/\s+/g, " ");
    return refined;
  };

  // 全文朗读的文本来源与文本模式显示保持一致：都使用 normalizeText 处理后的文本
  const getPageText = useCallback((_page: number): string => {
    return preprocessTTSPlainText(normalizeText(pageTextForTTS || ""));
  }, [pageTextForTTS]);

  const tts = useFullTextTTS({
    getPageText,
    totalPages: numPages || totalPages || 1,
    currentPage: pageNumber,
    onPageChange: goToPage,
    pageChangeDelay: 400,
  });

  const renderHeight = pageDimensions
    ? (renderWidth / pageDimensions.width) * pageDimensions.height
    : undefined;

  const renderTextMode = () => {
    if (!textContent) {
      return (
        <div className="flex-1 flex items-center justify-center text-gray-400 p-10 bg-gray-50">
          <div className="text-center">
            <p className="mb-2 text-lg">暂无文本内容</p>
            <p className="text-sm">可能该页面是纯图片或解析尚未完成</p>
          </div>
        </div>
      );
    }
    const normalizedContent = normalizeText(textContent);

    // 计算当前朗读片段在规范化内容中的字符范围
    // chunkText 来自 normalizeText(textContent)，直接 indexOf 即可精确匹配
    const chunkText = tts.currentChunkText;
    let hlStart = -1;
    let hlEnd   = -1;
    if (chunkText) {
      hlStart = normalizedContent.indexOf(chunkText);
      if (hlStart >= 0) hlEnd = hlStart + chunkText.length;
    }

    const tokens = normalizedContent.split(
      /([a-zA-Z0-9À-ÿ]+(?:[''-][a-zA-Z0-9À-ÿ]+)*)/,
    );

    let charPos = 0;
    return (
      <div className="flex-1 overflow-auto bg-gray-50 flex justify-center">
        <div className="max-w-3xl w-full bg-white shadow-sm min-h-full p-4 sm:p-6 md:p-12">
          <div className="prose prose-xl max-w-none font-serif leading-loose text-gray-800">
            {tokens.map((token, i) => {
              const start = charPos;
              const end   = charPos + token.length;
              charPos = end;

              // 当前 token 是否在高亮范围内
              const isHighlighted = hlStart >= 0 && start < hlEnd && end > hlStart;

              const isWord = /^[a-zA-Z0-9À-ÿ]+(?:[''-][a-zA-Z0-9À-ÿ]+)*$/.test(token);
              if (isWord) {
                return (
                  <span
                    key={i}
                    data-tts-hl={isHighlighted ? 'true' : undefined}
                    className={`cursor-pointer rounded-sm transition-colors ${
                      isHighlighted
                        ? 'bg-yellow-200 text-gray-900'
                        : 'hover:bg-yellow-100 hover:text-blue-700'
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onWordClick?.(token);
                    }}
                  >
                    {token}
                  </span>
                );
              }
              if (token.includes("\n"))
                return (
                  <span
                    key={i}
                    className={isHighlighted ? 'bg-yellow-100' : ''}
                  >
                    {token.split("\n").map((nl, idx) => (idx > 0 ? <br key={idx} /> : null))}
                  </span>
                );
              return (
                <span
                  key={i}
                  className={isHighlighted ? 'bg-yellow-100' : ''}
                >
                  {token}
                </span>
              );
            })}
          </div>
          <div className="mt-16 pt-8 border-t text-center text-gray-400 text-sm">
            - Page {pageNumber} -
          </div>
        </div>
      </div>
    );
  };

  // 朗读片段变化时，自动滚动到高亮块的中心位置
  useEffect(() => {
    if (!tts.isPlaying || !tts.currentChunkText || viewMode !== 'text') return;
    const el = document.querySelector('[data-tts-hl="true"]');
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [tts.currentChunkText, tts.isPlaying, viewMode]);

  // 鼠标按下：记录起始位置，准备判断点击或拖动
  const handlePageMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止冒泡，隔离外层手势
    mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
    setHoveredWord(null);
  };

  // 这里不需要 MouseMove 来更新 isSelecting，因为我们通过物理隔离屏蔽了手势
  // 只需要处理 Hover 高亮
  const handlePageMouseMove = (e: React.MouseEvent) => {
    // 高亮逻辑保持不变
    if (e.buttons !== 0 || !processedWords || !pageDimensions) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleFactor = renderWidth / pageDimensions.width;
    const totalOffsetX = pageOffset.x + manualOffset.x;
    const totalOffsetY = pageOffset.y + manualOffset.y;
    const pdfX = (e.clientX - rect.left) / scaleFactor + totalOffsetX;
    const pdfY = (e.clientY - rect.top) / scaleFactor + totalOffsetY;

    const hit = processedWords.find(
        (w) =>
        pdfX >= w.x &&
        pdfX <= w.x + w.width &&
        pdfY >= w.y &&
        pdfY <= w.y + w.height,
    );
    if (hit) {
        setHoveredWord({
        data: hit,
        rect: {
            left: (hit.x - totalOffsetX) * scaleFactor,
            top: (hit.y - totalOffsetY) * scaleFactor,
            width: hit.width * scaleFactor,
            height: hit.height * scaleFactor,
        },
        });
    } else setHoveredWord(null);
  };

  // 鼠标抬起：判断是点击还是选择
  const handlePageMouseUp = (e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止冒泡

    // 1. 如果没有起始点，忽略
    if (!mouseDownPosRef.current) return;

    // 2. 计算移动距离
    const dx = e.clientX - mouseDownPosRef.current.x;
    const dy = e.clientY - mouseDownPosRef.current.y;
    const dist = dx * dx + dy * dy;
    
    // 清除起始点
    mouseDownPosRef.current = null;

    // 3. 如果移动距离超过 25px² (5px)，视为拖拽选择，不触发查词
    if (dist > 25) {
        return;
    }

    // 4. 否则视为点击，执行查词逻辑
    const selection = window.getSelection();
    // 如果此时有跨行选择存在，且用户只是点了一下（比如想取消选择），应该允许浏览器的默认行为（清除选择）
    // 但如果点击在了单词上，我们想查词。
    // 通常点击会清除 Selection，所以这里 selection.isCollapsed 可能是 true（如果浏览器先处理了）
    // 我们主要依赖坐标判定

    if (!processedWords || !pageDimensions) return;
    
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleFactor = renderWidth / pageDimensions.width;
    const totalOffsetX = pageOffset.x + manualOffset.x;
    const totalOffsetY = pageOffset.y + manualOffset.y;

    const pdfX = (e.clientX - rect.left) / scaleFactor + totalOffsetX;
    const pdfY = (e.clientY - rect.top) / scaleFactor + totalOffsetY;

    const hitIndex = processedWords.findIndex(
        (w) =>
        pdfX >= w.x &&
        pdfX <= w.x + w.width &&
        pdfY >= w.y &&
        pdfY <= w.y + w.height,
    );

    if (hitIndex !== -1) {
        const hit = processedWords[hitIndex];
        
        // 简单的上下文获取逻辑（原逻辑的简化版，避免过长代码）
        // 实际上可以直接复用原有的 getContextFromWords 如果它是解耦的
        // 这里为了稳健，我们暂时只传 text，或者简单截取前后
        // 重新内联核心上下文逻辑以确保功能完整：
        const getContext = () => {
             // ...简化的上下文获取...
             // 为了代码简洁，只取当前句
             return hit.text; // 暂时简化，重点是修复响应性
        };
        
        // 恢复完整上下文逻辑，因为这是用户需要的功能
        const getContextFromWords = (allWords: WordData[], index: number): string => {
             // ...完整代码复用...
             // 由于篇幅限制，这里用之前的逻辑
            if (index < 0 || index >= allWords.length) return "";
            let start = index;
            let end = index;
            const targetBlockId = allWords[index].block_id;
            const isTerminator = (text: string) => /[.!?](\s|$)/.test(text);

            while (start > 0) {
                if (allWords[start-1].block_id !== targetBlockId) break;
                if (isTerminator(allWords[start-2]?.text.trim() || "")) break; // 简单判定
                if (isTerminator(allWords[start-1].text.trim())) break; 
                start--;
            }
            while (end < allWords.length - 1) {
                if (allWords[end+1].block_id !== targetBlockId) break;
                if (isTerminator(allWords[end].text.trim())) break;
                end++;
            }
            return allWords.slice(start, end + 1).map(w => w.text).join(" ").trim();
        }

        onWordClick?.(hit.text, getContextFromWords(processedWords, hitIndex));
    }
  };

  const handlePagePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
  };

  const handlePageMouseLeave = () => {
      setHoveredWord(null);
  };

  // 移除 useMemo 以确保 handler 能访问最新 state
  const pdfComponent = (
      <Document
        file={fileUrl}
        onLoadSuccess={onDocumentLoadSuccess}
        loading={
          <div className="p-10 text-center text-gray-500">Loading PDF...</div>
        }
      >
        <div
          ref={pageContainerRef}
          onMouseDown={handlePageMouseDown}
          onMouseUp={handlePageMouseUp}
          onPointerDown={handlePagePointerDown}
          onMouseMove={handlePageMouseMove}
          onMouseLeave={handlePageMouseLeave}
          className="relative shadow-lg bg-white"
          style={
            {
              "--render-width": `${renderWidth}px`,
              "--render-height": `${renderHeight}px`,
              width: "var(--render-width)",
              height: "var(--render-height)",
            } as React.CSSProperties
          }
        >
          <PDFPage
            key={pageNumber}
            pageNumber={pageNumber}
            width={renderWidth}
            onLoadSuccess={handlePageLoad}
            renderTextLayer={true}
            renderAnnotationLayer={false}
          />
           {/* Debug / Calibration Layer */}
           {words && pageDimensions && (
                <div className="absolute inset-0 pointer-events-none z-10">
                  {showDebug &&
                    words.map((w, i) => {
                      const totalOffsetX = pageOffset.x + manualOffset.x;
                      const totalOffsetY = pageOffset.y + manualOffset.y;
                      const scaleFactor = renderWidth / pageDimensions.width;
                      return (
                        <div
                          key={i}
                          className="absolute border border-red-500/50"
                          style={
                            {
                              left: `${(w.x - totalOffsetX) * scaleFactor}px`,
                              top: `${(w.y - totalOffsetY) * scaleFactor}px`,
                              width: `${w.width * scaleFactor}px`,
                              height: `${w.height * scaleFactor}px`,
                            } as React.CSSProperties
                          }
                        />
                      );
                    })}

                  {hoveredWord && (
                    <div
                      id="pdf-curr-highlight"
                      className="absolute bg-yellow-200/50 rounded-sm transition-opacity"
                      style={
                        {
                          left: `${hoveredWord.rect.left}px`,
                          top: `${hoveredWord.rect.top}px`,
                          width: `${hoveredWord.rect.width}px`,
                          height: `${hoveredWord.rect.height}px`,
                        } as React.CSSProperties
                      }
                    />
                  )}
                </div>
              )}
        </div>
      </Document>
  );

  const handleContainerMouseDown = (e: React.MouseEvent) => {
      mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleContainerMouseMove = (e: React.MouseEvent) => {
      // Only enable selection mode if dragged more than 5px
      if (mouseDownPosRef.current && !isSelecting) {
          const dx = e.clientX - mouseDownPosRef.current.x;
          const dy = e.clientY - mouseDownPosRef.current.y;
          if (dx * dx + dy * dy > 25) { // 5px threshold
              setIsSelecting(true);
          }
      }
  };

  // 手势翻页处理
  const handlePrevPage = useCallback(() => {
    if (pageNumber > 1) {
      goToPage(pageNumber - 1);
    }
  }, [pageNumber, goToPage]);

  const handleNextPage = useCallback(() => {
    if (pageNumber < (numPages || totalPages || 1)) {
      goToPage(pageNumber + 1);
    }
  }, [pageNumber, numPages, totalPages, goToPage]);

  // 绑定手势 (仅在非选择模式下启用)
  const gestureBind = useReaderGestures(handlePrevPage, handleNextPage, viewMode === "pdf" && !isSelecting);

  return (
    <div 
      className={`flex flex-col h-full bg-gray-100 ${isSelecting ? "pdf-reading-mode--selecting" : ""}`} 
      ref={containerRef} 
      data-reader-type="pdf"
      style={{ touchAction: 'pan-y' }} // 允许垂直滚动和选择，消除 use-gesture 警告
      onMouseDown={handleContainerMouseDown}
      onMouseMove={handleContainerMouseMove}
      {...gestureBind()}
    >
      {viewMode === "pdf" ? (
        <div className="flex-1 overflow-hidden flex" ref={scrollContainerRef}>
          {showOutline && outline.length > 0 && (
            <div className="w-64 bg-white border-r overflow-y-auto shrink-0">
              <div className="p-3 border-b bg-gray-50 font-medium text-sm text-gray-700 sticky top-0">
                📑 目录
              </div>
              <div className="p-2">
                {(() => {
                  const renderOutlineItems = (
                    items: OutlineItem[],
                    level: number = 0,
                  ): React.ReactNode => {
                    return items.map((item, idx) => (
                      <div key={idx}>
                        <button
                          onClick={() =>
                            item.pageNumber && goToPage(item.pageNumber)
                          }
                          className={`w-full text-left px-2 py-1.5 text-sm rounded hover:bg-blue-50 transition-colors ${
                            item.pageNumber === pageNumber
                              ? "bg-blue-100 text-blue-700"
                              : "text-gray-700"
                          } ${
                            [
                              "pl-2",
                              "pl-6",
                              "pl-10",
                              "pl-14",
                              "pl-20",
                              "pl-24",
                              "pl-24",
                            ][level] || "pl-2"
                          }`}
                        >
                          <span className="line-clamp-2">{item.title}</span>
                          {item.pageNumber && (
                            <span className="text-xs text-gray-400 ml-1">
                              p.{item.pageNumber}
                            </span>
                          )}
                        </button>
                        {item.items &&
                          item.items.length > 0 &&
                          renderOutlineItems(item.items, level + 1)}
                      </div>
                    ));
                  };
                  return renderOutlineItems(outline);
                })()}
              </div>
            </div>
          )}

          <div
            className="flex-1 overflow-auto p-4 flex justify-center"
            ref={contentRef}
          >
              {pdfComponent}
          </div>
        </div>
      ) : (
        renderTextMode()
      )}

      <div 
        className="absolute bottom-0 left-0 w-full z-40 flex items-center justify-between gap-6 px-6 py-2 bg-white/90 backdrop-blur-md border-t border-gray-200/50 text-sm"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 朗读控制区 ── */}
        <div className="flex items-center gap-2 shrink-0">
          {/* 音色选择：始终可见，朗读前就可以选 */}
          <select
            value={tts.voice}
            onChange={(e) => tts.setVoice(e.target.value as any)}
            className="text-xs bg-transparent border border-gray-200/60 rounded-full px-2 py-1 text-gray-500 hover:text-gray-700 hover:border-gray-300 cursor-pointer focus:outline-none transition-colors"
            title="选择朗读语音"
          >
            {tts.voices.map(v => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>

          <select
            value={tts.speed}
            onChange={(e) => tts.setSpeed(Number(e.target.value))}
            className="text-xs bg-transparent border border-gray-200/60 rounded-full px-2 py-1 text-gray-500 hover:text-gray-700 hover:border-gray-300 cursor-pointer focus:outline-none transition-colors"
            title="调整朗读速度"
          >
            {TTS_SPEED_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>

          {!tts.isPlaying && !tts.isPaused ? (
            // 初始状态：播放按钮
            <button
              onClick={tts.play}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-gray-100/80 hover:bg-gray-200/80 text-gray-700 transition-colors border border-gray-200/50"
              title="从当前页开始朗读全文"
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
              朗读
            </button>
          ) : (
            // 朗读中 / 已暂停
            <div className="flex items-center gap-1.5">
              {tts.isPlaying ? (
                <button
                  onClick={tts.pause}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium bg-amber-50 text-amber-600 hover:bg-amber-100 transition-colors border border-amber-200/60"
                  title="暂停朗读"
                >
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                  </svg>
                  暂停
                </button>
              ) : (
                <button
                  onClick={tts.resume}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium bg-green-50 text-green-600 hover:bg-green-100 transition-colors border border-green-200/60"
                  title="继续朗读"
                >
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                  继续
                </button>
              )}
              <button
                onClick={tts.stop}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium bg-gray-100/80 text-gray-500 hover:bg-red-50 hover:text-red-500 transition-colors border border-gray-200/50"
                title="停止朗读"
              >
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 6h12v12H6z" />
                </svg>
                停止
              </button>
              {/* 当前朗读页 */}
              <span className="text-xs text-gray-400 pl-0.5 inline-flex min-w-[16em]">
                {tts.currentReadingPage !== null ? (
                  <>
                    <span>{tts.isPaused ? '已暂停' : `第 ${tts.currentReadingPage} 页`}</span>
                    <span className="ml-1.5 text-gray-300">
                      <TTSLoadingDots active={tts.provider === 'qwen3' && tts.isGenerating} />
                    </span>
                  </>
                ) : (
                  <span className="inline-flex items-center">
                    <span className="opacity-0">第 9999 页</span>
                    <span className="ml-1.5 text-gray-300 opacity-0">
                      <TTSLoadingDots active />
                    </span>
                  </span>
                )}
              </span>
            </div>
          )}
        </div>

        {/* View Mode Toggle */}
        <div className="flex bg-gray-100/80 p-0.5 rounded-full border border-gray-200/50">
          <button
            onClick={() => setViewMode("pdf")}
            className={`px-3 py-1.5 text-xs font-medium rounded-full transition-all flex items-center gap-1.5 ${viewMode === "pdf" ? "bg-white text-gray-900 shadow-sm ring-1 ring-black/5" : "text-gray-500 hover:text-gray-700"}`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            原图
          </button>
          <button
            onClick={() => setViewMode("text")}
            className={`px-3 py-1.5 text-xs font-medium rounded-full transition-all flex items-center gap-1.5 ${viewMode === "text" ? "bg-white text-gray-900 shadow-sm ring-1 ring-black/5" : "text-gray-500 hover:text-gray-700"}`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            文本
          </button>
        </div>

        <div className="w-px h-4 bg-gray-300/50"></div>

        {/* Navigation */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => goToPage(pageNumber - 1)}
            disabled={pageNumber <= 1}
            className="p-1.5 hover:bg-black/5 rounded-full text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="上一页"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          
          <div className="flex items-center gap-2 font-medium tabular-nums text-gray-700 cursor-text hover:bg-black/5 px-2 py-1 rounded-md transition-colors group relative">
             <input
              type="text"
              value={pageInputValue}
              onChange={(e) => setPageInputValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && goToPage(parseInt(pageInputValue))}
              className="w-10 text-center bg-transparent border-none p-0 focus:ring-0 text-gray-900 font-semibold"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <span className="text-gray-400 select-none">/</span>
            <span className="text-gray-500 select-none min-w-[2ch] block">{numPages || totalPages || "?"}</span>
          </div>

          <button
            onClick={() => goToPage(pageNumber + 1)}
            disabled={pageNumber >= (numPages || totalPages || 9999)}
            className="p-1.5 hover:bg-black/5 rounded-full text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="下一页"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
        </div>

        <div className="w-px h-4 bg-gray-300/50"></div>

        <div
          ref={zoomMenuRef}
          className={`relative flex items-center gap-2 ${viewMode === "text" ? "opacity-30 pointer-events-none grayscale" : ""}`}
        >
          {/* Calibration Button */}
             {/* Calibration */}
             <button 
                onClick={() => setShowDebug(!showDebug)}
                className={`p-1.5 rounded-full transition-all ${showDebug ? "bg-red-50 text-red-600" : "hover:bg-black/5 text-gray-400 hover:text-gray-700"}`}
                title="校准模式"
             >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
             </button>

          {showDebug && (
            <div className="absolute bottom-full mb-2 right-0 bg-white border rounded-lg shadow-lg p-3 min-w-[200px] z-50 flex flex-col gap-2">
              <div className="text-xs font-bold text-gray-700 mb-1">
                坐标校准 (单位: PDF点)
              </div>
              <div className="flex items-center justify-between text-xs">
                <span>X 偏移:</span>
                <div className="flex items-center gap-1">
                  <button
                    className="px-1.5 bg-gray-100 rounded hover:bg-gray-200"
                    onClick={() =>
                      setManualOffset((p) => ({ ...p, x: p.x - 5 }))
                    }
                  >
                    -5
                  </button>
                  <span className="w-8 text-center">{manualOffset.x}</span>
                  <button
                    className="px-1.5 bg-gray-100 rounded hover:bg-gray-200"
                    onClick={() =>
                      setManualOffset((p) => ({ ...p, x: p.x + 5 }))
                    }
                  >
                    +5
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span>Y 偏移:</span>
                <div className="flex items-center gap-1">
                  <button
                    className="px-1.5 bg-gray-100 rounded hover:bg-gray-200"
                    onClick={() =>
                      setManualOffset((p) => ({ ...p, y: p.y - 5 }))
                    }
                  >
                    -5
                  </button>
                  <span className="w-8 text-center">{manualOffset.y}</span>
                  <button
                    className="px-1.5 bg-gray-100 rounded hover:bg-gray-200"
                    onClick={() =>
                      setManualOffset((p) => ({ ...p, y: p.y + 5 }))
                    }
                  >
                    +5
                  </button>
                </div>
              </div>
            </div>
          )}

             {/* Zoom Trigger */}
             <div className="relative">
                 <button
                    onClick={() => setShowZoomMenu(!showZoomMenu)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors hover:bg-black/5 text-gray-700 min-w-[3.5rem] justify-center"
                 >
                    <span>{getZoomDisplayText()}</span>
                    <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                 </button>
                 
                 {/* Zoom Menu Popover */}
                 {showZoomMenu && (
                    <div className="absolute bottom-full right-0 mb-4 w-52 bg-white/95 backdrop-blur-xl border border-gray-100/50 rounded-2xl shadow-[0_10px_40px_rgba(0,0,0,0.15)] p-3 z-50 flex flex-col gap-1 origin-bottom-right animate-in fade-in zoom-in-95 duration-200">
                        <div className="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest">视图设置</div>
                        <button onClick={() => setFitModeOption("width")} className={`w-full text-left px-3 py-2 text-sm rounded-xl flex items-center justify-between transition-colors ${fitMode === "width" ? "bg-blue-50/80 text-blue-600" : "hover:bg-gray-100/80 text-gray-700"}`}>
                            适合宽度 <kbd className="text-[10px] bg-white/50 px-1 rounded border border-black/5">W</kbd>
                        </button>
                        <button onClick={() => setFitModeOption("height")} className={`w-full text-left px-3 py-2 text-sm rounded-xl flex items-center justify-between transition-colors ${fitMode === "height" ? "bg-blue-50/80 text-blue-600" : "hover:bg-gray-100/80 text-gray-700"}`}>
                            适合高度 <kbd className="text-[10px] bg-white/50 px-1 rounded border border-black/5">H</kbd>
                        </button>
                        <button onClick={() => setFitModeOption("page")} className={`w-full text-left px-3 py-2 text-sm rounded-xl flex items-center justify-between transition-colors ${fitMode === "page" ? "bg-blue-50/80 text-blue-600" : "hover:bg-gray-100/80 text-gray-700"}`}>
                            适合页面 <kbd className="text-[10px] bg-white/50 px-1 rounded border border-black/5">P</kbd>
                        </button>
                        
                        <div className="h-px bg-gray-100/80 my-2 scale-x-90"></div>
                        
                        <div className="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest">缩放比例</div>
                        <div className="flex items-center gap-3 px-2">
                             <button onClick={zoomOut} className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded-full text-gray-600 transition-colors"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" /></svg></button>
                             <div className="flex-1 relative group">
                                <input 
                                    type="text" 
                                    className="w-full text-center font-semibold text-sm text-gray-700 bg-gray-50/50 border-none rounded-md py-1 focus:ring-0 group-hover:bg-gray-100/50 transition-colors" 
                                    value={zoomInputValue}
                                    onChange={(e) => setZoomInputValue(e.target.value.replace(/[^0-9]/g, ""))}
                                    onKeyDown={(e) => e.key === "Enter" && handleZoomInputSubmit()}
                                    onBlur={handleZoomInputSubmit}
                                    placeholder={Math.round(scale * 100) + "%"}
                                />
                             </div>
                             <button onClick={zoomIn} className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded-full text-gray-600 transition-colors"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg></button>
                        </div>
                    </div>
                 )}
             </div>
        </div>
      </div>
    </div>
  );
}
