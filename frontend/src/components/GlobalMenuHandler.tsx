'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSettings } from '../contexts/SettingsContext';
import { useGlobalDialogs } from '../contexts/GlobalDialogsContext';

// 定义 electronAPI 类型（与 MenuHandler 共享）
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

/**
 * 全局菜单导航处理组件
 * 在根布局中挂载，确保在所有页面中持续监听导航事件
 */
export default function GlobalMenuHandler() {
  const router = useRouter();
  const { openSettings } = useSettings();
  const { openUpload } = useGlobalDialogs();

  useEffect(() => {
    // 检查是否在 Electron 环境中
    if (typeof window === 'undefined' || !window.electronAPI) {
      return;
    }

    // 监听导航事件
    window.electronAPI.onNavigate((path: string) => {
      console.log('[GlobalMenuHandler] Navigate to:', path);
      router.push(path);
    });

    return () => {
        if (window.electronAPI) {
            window.electronAPI.removeNavigateListener();
        }
    };
  }, [router]);

  useEffect(() => {
    // 检查是否在 Electron 环境中
    if (typeof window === 'undefined' || !window.electronAPI) {
      return;
    }

    // 监听菜单操作事件（如偏好设置）
    // 作为唯一的 Electron 事件监听者，负责将事件广播给应用的其他部分
    window.electronAPI.onMenuAction((action: string) => {
      console.log('[GlobalMenuHandler] Received IPC menu action:', action);
      
      // 1. 处理全局事件
      if (action === 'open-settings') {
        openSettings();
        return; // Handled directly
      }
      
      if (action === 'import-book') {
        openUpload();
        return; // Handled directly
      }

      // 2. 广播事件给其他组件 (如 MenuHandler)
      // 使用自定义事件机制，避免多个 ipcRenderer 监听器互相覆盖(removeAllListeners)的问题
      const event = new CustomEvent('app-menu-action', { detail: action });
      window.dispatchEvent(event);
    });

    return () => {
        if (window.electronAPI) {
            window.electronAPI.removeMenuActionListener();
        }
    };
  }, [openSettings, openUpload]);

  // 这是一个纯逻辑组件，不渲染任何内容
  return null;
}
