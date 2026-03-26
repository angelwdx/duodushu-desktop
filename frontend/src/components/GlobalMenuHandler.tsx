'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSettings } from '../contexts/SettingsContext';
import { useGlobalDialogs } from '../contexts/GlobalDialogsContext';
import { getApiUrl } from '../lib/api';

// 定义 electronAPI 类型（含文件关联与自动更新）
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
      // 文件关联
      getOpenFilePath: () => Promise<string | null>;
      onOpenFile: (callback: (filePath: string) => void) => void;
      removeOpenFileListener: () => void;
      // 自动更新
      checkForUpdates: () => Promise<{ success: boolean; message?: string }>;
      installUpdate: () => Promise<void>;
      onUpdaterEvent: (callback: (event: any) => void) => void;
      removeUpdaterListener: () => void;
    };
  }
}

/**
 * 通过本地文件路径打开书籍：
 * 读取文件内容 → 上传到后端 → 跳转阅读页
 */
async function openLocalFile(filePath: string, router: ReturnType<typeof useRouter>) {
  try {
    // 用 fetch 读取本地文件内容（Electron 的 webSecurity:false 允许 file:// 协议）
    const fileUrl = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`无法读取文件: ${filePath}`);

    const blob = await response.blob();
    const fileName = filePath.split(/[\\/]/).pop() || 'book';
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const mimeType = ext === 'epub' ? 'application/epub+zip' : 'application/pdf';
    const file = new File([blob], fileName, { type: mimeType });

    // 上传到后端
    const formData = new FormData();
    formData.append('file', file);

    const uploadRes = await fetch(`${getApiUrl()}/api/books/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!uploadRes.ok) {
      const errData = await uploadRes.json().catch(() => ({}));
      throw new Error(errData.detail || '上传失败');
    }

    const { book_id } = await uploadRes.json();
    console.log('[GlobalMenuHandler] 文件已上传，book_id:', book_id);
    router.push(`/read?id=${book_id}`);
  } catch (err) {
    console.error('[GlobalMenuHandler] 打开本地文件失败:', err);
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

  // ===== 文件关联：启动时检查 pending 文件路径 =====
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.getOpenFilePath) return;

    window.electronAPI.getOpenFilePath().then((filePath) => {
      if (filePath) {
        console.log('[GlobalMenuHandler] 启动时有待打开文件:', filePath);
        openLocalFile(filePath, router);
      }
    });
  }, [router]);

  // ===== 文件关联：监听运行时双击打开 =====
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.onOpenFile) return;

    window.electronAPI.onOpenFile((filePath: string) => {
      console.log('[GlobalMenuHandler] 收到 open-file 事件:', filePath);
      openLocalFile(filePath, router);
    });

    return () => {
      window.electronAPI?.removeOpenFileListener?.();
    };
  }, [router]);

  // ===== 菜单导航事件 =====
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI) return;

    window.electronAPI.onNavigate((path: string) => {
      console.log('[GlobalMenuHandler] Navigate to:', path);
      router.push(path);
    });

    return () => {
      window.electronAPI?.removeNavigateListener?.();
    };
  }, [router]);

  // ===== 菜单操作事件（设置、导入书籍等）=====
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI) return;

    window.electronAPI.onMenuAction((action: string) => {
      console.log('[GlobalMenuHandler] Received IPC menu action:', action);

      if (action === 'open-settings') {
        openSettings();
        return;
      }

      if (action === 'import-book') {
        openUpload();
        return;
      }

      if (action === 'search-internal' || action === 'global-search') {
        // 全局搜索/原声查找直接跳转到生词本界面
        router.push('/vocabulary');
        // 等待页面加载完成发出聚焦事件
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('app-search-focus'));
        }, 300);
        return;
      }

      // 广播给其他组件（如 MenuHandler）
      const event = new CustomEvent('app-menu-action', { detail: action });
      window.dispatchEvent(event);
    });

    return () => {
      window.electronAPI?.removeMenuActionListener?.();
    };
  }, [openSettings, openUpload]);

  // 这是一个纯逻辑组件，不渲染任何内容
  return null;
}
