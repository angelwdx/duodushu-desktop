"use client";

import { memo, useMemo } from "react";

interface RHSJCDDictionaryProps {
  word: string;
  htmlContent: string;
}

function RHSJCDDictionary({ word, htmlContent }: RHSJCDDictionaryProps) {
  const normalizedHtml = useMemo(
    () => htmlContent.replace(/<link[^>]*rhsjcd\.css[^>]*\/?>/gi, ""),
    [htmlContent],
  );

  return (
    <div
      className="dictionary-scope-rhsjcd dictionary-container"
      data-dict="rhsjcd"
      data-word={word}
    >
      <div dangerouslySetInnerHTML={{ __html: normalizedHtml }} />
    </div>
  );
}

export default memo(RHSJCDDictionary);
