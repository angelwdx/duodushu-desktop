'use client';

import React from 'react';
import { useNetworkStatus } from '../hooks/useNetworkStatus';

/**
 * 全局防遮挡的固定定位离线提示框
 * 在断网时自动在页面上方显示
 */
export default function OfflineNotifier() {
  const isOnline = useNetworkStatus();

  if (isOnline) {
    return null;
  }

  return (
    <div className="fixed top-0 left-0 right-0 z-[99999] flex justify-center pointer-events-none">
      <div className="mt-2 bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-2 flex items-center gap-2 rounded-full shadow-md animate-in slide-in-from-top-4 fade-in duration-300">
        <svg className="w-4 h-4 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3l-6.928-12c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77-1.333.192 3 1.732 3z" />
          {/* 这里可以加一条斜线代表断网，但标准警告图标也足够清晰 */}
          <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" opacity={0.6} />
        </svg>
        <span className="text-sm font-medium">网络连接已断开，应用进入离线模式。AI 等联网功能将不可用。</span>
      </div>
    </div>
  );
}
