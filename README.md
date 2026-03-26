# 多读书 (Duodushu) 桌面客户端

**版本**: 1.3.0
**最后更新**: 2026-03-26

一款**本地优先（Local-First）且支持绿色便携（Portable）**的沉浸式英语学习工作站。现已全面支持 Windows 和 MacOS。

## 🚀 快速开始

### 便携模式（Windows）

1. 下载 `DuoDuShu-Desktop-Portable.exe`
2. 双击运行，无需安装
3. 所有数据存储在 exe 同级的 `data/` 目录

### 安装模式（MacOS）

1. 下载 `DuoDuShu-1.0.0.dmg`
2. 将 `Duodushu.app` 拖入 Applications 文件夹
3. **绕过签名检查**: 由于应用暂未签名，若提示“无法打开”，请在终端运行：
   ```bash
   sudo xattr -rd com.apple.quarantine /Applications/Duodushu.app
   ```
4. 首次运行时，所有用户数据将存储在 `~/Library/Application Support/duodushu-desktop`

### 开发模式

```bash
# 克隆项目
git clone https://github.com/angelwdx/duodushu-desktop.git
cd duodushu-desktop

# 安装依赖
npm install

# 启动开发环境
npm run dev
```

## 📚 核心特性

- ✅ **全平台支持** - 完美适配 Windows (Portable/NSIS) 和 MacOS (DMG/Zip)
- ✅ **本地优先** - 所有数据存储在本地存储，隐私安全，无需联网
- ✅ **自动更新与文件关联** - 支持 `.epub` / `.pdf` 双击直接打开，内置自动更新检测
- ✅ **系统托盘与全局唤起** - 支持最小化到系统托盘常驻；支持全局快捷键 `Cmd/Ctrl+Shift+Space` 一键唤起查词
- ✅ **多窗口并行阅读** - 支持点击“在新窗口打开”，实现多本图书、图书与生词本的并排对照阅读
- ✅ **智能网络感知** - 内置离线模式检测，断网时自动降级 UI 并禁用 AI 联网功能，确保纯本地阅读无报错
- ✅ **AI 深度辅助** - 支持多模型（GPT/Claude/DeepSeek等）辅助阅读与智能问答
- ✅ **沉浸式阅读** - 支持 PDF/EPUB 格式，集成 Edge TTS 高质量语音朗读
- ✅ **词典联动** - 支持多种自定义词典（Mdict），内置生词本与智能复习算法 (支持导出生词库为 CSV/Anki)

## 📖 文档导航

### 用户文档
- **[部署指南](./docs/DEPLOYMENT.md)** - 如何在不同平台安装和部署
- **[数据管理](./docs/DATA_STORAGE.md)** - 数据存储路径、备份与迁移指南
- **[故障排查](./docs/TROUBLESHOOTING.md)** - 常见问题（如 MacOS 权限、后端连接等）

### 开发文档
- **[开发指南](./docs/DEVELOPMENT.md)** - 开发环境搭建、调试与构建命令
- **[技术架构](./docs/TDD.md)** - 系统架构设计与模块说明
- **[API 参考](./docs/API.md)** - FastAPI 后端接口文档

## 🏗️ 项目结构

```
duodushu-desktop/
├── electron/                # Electron 主进程 (Node.js/TS)
├── frontend/                # Next.js 16 + Tailwind 4 前端
├── backend/                 # FastAPI + Python 后端
│   ├── app/                 # 核心逻辑
│   └── data/                # 开发环境数据库
├── docs/                    # 详细技术/用户文档
└── package.json             # 项目配置与脚本
```

## 🛠️ 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动全栈开发环境 (Frontend + Electron) |
| `npm run build` | 执行生产环境构建 (Frontend + Backend + Electron) |
| `npm run package` | 打包发布版本 (生成 exe/dmg) |

## 🔧 技术栈

| 模块 | 技术 |
|------|------|
| **外壳框架** | Electron 28+ |
| **前端框架** | Next.js 16 + React 19 |
| **样式系统** | Tailwind CSS 4 |
| **后端引擎** | FastAPI + SQLAlchemy 2.0 |
| **搜索引擎** | SQLite (FTS5 虚拟表 + 触发器同步) |
| **跨系统打包** | electron-builder + PyInstaller |

## 📦 构建和发布

### 构建全平台版本

```bash
npm run build
```

构建产物将存放在 `dist_app/` 目录中。

- **Windows**: `DuoDuShu-Desktop-Portable.exe` (便携版), `.exe` (安装版)
- **MacOS**: `.dmg` (磁盘映像), `.zip` (压缩包)

详见 [部署指南](./docs/DEPLOYMENT.md)

## 🤝 贡献与反馈

1. Fork 项目并创建特性分支 (`feature/xxx`)
2. 提交 Issue：[GitHub Issues](https://github.com/angelwdx/duodushu-desktop/issues)
3. 参与讨论：[GitHub Discussions](https://github.com/angelwdx/duodushu-desktop/discussions)

## 🎯 路线图 (Roadmap)

### v1.3.0 (当前稳定版)
- ✅ **全局快捷键与原生菜单逻辑重构 (Cmd+F / Cmd+Shift+Space)**
- ✅ **离线模式与网络状态智能检测 (智能禁用 AI 降级)**
- ✅ **多窗口支持 (Multi-Window Reading)**
- ✅ **系统托盘 (System Tray) 与双击文件关联支持**
- ✅ **全自动更新流程与生产构建流水线优化 (GitHub Actions)**

> [!TIP]
> 推荐使用 `v1.3.0` 版本以获取最完整的桌面端沉浸阅读体验。后续将重点转向 AI 深度解析算法的优化。

## 📝 许可证

MIT License © 2026 Duodushu Team
