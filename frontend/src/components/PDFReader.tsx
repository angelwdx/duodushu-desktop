"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useReaderGestures } from "../hooks/useReaderGestures";
import { Document, Page as PDFPage, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

// Configure PDF.js worker - using CDN version
const pdfWorkerUrl = `https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.296/build/pdf.worker.min.mjs`;
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// 注意：PDF 阅读需要联网加载 PDF.js worker 文件（约 700KB）
// 首次加载后会缓存到浏览器，后续使用缓存版本

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
  jumpRequest?: { dest: any; ts: number } | null;
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
                cursor: default !important;
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
            .pdf-reading-mode--selecting .react-pdf__Page__textContent span {
                cursor: text !important;
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

  // Handle jump requests (e.g. from TOC when page number resolution failed)
  useEffect(() => {
    if (!jumpRequest || !pdfDocRef.current) return;

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
          goToPage(dest + 1); // getPageIndex returns 0-based index? wait, dest is usually not number for page index, it's ref.
          // If passed raw page number from somewhere else? Usually TOC items have calculated pageNumber.
          // But let's support pageIndex just in case.
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
    let isExpanding = false;
    const handleSelectionChange = () => {
      if (isExpanding) return;
      const selection = window.getSelection();
      if (
        !selection ||
        selection.isCollapsed ||
        !containerRef.current?.contains(selection.anchorNode)
      ) {

        return;
      }
      const range = selection.getRangeAt(0);
      const startNode = range.startContainer;
      const startOffset = range.startOffset;
      const startSpan = (
        startNode.nodeType === Node.TEXT_NODE
          ? startNode.parentElement
          : startNode
      ) as HTMLElement;

      if (startSpan && startSpan.tagName === "SPAN" && startOffset === 0) {
        const prevSpan = startSpan.previousElementSibling as HTMLElement;
        if (
          prevSpan &&
          prevSpan.tagName === "SPAN" &&
          /^[A-Z]$/.test(prevSpan.textContent || "")
        ) {
          const r1 = prevSpan.getBoundingClientRect();
          const r2 = startSpan.getBoundingClientRect();
          if (Math.abs(r1.top - r2.top) < 20 && r2.left - r1.right < 15) {
            isExpanding = true;
            try {
              const newRange = document.createRange();
              newRange.setStart(prevSpan.firstChild || prevSpan, 0);
              // 安全边界检查
              const endNode = range.endContainer;
              const maxEnd = endNode.nodeType === 3 
                ? (endNode.textContent?.length || 0) 
                : endNode.childNodes.length;
              newRange.setEnd(endNode, Math.min(range.endOffset, maxEnd));
              selection.removeAllRanges();
              selection.addRange(newRange);
            } catch (e) {
              console.warn('[PDFReader] Selection expansion failed:', e);
            }
            setTimeout(() => {
              isExpanding = false;
            }, 50);
            return;
          }
        }
      }

      const selectionRects = range.getClientRects();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const mainRect = range.getBoundingClientRect();

      if (!processedWords || !pageDimensions || !pageContainerRef.current) {
        const text = selection.toString().trim();
        if (text) {
          // Use global selection system instead
          return;
        }

      }

      const scaleFactor = pageDimensions ? renderWidth / pageDimensions.width : 1;
      const pageBase = pageContainerRef.current?.getBoundingClientRect() || { left: 0, top: 0 };

      // Use total offset (system + manual calibration)
      const totalOffsetX = pageOffset.x + manualOffset.x;
      const totalOffsetY = pageOffset.y + manualOffset.y;

      const selectedWords = processedWords.filter((w) => {
        const wordLeft = pageBase.left + (w.x - totalOffsetX) * scaleFactor;
        const wordTop = pageBase.top + (w.y - totalOffsetY) * scaleFactor;
        const wordRight = wordLeft + w.width * scaleFactor;
        const wordBottom = wordTop + w.height * scaleFactor;
        const wordMidY = (wordTop + wordBottom) / 2;

        const isGiantWord = w.height > 25; // Drop-cap height threshold

        for (let i = 0; i < selectionRects.length; i++) {
          const r = selectionRects[i];
          const isGiantRect = r.height > 25 * scaleFactor;

          // Midpoint detection: vertical center of the word must be inside the selection rect
          const intersectsV = wordMidY > r.top && wordMidY < r.bottom;
          const intersectsH = wordRight > r.left + 1 && wordLeft < r.right - 1;

          if (intersectsH && intersectsV) {
            // Giant Drop-Cap rects should ONLY capture giant words.
            if (isGiantRect && !isGiantWord) continue;
            return true;
          }
        }
        return false;
      });
      // Sort words by reading order: top-to-bottom, then left-to-right
      const sortedWords = [...selectedWords].sort((a, b) => {
        // Group words by approximate row (within ~5pt tolerance)
        const rowA = Math.round(a.y / 5) * 5;
        const rowB = Math.round(b.y / 5) * 5;
        if (rowA !== rowB) return rowA - rowB; // Sort by row first
        return a.x - b.x; // Then by X (left to right)
      });

      // Smart text concatenation: add space based on gap between words
      let text = "";
      for (let i = 0; i < sortedWords.length; i++) {
        const word = sortedWords[i];
        if (i > 0) {
          const prevWord = sortedWords[i - 1];
          const gap = word.x - (prevWord.x + prevWord.width);
          const avgCharWidth =
            prevWord.width / Math.max(prevWord.text.length, 1);
          const isNewLine = Math.abs(word.y - prevWord.y) > 5;
          // Add space if: new line, or gap is larger than ~0.3 char widths
          if (isNewLine || gap > avgCharWidth * 0.3) {
            text += " ";
          }
        }
        text += word.text;
      }
      text = text.replace(/\s+/g, " ").trim();

      if (!text) {
        return;
      }
      // Use global selection system instead
    };


    document.addEventListener("selectionchange", handleSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", handleSelectionChange);
  }, [processedWords, pageDimensions, renderWidth, pageOffset, manualOffset.x, manualOffset.y]);

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

    // 修复：当 PDF 页面加载完成时，提取文本内容并同步给 AI
    // 优先使用实时提取的文本，如果失败则使用后端返回的textContent
    const extractPageText = async () => {
      try {
        const textContentFromPDF = await page.getTextContent();
        if (textContentFromPDF && textContentFromPDF.items && textContentFromPDF.items.length > 0) {
          // 过滤空字符串并连接所有文本项
          const extractedText = textContentFromPDF.items
            .map((item: any) => item.str || "")
            .filter((str: string) => str.trim() !== "")
            .join(" ");

          if (extractedText && extractedText.trim().length > 0) {
            if (onContentChange) {
              try {
                onContentChange(extractedText);
              } catch (err) {
                // 静默处理
              }
            }
          } else if (textContent) {
            // 如果提取失败，降级使用后端提供的文本内容
            console.log(`[PDFReader] Fallback to backend text for page ${pageNumber} (len: ${textContent.length})`);
            if (onContentChange) {
              onContentChange(textContent);
            }
          }
        }
      } catch (error) {
        console.error(`[PDFReader] Failed to extract text from page ${pageNumber}:`, error);
        // 降级到后端提供的文本内容
        if (textContent && onContentChange) {
          console.log(`[PDFReader] Fallback to backend text for page ${pageNumber}`);
          onContentChange(textContent);
        }
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

  /* Moved goToPage up */

  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  const handlePlayPage = async () => {
    if (isPlaying) {
      audioRef.current?.pause();
      setIsPlaying(false);
      return;
    }
    if (!words || words.length === 0) {
      alert("No text available on this page to read.");
      return;
    }
    const text = words.map((w) => w.text).join(" ");
    try {
      setIsPlaying(true);
      const { streamSpeech } = await import("../lib/api");
      const audioBlobUrl = await streamSpeech(text);
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = audioBlobUrl;
      const audio = new Audio(audioBlobUrl);
      audioRef.current = audio;
      audio.onended = () => {
        setIsPlaying(false);
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      };
      audio.onerror = () => {
        setIsPlaying(false);
        alert("Failed to play audio");
      };
      audio.play();
    } catch (e) {
      console.error(e);
      setIsPlaying(false);
      alert("Failed to generate speech");
    }
  };

  const renderHeight = pageDimensions
    ? (renderWidth / pageDimensions.width) * pageDimensions.height
    : undefined;

  const normalizeText = (text: string) => {
    if (!text) return "";
    let refined = text;
    refined = refined.replace(/([A-Z])\s*[\r\n]+\s*([a-z])/g, "$1$2");
    refined = refined.replace(/-\s*[\r\n]+\s*/g, "");
    refined = refined.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    refined = refined.replace(/\n\s*\n/g, "___PARAGRAPH___");
    refined = refined.replace(/\n/g, " ");
    refined = refined.replace(/___PARAGRAPH___/g, "\n\n");
    refined = refined.replace(/\s+/g, " ");
    return refined;
  };

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
    const tokens = normalizedContent.split(
      /([a-zA-Z0-9À-ÿ]+(?:['’-][a-zA-Z0-9À-ÿ]+)*)/,
    );
    return (
      <div className="flex-1 overflow-auto bg-gray-50 flex justify-center">
        <div className="max-w-3xl w-full bg-white shadow-sm min-h-full p-4 sm:p-6 md:p-12">
          <div className="prose prose-xl max-w-none font-serif leading-loose text-gray-800">
            {tokens.map((token, i) => {
              const isWord = /^[a-zA-Z0-9À-ÿ]+(?:['’-][a-zA-Z0-9À-ÿ]+)*$/.test(
                token,
              );
              if (isWord) {
                return (
                  <span
                    key={i}
                    className="cursor-pointer hover:bg-yellow-200 hover:text-blue-700 transition-colors rounded-sm"
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
                  <span key={i}>
                    {token
                      .split("\n")
                      .map((nl, idx) => (idx > 0 ? <br key={idx} /> : null))}
                  </span>
                );
              return <span key={i}>{token}</span>;
            })}
          </div>
          <div className="mt-16 pt-8 border-t text-center text-gray-400 text-sm">
            - Page {pageNumber} -
          </div>
        </div>
      </div>
    );
  };

  const pdfComponent = useMemo(
    () => (
      <Document
        file={fileUrl}
        onLoadSuccess={onDocumentLoadSuccess}
        loading={
          <div className="p-10 text-center text-gray-500">Loading PDF...</div>
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
      </Document>
    ),
    [fileUrl, pageNumber, renderWidth],
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

  // 绑定手势
  const gestureBind = useReaderGestures(handlePrevPage, handleNextPage, viewMode === "pdf");

  return (
    <div 
      className={`flex flex-col h-full bg-gray-100 ${isSelecting ? "pdf-reading-mode--selecting" : ""}`} 
      ref={containerRef} 
      data-reader-type="pdf"
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
            <div
              ref={pageContainerRef}
              className="relative shadow-lg bg-white"
              style={
                {
                  "--render-width": `${renderWidth}px`,
                  "--render-height": `${renderHeight}px`,
                  width: "var(--render-width)",
                  height: "var(--render-height)",
                } as React.CSSProperties
              }
              onMouseMove={(e) => {
                if (e.buttons !== 0 || !processedWords || !pageDimensions)
                  return;
                const rect = e.currentTarget.getBoundingClientRect();
                const scaleFactor = renderWidth / pageDimensions.width;
                // Total Offset = System Offset (pageOffset) + User Manual Offset (manualOffset)
                const totalOffsetX = pageOffset.x + manualOffset.x;
                const totalOffsetY = pageOffset.y + manualOffset.y;

                const pdfX =
                  (e.clientX - rect.left) / scaleFactor + totalOffsetX;
                const pdfY =
                  (e.clientY - rect.top) / scaleFactor + totalOffsetY;

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
              }}
              onMouseLeave={() => setHoveredWord(null)}
              onMouseDown={() => setHoveredWord(null)}
              onClick={(e) => {
                const selection = window.getSelection();
                if (
                  (selection && !selection.isCollapsed) ||
                  !processedWords ||
                  !pageDimensions
                )
                  return;
                const rect = e.currentTarget.getBoundingClientRect();
                const scaleFactor = renderWidth / pageDimensions.width;
                const totalOffsetX = pageOffset.x + manualOffset.x;
                const totalOffsetY = pageOffset.y + manualOffset.y;

                const pdfX =
                  (e.clientX - rect.left) / scaleFactor + totalOffsetX;
                const pdfY =
                  (e.clientY - rect.top) / scaleFactor + totalOffsetY;

                const hitIndex = processedWords.findIndex(
                  (w) =>
                    pdfX >= w.x &&
                    pdfX <= w.x + w.width &&
                    pdfY >= w.y &&
                    pdfY <= w.y + w.height,
                );

                if (hitIndex !== -1) {
                  const getContextFromWords = (
                    allWords: WordData[],
                    index: number,
                  ): string => {
                    if (index < 0 || index >= allWords.length) return "";
                    let start = index;
                    let end = index;
                    const targetWord = allWords[index];
                    const targetBlockId = targetWord.block_id;

                    const isTerminator = (text: string) =>
                      /[.!?](\s|$)/.test(text);

                    // Go backwards
                    while (start > 0) {
                      const prevWord = allWords[start - 1];
                      const currentWord = allWords[start];

                      // 1. Stop if block boundary
                      if (prevWord.block_id !== targetBlockId) {
                        // Special Case: Drop Cap in a separate block
                        // PyMuPDF often puts the large first letter in its own block.
                        const isPhysicallyNear =
                          Math.abs(currentWord.y - prevWord.y) <
                            currentWord.height * 2 &&
                          currentWord.x - (prevWord.x + prevWord.width) <
                            currentWord.height * 2;

                        const isPrevWordVeryShort = prevWord.text.length <= 2;

                        if (isPhysicallyNear && isPrevWordVeryShort) {
                          // Allow crossing this block boundary for the drop cap
                        } else {
                          break;
                        }
                      }

                      const heightRatio = prevWord.height / currentWord.height;
                      const verticalGap = Math.abs(currentWord.y - prevWord.y);

                      // 2. Identify Potential Drop Cap
                      const isStartOfSentence =
                        start - 1 === 0 ||
                        isTerminator(allWords[start - 2].text.trim());

                      const isDropCapPotential =
                        heightRatio > 1.3 && isStartOfSentence;

                      // 3. standard boundary checks (Skip if it's likely a drop cap)
                      if (!isDropCapPotential) {
                        // Stop if word height changed significantly (likely Title vs Content)
                        if (heightRatio > 1.6 || heightRatio < 0.5) break;

                        // Stop if vertical gap is too large (likely inter-paragraph or footer)
                        if (verticalGap > currentWord.height * 1.5) break;
                      }

                      // 4. Stop if we hit a sentence terminator
                      if (isTerminator(prevWord.text.trim())) break;

                      start--;
                    }

                    // Go forwards
                    while (end < allWords.length - 1) {
                      const nextWord = allWords[end + 1];
                      const currentWord = allWords[end];

                      // Stop if block boundary
                      if (nextWord.block_id !== targetBlockId) {
                        break;
                      }

                      // Stop if word height changed significantly
                      const heightRatio = nextWord.height / currentWord.height;
                      if (heightRatio > 1.6 || heightRatio < 0.5) {
                        break;
                      }

                      // Stop if vertical gap is too large
                      const vGap = Math.abs(nextWord.y - currentWord.y);
                      if (vGap > currentWord.height * 1.5) {
                        break;
                      }

                      // Check if current word contains terminator
                      const currentText = currentWord.text.trim();
                      if (isTerminator(currentText)) break;

                      // Move to next word
                      end++;
                    }
                    return allWords
                      .slice(start, end + 1)
                      .map((w) => w.text)
                      .join(" ")
                      .trim();
                  };

                  const hit = processedWords[hitIndex];
                  const context = getContextFromWords(processedWords, hitIndex);

                  onWordClick?.(hit.text, context);
                }
              }}
            >
              {pdfComponent}

              {words && pageDimensions && (
                <div className="absolute inset-0 pointer-events-none z-10">
                  {/* Debug / Calibration Layer */}
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
