"use client";

import { lazy, Suspense, memo } from "react";

// 动态导入词典组件，实现代码分割
const LongmanDictionary = lazy(() => import('./dictionary/LongmanDictionary'));
const OxfordDictionary = lazy(() => import('./dictionary/OxfordDictionary'));
const WebsterDictionary = lazy(() => import('./dictionary/WebsterDictionary'));
const ECDICTDictionary = lazy(() => import('./dictionary/ECDICTDictionary'));
const JMDICTDictionary = lazy(() => import('./dictionary/JMDICTDictionary'));

interface DictionaryContentProps {
  word: string;
  source: string;
  htmlContent: string;
  rawData?: any; // New prop for ECDICT full data
}

function DictionaryContent({
  word,
  source,
  htmlContent,
  rawData,
}: DictionaryContentProps) {

  const getDictionaryComponent = (src: string) => {
    const s = src.toLowerCase();
    if (s.includes('朗文') || s.includes('longman')) return LongmanDictionary;
    if (s.includes('牛津') || s.includes('oxford') || s.includes('oald')) return OxfordDictionary;
    if (s.includes('韦氏') || s.includes('webster') || s.includes('m-w')) return WebsterDictionary;
    if (s === 'ecdict') return ECDICTDictionary;
    if (s === 'jmdict') return JMDICTDictionary;
    return null;
  };

  let Component = getDictionaryComponent(source);
  if (!Component) {
    Component = source === 'ECDICT'
      ? ECDICTDictionary
      : source === 'JMdict'
        ? JMDICTDictionary
        : LongmanDictionary;
  }
  const DictionaryComponent = Component as any;

  return (
    <Suspense fallback={<DictionaryLoading />}>
      <DictionaryComponent
        word={word}
        htmlContent={htmlContent || ""}
        rawData={rawData}
      />
    </Suspense>
  );
}

function DictionaryLoading() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
    </div>
  );
}

export default memo(DictionaryContent);
