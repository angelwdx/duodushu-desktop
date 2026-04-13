"use client";

import { useEffect, useState, useCallback, useRef } from "react";

const LOOKUP_WORD_CHAR_RE = /[A-Za-zÀ-ÿ'’]/;

function getTextNodesInRoot(root: Node): Text[] {
  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) {
      nodes.push(current as Text);
    }
    current = walker.nextNode();
  }
  return nodes;
}

function collectWordPrefix(text: string): string {
  let index = text.length;
  while (index > 0 && LOOKUP_WORD_CHAR_RE.test(text[index - 1])) {
    index -= 1;
  }
  return text.slice(index);
}

function collectWordSuffix(text: string): string {
  let index = 0;
  while (index < text.length && LOOKUP_WORD_CHAR_RE.test(text[index])) {
    index += 1;
  }
  return text.slice(0, index);
}

interface SelectionState {
  text: string;
  x: number;
  y: number;
  source?: string;
  rect?: DOMRect;
  range?: Range; // 保存原始 Range 用于恢复选区
}

interface SelectionToolbarProps {
  selection: SelectionState | null;
  onNote?: (text: string, source?: string) => void;
  onAskAI?: (text: string, source?: string) => void;
  onLookup?: (text: string) => void;
  onCopy?: (text: string) => void;
  onClear?: () => void;
  hidden?: boolean;
}

export default function SelectionToolbar({
  selection,
  onNote,
  onAskAI,
  onLookup,
  onCopy,
  onClear,
  hidden = false,
}: SelectionToolbarProps) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const clonedRangeRef = useRef<Range | null>(null);

  // 克隆 Range（原始 Range 可能会失效）
  // 注意：Range 已经在 useGlobalTextSelection 中被克隆，这里再次克隆以确保安全
  useEffect(() => {
    if (selection?.range) {
      try {
        clonedRangeRef.current = selection.range.cloneRange();
      } catch (e) {
        clonedRangeRef.current = null;
      }
    } else {
      clonedRangeRef.current = null;
    }
  }, [selection?.range]);

  // 恢复选区高亮
  const restoreSelection = useCallback(() => {
    const rangeToRestore = clonedRangeRef.current || selection?.range;
    if (rangeToRestore) {
      try {
        const sel = window.getSelection();
        if (sel) {
          // 检查当前选区是否已经是我们期望的选区
          if (sel.rangeCount > 0) {
            const currentRange = sel.getRangeAt(0);
            // 如果选区文本相同，不需要重新设置
            try {
              if (currentRange.toString() === rangeToRestore.toString()) {
                return;
              }
            } catch (e) {
              // Range 可能已失效
            }
          }
          sel.removeAllRanges();
          sel.addRange(rangeToRestore.cloneRange()); // 使用克隆避免修改原始 Range
        }
      } catch (e) {
        // Range 可能已失效，忽略错误
        console.warn('[SelectionToolbar] Failed to restore selection:', e);
      }
    }
  }, [selection?.range]);

  // 工具栏出现时立即尝试恢复选区
  useEffect(() => {
    if (selection && !hidden) {
      // 使用 requestAnimationFrame 确保在 DOM 更新后执行
      const frameId = requestAnimationFrame(() => {
        restoreSelection();
      });
      return () => cancelAnimationFrame(frameId);
    }
  }, [selection, hidden, restoreSelection]);

  // 计算工具栏位置，避免超出视口
  const calculatePosition = useCallback(() => {
    if (!selection || hidden) {
      setPosition(null);
      return;
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const toolbarWidth = 220; // 估算宽度
    const toolbarHeight = 50; // 估算高度

    let x = selection.x;
    let y = selection.y - 10; // 默认在选择内容上方

    // 确保不超出视口
    if (x + toolbarWidth / 2 > viewportWidth) {
      x = viewportWidth - toolbarWidth / 2 - 20;
    }
    if (x - toolbarWidth / 2 < 0) {
      x = toolbarWidth / 2 + 20;
    }
    if (y < 20) {
      y = selection.rect?.bottom ? selection.rect.bottom + 10 : selection.y + 30;
    }
    if (y + toolbarHeight > viewportHeight) {
      y = viewportHeight - toolbarHeight - 20;
    }

    setPosition({ x, y });
  }, [selection, hidden]);

  useEffect(() => {
    calculatePosition();
  }, [calculatePosition]);

  const getLookupText = useCallback(() => {
    const rawText = selection?.text?.trim() || "";
    if (!rawText || /\s/.test(rawText) || !selection?.range) {
      return rawText;
    }

    const { startContainer, endContainer, startOffset, endOffset } = selection.range;
    if (startContainer.nodeType !== Node.TEXT_NODE || endContainer.nodeType !== Node.TEXT_NODE) {
      return rawText;
    }

    const root =
      (startContainer.parentElement?.closest(".react-pdf__Page__textContent") as Node | null) ||
      startContainer.parentElement ||
      startContainer;
    const textNodes = getTextNodesInRoot(root);
    const startNodeIndex = textNodes.findIndex((node) => node === startContainer);
    const endNodeIndex = textNodes.findIndex((node) => node === endContainer);
    if (startNodeIndex === -1 || endNodeIndex === -1 || startNodeIndex > endNodeIndex) {
      return rawText;
    }

    let prefix = collectWordPrefix((startContainer.textContent || "").slice(0, startOffset));
    let suffix = collectWordSuffix((endContainer.textContent || "").slice(endOffset));

    for (let i = startNodeIndex - 1; i >= 0; i -= 1) {
      const fragment = textNodes[i].textContent || "";
      if (!fragment) break;
      const collected = collectWordPrefix(fragment);
      if (!collected) break;
      prefix = collected + prefix;
      if (collected.length !== fragment.length) break;
    }

    for (let i = endNodeIndex + 1; i < textNodes.length; i += 1) {
      const fragment = textNodes[i].textContent || "";
      if (!fragment) break;
      const collected = collectWordSuffix(fragment);
      if (!collected) break;
      suffix += collected;
      if (collected.length !== fragment.length) break;
    }

    const expandedText = `${prefix}${rawText}${suffix}`.trim();
    if (!expandedText || /\s/.test(expandedText)) {
      return rawText;
    }

    return expandedText;
  }, [selection]);

  // 处理操作
  const handleNote = () => {
    if (!selection) return;
    onNote?.(selection.text, selection.source);
    onClear?.();
  };

  const handleAskAI = () => {
    if (!selection) return;
    onAskAI?.(selection.text, selection.source);
    onClear?.();
  };

  const handleLookup = () => {
    if (!selection) return;
    onLookup?.(getLookupText());
    onClear?.();
  };

  const handleCopy = async () => {
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(selection.text);
      onCopy?.(selection.text);
    } catch (e) {
      console.error("Failed to copy:", e);
    }
    onClear?.();
  };

  if (!selection || !position || hidden) return null;

  return (
    <div
      data-selection-toolbar="true"
      className="fixed z-[9999] bg-gray-900 text-white rounded-lg shadow-2xl flex items-center gap-1 p-1 transform transition-all duration-200 animate-in fade-in zoom-in-95 select-none"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transform: 'translateX(-50%)',
      }}
      onMouseEnter={restoreSelection}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* 记笔记按钮 */}
      {onNote && (
        <div className="relative group">
          <button
            onClick={handleNote}
            className="flex items-center justify-center w-10 h-10 hover:bg-gray-700 rounded-md transition-colors touch-icon-btn"
            aria-label="记笔记"
            title="记笔记"
          >
            <svg className="w-4 h-4 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>
        </div>
      )}

      {/* 分隔线 */}
      {(onNote && (onAskAI || onLookup || onCopy)) && (
        <div className="w-px h-4 bg-gray-700 mx-0.5"></div>
      )}

      {/* 问老师按钮 */}
      {onAskAI && (
        <div className="relative group">
          <button
            onClick={handleAskAI}
            className="flex items-center justify-center w-10 h-10 hover:bg-gray-700 rounded-md transition-colors touch-icon-btn"
            aria-label="询问 AI 老师"
            title="询问 AI"
          >
            <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </button>
        </div>
      )}

      {/* 分隔线 */}
      {(onAskAI && onLookup) && (
        <div className="w-px h-4 bg-gray-700 mx-0.5"></div>
      )}

      {/* 查词典按钮 */}
      {onLookup && (
        <div className="relative group">
          <button
            onClick={handleLookup}
            className="flex items-center justify-center w-10 h-10 hover:bg-gray-700 rounded-md transition-colors touch-icon-btn"
            aria-label="查词典"
            title="查词典"
          >
            <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18c1.747 0 3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332-.477-4.5-1.253M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13" />
            </svg>
          </button>
        </div>
      )}

      {/* 分隔线 */}
      {(onLookup && onCopy) && (
        <div className="w-px h-4 bg-gray-700 mx-0.5"></div>
      )}

      {/* 复制按钮 */}
      {onCopy && (
        <div className="relative group">
          <button
            onClick={handleCopy}
            className="flex items-center justify-center w-10 h-10 hover:bg-gray-700 rounded-md transition-colors touch-icon-btn"
            aria-label="复制到剪贴板"
            title="复制"
          >
            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
        </div>
      )}



      {/* 箭头 */}
      <div
        className="absolute bottom-0 left-1/2 transform -translate-x-1/2 translate-y-full w-0 h-0 border-l-[6px] border-r-[6px] border-t-[6px] border-l-transparent border-r-transparent border-t-gray-900"
        style={{ display: position?.y < 50 ? 'none' : 'block' }}
      ></div>
    </div>
  );
}
