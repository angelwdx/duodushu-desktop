# 多读书 (Duodushu) 桌面客户端

**版本**: 1.1.0
**最后更新**: 2026-02-04

一款**本地优先（Local-First）且支持绿色便携（Portable）**的沉浸式英语学习工作站。

## 🚀 快速开始

### 便携模式（推荐）

1. 下载 `DuoDuShu-Desktop-Portable.exe`
2. 双击运行，无需安装
3. 所有数据存储在 exe 同级的 `data/` 目录
4. 可以整体复制到 U 盘或其他电脑使用

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

- ✅ **绿色便携** - 解压即用，数据随身携带
- ✅ **本地优先** - 所有数据存储在本地，无需上传云端
- ✅ **AI 辅助** - 基于 FTS5 全文搜索，支持智能问答与辅助阅读
- ✅ **自定义词典** - 支持自定义词典，支持生词本与生词复习
- ✅ **语音朗读** - 集成 Edge TTS，提供高质量文本转语音
- ✅ **离线支持** - 基础功能完全离线，AI 功能可选联网

## 📖 文档导航

### 用户文档
- **[快速开始](./docs/DEPLOYMENT.md)** - 如何使用便携版
- **[数据存储](./docs/DATA_STORAGE.md)** - 数据存储位置和迁移指南
- **[故障排查](./docs/TROUBLESHOOTING.md)** - 常见问题和解决方案

### 开发文档
- **[开发指南](./docs/DEVELOPMENT.md)** - 环境设置和开发命令
- **[技术架构](./docs/TDD.md)** - 系统设计和架构
- **[API 文档](./docs/API.md)** - 后端 API 参考
- **[代码约定](./docs/CONVENTIONS.md)** - 代码规范和最佳实践

### 产品文档
- **[产品需求](./docs/PRD.md)** - 功能需求和版本规划

## 🏗️ 项目结构

```
duodushu-desktop/
├── electron/                # Electron 主进程
│   ├── main.ts
│   ├── preload.ts
│   └── tsconfig.json
├── frontend/                # Next.js 前端
│   ├── src/
│   ├── public/
│   └── package.json
├── backend/                 # FastAPI 后端
│   ├── app/
│   ├── requirements.txt
│   └── data/               # 开发数据目录
├── docs/                    # 文档
├── logs/                    # 日志
└── package.json
```

## 🛠️ 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动完整开发环境 |
| `npm run build` | 构建生产版本 |
| `npm run lint` | 代码检查 (前端) |
| `npm run dev:electron` | 仅启动 Electron |

## 📊 三种运行模式

### 1. 开发模式
- 数据存储在 `backend/data/`
- 用于本地开发调试
- 前端热重载，后端自动重启

### 2. 便携模式
- 数据存储在 exe 同级的 `data/` 目录
- 支持解压即用
- 可整体迁移到其他电脑

### 3. 标准安装模式
- 数据存储在系统 AppData 目录
- 遵循 Windows 应用标准
- 支持多用户

详见 [数据存储](./docs/DATA_STORAGE.md)

## 🔧 技术栈

| 模块 | 技术 |
|------|------|
| **应用框架** | Electron 28+ |
| **前端** | Next.js 16 + React 19 + Tailwind CSS 4 |
| **后端** | FastAPI + SQLAlchemy 2.0 |
| **数据库** | SQLite |
| **打包** | electron-builder + PyInstaller |

## 📦 构建和部署

### 构建便携版

```bash
npm run build
```

构建完成后，在 `dist_app/win-unpacked` 目录下找到应用文件。

### 制作便携版

1. 将 `win-unpacked` 重命名为 `Duodushu`
2. 在 `Duodushu` 目录内创建 `data` 文件夹
3. 现在可以整体复制使用

详见 [部署指南](./docs/DEPLOYMENT.md)

## 🐛 故障排查

遇到问题？查看 [故障排查](./docs/TROUBLESHOOTING.md) 文档。

常见问题：
- **后端无法启动** - 检查 Python 版本和依赖
- **前端无法连接后端** - 确保后端已启动
- **便携模式无法工作** - 检查 `data` 目录是否存在

## 🤝 贡献指南

1. Fork 项目
2. 创建特性分支 (`git checkout -b feature/xxx`)
3. 提交更改 (`git commit -m "feat: xxx"`)
4. 推送到分支 (`git push origin feature/xxx`)
5. 创建 Pull Request

详见 [代码约定](./docs/CONVENTIONS.md)

## 📝 许可证

MIT License

## 📞 联系方式

- 提交 Issue：[GitHub Issues](https://github.com/xxx/duodushu-desktop/issues)
- 讨论：[GitHub Discussions](https://github.com/xxx/duodushu-desktop/discussions)

## 🎯 版本规划

### v1.0.0（当前）
- ✅ 核心架构搭建
- ✅ 复用 Web 版所有阅读功能
- ✅ 本地 SQLite 数据库集成
- ✅ 便携模式支持
- ✅ 多模型AI支持

### v1.1 (计划中)
- 文件关联支持 (初步)
- 自动更新支持
- 性能优化

### v2.0（计划中）
- 支持macos、ipad
- 支持移动端

**需要帮助？** 查看 [文档](./docs) 或提交 [Issue](https://github.com/xxx/duodushu-desktop/issues)
