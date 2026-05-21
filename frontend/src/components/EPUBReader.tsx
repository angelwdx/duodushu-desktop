"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useReaderGestures } from '../hooks/useReaderGestures';
import { useFullTextTTS } from '../hooks/useFullTextTTS';
import TTSLoadingDots from './TTSLoadingDots';
import TTSQuickMenu from './TTSQuickMenu';
import { saveEpubState, getEpubState } from '../lib/epubCache';
import { createLogger } from '../lib/logger';
import { type FuriganaAnnotation, type JapaneseLookupSegment } from '../lib/api';
import { containsJapaneseText, isJapaneseBookLanguage } from '../lib/japaneseText';
import { ensureFuriganaAnnotations } from '../lib/japaneseFurigana';
import { preprocessTTSPlainText } from '../lib/ttsText';

const log = createLogger('EPUBReader');
const FURIGANA_PREFERENCE_KEY = 'reader_japanese_furigana_enabled';

function getEffectiveFuriganaLineHeight(lineHeight: number, enabled: boolean): number {
  if (!enabled) return lineHeight;
  return Math.max(lineHeight, 2.05);
}

const TTS_SPEED_OPTIONS = [
  { value: 1, label: '1.0x' },
  { value: 1.1, label: '1.1x' },
  { value: 1.2, label: '1.2x' },
  { value: 1.3, label: '1.3x' },
  { value: 1.4, label: '1.4x' },
  { value: 1.5, label: '1.5x' },
] as const;

interface OutlineItem {
  title: string;
  dest: string | null;
  pageNumber: number;
  level?: number;
}

interface EpubLayoutState {
  writingMode: string;
  isVertical: boolean;
  pageProgression: 'ltr' | 'rtl';
}

type AnnotationDisplayPiece =
  | { type: 'text'; text: string; start: number; end: number }
  | { type: 'ruby'; base: string; reading: string; start: number; end: number };

const LOOKUP_WORD_CHAR_PATTERN = /[\w\u00C0-\u024F\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff々〆ヵヶー'-]/;
const LOOKUP_WORD_EDGE_PATTERN = /^[^A-Za-z0-9\u00C0-\u024F\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff々〆ヵヶー'-]+|[^A-Za-z0-9\u00C0-\u024F\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff々〆ヵヶー'-]+$/g;
const LOOKUP_WORD_EDGE_QUOTES_PATTERN = /^['-]+|['-]+$/g;
const SENTENCE_SPLIT_PATTERN = /[^。！？.!?\n]+[。！？.!?]*/g;
const FORCE_HORIZONTAL_LAYOUT_STYLE_ID = 'duodushu-force-horizontal-layout';
const EPUB_STAGE_OVERRIDE_STYLE_ID = 'duodushu-epub-stage-overrides';
const FURIGANA_IGNORE_CLASS = 'duodushu-furigana-ignore';
type IdleCapableWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

interface EPUBReaderProps {
  initialProgress?: number;
  initialChapter?: number;
  fileUrl: string;
  bookId?: string;
  bookLanguage?: string | null;
  onWordClick?: (word: string, context?: string) => void;
  onOutlineChange?: (outline: OutlineItem[]) => void;
  onPageChange?: (progress: number) => void;
  onContentChange?: (content: string) => void; // 新增：内容变更回调
  onAskAI?: (text: string) => void;
  onHighlight?: (text: string, source?: string | number) => void;
  jumpRequest?: { dest: string | number; text?: string; word?: string; ts: number } | null;
}

export default function EPUBReader({
  fileUrl,
  bookId,
  bookLanguage,
  initialProgress,
  initialChapter, // 新增
  onWordClick,
  onOutlineChange,
  onPageChange,
  onContentChange, // 新增
  jumpRequest
}: EPUBReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<any>(null);
  const bookBufferRef = useRef<ArrayBuffer | null>(null);
  const renditionRef = useRef<any>(null);
  const saveProgressTimeout = useRef<NodeJS.Timeout | null>(null);
  const currentCfiRef = useRef<string | null>(null);
  const preciseProgressRef = useRef(0);
  const contentLayoutRef = useRef<EpubLayoutState>({
    writingMode: 'horizontal-tb',
    isVertical: false,
    pageProgression: 'ltr',
  });
  const bookDirectionRef = useRef<'ltr' | 'rtl'>('ltr');
  const forceHorizontalLayoutRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [displayPage, setDisplayPage] = useState<number | null>(null);
  const [displayTotalPages, setDisplayTotalPages] = useState<number | null>(null);
  const [visiblePageTextForTTS, setVisiblePageTextForTTS] = useState("");
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
  const lastReportedChapterRef = useRef<number | null>(null);
  const displayPageOffsetsRef = useRef<number[]>([]);
  const displayPaginationCacheRef = useRef(
    new Map<string, { totalPages: number; offsets: number[] }>(),
  );
  const displayPaginationMeasureTokenRef = useRef(0);
  const relocationTokenRef = useRef(0);
  const currentSectionPageRef = useRef<{ sectionIndex: number | null; sectionPage: number | null }>({
    sectionIndex: null,
    sectionPage: null,
  });
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const isJapaneseBook = useMemo(() => isJapaneseBookLanguage(bookLanguage), [bookLanguage]);
  const [showFurigana, setShowFurigana] = useState(false);
  const [furiganaPreferenceReady, setFuriganaPreferenceReady] = useState(!isJapaneseBook);
  const furiganaCacheRef = useRef<Map<string, FuriganaAnnotation>>(new Map());
  const furiganaEnabledRef = useRef(false);
  // 用于检测外观设置的实际变化（区分"初次挂载"和"值真的改变了"）
  const prevShowFuriganaRef = useRef<boolean | undefined>(undefined);
  const prevFontFamilyRef = useRef<string | undefined>(undefined);
  const prevLineHeightRef = useRef<number | undefined>(undefined);
  
  // Ref to hold latest settings for hooks to avoid stale closures
  const settingsRef = useRef({
    fontFamily: fontFamily,
    lineHeight: lineHeight,
    fontSize: fontSize,
    fitMode: fitMode,
  });

  // Sync state to ref
  useEffect(() => {
    settingsRef.current = { fontFamily, lineHeight, fontSize, fitMode };
  }, [fitMode, fontFamily, lineHeight, fontSize]);

  const updateProgressState = useCallback((nextProgress: number) => {
    const normalizedProgress = Math.min(100, Math.max(0, nextProgress));
    preciseProgressRef.current = normalizedProgress;
    setProgress((prev) => {
      const roundedProgress = Math.round(normalizedProgress);
      return prev === roundedProgress ? prev : roundedProgress;
    });
  }, []);

  const persistCurrentState = useCallback(() => {
    if (!bookId) return;

    const percentage = Number(preciseProgressRef.current.toFixed(4));
    const cfi = currentCfiRef.current;
    if (!cfi && percentage <= 0) return;

    const currentSettings = settingsRef.current;
    const currentSectionPage = currentSectionPageRef.current;
    const stateToSave: {
      cfi?: string;
      percentage: number;
      sectionIndex?: number;
      sectionPage?: number;
      settings: {
        fontSize: number;
        fontFamily: 'serif' | 'sans';
        lineHeight: number;
        fitMode: 'page' | 'width';
      };
    } = {
      percentage,
      settings: {
        fontSize: currentSettings.fontSize,
        fontFamily: currentSettings.fontFamily,
        lineHeight: currentSettings.lineHeight,
        fitMode: currentSettings.fitMode,
      },
    };

    if (cfi) stateToSave.cfi = cfi;
    if (typeof currentSectionPage.sectionIndex === 'number' && currentSectionPage.sectionIndex >= 0) {
      stateToSave.sectionIndex = currentSectionPage.sectionIndex;
    }
    if (typeof currentSectionPage.sectionPage === 'number' && currentSectionPage.sectionPage > 0) {
      stateToSave.sectionPage = currentSectionPage.sectionPage;
    }
    void saveEpubState(bookId, stateToSave);
  }, [bookId]);

  const waitForDocumentLayoutStable = useCallback(async (doc: Document) => {
    const fontsReady = (doc as Document & {
      fonts?: { ready?: Promise<unknown> };
    }).fonts?.ready;

    if (fontsReady) {
      await Promise.race([
        fontsReady.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 300)),
      ]);
    }

    const pendingImages = Array.from(doc.images ?? []).filter((image) => !image.complete);
    if (pendingImages.length > 0) {
      await Promise.race([
        Promise.all(
          pendingImages.map(
            (image) =>
              new Promise<void>((resolve) => {
                const done = () => resolve();
                image.addEventListener("load", done, { once: true });
                image.addEventListener("error", done, { once: true });
                setTimeout(done, 300);
              }),
          ),
        ),
        new Promise((resolve) => setTimeout(resolve, 400)),
      ]);
    }

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, []);

  const resolveChapterPage = useCallback((cfi: string | null | undefined, fallbackIndex?: number) => {
    if (!cfi) {
      return typeof fallbackIndex === "number" && fallbackIndex >= 0 ? fallbackIndex + 1 : 0;
    }

    try {
      const spineItem = bookRef.current?.spine?.get(cfi);
      if (spineItem && typeof spineItem.index === "number") {
        return spineItem.index + 1;
      }
    } catch {
      // ignore
    }

    return typeof fallbackIndex === "number" && fallbackIndex >= 0 ? fallbackIndex + 1 : 0;
  }, []);

  const updateDisplayedPagination = useCallback((
    location: any,
    offsets: number[] = displayPageOffsetsRef.current,
    totalPages: number | null = displayTotalPages,
  ) => {
    const displayedPage = location?.start?.displayed?.page;
    const displayedTotal = location?.start?.displayed?.total;
    const sectionIndex = typeof location?.start?.index === "number" ? location.start.index : -1;

    if (!(displayedPage > 0)) return;

    currentSectionPageRef.current = {
      sectionIndex: sectionIndex >= 0 ? sectionIndex : null,
      sectionPage: displayedPage,
    };

    if (sectionIndex >= 0 && totalPages && offsets[sectionIndex] !== undefined) {
      const globalPage = offsets[sectionIndex] + displayedPage;
      setDisplayPage((prev) => (prev === globalPage ? prev : globalPage));
      setDisplayTotalPages((prev) => (prev === totalPages ? prev : totalPages));
      return;
    }

    setDisplayPage((prev) => (prev === displayedPage ? prev : displayedPage));
    if (displayedTotal > 0 && !totalPages) {
      setDisplayTotalPages((prev) => (prev === displayedTotal ? prev : displayedTotal));
    }
  }, [displayTotalPages]);

  const extractVisibleTextFromCurrentContents = useCallback(() => {
    const contentsList = renditionRef.current?.getContents?.() ?? [];
    const segments: string[] = [];

    contentsList.forEach((contents: any) => {
      const doc = contents?.document as Document | undefined;
      const win = contents?.window as Window | undefined;
      if (!doc?.body || !win) return;

      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let currentNode = walker.nextNode();

      while (currentNode) {
        const textNode = currentNode as Text;
        const rawText = textNode.nodeValue ?? "";
        const parent = textNode.parentElement;
        const parentTag = parent?.tagName ?? "";
        const blockedParent =
          parentTag === "SCRIPT" ||
          parentTag === "STYLE" ||
          parentTag === "NOSCRIPT" ||
          parentTag === "RT" ||
          parentTag === "RP";

        if (!blockedParent && rawText.trim()) {
          try {
            const range = doc.createRange();
            range.selectNodeContents(textNode);
            const rects = Array.from(range.getClientRects());
            const isVisible = rects.some(
              (rect) =>
                rect.width > 0 &&
                rect.height > 0 &&
                rect.right > 0 &&
                rect.left < win.innerWidth &&
                rect.bottom > 0 &&
                rect.top < win.innerHeight,
            );

            if (isVisible) {
              segments.push(rawText);
            }
          } catch (error) {
            log.debug("Visible text range extraction failed:", error);
          }
        }

        currentNode = walker.nextNode();
      }
    });

    return segments.join("").replace(/\s+/g, " ").trim();
  }, []);

  const resolveCurrentPageTextForTTS = useCallback((candidateText: string) => {
    const visibleText = extractVisibleTextFromCurrentContents();
    if (visibleText.length >= 10) {
      return visibleText;
    }

    return candidateText.trim();
  }, [extractVisibleTextFromCurrentContents]);

  const publishVisibleContent = useCallback((text: string) => {
    setVisiblePageTextForTTS(resolveCurrentPageTextForTTS(text));
    onContentChange?.(text);
  }, [onContentChange, resolveCurrentPageTextForTTS]);

  useEffect(() => {
    setProgress(0);
    setDisplayPage(null);
    setDisplayTotalPages(null);
    setVisiblePageTextForTTS("");
    currentCfiRef.current = null;
    preciseProgressRef.current = 0;
    relocationTokenRef.current = 0;
    currentSectionPageRef.current = { sectionIndex: null, sectionPage: null };
    pendingJumpRef.current = null;
    jumpRequestedBeforeReadyRef.current = null;
    lastProcessedJumpTs.current = 0;
    isJumpingRef.current = false;
    lastReportedChapterRef.current = null;
    displayPageOffsetsRef.current = [];
  }, [bookId, fileUrl]);

  useEffect(() => {
    if (!isJapaneseBook) {
      setShowFurigana(false);
      setFuriganaPreferenceReady(true);
      return;
    }

    setFuriganaPreferenceReady(false);
    const saved = window.localStorage.getItem(FURIGANA_PREFERENCE_KEY);
    setShowFurigana(saved === null ? true : saved === 'true');
    setFuriganaPreferenceReady(true);
  }, [isJapaneseBook]);

  useEffect(() => {
    if (!isJapaneseBook || !furiganaPreferenceReady) return;
    window.localStorage.setItem(FURIGANA_PREFERENCE_KEY, String(showFurigana));
  }, [furiganaPreferenceReady, isJapaneseBook, showFurigana]);

  useEffect(() => {
    furiganaEnabledRef.current = isJapaneseBook && showFurigana;
  }, [isJapaneseBook, showFurigana]);

  useEffect(() => {
    forceHorizontalLayoutRef.current = isJapaneseBook;
  }, [isJapaneseBook]);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    let style = document.getElementById(EPUB_STAGE_OVERRIDE_STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = EPUB_STAGE_OVERRIDE_STYLE_ID;
      document.head.appendChild(style);
    }

    style.textContent = `
      .epub-container {
        scrollbar-width: none !important;
        -ms-overflow-style: none !important;
      }
      .epub-container::-webkit-scrollbar {
        display: none !important;
        width: 0 !important;
        height: 0 !important;
      }
      .epub-container .epub-view,
      .epub-container .epub-view iframe {
        scrollbar-width: none !important;
        -ms-overflow-style: none !important;
      }
      .epub-container .epub-view iframe::-webkit-scrollbar {
        display: none !important;
        width: 0 !important;
        height: 0 !important;
      }
    `;
  }, []);

  const normalizeWritingMode = useCallback((mode: string): string => {
    const normalized = mode.trim().toLowerCase();
    if (!normalized) return '';
    if (normalized === 'tb-rl') return 'vertical-rl';
    if (normalized === 'tb-lr') return 'vertical-lr';
    if (normalized === 'lr-tb') return 'horizontal-tb';
    return normalized;
  }, []);

  const getDocumentWritingMode = useCallback((doc: Document | null | undefined): string => {
    if (!doc?.documentElement || !doc.defaultView) return '';
    const readWritingMode = (element: Element | null | undefined) => {
      if (!element) return '';
      const style = doc.defaultView!.getComputedStyle(element) as CSSStyleDeclaration & {
        webkitWritingMode?: string;
      };
      return normalizeWritingMode(style.writingMode || style.webkitWritingMode || '');
    };

    const htmlMode = readWritingMode(doc.documentElement);
    if (htmlMode && htmlMode !== 'horizontal-tb') return htmlMode;
    return readWritingMode(doc.body) || htmlMode || '';
  }, [normalizeWritingMode]);

  const ensureDocumentHead = useCallback((doc: Document): HTMLHeadElement | null => {
    if (doc.head) return doc.head;

    const html = doc.documentElement;
    if (!html) return null;

    let head = doc.querySelector('head');
    if (!head) {
      head = doc.createElement('head');
      html.insertBefore(head, html.firstChild);
    }

    return head as HTMLHeadElement;
  }, []);

  const forceHorizontalWritingModeInDocument = useCallback((doc: Document | null | undefined) => {
    if (!doc?.documentElement) return;

    const head = ensureDocumentHead(doc);
    if (!head) return;

    const html = doc.documentElement as HTMLElement;
    const body = doc.body ?? doc.querySelector('body');

    html.setAttribute('dir', 'ltr');
    html.style.setProperty('writing-mode', 'horizontal-tb');
    html.style.setProperty('-webkit-writing-mode', 'horizontal-tb');
    html.style.setProperty('text-orientation', 'mixed');

    if (body instanceof HTMLElement) {
      body.setAttribute('dir', 'ltr');
      body.style.setProperty('writing-mode', 'horizontal-tb');
      body.style.setProperty('-webkit-writing-mode', 'horizontal-tb');
      body.style.setProperty('text-orientation', 'mixed');
    }

    let style = doc.getElementById(FORCE_HORIZONTAL_LAYOUT_STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = doc.createElement('style');
      style.id = FORCE_HORIZONTAL_LAYOUT_STYLE_ID;
      head.appendChild(style);
    }

    style.textContent = `
      html, body, body *:not(svg):not(svg *):not(math):not(math *) {
        writing-mode: horizontal-tb !important;
        -webkit-writing-mode: horizontal-tb !important;
        text-orientation: mixed !important;
      }
      html, body {
        direction: ltr !important;
      }
      ruby, ruby * {
        writing-mode: horizontal-tb !important;
        -webkit-writing-mode: horizontal-tb !important;
      }
      ruby rt {
        text-orientation: mixed !important;
      }
    `;
  }, [ensureDocumentHead]);

  const getDocumentDirection = useCallback((doc: Document | null | undefined): '' | 'ltr' | 'rtl' => {
    if (!doc?.documentElement || !doc.defaultView) return '';

    const readDirection = (element: Element | null | undefined): '' | 'ltr' | 'rtl' => {
      if (!element) return '';
      const style = doc.defaultView!.getComputedStyle(element);
      const direction = (style.direction || '').trim().toLowerCase();
      if (direction === 'ltr' || direction === 'rtl') {
        return direction;
      }

      const attrDirection = element.getAttribute('dir')?.trim().toLowerCase();
      if (attrDirection === 'ltr' || attrDirection === 'rtl') {
        return attrDirection;
      }

      return '';
    };

    return readDirection(doc.documentElement) || readDirection(doc.body);
  }, []);

  const resolveContentLayoutState = useCallback((doc: Document | null | undefined): EpubLayoutState => {
    if (forceHorizontalLayoutRef.current) {
      return {
        writingMode: 'horizontal-tb',
        isVertical: false,
        pageProgression: 'ltr',
      };
    }

    const writingMode = getDocumentWritingMode(doc) || 'horizontal-tb';
    const explicitDirection = getDocumentDirection(doc);
    const inferredProgression =
      explicitDirection ||
      (writingMode === 'vertical-rl' ? 'rtl' : writingMode === 'vertical-lr' ? 'ltr' : bookDirectionRef.current);

    return {
      writingMode,
      isVertical: writingMode.startsWith('vertical'),
      pageProgression: inferredProgression === 'rtl' ? 'rtl' : 'ltr',
    };
  }, [getDocumentDirection, getDocumentWritingMode]);

  const syncContentLayoutState = useCallback((doc: Document | null | undefined): EpubLayoutState => {
    const layoutState = resolveContentLayoutState(doc);
    contentLayoutRef.current = layoutState;
    return layoutState;
  }, [resolveContentLayoutState]);

  const restoreFuriganaInDocument = useCallback((doc: Document | null | undefined) => {
    if (!doc) return;
    doc.querySelectorAll<HTMLElement>('[data-duodushu-furigana="true"]').forEach((wrapper) => {
      const originalText = wrapper.dataset.originalText ?? wrapper.textContent ?? '';
      wrapper.replaceWith(doc.createTextNode(originalText));
    });
  }, []);

  const collectLookupCandidateTextNodes = useCallback((doc: Document | null | undefined) => {
    if (!doc?.body) return [] as Text[];

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const candidates: Text[] = [];
    let currentNode = walker.nextNode();

    while (currentNode) {
      const textNode = currentNode as Text;
      const text = textNode.nodeValue ?? '';
      const parent = textNode.parentElement;
      const parentTag = parent?.tagName ?? '';
      const blockedParent =
        parentTag === 'SCRIPT' ||
        parentTag === 'STYLE' ||
        parentTag === 'NOSCRIPT' ||
        parentTag === 'RT' ||
        parentTag === 'RP' ||
        parentTag === 'RUBY' ||
        parent?.closest('ruby') != null ||
        parent?.closest('[data-duodushu-furigana="true"]') != null;

      if (!blockedParent && text.trim() && containsJapaneseText(text)) {
        candidates.push(textNode);
      }

      currentNode = walker.nextNode();
    }

    return candidates;
  }, []);

  const extractPlainTextFromElement = useCallback((element: Element | null | undefined) => {
    if (!element) return '';
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll<HTMLElement>('[data-duodushu-furigana="true"]').forEach((wrapper) => {
      const originalText = wrapper.dataset.originalText ?? wrapper.textContent ?? '';
      wrapper.replaceWith(clone.ownerDocument.createTextNode(originalText));
    });

    clone.querySelectorAll('ruby').forEach((ruby) => {
      const baseText = Array.from(ruby.childNodes)
        .filter((node) => {
          const parentElement = node.parentElement;
          return !(parentElement && ['RT', 'RP'].includes(parentElement.tagName));
        })
        .map((node) => {
          // 不能用 instanceof HTMLElement — 来自 epub.js iframe 的节点
          // 使用的是 iframe 内部的构造函数，与主窗口的 HTMLElement 不同，
          // 导致 instanceof 检查始终返回 false，RT/RP 的假名文本会泄漏到结果中。
          if (node.nodeType === 1 && ['RT', 'RP'].includes((node as Element).tagName)) {
            return '';
          }
          return node.textContent ?? '';
        })
        .join('');

      ruby.replaceWith(clone.ownerDocument.createTextNode(baseText));
    });

    clone.querySelectorAll('rt, rp').forEach((node) => node.remove());
    return clone.innerText || clone.textContent || '';
  }, []);

  const extractPlainTextFromBody = useCallback((body: HTMLElement | null | undefined) => {
    return extractPlainTextFromElement(body);
  }, [extractPlainTextFromElement]);

  const getCurrentContentsFallbackText = useCallback(() => {
    const contentsList = renditionRef.current?.getContents?.() ?? [];
    const mergedText = Array.from(
      new Set(
        contentsList
          .map((contents: any) => extractPlainTextFromBody(contents?.document?.body).trim())
          .filter((text: string) => text.length > 0),
      ),
    ).join('\n');

    if (!mergedText) return '';
    return mergedText.length > 5000 ? `${mergedText.substring(0, 5000).trim()}\n...(truncated)` : mergedText;
  }, [extractPlainTextFromBody]);

  const resolveVisibleContentText = useCallback((text: string) => {
    const normalizedText = text.trim();
    if (normalizedText.length >= 10) return normalizedText;

    const fallbackText = getCurrentContentsFallbackText();
    if (fallbackText) {
      log.debug('Using current contents fallback for visible text', {
        extractedLength: normalizedText.length,
        fallbackLength: fallbackText.length,
      });
      return fallbackText;
    }

    return normalizedText;
  }, [getCurrentContentsFallbackText]);

  const applyReaderStylesToContents = useCallback((contents: any) => {
    const doc = contents?.document as Document | undefined;
    if (!doc?.documentElement || !doc.head) return;

    const currentSettings = settingsRef.current;
    const currentFont = currentSettings.fontFamily;
    const effectiveLineHeight = getEffectiveFuriganaLineHeight(
      currentSettings.lineHeight,
      furiganaEnabledRef.current,
    );
    const { writingMode, pageProgression } = syncContentLayoutState(doc);
    doc.documentElement.dataset.duodushuWritingMode = writingMode;
    doc.documentElement.dataset.duodushuPageProgression = pageProgression;

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
      /* epub.js 自行管理 html/body 的 overflow、height、width，
         此处仅隐藏滚动条（视觉层面），不干涉布局属性。
         如果覆盖了 overflow: hidden 或 height: 100%，会导致
         epub.js 的 textWidth()（通过 range.getBoundingClientRect()）
         返回被截断的宽度，iframe 无法被正确扩展到多列内容的
         完整宽度，翻页后显示空白。 */
       html {
           scrollbar-width: none !important;
           -ms-overflow-style: none !important;
       }
       body {
           scrollbar-width: none !important;
           -ms-overflow-style: none !important;
       }
       html::-webkit-scrollbar,
       body::-webkit-scrollbar {
           display: none !important;
           width: 0 !important;
           height: 0 !important;
       }
        body, p, div, span, li, blockquote {
            font-family: ${fontStack} !important;
            line-height: ${effectiveLineHeight} !important;
        }
       html[data-duodushu-writing-mode^="vertical"],
       html[data-duodushu-writing-mode^="vertical"] body {
           width: 100% !important;
           height: 100% !important;
           text-align: start !important;
           vertical-align: top !important;
       }
       html[data-duodushu-writing-mode^="vertical"] body > * {
           vertical-align: top !important;
       }
       html[data-duodushu-writing-mode^="vertical"] span[data-duodushu-furigana="true"] {
           text-orientation: mixed !important;
       }
       span[data-duodushu-furigana="true"] {
           display: inline !important;
           white-space: inherit !important;
           overflow-wrap: normal !important;
           word-break: keep-all !important;
      }
      ruby.duodushu-ruby {
          ruby-position: over;
          ruby-align: center;
          ruby-overhang: auto;
          writing-mode: inherit;
          line-height: inherit;
      }
       ruby.duodushu-ruby rt.duodushu-ruby-rt {
           font-size: 0.55em;
           line-height: 1;
           color: #0369a1;
           user-select: none;
           white-space: nowrap;
       }
       html[data-duodushu-writing-mode^="vertical"] ruby.duodushu-ruby {
           ruby-position: inter-character;
       }
       html[data-duodushu-writing-mode^="vertical"] ruby.duodushu-ruby rt.duodushu-ruby-rt {
           font-size: 0.45em;
           writing-mode: inherit;
           text-orientation: upright;
           white-space: nowrap;
           letter-spacing: 0;
       }
     `;
  }, [syncContentLayoutState]);

  const remeasureCurrentEpubViews = useCallback(() => {
    const manager = renditionRef.current?.manager;
    const displayedViews = manager?.views?.displayed?.() ?? [];

    displayedViews.forEach((view: any) => {
      try {
        view.expand?.();
      } catch (error) {
        log.debug('EPUB view remeasure failed:', error);
      }
    });
  }, []);

  const normalizeRenderedCfi = useCallback((rawCfi: string | null | undefined): string | null => {
    if (!rawCfi || !renditionRef.current) return rawCfi ?? null;

    try {
      const range = renditionRef.current.getRange(rawCfi, FURIGANA_IGNORE_CLASS);
      const doc = range?.startContainer?.ownerDocument;
      if (!range || !doc) return rawCfi;

      const contentsList = renditionRef.current.getContents?.() ?? [];
      const matchedContents = contentsList.find((contents: any) => contents?.document === doc);
      if (!matchedContents?.cfiFromRange) return rawCfi;

      return matchedContents.cfiFromRange(range, FURIGANA_IGNORE_CLASS) || rawCfi;
    } catch (error) {
      log.debug('Failed to normalize rendered CFI:', error);
      return rawCfi;
    }
  }, []);

  const prepareContentsForDisplay = useCallback(async (contents: any) => {
    applyReaderStylesToContents(contents);
    try {
      await applyFuriganaToDocumentRef.current(contents.document);
    } catch (error) {
      log.warn('EPUB furigana injection failed:', error);
    }
    if (isJapaneseBook && contents?.document) {
      await waitForDocumentLayoutStable(contents.document);
    }
    remeasureCurrentEpubViews();
  }, [applyReaderStylesToContents, isJapaneseBook, remeasureCurrentEpubViews, waitForDocumentLayoutStable]);

  const waitForVisibleContentsStable = useCallback(async () => {
    const contentsList = renditionRef.current?.getContents?.() ?? [];
    await Promise.all(
      contentsList.map(async (contents: any) => {
        const doc = contents?.document as Document | undefined;
        if (doc) {
          await waitForDocumentLayoutStable(doc);
        }
      }),
    );
    remeasureCurrentEpubViews();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, [remeasureCurrentEpubViews, waitForDocumentLayoutStable]);

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

  const getRangeVisualRect = useCallback((range: Range | null | undefined): DOMRect | null => {
      if (!range) return null;
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
      return rects[0] ?? range.getBoundingClientRect();
  }, []);

  const positionOverlayElement = useCallback((overlay: HTMLElement | null | undefined, rect: DOMRect | null | undefined) => {
      if (!overlay || !rect || (!rect.width && !rect.height)) {
          if (overlay) {
              overlay.style.display = 'none';
          }
          return;
      }

      overlay.style.width = `${Math.max(rect.width + 4, 4)}px`;
      overlay.style.height = `${Math.max(rect.height + 4, 4)}px`;
      overlay.style.top = `${rect.top - 2}px`;
      overlay.style.left = `${rect.left - 2}px`;
      overlay.style.display = 'block';
  }, []);

  const normalizeLookupWord = useCallback((rawWord: string): string => {
      const trimmed = rawWord
          .trim()
          .replace(LOOKUP_WORD_EDGE_PATTERN, '')
          .replace(LOOKUP_WORD_EDGE_QUOTES_PATTERN, '');

      if (!trimmed) return '';
      if (containsJapaneseText(trimmed)) {
          return trimmed.replace(/[ \t\u3000]+/g, '');
      }
      return trimmed.toLowerCase();
  }, []);

  const getDisplayPiecesFromAnnotation = useCallback((annotation: FuriganaAnnotation): AnnotationDisplayPiece[] => {
      const pieces: AnnotationDisplayPiece[] = [];
      let cursor = 0;

      annotation.segments.forEach((segment) => {
          if (segment.type === 'text') {
              const end = cursor + segment.text.length;
              pieces.push({ type: 'text', text: segment.text, start: cursor, end });
              cursor = end;
              return;
          }

          const end = cursor + segment.base.length;
          pieces.push({
              type: 'ruby',
              base: segment.base,
              reading: segment.reading,
              start: cursor,
              end,
          });
          cursor = end;
      });

      return pieces;
  }, []);

  const appendAnnotationPieceRange = useCallback((
      parent: HTMLElement,
      doc: Document,
      piece: AnnotationDisplayPiece,
      startOffset: number,
      endOffset: number,
      lookupWord?: string,
  ) => {
      if (endOffset <= startOffset) return;

      const attachLookupDataset = (element: HTMLElement) => {
          if (!lookupWord) return;
          element.dataset.duodushuLookup = 'true';
          element.dataset.duodushuLookupWord = lookupWord;
      };

      if (piece.type === 'text') {
          const textContent = piece.text.slice(startOffset, endOffset);
          if (!textContent) return;

          if (!lookupWord) {
              parent.appendChild(doc.createTextNode(textContent));
              return;
          }

          const span = doc.createElement('span');
          attachLookupDataset(span);
          span.textContent = textContent;
          parent.appendChild(span);
          return;
      }

      if (startOffset !== 0 || endOffset !== piece.base.length) {
          const fallback = piece.base.slice(startOffset, endOffset);
          if (!fallback) return;
          if (!lookupWord) {
              parent.appendChild(doc.createTextNode(fallback));
              return;
          }
          const span = doc.createElement('span');
          attachLookupDataset(span);
          span.textContent = fallback;
          parent.appendChild(span);
          return;
      }

      const ruby = doc.createElement('ruby');
      ruby.className = 'duodushu-ruby';
      attachLookupDataset(ruby);
      ruby.appendChild(doc.createTextNode(piece.base));

      const rt = doc.createElement('rt');
      rt.className = 'duodushu-ruby-rt';
      rt.textContent = piece.reading;
      ruby.appendChild(rt);
      parent.appendChild(ruby);
  }, []);

  const appendAnnotationContentRange = useCallback((
      parent: HTMLElement,
      doc: Document,
      pieces: AnnotationDisplayPiece[],
      start: number,
      end: number,
      lookupWord?: string,
  ) => {
      pieces.forEach((piece) => {
          if (piece.end <= start || piece.start >= end) return;
          appendAnnotationPieceRange(
              parent,
              doc,
              piece,
              Math.max(start, piece.start) - piece.start,
              Math.min(end, piece.end) - piece.start,
              lookupWord,
          );
      });
  }, [appendAnnotationPieceRange]);

  const createFuriganaWrapper = useCallback((
      doc: Document,
      annotation: FuriganaAnnotation,
      originalText: string,
  ) => {
      const wrapper = doc.createElement('span');
      wrapper.dataset.duodushuFurigana = 'true';
      wrapper.dataset.originalText = originalText;
      wrapper.classList.add(FURIGANA_IGNORE_CLASS);
      const displayPieces = getDisplayPiecesFromAnnotation(annotation);
      const lookupSegments = annotation.lookup_segments || [];
      let cursor = 0;

      lookupSegments.forEach((segment) => {
          if (cursor < segment.start) {
              appendAnnotationContentRange(wrapper, doc, displayPieces, cursor, segment.start);
          }
          const lookupWord = normalizeLookupWord(segment.lookup_text || segment.text);
          appendAnnotationContentRange(
              wrapper,
              doc,
              displayPieces,
              segment.start,
              segment.end,
              lookupWord || undefined,
          );
          cursor = segment.end;
      });

      if (cursor < originalText.length) {
          appendAnnotationContentRange(wrapper, doc, displayPieces, cursor, originalText.length);
      }

      return wrapper;
  }, [appendAnnotationContentRange, getDisplayPiecesFromAnnotation, normalizeLookupWord]);

  // 注意：此函数通过 furiganaEnabledRef.current（而非闭包中的 showFurigana）读取假名开关，
  // 保证被 epub.js hooks 注册的旧引用也能拿到最新状态。
  const applyFuriganaToDocument = useCallback(async (doc: Document | null | undefined) => {
      if (!doc?.body) return;

      restoreFuriganaInDocument(doc);
      const candidates = collectLookupCandidateTextNodes(doc);

      if (candidates.length === 0) return;

      await ensureFuriganaAnnotations(
          candidates.map((node) => node.nodeValue ?? ''),
          furiganaCacheRef.current,
      );

      if (!furiganaEnabledRef.current) return;

      candidates.forEach((node) => {
          const originalText = node.nodeValue ?? '';
          const annotation = furiganaCacheRef.current.get(originalText);
          if (!annotation?.has_furigana || !node.parentNode) return;
          node.parentNode.replaceChild(createFuriganaWrapper(doc, annotation, originalText), node);
      });
  }, [collectLookupCandidateTextNodes, createFuriganaWrapper, restoreFuriganaInDocument]);

  // Ref 始终指向最新的 applyFuriganaToDocument，供 epub.js hook（旧闭包中）调用
  const applyFuriganaToDocumentRef = useRef(applyFuriganaToDocument);
  useEffect(() => {
      applyFuriganaToDocumentRef.current = applyFuriganaToDocument;
  }, [applyFuriganaToDocument]);

  const findLookupSegmentAtOffset = useCallback((
      lookupSegments: JapaneseLookupSegment[],
      offset: number,
  ): JapaneseLookupSegment | null => {
      if (!lookupSegments.length) return null;

      const normalizedOffset = Math.max(0, offset);
      return (
          lookupSegments.find((segment) => normalizedOffset >= segment.start && normalizedOffset < segment.end) ||
          lookupSegments.find((segment) => normalizedOffset > 0 && normalizedOffset - 1 >= segment.start && normalizedOffset - 1 < segment.end) ||
          null
      );
  }, []);

  const getLookupElementRect = useCallback((lookupElement: HTMLElement): DOMRect | null => {
      if (lookupElement.tagName !== 'RUBY') {
          return lookupElement.getBoundingClientRect();
      }

      const range = lookupElement.ownerDocument.createRange();
      const contentNodes = Array.from(lookupElement.childNodes).filter((node) => {
          return !(node.nodeType === Node.ELEMENT_NODE && ['RT', 'RP'].includes((node as Element).tagName));
      });

      if (contentNodes.length === 0) {
          return lookupElement.getBoundingClientRect();
      }

      try {
          range.setStartBefore(contentNodes[0]);
          range.setEndAfter(contentNodes[contentNodes.length - 1]);
          return getRangeVisualRect(range);
      } catch {
          return lookupElement.getBoundingClientRect();
      }
  }, [getRangeVisualRect]);

  const getLookupTargetFromNode = useCallback((target: Node | null | undefined) => {
      let element: Element | null = null;
      if (target?.nodeType === Node.ELEMENT_NODE) {
          element = target as Element;
      } else if (target?.parentElement) {
          element = target.parentElement;
      }

      const lookupElement = element?.closest('[data-duodushu-lookup="true"]') as HTMLElement | null;
      if (!lookupElement) return null;

      const lookupWord = normalizeLookupWord(lookupElement.dataset.duodushuLookupWord || '');
      if (!lookupWord) return null;

      return {
          lookupWord,
          rect: getLookupElementRect(lookupElement),
          sourceNode: lookupElement,
      };
  }, [getLookupElementRect, normalizeLookupWord]);

  const extractContextSentence = useCallback((rawText: string, target: string): string => {
      const fullText = rawText.replace(/\s+/g, ' ').trim();
      if (!fullText) return '';

      const sentences = fullText.match(SENTENCE_SPLIT_PATTERN) || [];
      const normalizedTarget = containsJapaneseText(target) ? target : target.toLowerCase();

      for (const sentence of sentences) {
          const candidate = sentence.trim();
          if (!candidate) continue;

          const haystack = containsJapaneseText(normalizedTarget) ? candidate : candidate.toLowerCase();
          if (haystack.includes(normalizedTarget)) {
              return candidate;
          }
      }

      return fullText.length > 200 ? `${fullText.substring(0, 200).trim()}...` : fullText;
  }, []);

  const extractContextSentenceFromNode = useCallback((sourceNode: Node | null | undefined, target: string): string => {
      if (!sourceNode) return '';

      let contextNode: Element | null =
          sourceNode.nodeType === Node.TEXT_NODE
              ? sourceNode.parentElement
              : sourceNode.nodeType === Node.ELEMENT_NODE
                  ? sourceNode as Element
                  : null;

      while (contextNode && !['P', 'DIV', 'SECTION', 'ARTICLE', 'BODY'].includes(contextNode.tagName)) {
          contextNode = contextNode.parentElement;
      }

      if (!contextNode) return '';

      const widerNode =
          contextNode.tagName === 'P'
              ? (contextNode.parentElement ?? contextNode)
              : contextNode;
      const plainText = extractPlainTextFromElement(widerNode);
      return extractContextSentence(plainText, target);
  }, [extractContextSentence, extractPlainTextFromElement]);

  const getContentsViewportPoint = useCallback((contents: any, event: MouseEvent) => {
      const doc = contents?.document as Document | undefined;
      const win = contents?.window as Window | undefined;

      if (!doc || !win) {
          return { x: event.clientX, y: event.clientY };
      }

      const targetDoc = (event.target as Node | null)?.ownerDocument;
      if (event.view === win || targetDoc === doc) {
          return { x: event.clientX, y: event.clientY };
      }

      const frameElement = win.frameElement as HTMLElement | null;
      if (!frameElement) {
          return { x: event.clientX, y: event.clientY };
      }

      const frameRect = frameElement.getBoundingClientRect();
      return {
          x: event.clientX - frameRect.left,
          y: event.clientY - frameRect.top,
      };
  }, []);

  const expandRangeToWord = useCallback((doc: Document, sourceRange: Range | null | undefined): Range | null => {
      if (!sourceRange || sourceRange.startContainer.nodeType !== Node.TEXT_NODE) {
          return null;
      }

      const textNode = sourceRange.startContainer as Text;
      const text = textNode.textContent ?? '';
      if (!text) return null;

      const offset = Math.min(Math.max(0, sourceRange.startOffset), text.length);
      const annotation = furiganaCacheRef.current.get(text);
      const lookupSegment = annotation
          ? findLookupSegmentAtOffset(annotation.lookup_segments || [], offset)
          : null;

      if (lookupSegment) {
          const expandedRange = doc.createRange();
          safeSetRangeStart(expandedRange, textNode, lookupSegment.start);
          safeSetRangeEnd(expandedRange, textNode, lookupSegment.end);
          return expandedRange;
      }

      const anchorIndex =
          offset < text.length && LOOKUP_WORD_CHAR_PATTERN.test(text[offset])
              ? offset
              : offset > 0 && LOOKUP_WORD_CHAR_PATTERN.test(text[offset - 1])
                  ? offset - 1
                  : -1;

      if (anchorIndex === -1) {
          return null;
      }

      let start = anchorIndex;
      let end = anchorIndex + 1;

      while (start > 0 && LOOKUP_WORD_CHAR_PATTERN.test(text[start - 1])) {
          start -= 1;
      }

      while (end < text.length && LOOKUP_WORD_CHAR_PATTERN.test(text[end])) {
          end += 1;
      }

      const expandedRange = doc.createRange();
      safeSetRangeStart(expandedRange, textNode, start);
      safeSetRangeEnd(expandedRange, textNode, end);
      return expandedRange;
  }, [findLookupSegmentAtOffset]);

  // 辅助函数：处理文本搜索和高亮
  const handleTextSearch = useCallback(async (text: string, word?: string, maxAttempts = 15, pageOffset = 0, retryLevel = 0) => {
      log.info('handleTextSearch called:', { text: text.substring(0, 30), word, maxAttempts, pageOffset, retryLevel });

      try {
          log.info('Checking refs:', {
              hasRenditionRef: !!renditionRef.current,
              hasBookRef: !!bookRef.current
          });

          if (!renditionRef.current || !bookRef.current) {
              log.warn('handleTextSearch: rendition or book not ready');
              return false;
          }

          log.info('About to call getContents()...');
          const contents = renditionRef.current.getContents();
          log.info('getContents() returned:', {
              contentsLength: contents?.length,
              hasWindow: contents?.[0]?.window ? 'yes' : 'no',
              hasDocument: contents?.[0]?.document ? 'yes' : 'no'
          });

          if (!contents || !contents[0] || !contents[0].window) {
              log.warn('handleTextSearch: contents not available, retrying...', {
                  contentsExists: !!contents,
                  firstItemExists: !!contents?.[0],
                  windowExists: !!contents?.[0]?.window
              });
              if (maxAttempts > 0) {
                  setTimeout(() => handleTextSearch(text, word, maxAttempts - 1, pageOffset, retryLevel), 200);
              }
              return false;
          }

          // 关键：保存完整的 Contents 对象，它有 cfiFromNode 和 cfiFromRange 方法
          const contentsObj = contents[0];
          const win = contentsObj.window;
          const doc = contentsObj.document;


          // --- 文本标准化：处理弯引号等 ---
          const normalizeText = (str: string) => {
              return str.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
          };
          
          const normalizedText = normalizeText(text);
          const normalizedWord = word ? normalizeText(word) : undefined;

          // --- 策略：多级降级搜索 ---
          let query = normalizedText.trim();
          let isWholeWord = false;

          if (normalizedWord) {
              const cleanText = normalizedText.trim();
              const cleanWord = normalizedWord.trim();
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
              } else if (retryLevel === 2) {
                   // Level 2: 单词模式 - 全字匹配 (最精确单词匹配)
                   query = cleanWord;
                   isWholeWord = true;
              } else {
                   // Level 3: 单词模式 - 非全字匹配 (解决标点符号导致的 WholeWord 失败)
                   // 但仍搜索完整单词，不截取子串，防止匹配到错误单词(如 proper -> approaching)
                   query = cleanWord;
                   isWholeWord = false;
              }
          } else {
              query = normalizedText.substring(0, 20).trim();
          }

          log.info(`Searching (Level ${retryLevel}): "${query}" (WholeWord: ${isWholeWord})`);

          win.getSelection()?.removeAllRanges();

          let findResult = win.find(query, false, false, true, isWholeWord, true, false);
          
          // --- 手动 DOM 遍历搜索 (后备方案) ---
          if (!findResult && retryLevel >= 2) {
             try {
                log.info("window.find failed, trying manual DOM search...");
                // 辅助函数：在文档中手动查找文本 (支持跨节点)
                const findRangeInDocument = (doc: Document, text: string): Range | null => {
                    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null);
                    const nodes: Node[] = [];
                    let allText = "";
                    let node;
                    
                    // 1. 构建全文本映射
                    while (node = walker.nextNode()) {
                        nodes.push(node);
                        allText += (node.textContent || "");
                    }
                    

                    // 2. 在全文本中搜索
                    // 同样对 DOM 文本进行标准化 (替换弯引号)，确保能匹配 normalizedText
                    const normalizeForSearch = (s: string) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
                    
                    // Regex 构建：转义正则特殊字符
                    const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const normalizedTarget = normalizeForSearch(text).trim(); // text 已经是 normalizedText
                    
                    // 容错正则：允许字符间有软连字符、零宽空格等
                    // \u00AD: Soft Hyphen, \u200B: Zero Width Space, \u200C: ZWNJ, \u200D: ZWJ, \u2060: Word Joiner, \uFEFF: ZWNBS
                    const invisibleChars = "[\\u00AD\\u200B\\u200C\\u200D\\u2060\\uFEFF]*";
                    const escapedTarget = escapeRegExp(normalizedTarget);
                    const patternString = escapedTarget.split('').join(invisibleChars);
                    
                    let startIndex = -1;
                    let matchLength = 0;
                    
                    try {
                        const regex = new RegExp(patternString, 'i');
                        // 注意：这里使用未标准化的 allText 进行匹配，因为 allText 可能包含不可见字符，
                        // 而我们的正则就是为了匹配这些字符设计的。但是，引号需要处理吗？
                        // 为了同时处理引号和不可见字符，我们最好先处理 allText 的引号。
                        const normalizedAll = normalizeForSearch(allText);
                        
                        const match = regex.exec(normalizedAll);
                        if (match) {
                            startIndex = match.index;
                            matchLength = match[0].length;
                        }
                    } catch (e) {
                         log.warn("Regex construction failed:", e);
                         // Fallback to simple indexOf if regex fails (unlikely)
                         const lowerAll = normalizeForSearch(allText).toLowerCase();
                         const lowerTarget = normalizedTarget.toLowerCase();
                         startIndex = lowerAll.indexOf(lowerTarget);
                         matchLength = lowerTarget.length;
                    }
                    
                    if (startIndex === -1) {
                         // 保持一点日志以便观察，但简化
                         log.warn("Manual DOM search (Regex) failed.", { target: normalizedTarget });
                         return null;
                    }
                    
                    // 3. 将索引映射回 DOM 节点
                    const index = startIndex;
                    const targetLength = matchLength; // 使用实际匹配长度
                    let currentIdx = 0;
                    let startNode: Node | null = null;
                    let startOffset = 0;
                    let foundStart = false;
                    
                    for (const n of nodes) {
                        const content = n.textContent || "";
                        const len = content.length;
                        
                        // 找到开始位置
                        if (!foundStart && currentIdx + len > index) {
                            startNode = n;
                            startOffset = index - currentIdx;
                            foundStart = true;
                        }
                        
                        // 找到结束位置 (可能在同一个节点，也可能在后续节点)
                        if (foundStart && currentIdx + len >= index + targetLength) {
                            const endNode = n;
                            const endOffset = (index + targetLength) - currentIdx;
                            
                            const range = doc.createRange();
                            if (startNode) {
                                range.setStart(startNode, startOffset);
                                range.setEnd(endNode, endOffset);
                                return range;
                            }
                        }
                        
                        currentIdx += len;
                    }
                    return null;
                };

                const manualRange = findRangeInDocument(doc, query);
                if (manualRange) {
                    log.info("Manual DOM search success!");
                    const selection = win.getSelection();
                    if (selection) {
                        selection.removeAllRanges();
                        selection.addRange(manualRange);
                        findResult = true; // 伪装成功，让后续逻辑继续
                    }
                }
             } catch (manualErr) {
                 log.warn("Manual DOM search error:", manualErr);
             }
             
             // Debug: Log the content of the page if search failed
             if (!findResult && retryLevel === 3) {
                 const currentContent = bookRef.current?.rendition?.getContents()[0]?.document?.body?.textContent || "";
                 log.info('Search failed on page. Page content snippet:', currentContent.substring(0, 200).replace(/\s+/g, ' '));
             }
          }

          log.info(`window.find() result: ${findResult}`, { query });

          if (findResult) {
              log.info('Search success!');
              const selection = win.getSelection();
              if (selection && selection.rangeCount > 0) {
                  const range = selection.getRangeAt(0);

                  // 关键修复：使用旧版本的方法 - contentsObj.cfiFromNode() 来生成 CFI 并对齐页面
                  try {
                      let cfi;
                      try {
                          const node = range.startContainer;
                          const element = node.nodeType === 3 ? node.parentElement : (node as Element);
                          if (element) {
                              cfi = contentsObj.cfiFromNode(element, FURIGANA_IGNORE_CLASS);
                              log.info("Correcting alignment via Element CFI:", cfi);
                          }
                      } catch (cfiErr) {
                          log.info("Element CFI failed, trying range CFI:", cfiErr);
                          const simpleRange = doc.createRange();
                          try {
                              const node = range.startContainer;
                              const maxOff = node.nodeType === 3 ? (node.textContent?.length || 0) : node.childNodes.length;
                              simpleRange.setStart(node, Math.min(range.startOffset, maxOff));
                          } catch (reErr) {
                              log.info("Secondary CFI range failed:", reErr);
                          }
                          simpleRange.collapse(true);
                          cfi = contentsObj.cfiFromRange(simpleRange, FURIGANA_IGNORE_CLASS);
                      }

                      if (cfi) {
                          log.info("Displaying CFI for alignment:", cfi);
                          // 静默处理 IndexSizeError - 这是 epub.js 内部错误，不影响功能
                          renditionRef.current!.display(cfi).catch(() => {});
                      }
                  } catch {
                      // 静默处理对齐错误 - epub.js 内部错误，不影响功能
                  }

                  // --- 关键修复：使用 Overlay 而非修改 DOM 节点 ---
                      const searchOverlay = doc.getElementById('search-highlight-overlay') as HTMLElement | null;
                   if (searchOverlay && word) {
                      const rect = getRangeVisualRect(range);

                       // 在找到的范围内二次搜索单词位置
                       const foundText = range.toString();
                       const wordIndex = foundText.toLowerCase().indexOf(word.toLowerCase());

                      if (wordIndex !== -1) {
                          // 尝试精确定位单词
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

                                   const wordRect = getRangeVisualRect(wordRange);
                                   positionOverlayElement(searchOverlay, wordRect ?? rect);
                                   log.info('Overlay displayed for word');
                               } catch (wordRangeErr) {
                                   // 降级：使用完整范围
                                   log.debug('Word range overlay fallback:', wordRangeErr);
                                   positionOverlayElement(searchOverlay, rect);
                               }
                           } else {
                               // 非文本节点，使用完整范围
                               positionOverlayElement(searchOverlay, rect);
                           }
                       } else {
                           // 单词不在范围内，使用完整范围
                           positionOverlayElement(searchOverlay, rect);
                       }

                       // 3秒后自动隐藏
                       setTimeout(() => {
                           searchOverlay.style.display = 'none';
                       }, 3000);
                   } else if (searchOverlay) {
                       // 没有指定 word，使用完整范围
                       positionOverlayElement(searchOverlay, getRangeVisualRect(range));

                       setTimeout(() => {
                           searchOverlay.style.display = 'none';
                       }, 3000);
                   }

                  lastHighlightRef.current = { text, word, ts: Date.now() };
                  setIsSearching(false);
              }
              return true;
          }

          // --- 搜索失败处理逻辑 ---

          // 如果是严格模式失败，先尝试降级，不翻页
          // Level 3 是最后一级 (Level 2 failed -> Try Level 3)
          if (retryLevel < 3) {
              log.info(`Level ${retryLevel} failed, retrying with Level ${retryLevel + 1}...`);
              // 关键修复：使用 setTimeout 异步重试，避免同步递归导致所有级别立即执行
              setTimeout(() => {
                  handleTextSearch(text, word, maxAttempts, pageOffset, retryLevel + 1);
              }, 50);
              return false;
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
  }, [getRangeVisualRect, positionOverlayElement]);

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
              log.info('Scheduling text search after jump:', { text: savedJump.text, word: savedJump.word });
              setTimeout(() => {
                log.info('Starting text search now');
                handleTextSearch(savedJump.text!, savedJump.word);
                setTimeout(() => {
                  log.info('Text search completed, clearing jumping flag');
                  isJumpingRef.current = false;
                }, 1000);
              }, 600);
            } else {
              log.info('No text to search, clearing jumping flag');
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
                
                pendingJumpRef.current = null;
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
                            // spine is iterable with each()
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
                 pendingJumpRef.current = null;
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
                        // spine is iterable with each()
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
      log.debug('Saving state', { progress: preciseProgressRef.current, font: settingsRef.current.fontSize });
      persistCurrentState();
    }, 500);

    return () => { if (saveProgressTimeout.current) clearTimeout(saveProgressTimeout.current); };
  }, [bookId, forceSave, isReadyToSave, loading, persistCurrentState]);

  useEffect(() => {
    if (!bookId) return;

    const flushProgressSave = () => {
      if (saveProgressTimeout.current) {
        clearTimeout(saveProgressTimeout.current);
        saveProgressTimeout.current = null;
      }

      if (loading || !isReadyToSave) return;
      persistCurrentState();
    };

    window.addEventListener('pagehide', flushProgressSave);
    window.addEventListener('beforeunload', flushProgressSave);

    return () => {
      window.removeEventListener('pagehide', flushProgressSave);
      window.removeEventListener('beforeunload', flushProgressSave);
      flushProgressSave();
    };
  }, [bookId, isReadyToSave, loading, persistCurrentState]);

  // Initialize epub.js
  useEffect(() => {
    if (!isClient || !fileUrl) return;
    if (!containerRef.current) return;
    if (isJapaneseBook && !furiganaPreferenceReady) return;

    let book: any = null;
    let rendition: any = null;
    let isCancelled = false;
    let stableTimeout: NodeJS.Timeout;
    let cancelDeferredLocationGeneration: (() => void) | null = null;

    const initBook = async () => {
      setLoading(true);
      setError(null);
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
        void cacheEpub(fileUrl, arrayBuffer);
      }

      bookBufferRef.current = arrayBuffer.slice(0);

      book = ePub(arrayBuffer);
      bookRef.current = book;
      await book.ready;
      if (isCancelled) return;
      if (isJapaneseBook) {
        book.package.metadata.direction = 'ltr';
        bookDirectionRef.current = 'ltr';
        contentLayoutRef.current = {
          writingMode: 'horizontal-tb',
          isVertical: false,
          pageProgression: 'ltr',
        };
        book.spine.hooks.content.register((doc: Document) => {
          forceHorizontalWritingModeInDocument(doc);
        });
      } else {
        bookDirectionRef.current = book.package?.metadata?.direction === 'rtl' ? 'rtl' : 'ltr';
      }

      rendition = book.renderTo(containerRef.current!, {
        width: '100%',
        height: '100%',
        ignoreClass: FURIGANA_IGNORE_CLASS,
        manager: 'default',
        spread: 'none',
        flow: 'paginated',
      });
      renditionRef.current = rendition;
      if (isJapaneseBook) {
        rendition.direction('ltr');
      }
      rendition.themes.fontSize(`${fontSize}%`);

      // Inject on new content — 使用 ref 访问最新函数，避免旧闭包导致假名失效
      rendition.hooks.content.register((contents: any) => prepareContentsForDisplay(contents));

      // Apply to existing content immediately
      rendition.getContents().forEach((contents: any) => {
        void prepareContentsForDisplay(contents);
      });

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

          // Monkey Patch Range methods to silence IndexSizeError
          try {
            const originalSetEnd = win.Range.prototype.setEnd;
            win.Range.prototype.setEnd = function(node: Node, offset: number) {
              try {
                return originalSetEnd.call(this, node, offset);
              } catch (e: any) {
                const isIndexSizeError = e.name === 'IndexSizeError' || 
                                       (e.message && e.message.includes('IndexSizeError')) ||
                                       (e.message && e.message.includes('The offset is larger than'));
                if (isIndexSizeError) {
                   log.debug('[EPUB] Silenced IndexSizeError in setEnd', e);
                   return;
                }
                throw e;
              }
            };

            const originalSetStart = win.Range.prototype.setStart;
            win.Range.prototype.setStart = function(node: Node, offset: number) {
              try {
                return originalSetStart.call(this, node, offset);
              } catch (e: any) {
                 const isIndexSizeError = e.name === 'IndexSizeError' || 
                                       (e.message && e.message.includes('IndexSizeError')) ||
                                       (e.message && e.message.includes('The offset is larger than'));
                if (isIndexSizeError) {
                   log.debug('[EPUB] Silenced IndexSizeError in setStart', e);
                   return;
                }
                throw e;
              }
            };
          } catch (err) {
            log.warn('Failed to patch Range methods:', err);
          }

          // Create Highlight Overlay
          const overlay = doc.createElement('div');
          overlay.id = 'word-highlight-overlay';
          overlay.style.position = 'fixed';
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
          searchOverlay.style.position = 'fixed';
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

               const directLookupTarget = getLookupTargetFromNode(e.target as Node | null);
               if (directLookupTarget) {
                   positionOverlayElement(overlay, directLookupTarget.rect);
                   return;
               }

                // Word Highlighting Logic
                // Use standard browser API to get range at point
                let range: Range | null = null;
                const point = getContentsViewportPoint(contents, e);
                if (doc.caretRangeFromPoint) {
                    range = doc.caretRangeFromPoint(point.x, point.y);
                } else if (doc.caretPositionFromPoint) {
                    const pos = doc.caretPositionFromPoint(point.x, point.y);
                    if (pos) {
                        const caretRange = doc.createRange();
                        range = caretRange;
                        try {
                            const maxOff = pos.offsetNode.nodeType === 3 ? (pos.offsetNode.textContent?.length || 0) : pos.offsetNode.childNodes.length;
                            caretRange.setStart(pos.offsetNode, Math.min(pos.offset, maxOff));
                            caretRange.collapse(true);
                       } catch (reErr) {
                           log.debug('Caret position range failed:', reErr);
                       }
                    }
               }

               if (range) {
                   try {
                        const wordRange = expandRangeToWord(doc, range);
                        const textNode = wordRange?.startContainer.nodeType === Node.TEXT_NODE
                            ? wordRange.startContainer as Text
                            : null;
                        const textAnnotation = textNode
                            ? furiganaCacheRef.current.get(textNode.textContent ?? '')
                            : null;
                        const offset = textNode ? wordRange!.startOffset : -1;
                        const lookupSegment = textAnnotation
                            ? findLookupSegmentAtOffset(textAnnotation.lookup_segments || [], offset)
                            : null;
                        const word = normalizeLookupWord(lookupSegment?.lookup_text || wordRange?.toString() || '');

                        if (wordRange && word) {
                            positionOverlayElement(overlay, getRangeVisualRect(wordRange));
                            return;
                        }
                    } catch (error) {
                        log.debug('MouseMove word highlight failed:', error);
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
                               const rect = getRangeVisualRect(range);
                               
                               // We need to translate iframe-relative coordinates to viewport coordinates
                               const iframe = containerRef.current?.querySelector('iframe');
                               if (iframe && rect) {
                                   const iframeRect = iframe.getBoundingClientRect();
                                   const x = iframeRect.left + rect.left + rect.width / 2;
                                   const y = iframeRect.top + rect.top;
                                  
                                  // --- 关键修复：计算精确的章节索引 ---
                                  let pageNum = undefined;
                                  let cfi = undefined;
                                  try {
                                      // 1. 生成 CFI
                                      const contents = bookRef.current?.rendition?.getContents()[0];
                                      if (contents && bookRef.current) {
                                          cfi = contents.cfiFromRange(range, FURIGANA_IGNORE_CLASS);
                                          
                                          // 2. 根据 CFI 获取 Spine Item (章节)
                                          if (cfi) {
                                              const spineItem = bookRef.current.spine.get(cfi);
                                              if (spineItem && typeof spineItem.index === 'number') {
                                                  pageNum = spineItem.index + 1; // 1-based index
                                                  log.info("Calculated precise page number from selection:", pageNum, "CFI:", cfi);
                                              }
                                          }
                                      }
                                  } catch (cfiErr) {
                                      log.warn("Failed to calculate CFI/Page for selection:", cfiErr);
                                  }

                                  log.debug('Dispatching selection:', { text, x, y, pageNum });
                                  document.dispatchEvent(new CustomEvent('epub-text-selected', {
                                      detail: { text, x, y, rect, pageNum, cfi },
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
          doc.addEventListener('click', () => {
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
      let cachedPercentage: number | undefined;
      let cachedSectionIndex: number | undefined;
      let cachedSectionPage: number | undefined;
      let locationsGeneratedDuringRestore = false;
      const ensureLocationsGenerated = async () => {
        if (locationsGeneratedDuringRestore) return;
        await book.locations.generate(1000);
        locationsGeneratedDuringRestore = true;
      };
      if (bookId) {
        try {
          const cached = await getEpubState(bookId);
            if (cached) {
             const nextFontSize = cached.settings?.fontSize || fontSize;
             const nextFontFamily = cached.settings?.fontFamily || fontFamily;
             const nextLineHeight = cached.settings?.lineHeight || lineHeight;
              settingsRef.current = {
                fontSize: nextFontSize,
                fontFamily: nextFontFamily,
                lineHeight: nextLineHeight,
                fitMode: cached.settings?.fitMode || fitMode,
               };
               if (cached.settings?.fontSize) {
                  setFontSize(nextFontSize);
                  rendition.themes.fontSize(`${nextFontSize}%`);
               }
                if (cached.settings?.fontFamily) setFontFamily(nextFontFamily);
                if (cached.settings?.lineHeight) setLineHeight(nextLineHeight);
                if (cached.settings?.fitMode) setFitMode(cached.settings.fitMode);
                if (typeof cached.percentage === 'number') {
                  cachedPercentage = cached.percentage;
                  updateProgressState(cached.percentage);
                }
                if (typeof cached.sectionIndex === 'number' && cached.sectionIndex >= 0) {
                  cachedSectionIndex = cached.sectionIndex;
                }
                if (typeof cached.sectionPage === 'number' && cached.sectionPage > 0) {
                  cachedSectionPage = cached.sectionPage;
                }

                // 只有当没有指定 jumpRequest 时，才使用缓存的 CFI
                // 注意：UniversalReader 现在将 pageNumber 转换为 jumpRequest
                if (cached.cfi && (!jumpRequest || !jumpRequest.dest)) {
                    startLocation = cached.cfi;
               }
              }
        } catch (e) { log.warn('Failed to load cached state:', e); }
      }

      // 如果有 initialChapter (遗留逻辑) 或 jumpRequest，不在此处处理
      // 它们会通过 useEffect 或 pendingJumpRef 处理

      // 没有可靠 CFI 时，优先使用章节索引兜底，避免为了 percentage 恢复而阻塞首屏。
      if (!startLocation && !jumpRequest && typeof cachedSectionIndex === 'number' && cachedSectionIndex >= 0) {
          startLocation = cachedSectionIndex;
      }

      // 没有可靠 CFI/章节锚点时，再退回到本地缓存的精确 percentage。
      if (!startLocation && !jumpRequest && cachedPercentage && cachedPercentage > 0) {
          try {
            await ensureLocationsGenerated();
            startLocation = book.locations.cfiFromPercentage(cachedPercentage / 100);
          } catch (e) { log.warn('Failed to generate locations for cached progress:', e); }
      }

      // 如果没有本地精确缓存，再使用父层章节页兜底。
      if (!startLocation && !jumpRequest && initialChapter && initialChapter > 0) {
          startLocation = initialChapter - 1;
      }

      // 如果还没有 startLocation，尝试使用 initialProgress
      if (!startLocation && !jumpRequest && initialProgress && initialProgress > 0) {
          try {
            updateProgressState(initialProgress);
            await ensureLocationsGenerated();
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

      if (isJapaneseBook) {
        try {
          await waitForVisibleContentsStable();
        } catch (error) {
          log.debug('日文 EPUB 初始布局稳定等待失败:', error);
        }
      }

      if (!jumpRequest && typeof cachedSectionIndex === 'number' && typeof cachedSectionPage === 'number') {
        const waitForRestoreStep = async () => {
          if (isJapaneseBook) {
            await waitForVisibleContentsStable();
            return;
          }
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
        };

        try {
          let currentLocation = rendition.currentLocation?.();
          if (currentLocation?.start?.index !== cachedSectionIndex) {
            await rendition.display(cachedSectionIndex);
            await waitForRestoreStep();
            currentLocation = rendition.currentLocation?.();
          }

          const currentSectionPage = currentLocation?.start?.displayed?.page;
          const currentSectionIndex = currentLocation?.start?.index;
          const pageDrift =
            currentSectionIndex === cachedSectionIndex && typeof currentSectionPage === 'number'
              ? cachedSectionPage - currentSectionPage
              : 0;

          if (pageDrift !== 0 && Math.abs(pageDrift) <= 3) {
            const step = pageDrift > 0 ? 'next' : 'prev';
            for (let i = 0; i < Math.abs(pageDrift); i += 1) {
              await rendition[step]?.();
              await waitForRestoreStep();
            }
          }
        } catch (error) {
          log.debug('章节内页码恢复校准失败:', error);
        }
      }

      if (!isCancelled) {
        log.info('Setting renditionReady to true');
        setRenditionReady(true);
      } else {
        log.warn('EPUB initialization was cancelled, renditionReady will not be set');
      }
      
      // 新增：初始化完成后立即同步一次内容
      if (!isCancelled && rendition) {
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

                                 // 清理假名标注
                                 const div = doc.createElement('div');
                                 div.appendChild(range.cloneContents());
                                 let text = extractPlainTextFromBody(div);
                                 // 如果提取的文本为空或太短，使用备用方法
                                 if (!text || text.length < 10) {
                                     log.debug('INIT SYNC - extractPlainTextFromBody returned empty/short, using fallback');
                                     text = range.toString().trim();
                                     text = text.replace(/〔([^〕]+)〕/g, '').replace(/（[^()]*?[ぁ-んァ-ヶ]+[^\(\）]*?）/g, '').trim();
                                 }
                                  const resolvedText = resolveVisibleContentText(text);
                                  log.debug('INIT SYNC - Text length:', resolvedText.length);
                                  publishVisibleContent(resolvedText);
                              } catch (rangeOpErr) {
                                  log.debug('INIT SYNC - Range operation failed (offsets may be stale):', rangeOpErr);
                                  // Fallback: Safe truncation
                                  let startText = rangeStart.toString().trim();
                                  // 手动清理假名
                                  startText = startText.replace(/〔([^〕]+)〕/g, '').replace(/（[^()]*?[ぁ-んァ-ヶ]+[^\(\）]*?）/g, '').trim();
                                  if (startText.length > 2000) {
                                      publishVisibleContent(resolveVisibleContentText(startText.substring(0, 2000) + "\n...(truncated)"));
                                  } else {
                                      publishVisibleContent(resolveVisibleContentText(startText));
                                  }
                              }
                          } else {
                              // Fallback for cross-chapter or detached nodes
                              const sText = rangeStart.toString().trim();
                              const eText = rangeEnd.toString().trim();
                              // 手动清理假名
                              const combined = (sText + "\n...\n" + eText).replace(/〔([^〕]+)〕/g, '').replace(/（[^()]*?[ぁ-んァ-ヶ]+[^\(\）]*?）/g, '').trim();
                              if (combined.length > 5000) {
                                  publishVisibleContent(resolveVisibleContentText(combined.substring(0, 5000) + "\n...(truncated)"));
                              } else {
                                  publishVisibleContent(resolveVisibleContentText(combined));
                              }
                              log.debug('INIT SYNC (Fallback) - Text length truncated check used');
                          }
                      } else if (rangeStart) {
                          // 只有 start 成功
                         let startText = rangeStart.toString().trim();
                          // 手动清理假名
                          startText = startText.replace(/〔([^〕]+)〕/g, '').replace(/（[^()]*?[ぁ-んァ-ヶ]+[^\(\）]*?）/g, '').trim();
                          if (startText.length > 3000) {
                              publishVisibleContent(resolveVisibleContentText(startText.substring(0, 2000) + "\n...(truncated)"));
                          } else {
                              publishVisibleContent(resolveVisibleContentText(startText));
                          }
                      }
                    } catch (err) {
                      log.debug('Manual range construction failed (likely IndexSizeError from epub.js):', err);
                      // Simple fallback - 最后尝试
                     try {
                       const range = await book.getRange(start);
                        if (range) {
                          // 手动清理假名
                          let text = range.toString().trim();
                          text = text.replace(/〔([^〕]+)〕/g, '').replace(/（[^()]*?[ぁ-んァ-ヶ]+[^\(\）]*?）/g, '').trim();
                          publishVisibleContent(resolveVisibleContentText(text));
                        } else {
                          publishVisibleContent(resolveVisibleContentText(''));
                        }
                      } catch (finalErr) {
                        log.debug('Final getRange fallback failed:', finalErr);
                        publishVisibleContent(resolveVisibleContentText(''));
                      }
                    }
                 }
              } catch (e) {
                 log.debug('Init sync failed:', e);
                 publishVisibleContent(resolveVisibleContentText(''));
              }
           });
       }

      if (!isCancelled) {
          setLoading(false);
          if (stableTimeout) clearTimeout(stableTimeout);
          stableTimeout = setTimeout(() => {
              if (!isCancelled && !isJumpingRef.current) setIsReadyToSave(true);
          }, 1000);
      }

      const initialLocation = rendition.currentLocation?.();
      if (initialLocation?.start?.displayed?.page > 0) {
        currentSectionPageRef.current = {
          sectionIndex: typeof initialLocation.start.index === 'number' ? initialLocation.start.index : null,
          sectionPage: initialLocation.start.displayed.page,
        };
      }
      const initialCfi =
        normalizeRenderedCfi(initialLocation?.start?.cfi) ??
        initialLocation?.start?.cfi ??
        (typeof startLocation === 'string' ? normalizeRenderedCfi(startLocation) ?? startLocation : null);
      if (initialCfi) {
        currentCfiRef.current = initialCfi;
      }

      try {
        let locationsReady = locationsGeneratedDuringRestore;
        const idleWindow = window as IdleCapableWindow;
        const scheduleLocationGeneration = () => {
          if (isCancelled || !bookRef.current) return;
          if (locationsReady) return;
          book.locations.generate(1000).then(() => {
            if (isCancelled) return;
            locationsReady = true;
              if (currentCfiRef.current) {
                   try {
                      const currentProgress = book.locations.percentageFromCfi(currentCfiRef.current);
                      updateProgressState(currentProgress * 100);
                   } catch {}
               }

          }).catch(() => {
             if (!isCancelled) {
               setLoading(false);
               setIsReadyToSave(true);
             }
          });
        };

        if (typeof idleWindow.requestIdleCallback === 'function') {
          const handle = idleWindow.requestIdleCallback(() => scheduleLocationGeneration(), { timeout: 2000 });
          cancelDeferredLocationGeneration = () => idleWindow.cancelIdleCallback?.(handle);
        } else {
          const handle = window.setTimeout(scheduleLocationGeneration, 1500);
          cancelDeferredLocationGeneration = () => window.clearTimeout(handle);
        }

        rendition.on('relocated', async (location: any) => {
          const relocationToken = ++relocationTokenRef.current;
          let effectiveLocation = location;

          if (isJapaneseBook) {
            try {
              await waitForVisibleContentsStable();
              if (relocationToken !== relocationTokenRef.current) return;
              const stabilizedLocation = renditionRef.current?.currentLocation?.();
              if (stabilizedLocation?.start) {
                effectiveLocation = stabilizedLocation;
              }
            } catch (error) {
              log.debug('日文 EPUB relocated 稳定化失败:', error);
            }
          }

          if (relocationToken !== relocationTokenRef.current) return;

          if (effectiveLocation && effectiveLocation.start) {
            const cfi = normalizeRenderedCfi(effectiveLocation.start.cfi) ?? effectiveLocation.start.cfi;
            currentCfiRef.current = cfi;
            if (locationsReady && book.locations.length() > 0) {
              const currentProgress = book.locations.percentageFromCfi(cfi);
              updateProgressState(currentProgress * 100);
            }
            setForceSave(prev => prev + 1);

            updateDisplayedPagination(effectiveLocation);

            if (onPageChange) {
              const chapterPage = resolveChapterPage(cfi, effectiveLocation.start.index);
              if (chapterPage > 0 && lastReportedChapterRef.current !== chapterPage) {
                lastReportedChapterRef.current = chapterPage;
                onPageChange(chapterPage);
              }
            }

            // 新增：提取并回传当前页可见内容（带防抖）
            setVisiblePageTextForTTS("");
            if (contentSyncTimeoutRef.current) clearTimeout(contentSyncTimeoutRef.current);

            contentSyncTimeoutRef.current = setTimeout(async () => {
              try {
                const start = effectiveLocation.start.cfi;
                const end = effectiveLocation.end.cfi;

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
                                 // 清理假名
                                 const div = doc.createElement('div');
                                 div.appendChild(range.cloneContents());
                                 text = extractPlainTextFromBody(div);
                                 log.debug('Relocated sync - extractPlainTextFromBody result:', { length: text.length });
                                 // 如果提取的文本为空或太短，使用备用方法
                                 if (!text || text.length < 10) {
                                     log.debug('extractPlainTextFromBody returned empty/short, using fallback');
                                     text = range.toString().trim();
                                     text = text.replace(/〔([^〕]+)〕/g, '').replace(/（[^()]*?[ぁ-んァ-ヶ]+[^\(\）]*?）/g, '').trim();
                                     log.debug('Relocated sync - fallback result:', { length: text.length });
                                 }
                             } catch (rangeOpErr) {
                                 log.debug('Relocated sync - Range operation failed:', rangeOpErr);
                                 // Fallback: Safe truncation if start range is too large (likely whole chapter/wrapper)
                                 let startText = rangeStart.toString().trim();
                                 // 手动清理常见的假名格式
                                 startText = startText.replace(/〔([^〕]+)〕/g, '').replace(/（[^()]*?[ぁ-んァ-ヶ]+[^\(\）]*?）/g, '').trim();
                                 if (startText.length > 2000) {
                                     // Likely an element fallback, truncate
                                     text = startText.substring(0, 2000) + "\n...(truncated)";
                                 } else {
                                     text = startText;
                                 }
                                 log.debug('Relocated sync - rangeOpErr fallback result:', { length: text.length });
                             }
                         } else {
                             // Fallback for cross-document (unlikely in single-view) or disconnected nodes
                              const sText = rangeStart.toString().trim();
                              const eText = rangeEnd.toString().trim();
                             // 手动清理假名
                             const cleanCombined = (sText + "\n...\n" + eText).replace(/〔([^〕]+)〕/g, '').replace(/（[^()]*?[ぁ-んァ-ヶ]+[^\(\）]*?）/g, '').trim();
                             if (cleanCombined.length > 5000) {
                                 text = cleanCombined.substring(0, 5000) + "\n...(truncated)";
                             } else {
                                 text = cleanCombined;
                             }
                             log.debug('Relocated sync - cross-doc fallback result:', { length: text.length });
                         }
                   } else if (rangeStart) {
                        // Only start range available (end failed)
                        let startText = rangeStart.toString().trim();
                        // 手动清理假名
                        startText = startText.replace(/〔([^〕]+)〕/g, '').replace(/（[^()]*?[ぁ-んァ-ヶ]+[^\(\）]*?）/g, '').trim();
                        // 关键修复: 如果只有 start 且内容极长，说明可能选中了整个章节容器
                        if (startText.length > 3000) {
                             log.warn('Fallback extraction used start-only which is very long, truncating.');
                             text = startText.substring(0, 2000) + "\n...(truncated)";
                        } else {
                             text = startText;
                        }
                        log.debug('Relocated sync - start-only fallback result:', { length: text.length });
                   }
                 } catch {
                    log.debug('Range extraction failed, trying fallback...');
                  }

                  // 2. 如果主方式失败或结果为空，尝试兜底方式：单点提取
                  if (!text) {
                    try {
                      const range = rendition.getRange(start);
                      if (range) {
                        // 手动清理假名
                        let rawText = range.toString().trim();
                        rawText = rawText.replace(/〔([^〕]+)〕/g, '').replace(/（[^()]*?[ぁ-んァ-ヶ]+[^\(\）]*?）/g, '').trim();
                        text = rawText;
                        log.debug('Relocated sync - rendition.getRange fallback result:', { length: text.length });
                      }
                    } catch (fallbackErr) {
                      log.debug('Fallback extraction failed:', fallbackErr);
                    }
                  }

                  // 始终调用 onContentChange，即使内容为空
                  const resolvedText = resolveVisibleContentText(text);
                  log.debug('Relocated sync - Final result:', { length: resolvedText.length, hasText: !!resolvedText });
                  publishVisibleContent(resolvedText);
                } catch (e) {
                  log.debug('Content extraction logic encounter error:', e);
                  // 出错时也要调用 onContentChange，避免状态卡住
                publishVisibleContent(resolveVisibleContentText(''));
              }
            }, 300); // 300ms 防抖，等待排版稳定
          }
        });


        // Handle click (Lookup Word)
        rendition.on('click', (e: MouseEvent, contents: any) => {
            // Click-to-lookup logic
            const selection = contents.window.getSelection();
            if (onWordClick && (!selection || selection.isCollapsed)) {
                const directLookupTarget = getLookupTargetFromNode(e.target as Node | null);
                if (directLookupTarget) {
                    const contextSentence = extractContextSentenceFromNode(
                        directLookupTarget.sourceNode,
                        directLookupTarget.lookupWord,
                    );
                    onWordClick(directLookupTarget.lookupWord, contextSentence || undefined);
                    return;
                }

                // Try to identify word at click position
                // Note: We access the document inside the iframe
                const doc = contents.document;
                // Use standard browser caretRangeFromPoint or caretPositionFromPoint
                let range: Range | null = null;
                const point = getContentsViewportPoint(contents, e);
                if (doc.caretRangeFromPoint) {
                    range = doc.caretRangeFromPoint(point.x, point.y);
                } else if (doc.caretPositionFromPoint) {
                    const pos = doc.caretPositionFromPoint(point.x, point.y);
                    if (pos) {
                        const caretRange = doc.createRange();
                        caretRange.setStart(pos.offsetNode, Math.min(pos.offset, pos.offsetNode.nodeType === 3 ? (pos.offsetNode.textContent?.length || 0) : pos.offsetNode.childNodes.length));
                        caretRange.collapse(true);
                        range = caretRange;
                    }
                }

                if (range) {
                    let lookupRange = expandRangeToWord(doc, range);

                    try {
                        if (!lookupRange && (range as any).expand) {
                            (range as any).expand('word');
                            lookupRange = range;
                        }

                        const textNode = lookupRange?.startContainer.nodeType === Node.TEXT_NODE
                            ? lookupRange.startContainer as Text
                            : null;
                        const textAnnotation = textNode
                            ? furiganaCacheRef.current.get(textNode.textContent ?? '')
                            : null;
                        const offset = textNode ? lookupRange!.startOffset : -1;
                        const lookupSegment = textAnnotation
                            ? findLookupSegmentAtOffset(textAnnotation.lookup_segments || [], offset)
                            : null;
                        const cleanWord = normalizeLookupWord(lookupSegment?.lookup_text || lookupRange?.toString() || '');
                        const minLookupLength = containsJapaneseText(cleanWord) ? 1 : 2;

                        if (cleanWord && cleanWord.length >= minLookupLength) {
                                log.debug('Looked up word:', cleanWord);
                                
                                // Extract context sentence from iframe
                                let contextSentence = '';
                                try {
                                    const node = lookupRange?.commonAncestorContainer ?? range.commonAncestorContainer;
                                    contextSentence = extractContextSentenceFromNode(node, cleanWord);
                                } catch (e) { 
                                    log.warn('Context extraction failed:', e); 
                                }
                                
                                onWordClick(cleanWord, contextSentence || undefined);
                                return; // Success
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
      cancelDeferredLocationGeneration?.();
      if (stableTimeout) clearTimeout(stableTimeout);
      setRenditionReady(false);
      if (bookRef.current) {
        try { bookRef.current.destroy(); } catch {}
        bookRef.current = null;
        renditionRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 初始化流程依赖大量稳定引用，按文件切换时重建即可
  }, [fileUrl, forceHorizontalWritingModeInDocument, furiganaPreferenceReady, isClient, isJapaneseBook, prepareContentsForDisplay]);


  const flattenToc = (toc: any[], level: number): OutlineItem[] => {
    const result: OutlineItem[] = [];
    for (const item of toc) {
      result.push({ title: item.label, dest: item.href, pageNumber: 0, level });
      if (item.subitems && item.subitems.length > 0) result.push(...flattenToc(item.subitems, level + 1));
    }
    return result;
  };

  const goNext = useCallback(() => {
    void renditionRef.current?.next();
  }, []);
  const goPrev = useCallback(() => {
    void renditionRef.current?.prev();
  }, []);
  const changeFontSize = useCallback((delta: number) => {
    const newSize = Math.max(80, Math.min(150, fontSize + delta));
    setFontSize(newSize);
    renditionRef.current?.themes.fontSize(`${newSize}%`);
  }, [fontSize]);

  // ─── 全文朗读 ─────────────────────────────────────────────────────────────
  // EPUB 按章节朗读。每次 onPageChange 调用 renditionRef.next() 跳到下一章。
  // 当 rendition 无法再进行时（最后一章），getPageText 返回空字符串，朗读循环将自动结束。
  const epubPageRef = useRef(1); // 用于模拟页码计数，触发 onPageChange

  const getEpubPageText = useCallback((): string => {
    try {
      const contents = renditionRef.current?.getContents();
      const body = contents?.[0]?.document?.body;
      const rawText = extractPlainTextFromBody(body);
      return preprocessTTSPlainText(rawText.trim(), bookLanguage);
    } catch {
      return '';
    }
  }, [bookLanguage, extractPlainTextFromBody]);

  const getCurrentEpubPageText = useCallback((): string => {
    try {
      const location = renditionRef.current?.currentLocation?.();
      const startCfi = location?.start?.cfi;
      const endCfi = location?.end?.cfi;

      if (startCfi && endCfi) {
        const startRange = renditionRef.current?.getRange(startCfi, FURIGANA_IGNORE_CLASS);
        const endRange = renditionRef.current?.getRange(endCfi, FURIGANA_IGNORE_CLASS);
        const startContainer = startRange?.startContainer;
        const endContainer = endRange?.endContainer;
        const doc = startContainer?.ownerDocument;

        if (
          doc &&
          startContainer &&
          endContainer &&
          doc === endContainer.ownerDocument &&
          doc.contains(startContainer) &&
          doc.contains(endContainer)
        ) {
          const range = doc.createRange();
          const maxStart =
            startContainer.nodeType === 3
              ? (startContainer.textContent?.length || 0)
              : startContainer.childNodes.length;
          const maxEnd =
            endContainer.nodeType === 3
              ? (endContainer.textContent?.length || 0)
              : endContainer.childNodes.length;
          range.setStart(startContainer, Math.min(startRange.startOffset, maxStart));
          range.setEnd(endContainer, Math.min(endRange.endOffset, maxEnd));
          const div = doc.createElement("div");
          div.appendChild(range.cloneContents());
          const visibleText = extractPlainTextFromBody(div).trim();
          if (visibleText) {
            return preprocessTTSPlainText(visibleText, bookLanguage);
          }
        }
      }
    } catch (error) {
      log.debug("Current EPUB page text extraction failed:", error);
    }

    return preprocessTTSPlainText(visiblePageTextForTTS.trim(), bookLanguage);
  }, [bookLanguage, extractPlainTextFromBody, visiblePageTextForTTS]);

  const handleEpubTTSPageChange = useCallback((page: number) => {
    // 第 1 页是当前章节，不需要翻页；后续页都调用 next()
    if (page > 1) {
      void renditionRef.current?.next();
    }
    epubPageRef.current = page;
  }, []);

  const tts = useFullTextTTS({
    getPageText: getEpubPageText,
    getCurrentPageText: getCurrentEpubPageText,
    totalPages: 9999, // EPUB 章节数不确定，依赖空页检测终止
    currentPage: 1,   // 始终从当前章节开始
    onPageChange: handleEpubTTSPageChange,
    pageChangeDelay: 1200, // epub.js 加载新章节需约 1s
    bookLanguage,
  });

  useEffect(() => {
    if (!renditionReady || !renditionRef.current) return;

    // 检测本次 effect 触发时，哪些值实际上发生了变化
    const furiganaChanged = prevShowFuriganaRef.current !== undefined &&
      prevShowFuriganaRef.current !== showFurigana;
    const fontChanged = prevFontFamilyRef.current !== undefined &&
      prevFontFamilyRef.current !== fontFamily;
    const lineHeightChanged = prevLineHeightRef.current !== undefined &&
      prevLineHeightRef.current !== lineHeight;
    const needsReflow = furiganaChanged || fontChanged || lineHeightChanged;

    // 记录本次值，供下次 effect 比对
    prevShowFuriganaRef.current = showFurigana;
    prevFontFamilyRef.current = fontFamily;
    prevLineHeightRef.current = lineHeight;

    let cancelled = false;

    const refreshCurrentContents = async () => {
      const contentsList = renditionRef.current?.getContents() ?? [];
      await Promise.all(
        contentsList.map(async (contents: any) => {
          applyReaderStylesToContents(contents);
          try {
            await applyFuriganaToDocument(contents.document);
          } catch (error) {
            log.warn('EPUB furigana refresh failed:', error);
          }
        }),
      );
      if (isJapaneseBook) {
        await waitForVisibleContentsStable();
      } else {
        remeasureCurrentEpubViews();
      }

      if (cancelled) return;

      // 仅在外观设置真正改变时才触发 reflow（resize + display），
      // 避免 renditionReady 首次变为 true 时的多余 resize+display 干扰 epub.js 初始布局
      if (!needsReflow || !containerRef.current || !renditionRef.current) return;

      const currentLocation = renditionRef.current.currentLocation?.();
      const currentCfi = currentCfiRef.current || normalizeRenderedCfi(currentLocation?.start?.cfi);

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });

      if (cancelled) return;

      const { width, height } = containerRef.current.getBoundingClientRect();
      renditionRef.current.resize(width, height);
      remeasureCurrentEpubViews();

      if (currentCfi) {
        try {
          await renditionRef.current.display(currentCfi);
        } catch (error) {
          log.debug('假名 reflow display 失败:', error);
        }
      }

      if (cancelled) return;
      publishVisibleContent(resolveVisibleContentText(''));
    };

    void refreshCurrentContents();

    return () => {
      cancelled = true;
    };
  }, [applyFuriganaToDocument, applyReaderStylesToContents, fontFamily, isJapaneseBook, lineHeight, normalizeRenderedCfi, publishVisibleContent, remeasureCurrentEpubViews, renditionReady, resolveVisibleContentText, showFurigana, waitForVisibleContentsStable]);

  const displayPaginationSignature = useMemo(() => {
    const width = Math.round(containerSize.width);
    const height = Math.round(containerSize.height);
    return [
      fileUrl,
      width,
      height,
      fontSize,
      fontFamily,
      lineHeight,
      showFurigana ? 1 : 0,
      isJapaneseBook ? 1 : 0,
    ].join("|");
  }, [containerSize.height, containerSize.width, fileUrl, fontFamily, fontSize, isJapaneseBook, lineHeight, showFurigana]);

  useEffect(() => {
    if (
      !renditionReady ||
      !bookBufferRef.current ||
      containerSize.width <= 0 ||
      containerSize.height <= 0
    ) {
      return;
    }

    const cached = displayPaginationCacheRef.current.get(displayPaginationSignature);
    if (cached) {
      displayPageOffsetsRef.current = cached.offsets;
      setDisplayTotalPages(cached.totalPages);
      const currentLocation = renditionRef.current?.currentLocation?.();
      if (currentLocation) {
        updateDisplayedPagination(currentLocation, cached.offsets, cached.totalPages);
      }
      return;
    }

    let cancelled = false;
    let cancelScheduledMeasurement: (() => void) | null = null;
    const measureToken = ++displayPaginationMeasureTokenRef.current;

    const measureDisplayedPagination = async () => {
      const ePub = (await import("epubjs")).default;
      const sourceBuffer = bookBufferRef.current;
      if (!sourceBuffer || cancelled) return;

      const hiddenContainer = document.createElement("div");
      hiddenContainer.setAttribute("aria-hidden", "true");
      hiddenContainer.style.position = "fixed";
      hiddenContainer.style.left = "-100000px";
      hiddenContainer.style.top = "0";
      hiddenContainer.style.width = `${Math.round(containerSize.width)}px`;
      hiddenContainer.style.height = `${Math.round(containerSize.height)}px`;
      hiddenContainer.style.opacity = "0";
      hiddenContainer.style.pointerEvents = "none";
      hiddenContainer.style.overflow = "hidden";
      document.body.appendChild(hiddenContainer);

      let measureBook: any = null;
      let measureRendition: any = null;
      let measureBookOpened: Promise<unknown> | null = null;

      try {
        measureBook = ePub(sourceBuffer.slice(0));
        measureBookOpened = measureBook.opened.catch(() => undefined);
        await measureBook.ready;

        if (cancelled || displayPaginationMeasureTokenRef.current !== measureToken) return;

        if (isJapaneseBook) {
          measureBook.package.metadata.direction = "ltr";
          measureBook.spine.hooks.content.register((doc: Document) => {
            forceHorizontalWritingModeInDocument(doc);
          });
        }

        measureRendition = measureBook.renderTo(hiddenContainer, {
          width: "100%",
          height: "100%",
          ignoreClass: FURIGANA_IGNORE_CLASS,
          manager: "default",
          spread: "none",
          flow: "paginated",
        });

        if (isJapaneseBook) {
          measureRendition.direction("ltr");
        }
        measureRendition.themes.fontSize(`${fontSize}%`);
        measureRendition.hooks.content.register(async (contents: any) => {
          applyReaderStylesToContents(contents);
          await applyFuriganaToDocumentRef.current(contents.document);
          const displayedViews = measureRendition.manager?.views?.displayed?.() ?? [];
          displayedViews.forEach((view: any) => {
            try {
              view.expand?.();
            } catch (error) {
              log.debug("Hidden EPUB view remeasure failed:", error);
            }
          });
          await waitForDocumentLayoutStable(contents.document);
        });

        const sections: any[] = [];
        measureBook.spine.each((section: any) => {
          if (section.linear) {
            sections.push(section);
          }
        });

        const offsets: number[] = [];
        let totalPages = 0;

        for (const section of sections) {
          if (cancelled || displayPaginationMeasureTokenRef.current !== measureToken) return;

          offsets[section.index] = totalPages;
          await measureRendition.display(section.href);

          const currentLocation = measureRendition.currentLocation?.();
          const sectionPages = Math.max(
            1,
            currentLocation?.start?.displayed?.total ??
              currentLocation?.end?.displayed?.total ??
              1,
          );
          totalPages += sectionPages;
        }

        if (cancelled || displayPaginationMeasureTokenRef.current !== measureToken) return;

        displayPaginationCacheRef.current.set(displayPaginationSignature, {
          totalPages,
          offsets,
        });
        displayPageOffsetsRef.current = offsets;
        setDisplayTotalPages(totalPages);

        const currentLocation = renditionRef.current?.currentLocation?.();
        if (currentLocation) {
          updateDisplayedPagination(currentLocation, offsets, totalPages);
        }
      } catch (error) {
        log.warn("EPUB displayed pagination measurement failed:", error);
      } finally {
        if (measureBookOpened) {
          try {
            await measureBookOpened;
          } catch {
            // ignore
          }
        }
        try {
          measureRendition?.destroy?.();
        } catch {
          // ignore
        }
        try {
          measureBook?.destroy?.();
        } catch {
          // ignore
        }
        hiddenContainer.remove();
      }
    };

    const idleWindow = window as IdleCapableWindow;
    if (typeof idleWindow.requestIdleCallback === "function") {
      const handle = idleWindow.requestIdleCallback(() => {
        void measureDisplayedPagination();
      }, { timeout: 2000 });
      cancelScheduledMeasurement = () => idleWindow.cancelIdleCallback?.(handle);
    } else {
      const handle = window.setTimeout(() => {
        void measureDisplayedPagination();
      }, 600);
      cancelScheduledMeasurement = () => window.clearTimeout(handle);
    }

    return () => {
      cancelled = true;
      cancelScheduledMeasurement?.();
    };
  }, [
    applyReaderStylesToContents,
    containerSize.height,
    containerSize.width,
    displayPaginationSignature,
    fontSize,
    forceHorizontalWritingModeInDocument,
    isJapaneseBook,
    renditionReady,
    updateDisplayedPagination,
    waitForDocumentLayoutStable,
  ]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const { isVertical, pageProgression } = contentLayoutRef.current;

      if (isVertical) {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          goPrev();
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          goNext();
          return;
        }
      }

      if (pageProgression === 'rtl') {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          goNext();
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          goPrev();
        }
        return;
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      }
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
          setContainerSize((prev) =>
            prev.width === width && prev.height === height ? prev : { width, height },
          );
          
          // Save current location
          let currentCfi = currentCfiRef.current;
          try {
            if (!currentCfi) {
              const location = renditionRef.current.currentLocation();
              if (location && location.start) {
                currentCfi = normalizeRenderedCfi(location.start.cfi);
              }
            }
          } catch {}

          if (!currentCfi) {
            try {
              const location = renditionRef.current.currentLocation();
              if (location && location.start) {
                currentCfi = location.start.cfi;
              }
            } catch {}
          }

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
          } catch {
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
    const { width, height } = containerRef.current.getBoundingClientRect();
    setContainerSize({ width, height });

    return () => {
      resizeObserver.disconnect();
      if (resizeTimeout) clearTimeout(resizeTimeout);
    };
  }, [normalizeRenderedCfi, renditionReady]);

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
        {/* ── 朗读控制区 ── */}
        <div className="flex items-center gap-2 shrink-0">
          {isJapaneseBook && (
            <>
              <button
                onClick={() => setShowFurigana((prev) => !prev)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                  showFurigana
                    ? 'bg-sky-50 text-sky-700 border-sky-200/70'
                    : 'bg-white/80 text-gray-600 border-gray-200/60 hover:bg-gray-100/80'
                }`}
                title={showFurigana ? '关闭假名标注' : '显示假名标注'}
              >
                假名
              </button>
              <div className="w-px h-4 bg-gray-300/50"></div>
            </>
          )}

          {/* 音色选择：始终可见 */}
          <TTSQuickMenu
            voice={tts.voice}
            voices={tts.voices}
            onVoiceChange={(voice) => tts.setVoice(voice as any)}
            speed={tts.speed}
            speedOptions={TTS_SPEED_OPTIONS}
            onSpeedChange={tts.setSpeed}
          />

          {!tts.isPlaying && !tts.isPaused ? (
            <div className="flex items-center gap-1">
              <button
                onClick={tts.playCurrentPage}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-blue-50 hover:bg-blue-100 text-blue-600 transition-colors border border-blue-200/50"
                title="朗读当前页面"
              >
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
                朗读
              </button>
            </div>
          ) : (
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
              <span className="text-xs text-gray-400 pl-0.5 inline-flex min-w-[14em]">
                <span>{tts.isPaused ? '已暂停' : '正在朗读...'}</span>
                <span className="ml-1.5 text-gray-300">
                  <TTSLoadingDots active={tts.provider === 'qwen3' && tts.isGenerating} />
                </span>
              </span>
            </div>
          )}
        </div>

        <div className="w-px h-4 bg-gray-300/50"></div>

        {/* Progress Info */}
        <div className="flex items-center gap-2 text-gray-500 font-medium tabular-nums text-xs justify-center">
             <span>{displayPage ? `${displayPage}/${displayTotalPages ?? '--'}` : `--/${displayTotalPages ?? '--'}`}</span>
             <span className="text-gray-300">•</span>
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
