import { Menu, shell, app, BrowserWindow, MenuItemConstructorOptions, ipcMain } from 'electron';

// 是否为开发模式
const IS_DEV = !app.isPackaged;

/**
 * 创建应用菜单
 * @param mainWindow 主窗口实例
 */
export function createApplicationMenu(mainWindow: BrowserWindow): void {
  const template: MenuItemConstructorOptions[] = [
    // 文件菜单
    {
      label: '文件',
      submenu: [
        {
          label: '导入书籍',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow.webContents.send('menu-action', 'import-book');
          }
        },
        {
          label: '导出笔记',
          click: () => {
            mainWindow.webContents.send('menu-action', 'export-notes');
          }
        },
        { type: 'separator' },
        {
          role: 'quit',
          label: '退出',
          accelerator: 'Alt+F4'
        }
      ]
    },

    // 编辑菜单
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        {
          label: '在应用内查找',
          accelerator: 'CmdOrCtrl+F',
          click: () => {
            mainWindow.webContents.send('menu-action', 'search-internal');
          }
        }
      ]
    },

    // 工具菜单
    {
      label: '工具',
      submenu: [
        {
          label: '生词本',
          submenu: [
            {
              label: '生词列表',
              accelerator: 'CmdOrCtrl+Shift+V',
              click: () => {
                mainWindow.webContents.send('navigate', '/vocabulary');
              }
            },
            {
              label: '学习模式',
              click: () => {
                mainWindow.webContents.send('navigate', '/vocabulary/learn');
              }
            },
            {
              label: '复习模式',
              click: () => {
                mainWindow.webContents.send('navigate', '/vocabulary/review');
              }
            }
          ]
        },
        {
          label: '词典管理',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => {
            mainWindow.webContents.send('navigate', '/dicts');
          }
        },
        { type: 'separator' },
        {
          label: '偏好设置',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            mainWindow.webContents.send('menu-action', 'open-settings');
          }
        }
      ]
    },

    // 视图菜单
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'forceReload', label: '强制刷新' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { type: 'separator' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '重置缩放' },
        ...(IS_DEV ? [
          { type: 'separator' as const },
          { role: 'toggleDevTools' as const, label: '开发者工具' }
        ] : [])
      ]
    },

    // 帮助菜单
    {
      label: '帮助',
      submenu: [
        {
          label: '使用指南',
          click: () => {
            shell.openExternal('https://github.com/angelwdx/duodushu-desktop#readme');
          }
        },
        {
          label: '检查更新',
          click: async () => {
            // 触发 autoUpdater 检查（生产模式），开发模式仅通知前端
            if (app.isPackaged) {
              await ipcMain.emit('check-for-updates-menu');
            }
            mainWindow.webContents.send('menu-action', 'check-update');
          }
        },
        {
          label: '反馈问题',
          click: () => {
            shell.openExternal('https://github.com/angelwdx/duodushu-desktop/issues');
          }
        },
        { type: 'separator' },
        {
          label: '关于',
          click: () => {
            mainWindow.webContents.send('menu-action', 'show-about');
          }
        }
      ]
    }
  ];

  // macOS 特殊处理：在最前面添加应用菜单
  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about', label: '关于' },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
