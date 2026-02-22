import { app, BrowserWindow, ipcMain, shell, protocol, net } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import * as util from 'util';
import * as url from 'url';
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

// 定义常量
// 使用 app.isPackaged 判定是否为生产环境（更可靠）
const IS_DEV = !app.isPackaged;
const PY_DIST_FOLDER = 'backend'; // 打包后 Python 可执行文件所在目录名称
// const PY_MODULE = 'backend'; // Python 模块/可执行文件名

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
      allowRunningInsecureContent: true,
    },
  });

  // 创建应用菜单
  createApplicationMenu(mainWindow);

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
      // 可以弹出一个 dialog 告知用户
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

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    logErrorToFile(`Page failed to load: ${errorCode} - ${errorDescription}`);
  });

  mainWindow.webContents.on('dom-ready', () => {
    logToFile('DOM Ready');
  });
}

// 启动 Python 后端
function startPythonBackend() {
  logToFile('startPythonBackend called');
  let scriptPath: string;
  let cmd: string;
  let args: string[] = [];

  const appPath = app.getAppPath();

  // 确定数据目录路径 (便携模式优先)
  // 检查应用同级目录下是否有 data 文件夹
  // 在开发模式下，我们使用项目根目录下的 data
  // 在生产模式(打包后)，如果exe旁边有data，则用那个，否则用 userData
  let dataPath: string;
  let workingDir: string = "";

  if (IS_DEV) {
    // 开发环境：使用 app.getAppPath() 返回应用目录（项目根目录），更可靠
    dataPath = path.join(appPath, 'backend', 'data');
    workingDir = path.join(appPath, 'backend');
    logToFile(`开发模式 - 使用应用目录: ${appPath}`);
  } else {
    // 生产环境检查逻辑：便携模式优先
    // 1. 检查是否为 electron-builder 的便携式应用 (Portable App)
    // 此时 process.env.PORTABLE_EXECUTABLE_DIR 会指向真实 exe 所在目录
    const portableExeDir = process.env.PORTABLE_EXECUTABLE_DIR;

    // 2. 如果不是便携版，则使用 process.execPath (解压版/安装版)
    const exeDir = portableExeDir ? portableExeDir : path.dirname(process.execPath);

    const portableDataPath = path.join(exeDir, 'data');

    logToFile(`Portable check - Executable Dir: ${exeDir} (Portable Env: ${portableExeDir || 'N/A'})`);

    // 策略：
    // A. 如果是便携版(PORTABLE_EXECUTABLE_DIR 存在)，强制使用该目录下的 data (自动创建)
    // B. 如果是普通版，只有当 exe 同级存在 data 目录时才启用便携模式 (USB 模式)

    if (portableExeDir) {
      // 便携版强制使用同级 data
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
      // 解压版/安装版：如果发现同级有 data 目录，则使用它 (USB 模式)
      dataPath = portableDataPath;
      logToFile(`检测到同级 data 目录，启用便携模式: ${dataPath}`);
    } else {
      // 默认回退到系统 userData
      dataPath = app.getPath('userData');
      logToFile(`使用标准安装模式 (userData): ${dataPath}`);
    }
  }

  logToFile(`Python Data Path: ${dataPath}`);

  if (IS_DEV) {
    // 开发模式：直接运行 Python 脚本
    const venvPythonPath = process.platform === 'win32'
      ? path.join(appPath, 'backend', '.venv', 'Scripts', 'python.exe')
      : path.join(appPath, 'backend', '.venv', 'bin', 'python3');

    if (fs.existsSync(venvPythonPath)) {
      cmd = venvPythonPath;
      logToFile(`开发模式 - 使用虚拟环境 Python: ${cmd}`);
    } else {
      // 退回到系统 Python
      cmd = process.platform === 'win32' ? 'python' : 'python3';
      logToFile(`开发模式 - 未发现虚拟环境，回退到系统 Python: ${cmd}`);
    }

    scriptPath = path.join(appPath, 'backend', 'run_backend.py');
    args = [scriptPath, '--port', '8000', '--data-dir', dataPath];
  } else {
    // 生产模式：运行打包后的可执行文件
    const backendPath = path.join(process.resourcesPath, PY_DIST_FOLDER);
    const exeName = process.platform === 'win32' ? 'backend.exe' : 'backend';
    const exePath = path.join(backendPath, exeName);

    // 确定工作目录：backend.exe 所在的实际目录
    // PyInstaller 将可执行文件放在 _internal/ 子目录中
    // 设置工作目录为 _internal 目录，确保数据目录正确创建
    workingDir = path.dirname(exePath);
    const internalDir = path.join(backendPath, '_internal');
    if (fs.existsSync(internalDir)) {
      workingDir = internalDir;
    }

    // 传递绝对路径作为 --data-dir 参数
    scriptPath = exePath;
    cmd = scriptPath;

    // 将 dataPath 转换为绝对路径（相对于 exe 所在目录）
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
      pythonProcess.stdout.on('data', (data) => {
        // Log only critical info or errors to avoid flooding
        //   console.log(`[Python]: ${data}`);
      });
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
  // 先启动后端，再创建窗口
  // 实际项目中可能需要等待后端健康检查(health check)通过后再加载前端
  // 这里暂时直接启动
  startPythonBackend();
  await createWindow();

  app.on('activate', async function () {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  logToFile('window-all-closed event');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  logToFile('will-quit event');
  stopPythonBackend();
});
