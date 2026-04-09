"use client";

import React from "react";
import { getLookupWordFromText, splitTextForWordLookup } from "../lib/wordLookup";

interface ClickableTextProps {
  text: string;
  onWordClick: (word: string, context?: string) => void;
  className?: string;
}

/**
 * 可点击文本组件 - 将文本拆分成可点击的单词
 * 点击单词时会触发 onWordClick 回调，支持查词典等功能
 */
export default function ClickableText({
  text,
  onWordClick,
  className = "",
}: ClickableTextProps) {
  // 将文本拆分成单词和非单词部分
  const parts = splitTextForWordLookup(text);

  return (
    <span className={className}>
      {parts.map((part, index) => {
        const cleanWord = getLookupWordFromText(part);

        // 如果是空白或非可查词片段，直接渲染
        if (!cleanWord || part.trim() === "") {
          return <span key={index}>{part}</span>;
        }

        return (
          <span
            key={index}
            onClick={(e) => {
              e.stopPropagation();
              onWordClick(cleanWord, text);
            }}
            className="cursor-pointer hover:bg-yellow-100 hover:text-yellow-900 transition-colors duration-150"
            title={`查词：${cleanWord}`}
          >
            {part}
          </span>
        );
      })}
    </span>
  );
}
