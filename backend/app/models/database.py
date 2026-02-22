from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
import os
from dotenv import load_dotenv
from app.config import DB_PATH, BASE_DIR, UPLOADS_DIR, DICTS_DIR

load_dotenv()

# 使用 config.py 中定义的 DB_PATH
# 在 Windows 上，sqlite:///D:\... 可能不稳定，使用绝对路径处理
db_abs_path = os.path.abspath(DB_PATH)
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{db_abs_path}")

# 确保父目录存在
if DB_PATH.parent and not DB_PATH.parent.exists():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

engine = create_engine(
    DATABASE_URL, connect_args={"check_same_thread": False}
)

# 启用 SQLite WAL 模式和 busy_timeout，提升并发读写性能
from sqlalchemy import event

@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# 导出配置常量供其他模块使用
__all__ = ['engine', 'SessionLocal', 'Base', 'get_db', 'BASE_DIR', 'UPLOADS_DIR', 'DICTS_DIR']