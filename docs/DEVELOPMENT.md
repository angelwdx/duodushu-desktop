# 开发指南

**最后更新**: 2026-02-04

本文档指导开发者如何设置开发环境、运行项目和进行调试。

## 1. 环境准备

### Node.js
确保安装了 Node.js (推荐 v18+)。

在根目录安装依赖：
```bash
npm install
```

前端依赖会自动在 `npm run build:frontend` 时安装，或者你可以手动进入 `frontend` 目录运行 `npm install`。

### Python
确保安装了 Python 3.10+。

建议创建虚拟环境并安装依赖：
```bash
cd backend
# 创建虚拟环境 (可选)
python -m venv .venv

# Windows 激活
.\.venv\Scripts\activate

# macOS/Linux 激活
# source .venv/bin/activate

# 安装依赖 (包含 PyInstaller)
pip install -r requirements.txt
```

## 2. 开发模式

### 启动完整开发环境
同时启动前端、后端和 Electron 窗口进行调试：

```bash
# 在根目录运行
npm run dev
```

该命令会并行执行 `npm run dev:frontend` 和 `npm run dev:electron`。
**注意**：开发模式下数据存储在 `backend/data` 目录。

### 单独启动各个模块

**后端开发**：
```bash
cd backend
python -m uvicorn app.main:app --reload --port 8000
```

**前端开发**：
```bash
cd frontend
npm run dev
```

**Electron 开发**：
```bash
# 需确保前端(3000)和后端(8000)已启动
npm run dev:electron
```

## 3. 调试技巧

### 后端调试
- 使用 `--reload` 标志启用热重载
- 查看日志输出了解请求流程
- **定时任务**: 后端包含 `APScheduler` 定时任务（如每日生词优先级更新），调试时留意日志中的 `apscheduler` 相关输出。
- 使用 Python 调试器：
  ```python
  import pdb; pdb.set_trace()
  ```

### 前端调试
- 使用 Chrome DevTools (F12)
- 查看 Network 标签检查 API 调用
- 使用 React DevTools 浏览器扩展

### Electron 调试
- 在 Electron 窗口中按 F12 打开开发者工具
- 查看 Console 标签了解错误信息
- 使用 `console.log` 或 `lib/logger.ts` 记录日志

## 4. 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动完整开发环境 (Frontend + Electron) |
| `npm run build` | 构建完整生产版本 (Frontend + Backend + Electron + Package) |
| `npm run build:frontend` | 仅构建 Next.js 前端 |
| `npm run build:backend` | 使用 PyInstaller 打包 Python 后端 |
| `npm run build:electron` | 编译 Electron 主进程 |
| `npm run lint` | 运行代码检查 |
| `cd backend && pytest` | 运行后端单元测试 |

## 5. 代码规范

详见 [CONVENTIONS.md](./CONVENTIONS.md)

## 6. 数据库操作

### 查看数据库
```bash
# 使用 SQLite 命令行工具
sqlite3 backend/data/app.db

# 查看所有表
.tables

# 查看表结构
.schema books
```

### 重置数据库
```bash
# 删除现有数据库
rm backend/data/app.db

# 重新启动应用会自动创建新数据库
```

## 7. 常见问题

**Q: 后端无法启动**
- 检查 Python 版本是否 >= 3.10
- 检查依赖是否安装完整：`pip install -r requirements.txt`
- 查看错误日志了解具体问题

**Q: 前端无法连接后端**
- 确保后端已启动在 `http://localhost:8000`
- 检查 `frontend/src/lib/api.ts` 中的 API 基础 URL 配置
- 查看浏览器控制台的网络错误

**Q: Electron 窗口无法打开**
- 检查 Node.js 版本
- 清除 `node_modules` 并重新安装：`rm -rf node_modules && npm install`
- 查看 Electron 日志了解具体错误

更多问题见 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
