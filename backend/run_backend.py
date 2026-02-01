import os
import sys
import argparse
import uvicorn
from pathlib import Path

# 添加当前目录到 sys.path，确保能导入 app 模块
sys.path.append(os.path.dirname(os.path.abspath(__file__)))


def main():
    parser = argparse.ArgumentParser(description="Duodushu Backend Server")
    parser.add_argument("--port", type=int, default=8000, help="Port to run server on")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind")
    parser.add_argument("--data-dir", type=str, help="Path to data directory")

    args = parser.parse_args()

    # 设置环境变量，供 app.config 使用
    # 注意：必须在导入 app.main 之前设置！
    if args.data_dir:
        # 确保转换为绝对路径，并验证路径有效性
        data_path = Path(args.data_dir).resolve()

        # 验证路径是否可访问
        try:
            data_path.mkdir(parents=True, exist_ok=True)
            os.environ["APP_DATA_DIR"] = str(data_path)
            print(f"[Backend] Data directory set to: {data_path}")
        except Exception as e:
            print(f"[Backend] Warning: Failed to create/access data directory {data_path}: {e}")
            print(f"[Backend] Will use default data directory")
    else:
        print(f"[Backend] No --data-dir specified, using default data directory")

    # 导入 app (必须在设置环境变量之后)
    try:
        from app.main import app
    except Exception as e:
        import traceback

        error_msg = traceback.format_exc()
        log_path = Path("backend_startup_error.txt")
        if args.data_dir:
            log_path = Path(args.data_dir) / "backend_startup_error.txt"

        with open(log_path, "w", encoding="utf-8") as f:
            f.write(f"Failed to import app:\n{error_msg}")

        print(f"[Backend] Failed to import app: {e}")
        sys.exit(1)

    print(f"[Backend] Starting server on {args.host}:{args.port}")

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
