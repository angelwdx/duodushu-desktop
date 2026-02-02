'use client';

import { useEffect } from 'react';

// 定义 electronAPI 类型
declare global {
  interface Window {
    electronAPI?: {
      getBackendUrl: () => Promise<string>;
      sendMessage: (message: string) => void;
      openExternal: (url: string) => void;
      onNavigate: (callback: (path: string) => void) => void;
      onMenuAction: (callback: (action: string) => void) => void;
      removeNavigateListener: () => void;
      removeMenuActionListener: () => void;
    };
  }
}

interface MenuHandlerProps {
  onImportBook?: () => void;
  onExportNotes?: () => void;
  onShowAbout?: () => void;
  onCheckUpdate?: () => void;
}

/**
 * 菜单事件处理组件
 * 监听 Electron 菜单操作并执行相应的动作
 * 注意：导航事件由 GlobalMenuHandler 在根布局中处理
 */
export default function MenuHandler({
  onImportBook,
  onExportNotes,
  onShowAbout,
  onCheckUpdate,
}: MenuHandlerProps) {
  useEffect(() => {
    // 检查是否在 Electron 环境中
    if (typeof window === 'undefined' || !window.electronAPI) {
      return;
    }

    // 监听来自 GlobalMenuHandler 广播的自定义事件
    // 不再直接监听 window.electronAPI.onMenuAction，避免 removeListener 冲突
    const handleMenuAction = (event: Event) => {
      const customEvent = event as CustomEvent<string>;
      const action = customEvent.detail;
      
      console.log('[MenuHandler] Received DOM menu action:', action);
      
      switch (action) {
        case 'import-book':
          onImportBook?.();
          break;
        case 'export-notes':
          onExportNotes?.();
          break;
        case 'show-about':
          onShowAbout?.();
          break;
        case 'check-update':
          onCheckUpdate?.();
          break;
        // open-settings 由 GlobalMenuHandler 直接处理，这里无需 break; // Ignore
        default:
          // Ignore other actions
          break;
      }
    };

    window.addEventListener('app-menu-action', handleMenuAction);

    // 清理监听器
    return () => {
      window.removeEventListener('app-menu-action', handleMenuAction);
    };
  }, [onImportBook, onExportNotes, onShowAbout, onCheckUpdate]);

  // 这是一个纯逻辑组件，不渲染任何内容
  return null;
}
