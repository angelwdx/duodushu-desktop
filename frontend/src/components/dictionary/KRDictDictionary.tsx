"use client";

import { memo, useMemo } from "react";

interface KRDictDictionaryProps {
  word: string;
  htmlContent: string;
}

function KRDictDictionary({ word, htmlContent }: KRDictDictionaryProps) {
  const normalizedHtml = useMemo(
    () =>
      htmlContent
        .replace(/<link[^>]*\/?>/gi, "")
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<script[^>]*\/?>/gi, ""),
    [htmlContent],
  );

  return (
    <div
      className="dictionary-scope-krdict dictionary-container"
      data-dict="krdict"
      data-word={word}
    >
      <div dangerouslySetInnerHTML={{ __html: normalizedHtml }} />
    </div>
  );
}

export default memo(KRDictDictionary);
