import { contextBridge, ipcRenderer } from 'electron';

// 通过 IPC 获取后端 URL
let cachedBackendUrl: string | null = null;

// 初始化时获取一次后端 URL
ipcRenderer.invoke('get-backend-url').then((url: string) => {
  cachedBackendUrl = url;
  console.log('[Preload] Backend URL received:', url);
}).catch((err) => {
  console.error('[Preload] Failed to get backend URL:', err);
});

contextBridge.exposeInMainWorld('electronAPI', {
  // 从主进程获取后端 URL
  getBackendUrl: async () => {
    if (cachedBackendUrl) {
      return cachedBackendUrl;
    }
    try {
      const url = await ipcRenderer.invoke('get-backend-url');
      cachedBackendUrl = url;
      return url;
    } catch (err) {
      console.error('[Preload] Failed to get backend URL:', err);
      return 'http://127.0.0.1:8000';
    }
  },

  // 示例：从渲染进程发送消息到主进程
  sendMessage: (message: string) => ipcRenderer.send('message', message),
  // 示例：打开外部链接
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
});
