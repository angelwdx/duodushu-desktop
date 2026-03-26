"use client";

import React, { useState, useEffect, useCallback } from 'react';

type UpdaterEventType = 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';

interface UpdaterEvent {
  type: UpdaterEventType;
  version?: string;
  percent?: number;
  message?: string;
}

/**
 * 自动更新通知组件
 * 监听 Electron autoUpdater 事件，在右下角显示更新通知 Toast
 */
export default function UpdateNotifier() {
  const [event, setEvent] = useState<UpdaterEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.onUpdaterEvent) return;

    const handleEvent = (ev: UpdaterEvent) => {
      setDismissed(false);
      setEvent(ev);
      // "正在检查" 和 "无新版本" 状态 3 秒后自动消失
      if (ev.type === 'checking' || ev.type === 'not-available') {
        setTimeout(() => setDismissed(true), 3000);
      }
    };

    api.onUpdaterEvent(handleEvent);
    // 监听菜单触发手动更新（前端通过 check-update action 触发）
    api.onMenuAction?.((action: string) => {
      if (action === 'check-update') {
        api.checkForUpdates?.().catch(console.error);
      }
    });

    return () => {
      api.removeUpdaterListener?.();
    };
  }, []);

  const handleInstall = useCallback(() => {
    const api = (window as any).electronAPI;
    api?.installUpdate?.();
  }, []);

  if (!event || dismissed) return null;

  const config: Record<UpdaterEventType, { icon: string; bg: string; border: string; text: string; label: string }> = {
    checking: {
      icon: '🔍',
      bg: 'bg-gray-900/95',
      border: 'border-gray-700',
      text: 'text-gray-200',
      label: '正在检查更新...',
    },
    available: {
      icon: '🚀',
      bg: 'bg-blue-900/95',
      border: 'border-blue-600',
      text: 'text-blue-100',
      label: `发现新版本 ${event.version ?? ''}，正在下载...`,
    },
    'not-available': {
      icon: '✅',
      bg: 'bg-gray-900/95',
      border: 'border-gray-700',
      text: 'text-gray-200',
      label: '当前已是最新版本',
    },
    downloading: {
      icon: '⬇️',
      bg: 'bg-blue-900/95',
      border: 'border-blue-600',
      text: 'text-blue-100',
      label: `下载中 ${event.percent ?? 0}%`,
    },
    downloaded: {
      icon: '✨',
      bg: 'bg-green-900/95',
      border: 'border-green-600',
      text: 'text-green-100',
      label: `新版本 ${event.version ?? ''} 已就绪，重启后安装`,
    },
    error: {
      icon: '⚠️',
      bg: 'bg-red-900/95',
      border: 'border-red-700',
      text: 'text-red-200',
      label: `更新出错：${event.message ?? '未知错误'}`,
    },
  };

  const c = config[event.type];

  return (
    <div
      className={`fixed bottom-5 right-5 z-[9999] flex items-center gap-3 px-4 py-3 rounded-xl border shadow-2xl backdrop-blur-sm transition-all duration-300 animate-in slide-in-from-bottom-4 ${c.bg} ${c.border}`}
      style={{ minWidth: 260, maxWidth: 380 }}
    >
      <span className="text-lg select-none">{c.icon}</span>
      <span className={`flex-1 text-sm font-medium ${c.text}`}>{c.label}</span>

      {/* 下载进度条 */}
      {event.type === 'downloading' && (
        <div className="absolute bottom-0 left-0 h-0.5 bg-blue-400 rounded-b-xl transition-all duration-300"
          style={{ width: `${event.percent ?? 0}%` }} />
      )}

      {/* 已下载：显示立即安装按钮 */}
      {event.type === 'downloaded' && (
        <button
          onClick={handleInstall}
          className="shrink-0 px-3 py-1 text-xs font-bold bg-green-500 hover:bg-green-400 text-white rounded-lg transition-colors"
        >
          立即重启
        </button>
      )}

      {/* 关闭按钮（非下载中） */}
      {event.type !== 'downloading' && (
        <button
          onClick={() => setDismissed(true)}
          className={`shrink-0 opacity-60 hover:opacity-100 transition-opacity ${c.text}`}
          aria-label="关闭"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
