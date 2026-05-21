"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface VoiceOption {
  id: string;
  label: string;
}

interface SpeedOption {
  value: number;
  label: string;
}

interface TTSQuickMenuProps {
  voice: string;
  voices: readonly VoiceOption[];
  onVoiceChange: (voice: string) => void;
  speed: number;
  speedOptions: readonly SpeedOption[];
  onSpeedChange: (speed: number) => void;
}

function getCompactVoiceLabel(label: string): string {
  // label 格式: "Provider · Name（描述）"
  // 提取名字和 provider，重排为 "Name · Provider"
  const sep = " · ";
  const sepIdx = label.indexOf(sep);
  let provider = "";
  let name = label;

  if (sepIdx >= 0) {
    provider = label.slice(0, sepIdx).trim();
    name = label.slice(sepIdx + sep.length).trim();
  }

  // 去掉括号描述，如 "（美式女声）"
  name = name
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .trim();

  if (!name) return label;

  // provider 缩短：取关键部分
  const shortProvider = provider
    .replace(/^Edge\s+TTS$/, "Edge")
    .replace(/^自定义\s*API$/, "API")
    .replace(/^本地\s*Qwen3$/, "Qwen3");

  const result = shortProvider ? `${name} · ${shortProvider}` : name;
  return result.length > 14 ? `${result.slice(0, 14)}…` : result;
}

export default function TTSQuickMenu({
  voice,
  voices,
  onVoiceChange,
  speed,
  speedOptions,
  onSpeedChange,
}: TTSQuickMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const activeVoiceLabel = useMemo(() => {
    const matchedVoice = voices.find((option) => option.id === voice);
    return matchedVoice?.label ?? voice;
  }, [voice, voices]);

  const activeSpeedLabel = useMemo(() => {
    const matchedSpeed = speedOptions.find((option) => option.value === speed);
    return matchedSpeed?.label ?? `${speed}x`;
  }, [speed, speedOptions]);

  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1.5 max-w-[11rem] px-3 py-1.5 rounded-full text-xs font-medium bg-white/80 border border-gray-200/60 text-gray-600 hover:bg-gray-100/80 hover:text-gray-800 transition-colors"
        title={`语音：${activeVoiceLabel}，速度：${activeSpeedLabel}`}
      >
        <svg className="w-3.5 h-3.5 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5 6 9H3v6h3l5 4V5Zm5.54 2.46a5 5 0 0 1 0 7.08M14.12 9.88a2 2 0 0 1 0 2.83" />
        </svg>
        <span className="truncate">{getCompactVoiceLabel(activeVoiceLabel)}</span>
        <span className="text-gray-300">·</span>
        <span className="shrink-0 text-gray-500">{activeSpeedLabel}</span>
        <svg className={`w-3 h-3 shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m19 9-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 bottom-full mb-3 w-64 bg-white/95 backdrop-blur-xl border border-gray-100/60 rounded-2xl shadow-[0_10px_40px_rgba(0,0,0,0.15)] p-3 z-50">
          <div className="px-2 pb-2 text-[10px] font-bold text-gray-400 uppercase tracking-widest">朗读设置</div>

          <div className="px-2 pb-1 text-[11px] font-semibold text-gray-500">音色</div>
          <div className="max-h-52 overflow-y-auto space-y-1 pr-1">
            {voices.map((option) => {
              const active = option.id === voice;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    onVoiceChange(option.id);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-3 py-2 rounded-xl text-sm transition-colors ${
                    active
                      ? "bg-blue-50/80 text-blue-600"
                      : "text-gray-700 hover:bg-gray-100/80"
                  }`}
                  title={option.label}
                >
                  <span className="block truncate">{option.label}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-3 px-2 pb-1 text-[11px] font-semibold text-gray-500">速度</div>
          <div className="grid grid-cols-3 gap-1">
            {speedOptions.map((option) => {
              const active = option.value === speed;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onSpeedChange(option.value)}
                  className={`px-2.5 py-2 rounded-xl text-xs font-medium transition-colors ${
                    active
                      ? "bg-blue-50/80 text-blue-600"
                      : "bg-gray-50 text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
