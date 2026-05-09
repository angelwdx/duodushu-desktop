"use client";

import React from 'react';

interface ECDICTData {
  word: string;
  phonetic?: string;
  pos?: string;
  translation?: string;
  definition?: string;
  collins?: string;
  oxford?: string;
  tag?: string;
  bnc?: number;
  frq?: number;
  exchange?: string;
  [key: string]: any;
}

interface ECDICTDictionaryProps {
  word: string;
  rawData?: ECDICTData;
}

export default function ECDICTDictionary({ rawData }: ECDICTDictionaryProps) {
  if (!rawData) {
    return (
      <div className="p-4 text-gray-500 italic">
        未找到 ECDICT 详细数据
      </div>
    );
  }

  // 解析标签 (zk gk cet4等)
  const tags = rawData.tag ? rawData.tag.split(' ') : [];
  
  // 解析变形 (p:plural, d:past, i:ing, s:3rd person)
  const parseExchange = (exc?: string) => {
    if (!exc) return null;
    const parts = exc.split('/');
    const map: Record<string, string> = {
      'p': '复数',
      'd': '过去式',
      'i': '过去分词',
      'g': '现在分词',
      's': '第三人称单数',
      'r': '比较级',
      't': '最高级',
      'f': '原型',
      'n': '名词复数'
    };
    return parts.map(p => {
        const [k, v] = p.split(':');
        return { label: map[k] || k, value: v };
    });
  };

  const exchangeData = parseExchange(rawData.exchange);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
      {/* 头部：单词 & 音标 */}
      <div className="border-b pb-4">
        <h2 className="text-3xl font-serif font-bold text-gray-900">{rawData.word}</h2>
        {rawData.phonetic && (
          <div className="ipa-phonetic text-slate-500 font-medium tracking-wide text-lg mt-1">
            [{rawData.phonetic}]
          </div>
        )}
      </div>

      {/* 核心释义 */}
      <div className="space-y-4">
        {rawData.translation && (
            <div className="bg-blue-50/50 rounded-xl p-4 border border-blue-100 shadow-sm">
                <div className="text-xs font-bold text-blue-400 uppercase tracking-widest mb-2">中文简明释义</div>
                <div className="text-gray-800 text-lg leading-relaxed whitespace-pre-wrap">
                    {rawData.translation.replace(/\\n/g, '\n')}
                </div>
            </div>
        )}

        {rawData.definition && (
            <div>
                <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">英文详细定义 (ECDICT)</div>
                <div className="text-gray-700 text-sm leading-relaxed whitespace-pre-wrap pl-4 border-l-2 border-gray-100 italic font-serif">
                    {rawData.definition.replace(/\\n/g, '\n')}
                </div>
            </div>
        )}
      </div>

      {/* 词频 & 等级 标签 */}
      <div className="flex flex-wrap gap-2">
        {rawData.collins && (
             <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-[10px] font-bold rounded uppercase">
                Collins {rawData.collins}★
             </span>
        )}
        {rawData.oxford && (
             <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 text-[10px] font-bold rounded uppercase">
                Oxford 3000
             </span>
        )}
        {tags.map(t => (
            <span key={t} className="px-2 py-0.5 bg-gray-100 text-gray-600 text-[10px] font-bold rounded uppercase">
                {t}
            </span>
        ))}
      </div>

      {/* 语料库排名 */}
      {(rawData.bnc !== undefined || rawData.frq !== undefined) && (
          <div className="grid grid-cols-2 gap-4 pt-4 border-t border-gray-50 uppercase tracking-tighter text-[10px] font-bold text-gray-400">
             {rawData.bnc && <div>BNC Rank: <span className="text-gray-600">#{rawData.bnc}</span></div>}
             {rawData.frq && <div>FRQ Rank: <span className="text-gray-600">#{rawData.frq}</span></div>}
          </div>
      )}

      {/* 词形变化 */}
      {exchangeData && exchangeData.length > 0 && (
          <div className="pt-4 border-t border-gray-50">
             <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">词形变化 (Morphology)</div>
             <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                {exchangeData.map((ex, idx) => (
                    <div key={idx} className="flex gap-1.5">
                        <span className="text-gray-400">{ex.label}:</span>
                        <span className="text-blue-600 font-medium">{ex.value}</span>
                    </div>
                ))}
             </div>
          </div>
      )}
    </div>
  );
}
