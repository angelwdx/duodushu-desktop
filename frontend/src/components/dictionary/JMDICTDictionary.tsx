interface JMdictSense {
  part_of_speech?: string;
  glosses?: string[];
  misc?: string[];
  info?: string[];
}

interface JMdictEntry {
  word: string;
  reading?: string;
  summary?: string;
  kanji_forms?: string[];
  reading_forms?: string[];
  senses?: JMdictSense[];
}

interface JMdictData {
  entries?: JMdictEntry[];
}

interface JMdictDictionaryProps {
  rawData?: JMdictData;
}

export default function JMDICTDictionary({ rawData }: JMdictDictionaryProps) {
  const entries = rawData?.entries || [];

  if (!entries.length) {
    return (
      <div className="p-4 rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-500">
        未找到 JMdict 详细数据
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {entries.map((entry, index) => {
        const extraKanjiForms = (entry.kanji_forms || []).filter((form) => form !== entry.word);
        const extraReadingForms = (entry.reading_forms || []).filter((form) => form !== entry.reading);

        return (
          <section
            key={`${entry.word}-${entry.reading || "no-reading"}-${index}`}
            className="rounded-xl border border-gray-200 bg-white p-4 shadow-xs"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="text-lg font-semibold text-gray-900">{entry.word}</h3>
              {entry.reading && entry.reading !== entry.word ? (
                <span className="text-sm text-gray-500">{entry.reading}</span>
              ) : null}
              {entry.summary ? (
                <span className="text-sm text-gray-400">· {entry.summary}</span>
              ) : null}
            </div>

            {extraKanjiForms.length > 0 ? (
              <div className="mt-2 text-xs text-gray-500">
                表记：{extraKanjiForms.join("、")}
              </div>
            ) : null}

            {extraReadingForms.length > 0 ? (
              <div className="mt-1 text-xs text-gray-500">
                读音：{extraReadingForms.join("、")}
              </div>
            ) : null}

            <div className="mt-4 space-y-3">
              {(entry.senses || []).map((sense, senseIndex) => (
                <div key={`${entry.word}-sense-${senseIndex}`} className="rounded-lg bg-gray-50 px-3 py-2.5">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                    {sense.part_of_speech || "Japanese"}
                  </div>
                  <ul className="mt-2 space-y-1.5 text-sm text-gray-800">
                    {(sense.glosses || []).map((gloss, glossIndex) => (
                      <li key={`${entry.word}-sense-${senseIndex}-gloss-${glossIndex}`} className="leading-relaxed">
                        {gloss}
                      </li>
                    ))}
                  </ul>
                  {sense.misc && sense.misc.length > 0 ? (
                    <div className="mt-2 text-xs text-gray-500">
                      标签：{sense.misc.join("、")}
                    </div>
                  ) : null}
                  {sense.info && sense.info.length > 0 ? (
                    <div className="mt-1 text-xs text-gray-500">
                      备注：{sense.info.join("；")}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        );
      })}

    </div>
  );
}
