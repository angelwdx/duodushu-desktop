"use client";

import React, { useState, useEffect, useRef } from 'react';
import {
  clearTTSCache,
  getTTSConfig,
  getTTSCacheInfo,
  getTTSVoices,
  saveTTSConfig,
  testTTSConfig,
  TTSCacheInfo,
  TTSConfig,
  TTSVoiceOption,
} from '../lib/api';

// ─── Edge TTS 内置音色 ────────────────────────────────────────────────────
const EDGE_VOICES = [
  { id: 'default', label: 'Aria（女声 · 默认）' },
  { id: 'male',    label: 'Christopher（男声）' },
  { id: 'female',  label: 'Jenny（女声）' },
];

const TTS_SPEED_OPTIONS = [
  { value: '1', label: '1.0x' },
  { value: '1.1', label: '1.1x' },
  { value: '1.2', label: '1.2x' },
  { value: '1.3', label: '1.3x' },
  { value: '1.4', label: '1.4x' },
  { value: '1.5', label: '1.5x' },
];

// ─── 主组件 ───────────────────────────────────────────────────────────────

export default function TTSConfigPanel() {
  const [config, setConfig]         = useState<TTSConfig | null>(null);
  const [saving, setSaving]         = useState(false);
  const [testing, setTesting]       = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheInfo, setCacheInfo]   = useState<TTSCacheInfo | null>(null);
  const [qwen3Voices, setQwen3Voices] = useState<TTSVoiceOption[]>([]);
  const [message, setMessage]       = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const audioRef                    = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef                  = useRef<string | null>(null);

  useEffect(() => {
    getTTSConfig().then(setConfig);
    getTTSCacheInfo().then(setCacheInfo);
    getTTSVoices().then(setQwen3Voices);
  }, []);

  const updateConfig = (patch: Partial<TTSConfig>) =>
    setConfig(prev => prev ? { ...prev, ...patch } : null);

  const updateEdge = (patch: Partial<TTSConfig['edge']>) =>
    setConfig(prev => prev ? { ...prev, edge: { ...prev.edge, ...patch } } : null);

  const updateApi = (patch: Partial<TTSConfig['openai_api']>) =>
    setConfig(prev => prev ? { ...prev, openai_api: { ...prev.openai_api, ...patch } } : null);

  const updateQwen3 = (patch: Partial<TTSConfig['qwen3']>) =>
    setConfig(prev => prev ? { ...prev, qwen3: { ...prev.qwen3, ...patch } } : null);

  const resetToDefaults = () => {
    setConfig({
      provider: 'edge',
      edge: { voice: 'default', speed: 1 },
      openai_api: { base_url: 'https://api.openai.com/v1', api_key: '', model: 'tts-1', voice: 'alloy', speed: 1 },
      qwen3: { base_url: 'http://127.0.0.1:18790/v1', model: 'tts-1', voice: '塔塔', speed: 1 },
    });
    setMessage({ type: 'success', text: '已恢复默认 TTS 配置，记得点击保存配置' });
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setMessage(null);
    try {
      await saveTTSConfig(config);
      setMessage({ type: 'success', text: '配置已保存' });
    } catch {
      setMessage({ type: 'error', text: '保存失败，请重试' });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!config || testing) return;
    setTesting(true);
    setMessage(null);

    // 停止上一段测试音频
    audioRef.current?.pause();
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);

    try {
      const blobUrl = await testTTSConfig(config);
      blobUrlRef.current = blobUrl;
      const audio = new Audio(blobUrl);
      audioRef.current = audio;
      audio.onended  = () => setTesting(false);
      audio.onerror  = () => { setTesting(false); setMessage({ type: 'error', text: '音频播放失败' }); };
      await audio.play();
    } catch (e: any) {
      setMessage({ type: 'error', text: `测试失败：${e?.message ?? '请检查配置'}` });
      setTesting(false);
    }
  };

  const handleClearCache = async () => {
    if (clearingCache) return;
    setClearingCache(true);
    setMessage(null);
    try {
      const result = await clearTTSCache();
      const nextInfo = await getTTSCacheInfo();
      setCacheInfo(nextInfo);
      setMessage({ type: 'success', text: `已清理 ${result.deleted} 个缓存文件` });
    } catch {
      setMessage({ type: 'error', text: '清理缓存失败，请重试' });
    } finally {
      setClearingCache(false);
    }
  };

  if (!config) {
    return (
      <div className="flex items-center justify-center py-8 text-gray-400 text-sm">
        <svg className="animate-spin w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
        </svg>
        加载配置...
      </div>
    );
  }

  return (
    <div className="space-y-5">

      {/* ── Provider 选择 ── */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">语音合成方式</p>
        <div className="space-y-2">
          {PROVIDER_OPTIONS.map(opt => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                config.provider === opt.value
                  ? 'border-blue-400 bg-blue-50/60'
                  : 'border-gray-200 hover:border-gray-300 bg-white/50'
              }`}
            >
              <input
                type="radio"
                name="tts-provider"
                value={opt.value}
                checked={config.provider === opt.value}
                onChange={() => updateConfig({ provider: opt.value as any })}
                className="mt-0.5 accent-blue-500"
              />
              <div>
                <div className="text-sm font-medium text-gray-800">{opt.label}</div>
                <div className="text-xs text-gray-500 mt-0.5">{opt.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* ── Provider 特定配置 ── */}
      {config.provider === 'edge' && (
        <Section title="Edge TTS 音色">
          <SelectField
            label="音色"
            value={config.edge.voice}
            onChange={v => updateEdge({ voice: v })}
            options={EDGE_VOICES.map(v => ({ value: v.id, label: v.label }))}
          />
          <SelectField
            label="默认速度"
            value={String(config.edge.speed)}
            onChange={v => updateEdge({ speed: Number(v) })}
            options={TTS_SPEED_OPTIONS}
          />
        </Section>
      )}

      {config.provider === 'openai_api' && (
        <Section title="OpenAI 兼容 API 配置">
          <InputField label="Base URL" value={config.openai_api.base_url}
            placeholder="https://api.openai.com/v1"
            onChange={v => updateApi({ base_url: v })} />
          <InputField label="API Key" value={config.openai_api.api_key}
            type="password" placeholder="sk-..."
            onChange={v => updateApi({ api_key: v })} />
          <InputField label="模型" value={config.openai_api.model}
            placeholder="tts-1"
            onChange={v => updateApi({ model: v })} />
          <InputField label="音色 (Voice)" value={config.openai_api.voice}
            placeholder="alloy / echo / fable / onyx / nova / shimmer"
            onChange={v => updateApi({ voice: v })} />
          <SelectField
            label="默认速度"
            value={String(config.openai_api.speed)}
            onChange={v => updateApi({ speed: Number(v) })}
            options={TTS_SPEED_OPTIONS}
          />
          <HintBox>
            支持 OpenAI、Fish Audio、硅基流动等兼容服务。<br />
            以 OpenAI 为例：Base URL 填 <code>https://api.openai.com/v1</code>，模型填 <code>tts-1</code>。
          </HintBox>
        </Section>
      )}

      {config.provider === 'qwen3' && (
        <Section title="本地 Qwen3 TTS 配置">
          <InputField label="服务地址" value={config.qwen3.base_url}
            placeholder="http://127.0.0.1:18790/v1"
            onChange={v => updateQwen3({ base_url: v })} />
          <InputField label="模型名" value={config.qwen3.model}
            placeholder="tts-1"
            onChange={v => updateQwen3({ model: v })} />
          {qwen3Voices.length > 0 ? (
            <SelectField
              label="音色"
              value={config.qwen3.voice}
              onChange={v => updateQwen3({ voice: v })}
              options={qwen3Voices.map(v => ({ value: v.voice, label: v.name || v.voice }))}
            />
          ) : (
            <InputField label="音色 (Voice)" value={config.qwen3.voice}
              placeholder="塔塔"
              onChange={v => updateQwen3({ voice: v })} />
          )}
          <SelectField
            label="默认速度"
            value={String(config.qwen3.speed)}
            onChange={v => updateQwen3({ speed: Number(v) })}
            options={TTS_SPEED_OPTIONS}
          />
          <HintBox>
            建议使用稳定版本地 Qwen3 TTS 服务。默认地址 <code>http://127.0.0.1:18790/v1</code>，模型 <code>tts-1</code>，音色 <code>塔塔</code>。
          </HintBox>
        </Section>
      )}

      <Section title="TTS 缓存">
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-gray-600">
            {cacheInfo ? (
              <span>
                当前缓存 {cacheInfo.file_count} 条，约 {cacheInfo.total_mb} MB
                {' '} / 上限 {cacheInfo.max_files} 条，{cacheInfo.max_mb} MB
              </span>
            ) : (
              <span>缓存信息读取失败</span>
            )}
          </div>
          <button
            onClick={handleClearCache}
            disabled={clearingCache}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors disabled:opacity-50 shrink-0"
          >
            {clearingCache ? '清理中…' : '清理缓存'}
          </button>
        </div>
        <HintBox>
          Qwen3 和其他 TTS 的朗读音频会缓存在本地，重复朗读同一段时可直接命中。缓存会自动按大小和条目数清理。
        </HintBox>
      </Section>

      {/* ── 操作按钮 ── */}
      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={handleTest}
          disabled={testing}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors disabled:opacity-50"
        >
          {testing ? (
            <>
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
              </svg>
              播放中…
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M3 18v-6a9 9 0 0118 0v6"/>
                <path d="M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z"/>
              </svg>
              测试发音
            </>
          )}
        </button>

        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存配置'}
        </button>

        <button
          onClick={resetToDefaults}
          disabled={saving || testing || clearingCache}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 transition-colors disabled:opacity-50"
        >
          恢复默认
        </button>

        {message && (
          <span className={`text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-500'}`}>
            {message.type === 'success' ? '✓ ' : '✗ '}{message.text}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── 常量 ─────────────────────────────────────────────────────────────────

const PROVIDER_OPTIONS = [
  {
    value: 'edge',
    label: 'Edge TTS（免费）',
    desc: '微软 Edge 神经网络语音，无需 API Key，开箱即用',
  },
  {
    value: 'openai_api',
    label: '自定义 API（OpenAI 兼容）',
    desc: '接入 OpenAI TTS、Fish Audio、硅基流动等兼容服务',
  },
  {
    value: 'qwen3',
    label: '本地 Qwen3 TTS',
    desc: '连接本地部署的 Qwen3 语音合成服务',
  },
];

// ─── 子组件 ───────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 p-4 space-y-3 bg-gray-50/50">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{title}</p>
      {children}
    </div>
  );
}

function InputField({
  label, value, onChange, placeholder, type = 'text',
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-gray-600 font-medium">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-1.5 text-sm rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-300 transition"
      />
    </div>
  );
}

function SelectField({
  label, value, onChange, options,
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-gray-600 font-medium">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-1.5 text-sm rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-300 transition cursor-pointer"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function HintBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs text-gray-500 bg-blue-50/60 border border-blue-100 rounded-lg px-3 py-2">
      <svg className="w-3.5 h-3.5 text-blue-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
      <span>{children}</span>
    </div>
  );
}
