import { app, BrowserWindow, ipcMain, shell, protocol, net, Tray, Menu, nativeImage, globalShortcut } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import * as util from 'util';
import * as url from 'url';
import { autoUpdater } from 'electron-updater';
import { createApplicationMenu } from './menu';

// Logging setup
const logFile = path.join(app.getPath('userData'), 'startup.log');
const errorLogFile = path.join(app.getPath('userData'), 'startup_error.log');

function logToFile(message: string) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(logFile, logMessage);
  } catch (error) {
    console.error('Failed to write to log file:', error);
  }
}

function logErrorToFile(message: string, error?: any) {
  const timestamp = new Date().toISOString();
  let logMessage = `[${timestamp}] [ERROR] ${message}\n`;
  if (error) {
    logMessage += `Stack: ${util.inspect(error)}\n`;
  }
  try {
    fs.appendFileSync(errorLogFile, logMessage);
    fs.appendFileSync(logFile, logMessage);
  } catch (e) {
    console.error('Failed to write to error log file:', e);
  }
}

// Clear logs on startup
try {
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(errorLogFile, '');
} catch (e) { /* ignore */ }


logToFile(`App starting...`);
logToFile(`Node version: ${process.versions.node}`);
logToFile(`Electron version: ${process.versions.electron}`);
logToFile(`Chrome version: ${process.versions.chrome}`);
logToFile(`App Path: ${app.getAppPath()}`);
logToFile(`UserData Path: ${app.getPath('userData')}`);


let mainWindow: BrowserWindow | null = null;
let pythonProcess: ChildProcess | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// 定义常量
// 使用 app.isPackaged 判定是否为生产环境（更可靠）
const IS_DEV = !app.isPackaged;
const PY_DIST_FOLDER = 'backend'; // 打包后 Python 可执行文件所在目录名称

logToFile(`IS_DEV: ${IS_DEV} (app.isPackaged: ${app.isPackaged})`);

// 禁用 GPU 以避免崩溃问题
app.commandLine.appendSwitch('--disable-gpu');
app.commandLine.appendSwitch('--disable-software-rasterizer');
app.commandLine.appendSwitch('--no-sandbox');

// Register the scheme as privileged (must be done before app is ready)
if (!IS_DEV) {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true } }
  ]);
}

// ===== 文件关联：记录从命令行/外部传入的待打开文件路径 =====
let pendingOpenFilePath: string | null = null;

// macOS: 双击文件时 app 尚未就绪前触发
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  logToFile(`open-file event: ${filePath}`);
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('open-file', filePath);
  } else {
    pendingOpenFilePath = filePath;
  }
});

// Windows/Linux: 通过命令行参数传入文件路径（单实例锁）
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    logToFile(`second-instance: ${commandLine.join(' ')}`);
    // 主窗口已存在时，聚焦并打开文件
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      const filePath = commandLine.find(arg =>
        arg.toLowerCase().endsWith('.epub') || arg.toLowerCase().endsWith('.pdf')
      );
      if (filePath) {
        mainWindow.webContents.send('open-file', filePath);
      }
    }
  });
}

// 从进程启动参数中提取文件路径（首次打开）
function extractFileFromArgs(argv: string[]): string | null {
  const fileArg = argv.slice(IS_DEV ? 2 : 1).find(arg =>
    arg.toLowerCase().endsWith('.epub') || arg.toLowerCase().endsWith('.pdf')
  );
  return fileArg || null;
}

// ===== 自动更新配置 =====
function setupAutoUpdater() {
  if (IS_DEV) {
    logToFile('AutoUpdater: 开发模式，跳过更新检查');
    return;
  }

  autoUpdater.logger = {
    info: (msg: any) => logToFile(`[AutoUpdater] ${msg}`),
    warn: (msg: any) => logToFile(`[AutoUpdater WARN] ${msg}`),
    error: (msg: any) => logErrorToFile(`[AutoUpdater ERROR] ${msg}`),
    debug: () => {},
  } as any;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    logToFile('AutoUpdater: 正在检查更新...');
    mainWindow?.webContents.send('updater-event', { type: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    logToFile(`AutoUpdater: 发现新版本 ${info.version}`);
    mainWindow?.webContents.send('updater-event', { type: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    logToFile('AutoUpdater: 当前已是最新版本');
    mainWindow?.webContents.send('updater-event', { type: 'not-available' });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent);
    mainWindow?.webContents.send('updater-event', { type: 'downloading', percent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    logToFile(`AutoUpdater: 更新已下载完成 ${info.version}`);
    mainWindow?.webContents.send('updater-event', { type: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    logErrorToFile('AutoUpdater error', err);
    mainWindow?.webContents.send('updater-event', { type: 'error', message: err.message });
  });

  // 注册 IPC：手动检查更新（菜单触发）
  ipcMain.handle('check-for-updates', async () => {
    try {
      await autoUpdater.checkForUpdates();
      return { success: true };
    } catch (e: any) {
      logErrorToFile('手动检查更新失败', e);
      return { success: false, message: e.message };
    }
  });

  // 注册 IPC：立即安装已下载的更新
  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall();
  });

  // 应用就绪后延迟 5 秒检查更新（避免阻塞启动）
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => {
      logErrorToFile('自动检查更新失败', e);
    });
  }, 5000);
}

async function createWindow() {
  logToFile('createWindow called');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false, // 初始隐藏，等后端准备好再显示
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
  });

  // 创建应用菜单
  createApplicationMenu(mainWindow);

  // 拦截关闭事件，实现最小化到托盘
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      if (process.platform === 'darwin') {
        app.dock.hide(); // mac 下隐藏 dock 图标
      }
      logToFile('Window hidden to tray');
    }
  });

  // 等待后端就绪的逻辑
  const checkBackendReady = async (retries = 20): Promise<boolean> => {
    for (let i = 0; i < retries; i++) {
      try {
        logToFile(`Checking backend health (attempt ${i + 1}/${retries})...`);
        const response = await net.fetch('http://127.0.0.1:8000/health');
        if (response.ok) {
          logToFile('Backend is ready!');
          return true;
        }
      } catch (e) {
        // 后端尚未启动
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return false;
  };

  if (IS_DEV) {
    logToFile('Loading development URL: http://localhost:3000');
    mainWindow.loadURL('http://localhost:3000');
    // 开发模式下直接显示，方便调试
    mainWindow.once('ready-to-show', () => mainWindow?.show());
    mainWindow.webContents.openDevTools();
  } else {
    // 生产模式：等待后端就绪后再加载和显示
    const isReady = await checkBackendReady();

    if (isReady) {
      protocol.handle('app', (request) => {
        const reqUrl = request.url;
        let pathName = new URL(reqUrl).pathname;
        if (pathName === '/') pathName = '/index.html';

        const possiblePaths = [
          path.join(__dirname, '../frontend/out', pathName),
          path.join(__dirname, '../frontend/out', pathName + '.html'),
          path.join(__dirname, '../frontend/out', pathName, 'index.html')
        ];

        let filePath = '';
        for (const p of possiblePaths) {
          const decodedPath = decodeURIComponent(p);
          if (fs.existsSync(decodedPath) && fs.statSync(decodedPath).isFile()) {
            filePath = decodedPath;
            break;
          }
        }

        if (!filePath) {
          filePath = path.join(__dirname, '../frontend/out', 'index.html');
        }

        return net.fetch(url.pathToFileURL(filePath).toString());
      });

      logToFile('Loading URL: app://./index.html');
      await mainWindow.loadURL('app://./index.html');
      mainWindow.show(); // 后端好了，前端也加载了，现在展示给用户
    } else {
      logErrorToFile('Backend failed to start within timeout');
    }
  }

  // 处理外部链接打开请求
  ipcMain.on('open-external', (event, url) => {
    shell.openExternal(url);
  });

  // 获取后端 URL（用于前端动态检测）
  ipcMain.handle('get-backend-url', (event) => {
    const port = 8000;
    const backendUrl = `http://127.0.0.1:${port}`;
    logToFile(`Providing backend URL: ${backendUrl}`);
    return backendUrl;
  });

  // 文件关联：前端启动后提供待打开的文件路径
  ipcMain.handle('get-open-file-path', () => {
    const filePath = pendingOpenFilePath;
    pendingOpenFilePath = null;
    return filePath;
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    logErrorToFile(`Page failed to load: ${errorCode} - ${errorDescription}`);
  });

  mainWindow.webContents.on('dom-ready', () => {
    logToFile('DOM Ready');
    // 如果有从命令行传入的待打开文件，通知前端
    if (pendingOpenFilePath) {
      mainWindow?.webContents.send('open-file', pendingOpenFilePath);
      pendingOpenFilePath = null;
    }
  });
}

// 创建独立阅读窗口
async function createSecondaryWindow(urlSuffix: string) {
  logToFile(`createSecondaryWindow called with urlSuffix: ${urlSuffix}`);
  const secWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
  });

  // 创建应用菜单
  createApplicationMenu(secWindow);

  const formattedUrlSuffix = urlSuffix.startsWith('/') ? urlSuffix : `/${urlSuffix}`;

  if (IS_DEV) {
    const fullUrl = `http://localhost:3000${formattedUrlSuffix}`;
    logToFile(`Loading development secondary URL: ${fullUrl}`);
    secWindow.loadURL(fullUrl);
    secWindow.once('ready-to-show', () => secWindow.show());
  } else {
    // 生产环境依托事先已注册好的 protocol.handle('app') 会自动转译路径
    const fullUrl = `app://.${formattedUrlSuffix}`;
    logToFile(`Loading production secondary URL: ${fullUrl}`);
    secWindow.loadURL(fullUrl);
    secWindow.once('ready-to-show', () => secWindow.show());
  }

  secWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    logErrorToFile(`Secondary Page failed to load: ${errorCode} - ${errorDescription}`);
  });
}

// 启动 Python 后端
function startPythonBackend() {
  logToFile('startPythonBackend called');
  let scriptPath: string;
  let cmd: string;
  let args: string[] = [];

  const appPath = app.getAppPath();

  let dataPath: string;
  let workingDir: string = "";

  if (IS_DEV) {
    dataPath = path.join(appPath, 'backend', 'data');
    workingDir = path.join(appPath, 'backend');
    logToFile(`开发模式 - 使用应用目录: ${appPath}`);
  } else {
    const portableExeDir = process.env.PORTABLE_EXECUTABLE_DIR;
    const exeDir = portableExeDir ? portableExeDir : path.dirname(process.execPath);
    const portableDataPath = path.join(exeDir, 'data');

    logToFile(`Portable check - Executable Dir: ${exeDir} (Portable Env: ${portableExeDir || 'N/A'})`);

    if (portableExeDir) {
      dataPath = portableDataPath;
      if (!fs.existsSync(dataPath)) {
        try {
          fs.mkdirSync(dataPath);
        } catch (e) {
          logErrorToFile('Failed to create portable data dir', e);
        }
      }
      logToFile(`检测到便携版运行环境，强制使用数据目录: ${dataPath}`);
    } else if (fs.existsSync(portableDataPath)) {
      dataPath = portableDataPath;
      logToFile(`检测到同级 data 目录，启用便携模式: ${dataPath}`);
    } else {
      dataPath = app.getPath('userData');
      logToFile(`使用标准安装模式 (userData): ${dataPath}`);
    }
  }

  logToFile(`Python Data Path: ${dataPath}`);

  if (IS_DEV) {
    const venvPythonPath = process.platform === 'win32'
      ? path.join(appPath, 'backend', '.venv', 'Scripts', 'python.exe')
      : path.join(appPath, 'backend', '.venv', 'bin', 'python3');

    if (fs.existsSync(venvPythonPath)) {
      cmd = venvPythonPath;
      logToFile(`开发模式 - 使用虚拟环境 Python: ${cmd}`);
    } else {
      cmd = process.platform === 'win32' ? 'python' : 'python3';
      logToFile(`开发模式 - 未发现虚拟环境，回退到系统 Python: ${cmd}`);
    }

    scriptPath = path.join(appPath, 'backend', 'run_backend.py');
    args = [scriptPath, '--port', '8000', '--data-dir', dataPath];
  } else {
    const backendPath = path.join(process.resourcesPath, PY_DIST_FOLDER);
    const exeName = process.platform === 'win32' ? 'backend.exe' : 'backend';
    const exePath = path.join(backendPath, exeName);

    workingDir = path.dirname(exePath);
    const internalDir = path.join(backendPath, '_internal');
    if (fs.existsSync(internalDir)) {
      workingDir = internalDir;
    }

    scriptPath = exePath;
    cmd = scriptPath;

    const absoluteDataPath = path.resolve(workingDir, dataPath);
    args = ['--port', '8000', '--data-dir', absoluteDataPath];

    logToFile(`Starting Python backend in directory: ${workingDir}`);
    logToFile(`Script: ${scriptPath}`);
    logToFile(`Args: ${args.join(' ')}`);
  }

  logToFile(`Starting Python backend: ${cmd} ${args.join(' ')}`);

  try {
    pythonProcess = spawn(cmd, args, {
      cwd: workingDir,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    logToFile(`Python process spawned with PID: ${pythonProcess.pid}`);

    if (pythonProcess.stdout) {
      pythonProcess.stdout.on('data', (_data) => { /* suppress verbose output */ });
    }

    if (pythonProcess.stderr) {
      pythonProcess.stderr.on('data', (data) => {
        logErrorToFile(`[Python Stderr]: ${data}`);
      });
    }

    pythonProcess.on('error', (err) => {
      logErrorToFile('Python process spawn error', err);
    });

    pythonProcess.on('close', (code) => {
      logToFile(`Python process exited with code ${code}`);
    });
  } catch (e) {
    logErrorToFile('Failed to spawn python process', e);
  }
}

function stopPythonBackend() {
  if (pythonProcess) {
    logToFile('Stopping Python backend...');
    pythonProcess.kill();
    pythonProcess = null;
  }
}

app.whenReady().then(async () => {
  logToFile('App ready event received');

  // 检查命令行参数中的文件路径（Windows 首次双击打开时）
  const fileFromArgs = extractFileFromArgs(process.argv);
  if (fileFromArgs) {
    pendingOpenFilePath = fileFromArgs;
    logToFile(`检测到命令行文件参数: ${fileFromArgs}`);
  }

  startPythonBackend();
  await createWindow();

  // 监听前端传来的在新窗口打开请求
  ipcMain.on('open-new-window', (event, targetUrl) => {
    createSecondaryWindow(targetUrl);
  });

  // 初始化自动更新
  setupAutoUpdater();

  // 初始化系统托盘
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  // 对于 macOS，图标过大会被裁剪，创建 nativeImage 并调整大小
  let trayIcon = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') {
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
  } else {
    trayIcon = trayIcon.resize({ width: 24, height: 24 });
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('多读书 Duodushu');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示多读书',
      click: () => {
        mainWindow?.show();
        if (process.platform === 'darwin') app.dock.show();
      }
    },
    { type: 'separator' },
    {
      label: '退出多读书',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
      if (process.platform === 'darwin') app.dock.hide();
    } else {
      mainWindow?.show();
      if (process.platform === 'darwin') app.dock.show();
    }
  });

  // ===== 注册全局快捷键 =====
  const ret = globalShortcut.register('CommandOrControl+Shift+Space', () => {
    logToFile('Global shortcut triggered: CommandOrControl+Shift+Space');
    // 优先唤起当前聚焦窗口，如果全在后台或无焦点则取最后存活窗口或 mainWindow
    const targetWin = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || mainWindow;
    if (targetWin) {
      if (!targetWin.isVisible()) {
        targetWin.show();
        if (process.platform === 'darwin') app.dock.show();
      }
      if (targetWin.isMinimized()) {
        targetWin.restore();
      }
      targetWin.focus();
      // 向前端发送全局快捷查词事件
      targetWin.webContents.send('menu-action', 'global-search');
    }
  });

  if (!ret) {
    logErrorToFile('Failed to register global shortcut CommandOrControl+Shift+Space');
  }

  app.on('activate', async function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    } else {
      mainWindow?.show();
      if (process.platform === 'darwin') app.dock.show();
    }
  });
});

// 在 macOS 上，彻底退出之前也标记 isQuitting
app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  logToFile('window-all-closed event');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  logToFile('will-quit event');
  
  // 清理所有的全局快捷键
  globalShortcut.unregisterAll();
  
  stopPythonBackend();
});
