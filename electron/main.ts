import { app, BrowserWindow, ipcMain, shell, protocol, net } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import * as util from 'util';
import * as url from 'url';

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
} catch(e) { /* ignore */ }


logToFile(`App starting...`);
logToFile(`Node version: ${process.versions.node}`);
logToFile(`Electron version: ${process.versions.electron}`);
logToFile(`Chrome version: ${process.versions.chrome}`);
logToFile(`App Path: ${app.getAppPath()}`);
logToFile(`UserData Path: ${app.getPath('userData')}`);


let mainWindow: BrowserWindow | null = null;
let pythonProcess: ChildProcess | null = null;

// 定义常量
const IS_DEV = process.env.NODE_ENV === 'development';
const PY_DIST_FOLDER = 'backend'; // 打包后 Python 可执行文件所在目录名称
// const PY_MODULE = 'backend'; // Python 模块/可执行文件名

logToFile(`IS_DEV: ${IS_DEV}`);

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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false, // Disable web security to allow mixed content (HTTP requests to localhost)
      allowRunningInsecureContent: true,
    },
  });

  if (IS_DEV) {
    // 开发模式：加载 Next.js 开发服务器
    logToFile('Loading development URL: http://localhost:3000');
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    // 生产模式：使用自定义协议加载静态文件
    // Setup app:// protocol handler
    protocol.handle('app', (request) => {
        const reqUrl = request.url;
        logToFile(`Requesting: ${reqUrl}`);
        
        let pathName = new URL(reqUrl).pathname;
        if (pathName === '/') {
            pathName = '/index.html';
        }

        // Handle Next.js directory indices (like /vocabulary -> /vocabulary.html or /vocabulary/index.html)
        // But since Next.js 'export' usually generates .html files for pages, we check that.
        
        const possiblePaths = [
            path.join(__dirname, '../frontend/out', pathName),
            path.join(__dirname, '../frontend/out', pathName + '.html'),
            path.join(__dirname, '../frontend/out', pathName, 'index.html')
        ];

        let filePath = '';
        for (const p of possiblePaths) {
            // Decoding URI component to handle spaces/special chars if any
            const decodedPath = decodeURIComponent(p);
            if (fs.existsSync(decodedPath) && fs.statSync(decodedPath).isFile()) {
                filePath = decodedPath;
                break;
            }
        }

        if (!filePath) {
             // 404 fallback
             filePath = path.join(__dirname, '../frontend/out', '404.html');
             if (!fs.existsSync(filePath)) {
                 // Final fallback if 404 doesn't exist
                 filePath = path.join(__dirname, '../frontend/out', 'index.html');
             }
        }

        return net.fetch(url.pathToFileURL(filePath).toString());
    });

    logToFile('Loading URL: app://./index.html');
    await mainWindow.loadURL('app://./index.html');
    logToFile('URL loaded successfully');
      
      // TEMPORARY: Open DevTools in production to debug blank screen
      // mainWindow.webContents.openDevTools();
  }

  // 处理外部链接打开请求
  ipcMain.on('open-external', (event, url) => {
    shell.openExternal(url);
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

  if (IS_DEV) {
     dataPath = path.join(process.cwd(), 'backend', 'data'); // 开发环境默认路径
  } else {
     // 生产环境检查逻辑：便携模式优先
     // process.execPath 是 exe 文件的完整路径
     // 检查 exe 同级目录下是否有 data 文件夹
     const exeDir = path.dirname(process.execPath);
     const portableDataPath = path.join(exeDir, 'data');
     if (fs.existsSync(portableDataPath)) {
         dataPath = portableDataPath;
         logToFile(`便携模式已启用: ${dataPath}`);
     } else {
         dataPath = app.getPath('userData');
         logToFile(`使用系统 userData 目录: ${dataPath}`);
     }
  }
  
  logToFile(`Python Data Path: ${dataPath}`);

  if (IS_DEV) {
    // 开发模式：直接运行 Python 脚本
    // 假设此时我们在项目根目录运行 electron
    cmd = 'python'; // 或 'python3', 取决于系统环境
    scriptPath = path.join(process.cwd(), 'backend', 'run_backend.py'); // 我们需要创建一个 run_backend.py
    args = [scriptPath, '--port', '8000', '--data-dir', dataPath];
  } else {
    // 生产模式：运行打包后的可执行文件
    const backendPath = path.join(process.resourcesPath, PY_DIST_FOLDER);
    // Windows 下通常是 backend/backend.exe
    const exeName = process.platform === 'win32' ? 'backend.exe' : 'backend';
    scriptPath = path.join(backendPath, exeName);
    cmd = scriptPath;
    args = ['--port', '8000', '--data-dir', dataPath];
  }

  logToFile(`Starting Python backend: ${cmd} ${args.join(' ')}`);

  try {
      pythonProcess = spawn(cmd, args);
      
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
