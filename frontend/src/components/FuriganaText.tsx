"use client";

import type { ReactElement } from "react";
import type { FuriganaAnnotation } from "../lib/api";

interface FuriganaTextProps {
  annotation: FuriganaAnnotation;
  baseOffset?: number;
  highlightRange?: { start: number; end: number };
}

function overlaps(
  range: { start: number; end: number } | undefined,
  start: number,
  end: number,
): boolean {
  if (!range) return false;
  if (range.start < 0 || range.end < 0) return false;
  return start < range.end && end > range.start;
}

export default function FuriganaText({
  annotation,
  baseOffset = 0,
  highlightRange,
}: FuriganaTextProps) {
  const rubyBaseClassName =
    "align-top [ruby-position:over] [ruby-align:center] [ruby-overhang:auto]";
  const rubyReadingClassName =
    "select-none whitespace-nowrap text-[0.55em] leading-none text-sky-700";

  return (
    <>
      {annotation.segments.reduce<ReactElement[]>((nodes, segment, index) => {
        const consumedLength = annotation.segments
          .slice(0, index)
          .reduce((total, current) => total + (current.type === "text" ? current.text.length : current.base.length), 0);
        const start = baseOffset + consumedLength;

        if (segment.type === "text") {
          const end = start + segment.text.length;
          const isHighlighted = overlaps(highlightRange, start, end);

          nodes.push(
            <span
              key={`text-${index}-${start}`}
              data-char-start={start}
              data-char-end={end}
              data-tts-hl={isHighlighted ? "true" : undefined}
              className={isHighlighted ? "bg-yellow-100 rounded-sm" : undefined}
            >
              {segment.text}
            </span>,
          );
          return nodes;
        }

        const end = start + segment.base.length;
        const isHighlighted = overlaps(highlightRange, start, end);

        nodes.push(
          <ruby
            key={`ruby-${index}-${start}`}
            data-char-start={start}
            data-char-end={end}
            data-tts-hl={isHighlighted ? "true" : undefined}
            className={`${rubyBaseClassName} ${isHighlighted ? "bg-yellow-100 rounded-sm" : "rounded-sm"}`}
          >
            {segment.base}
            <rt className={rubyReadingClassName}>
              {segment.reading}
            </rt>
          </ruby>,
        );
        return nodes;
      }, [])}
    </>
  );
}
