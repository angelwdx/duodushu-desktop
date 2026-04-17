# 多读书 (Duodushu) 桌面客户端

**版本**: 1.0.5
**最后更新**: 2026-04-17

一款**本地优先（Local-First）且支持绿色便携（Portable）**的沉浸式英语学习工作站。现已全面支持 Windows 和 MacOS。

## 🚀 快速开始

### 便携模式（Windows）

1. 下载 `DuoDuShu-Desktop-Portable.exe`
2. 双击运行，无需安装
3. 所有数据存储在 exe 同级的 `data/` 目录

### 安装模式（MacOS）

1. 下载 `Duodushu-1.0.5-arm64.dmg`
2. 将 `Duodushu.app` 拖入 Applications 文件夹
3. **解决"已损坏"提示**: 由于应用暂未签署 Apple 开发者证书，从浏览器下载的版本会被 macOS 误报为"已损坏"。请在终端运行以下指令解决：
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

## ✨ 最新更新

### v1.0.5
- ✅ **笔记持久化** - 划线笔记从 localStorage 迁移到 SQLite 数据库，重启、更新后笔记永不丢失
- ✅ **全局内容搜索** - 主页新增 🔍 搜索入口（或 `Cmd+F`），同时搜索书名和书中全文，结果展示上下文摘要，点击直接跳转到对应页并高亮词语

### v1.0.4
- ✅ **macOS 托盘单击修复** - 解决需要长按才能打开窗口的问题；改为单击显示/隐藏，右键弹出菜单
- ✅ **配置弹窗可滚动** - TTS 配置面板展开后弹窗支持滚动，保存按钮始终可见
- ✅ **TTS 缓存扩容** - 缓存上限从 512MB/200条 提升至 10GB/50,000条
- ✅ **EPUB 解析修复** - 修复开发环境因错误 Python 版本导致 EPUB 解析失败的问题

### v1.0.2
- ✅ **PDF 文本修复增强** - 修复复杂 PDF 中段首下沉首字母被拆开的情况
- ✅ **阅读链路统一规范化** - 文本模式、全文朗读、点词上下文共用同一套 PDF 文本修复规则
- ✅ **Edge TTS 音色扩展** - 新增更多英语区域音色，默认音色调整为 `Aria`
- ✅ **macOS 开发数据对齐** - 开发环境可复用安装版 `userData` 目录

## 📚 核心特性

- ✅ **全平台支持** - 完美适配 Windows (Portable/NSIS) 和 MacOS (DMG/Zip)
- ✅ **本地优先** - 所有数据存储在本地，隐私安全，无需联网
- ✅ **全局内容搜索** - 跨书搜索书名与书中内容（FTS5 全文检索），点击直达对应页面
- ✅ **笔记系统** - 划线高亮 + 评论，持久化存储，支持导出 Markdown
- ✅ **自动更新与文件关联** - 支持 `.epub` / `.pdf` 双击直接打开，内置自动更新检测
- ✅ **系统托盘与全局唤起** - 支持最小化到系统托盘常驻；支持全局快捷键 `Cmd/Ctrl+Shift+Space` 一键唤起查词
- ✅ **多窗口并行阅读** - 支持点击"在新窗口打开"，实现多本图书、图书与生词本的并排对照阅读
- ✅ **智能网络感知** - 内置离线模式检测，断网时自动降级 UI 并禁用 AI 联网功能
- ✅ **AI 深度辅助** - 支持多模型（GPT/Claude/DeepSeek等）辅助阅读与智能问答
- ✅ **沉浸式阅读** - 支持 PDF/EPUB/TXT 阅读，集成 Edge TTS 与本地 Qwen3 TTS 朗读
- ✅ **词典联动** - 支持多种自定义词典（Mdict），内置生词本与智能复习算法（支持导出 CSV/Anki）

## 📖 文档导航

### 用户文档
- **[部署指南](./docs/DEPLOYMENT.md)** - 如何在不同平台安装和部署
- **[数据管理](./docs/DATA_STORAGE.md)** - 数据存储路径、备份与迁移指南
- **[Qwen3 TTS 指南](./docs/TTS_QWEN3.md)** - 本地 Qwen3 TTS 配置、自动启动与排障
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

## 🔄 自动更新与发布

- 桌面端自动更新基于 `electron-updater`，发布源为 GitHub Releases
- 当前自动更新仓库为 `angelwdx/duodushu-desktop`
- 推送形如 `v1.0.5` 的 tag 后，会自动触发 [`.github/workflows/build.yml`](./.github/workflows/build.yml)
- 工作流会分别构建 macOS 和 Windows 安装包，并自动创建 GitHub Release

### 发布新版

```bash
git add -A && git commit -m "feat: ..."
git tag v1.0.x
git push origin main && git push origin v1.0.x
```

详见 [部署指南](./docs/DEPLOYMENT.md)

## 🔧 技术栈

| 模块 | 技术 |
|------|------|
| **外壳框架** | Electron 28+ |
| **前端框架** | Next.js 16 + React 19 |
| **样式系统** | Tailwind CSS 4 |
| **后端引擎** | FastAPI + SQLAlchemy 2.0 |
| **全文搜索** | SQLite FTS5（虚拟表 + 触发器自动同步） |
| **跨系统打包** | electron-builder + PyInstaller |

## 🎯 路线图 (Roadmap)

### v1.0.x（当前稳定版）
- ✅ **全局内容搜索 (FTS5)** — 跨书搜索书名与书中全文，点击结果直达对应页面并高亮
- ✅ **笔记持久化** — 划线笔记存入 SQLite，永久保存，支持导出 Markdown
- ✅ **macOS 托盘单击修复** — 单击即可显示/隐藏窗口
- ✅ **TTS 缓存扩容** — 支持最大 10GB / 50,000 条音频缓存
- ✅ **全局快捷键与原生菜单逻辑重构 (Cmd+F / Cmd+Shift+Space)**
- ✅ **离线模式与网络状态智能检测**
- ✅ **多窗口支持 (Multi-Window Reading)**
- ✅ **系统托盘与双击文件关联支持**
- ✅ **全自动更新流程与生产构建流水线优化 (GitHub Actions)**
- ✅ **本地 Qwen3 TTS 集成与阅读器朗读控制增强**
- ✅ **PDF 下沉首字母修复与朗读/查词文本统一**

> [!TIP]
> 推荐使用 `v1.0.5` 版本以获取当前最完整的桌面端沉浸阅读体验。

## 🤝 贡献与反馈

1. Fork 项目并创建特性分支 (`feature/xxx`)
2. 提交 Issue：[GitHub Issues](https://github.com/angelwdx/duodushu-desktop/issues)
3. 参与讨论：[GitHub Discussions](https://github.com/angelwdx/duodushu-desktop/discussions)

## 📝 许可证

MIT License © 2026 Duodushu Team
