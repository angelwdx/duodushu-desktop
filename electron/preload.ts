import { contextBridge, ipcRenderer } from 'electron';

// 预定义默认后端 URL（用于便携版）
const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8000';

// 获取后端 URL（优先使用预定义的 URL，避免 IPC 问题）
let cachedBackendUrl = DEFAULT_BACKEND_URL;

// 初始化时尝试获取一次后端 URL
ipcRenderer.invoke('get-backend-url').then((url: string) => {
  cachedBackendUrl = url;
  console.log('[Preload] Backend URL received:', url);
}).catch((err) => {
  console.error('[Preload] Failed to get backend URL:', err);
});

contextBridge.exposeInMainWorld('electronAPI', {
  // ===== 后端 URL =====
  getBackendUrl: async () => {
    if (cachedBackendUrl && cachedBackendUrl !== DEFAULT_BACKEND_URL) {
      return cachedBackendUrl;
    }
    try {
      const url = await ipcRenderer.invoke('get-backend-url');
      if (url && url !== DEFAULT_BACKEND_URL) {
        cachedBackendUrl = url;
        return url;
      }
    } catch (err) {
      console.error('[Preload] Failed to get backend URL:', err);
    }
    return DEFAULT_BACKEND_URL;
  },

  // ===== 通用工具 =====
  sendMessage: (message: string) => ipcRenderer.send('message', message),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),

  // ===== 菜单导航/操作事件 =====
  onNavigate: (callback: (path: string) => void) => {
    ipcRenderer.on('navigate', (_event, path: string) => callback(path));
  },
  onMenuAction: (callback: (action: string) => void) => {
    ipcRenderer.on('menu-action', (_event, action: string) => callback(action));
  },
  openNewWindow: (url: string) => {
    ipcRenderer.send('open-new-window', url);
  },
  removeNavigateListener: () => {
    ipcRenderer.removeAllListeners('navigate');
  },
  removeMenuActionListener: () => {
    ipcRenderer.removeAllListeners('menu-action');
  },

  // ===== 文件关联：接收双击打开的文件路径 =====
  /** 获取启动时待打开的文件路径（调用一次后清空） */
  getOpenFilePath: (): Promise<string | null> =>
    ipcRenderer.invoke('get-open-file-path'),

  /** 监听运行时新文件打开事件（Windows second-instance / macOS open-file） */
  onOpenFile: (callback: (filePath: string) => void) => {
    ipcRenderer.on('open-file', (_event, filePath: string) => callback(filePath));
  },
  removeOpenFileListener: () => {
    ipcRenderer.removeAllListeners('open-file');
  },

  // ===== 自动更新 =====
  /** 手动触发检查更新 */
  checkForUpdates: (): Promise<{ success: boolean; message?: string }> =>
    ipcRenderer.invoke('check-for-updates'),

  /** 立即退出并安装已下载的更新 */
  installUpdate: (): Promise<void> =>
    ipcRenderer.invoke('install-update'),

  /** 监听更新事件 */
  onUpdaterEvent: (callback: (event: {
    type: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
    version?: string;
    percent?: number;
    message?: string;
  }) => void) => {
    ipcRenderer.on('updater-event', (_event, data) => callback(data));
  },
  removeUpdaterListener: () => {
    ipcRenderer.removeAllListeners('updater-event');
  },
});
