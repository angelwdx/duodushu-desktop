#!/bin/bash

# =================================================================
# Duodushu Dev Server Manager
# =================================================================

# 1. 确保环境变量包含 Homebrew 路径 (针对您的 Mac 环境)
export PATH="/opt/homebrew/bin:$PATH"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

# 2. 清理可能占用的端口 (后端 8000, 前端 3000)
echo "🔍 检查并清理旧进程..."
pkill -f "uvicorn.*8000"
pkill -f "run_backend.py"
pkill -f "next dev"
sleep 1

# 3. 设置数据目录
# 默认使用与安装版一致的数据目录
DATA_DIR="$HOME/Library/Application Support/duodushu-desktop"
if [[ "$1" == "--isolated" ]]; then
    DATA_DIR="$BACKEND_DIR/data"
    echo "📂 已启用隔离模式：使用独立开发版数据目录 ($DATA_DIR)"
else
    echo "🔗 连接正式版数据目录 ($DATA_DIR)"
fi

echo "🚀 数据路径: $DATA_DIR"

# 4. 启动后端 (后台运行)
echo "⚙️  启动后端服务器 (Port 8000)..."
cd "$BACKEND_DIR"
./.venv/bin/python3 run_backend.py --port 8000 --data-dir "$DATA_DIR" > "$ROOT_DIR/backend.log" 2>&1 &
BACKEND_PID=$!

# 5. 启动前端 (后台运行)
echo "🎨 启动前端服务器 (Port 3000)..."
cd "$FRONTEND_DIR"
npm run dev > "$ROOT_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!

echo "----------------------------------------------------"
echo "✅ 全部服务已启动！"
echo "🌐 前端地址: http://localhost:3000"
echo "🔌 后端地址: http://127.0.0.1:8000"
echo "📝 日志文件: backend.log, frontend.log"
echo "💡 按 Ctrl+C 停止所有服务"
echo "----------------------------------------------------"

# 6. 监听退出信号并清理进程
trap "echo '🛑 正在停止服务...'; kill $BACKEND_PID $FRONTEND_PID; exit" SIGINT SIGTERM

# 保持脚本运行，展示实时日志 (可选)
tail -f "$ROOT_DIR/backend.log" "$ROOT_DIR/frontend.log"
