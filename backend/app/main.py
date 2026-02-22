from fastapi import FastAPI, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from .routers import (
    books,
    dictionary,
    tts,
    vocabulary,
    vocabulary_snippet,
    bookmarks,
    ai,
    rag,
    dicts,
    test as test_router,
    config,
)
from app.models import models
from .models.database import engine, SessionLocal
from app.config import BASE_DIR
from apscheduler.schedulers.background import BackgroundScheduler
from datetime import datetime
import atexit
import os
import logging

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler()],
    force=True,  # 强制重新配置
)

logger = logging.getLogger(__name__)

# 创建后台调度器
# 创建后台调度器
scheduler = BackgroundScheduler()


def scheduled_priority_update():
    """每天凌晨3点更新所有单词优先级"""
    logger.info(f"🕒 [{datetime.utcnow()}] 开始定时更新单词优先级...")

    db = SessionLocal()
    try:
        from .routers.vocabulary import update_all_priorities

        result = update_all_priorities(db)
        logger.info(f"✅ 定时更新完成: {result}")
    except Exception as e:
        logger.error(f"❌ 定时更新失败: {e}", exc_info=True)
    finally:
        db.close()


# 添加定时任务：每天凌晨3点
scheduler.add_job(scheduled_priority_update, "cron", hour=3, minute=0, id="daily_priority_update")

from contextlib import asynccontextmanager


def _migrate_word_contexts_unique_index(db_path: str):
    """
    迁移：为 word_contexts 表添加唯一索引
    
    步骤：
    1. 检查唯一索引是否已存在（幂等）
    2. 清理已存在的重复数据（保留 id 最小的记录）
    3. 创建唯一索引
    """
    import sqlite3
    
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # 检查索引是否已存在
        existing_indexes = cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='uq_word_context'"
        ).fetchone()
        
        if existing_indexes:
            logger.info("word_contexts 唯一索引已存在，跳过迁移")
            conn.close()
            return
        
        # 统计重复数据
        duplicates = cursor.execute("""
            SELECT word, book_id, page_number, context_sentence, COUNT(*) as cnt
            FROM word_contexts
            GROUP BY word, book_id, page_number, context_sentence
            HAVING cnt > 1
        """).fetchall()
        
        if duplicates:
            logger.info(f"发现 {len(duplicates)} 组重复的 word_contexts 记录，开始清理...")
            
            # 删除重复记录（保留每组中 id 最小的）
            cursor.execute("""
                DELETE FROM word_contexts
                WHERE id NOT IN (
                    SELECT MIN(id)
                    FROM word_contexts
                    GROUP BY word, book_id, page_number, context_sentence
                )
            """)
            deleted = cursor.rowcount
            logger.info(f"已清理 {deleted} 条重复的 word_contexts 记录")
        
        # 创建唯一索引
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS uq_word_context
            ON word_contexts(word, book_id, page_number, context_sentence)
        """)
        
        conn.commit()
        logger.info("word_contexts 唯一索引创建成功")
        
    except Exception as e:
        logger.error(f"word_contexts 迁移失败: {e}")
    finally:
        if conn:
            conn.close()

def ensure_fts5_index(db_path: str):
    """
    确保 FTS5 全文搜索索引存在
    
    在应用启动时自动执行，创建 pages_fts 虚拟表和同步触发器。
    这是幂等操作，使用 IF NOT EXISTS 避免重复创建。
    """
    import sqlite3
    
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # 检查 FTS5 是否可用
        try:
            cursor.execute("CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_test USING fts5(t);")
            cursor.execute("DROP TABLE IF EXISTS _fts5_test;")
        except sqlite3.OperationalError as e:
            if "no such module: fts5" in str(e):
                logger.error("FTS5 模块不可用，例句提取功能将无法正常工作")
                return False
            raise
        
        # 创建 pages_fts 虚拟表
        cursor.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
                id UNINDEXED,
                book_id UNINDEXED,
                page_number UNINDEXED,
                text_content,
                content='pages',
                content_rowid='id'
            );
        """)
        
        # 检查是否需要同步数据（仅当 pages_fts 为空且 pages 有数据时）
        fts_count = cursor.execute("SELECT COUNT(*) FROM pages_fts").fetchone()[0]
        pages_count = cursor.execute("SELECT COUNT(*) FROM pages WHERE text_content IS NOT NULL").fetchone()[0]
        
        if fts_count == 0 and pages_count > 0:
            logger.info(f"同步 {pages_count} 页到 FTS5 索引...")
            cursor.execute("""
                INSERT OR REPLACE INTO pages_fts(id, book_id, page_number, text_content)
                SELECT id, book_id, page_number, text_content
                FROM pages
                WHERE text_content IS NOT NULL;
            """)
            logger.info(f"FTS5 索引同步完成")
        
        # 创建自动同步触发器（INSERT）
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
                INSERT INTO pages_fts(id, book_id, page_number, text_content)
                VALUES (NEW.id, NEW.book_id, NEW.page_number, NEW.text_content);
            END;
        """)
        
        # 创建自动同步触发器（UPDATE）
        # 对于 FTS5 外部内容表，更新时需先删除旧行再插入新行
        cursor.execute("DROP TRIGGER IF EXISTS pages_au;")
        cursor.execute("""
            CREATE TRIGGER pages_au AFTER UPDATE ON pages BEGIN
                INSERT INTO pages_fts(pages_fts, id) VALUES('delete', OLD.id);
                INSERT INTO pages_fts(id, book_id, page_number, text_content)
                VALUES (NEW.id, NEW.book_id, NEW.page_number, NEW.text_content);
            END;
        """)
        
        # 创建自动同步触发器（DELETE）
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
                INSERT INTO pages_fts(pages_fts, id) VALUES('delete', OLD.id);
            END;
        """)
        
        conn.commit()
        logger.info("FTS5 全文搜索索引初始化完成")
        return True
        
    except Exception as e:
        logger.error(f"FTS5 初始化失败: {e}")
        return False
    finally:
        if conn:
            conn.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Initialize database and start scheduler
    # 创建数据库表并迁移
    logger.info("初始化数据库...")
    try:
        models.Base.metadata.create_all(bind=engine)
        logger.info("数据库表创建完成")

        # 迁移：添加新列到现有表
        from sqlalchemy import inspect, text

        inspector = inspect(engine)

        # 检查 vocabulary 表是否有缺失的列
        with engine.connect() as conn:
            existing_columns = [col["name"] for col in inspector.get_columns("vocabulary")]
            new_columns = {
                "query_count": "ALTER TABLE vocabulary ADD COLUMN query_count INTEGER DEFAULT 0",
                "last_queried_at": "ALTER TABLE vocabulary ADD COLUMN last_queried_at TIMESTAMP",
                "priority_score": "ALTER TABLE vocabulary ADD COLUMN priority_score REAL DEFAULT 0.0",
                "learning_status": 'ALTER TABLE vocabulary ADD COLUMN learning_status VARCHAR DEFAULT "new"',
            }

            for col_name, alter_sql in new_columns.items():
                if col_name not in existing_columns:
                    try:
                        conn.execute(text(alter_sql))
                        conn.commit()
                        logger.info(f"已添加列: vocabulary.{col_name}")
                    except Exception as e:
                        logger.warning(f"添加列 {col_name} 失败（可能已存在）: {e}")

        # 初始化 FTS5 全文搜索索引（用于例句提取功能）
        from app.config import DB_PATH
        ensure_fts5_index(str(DB_PATH))

        # 迁移：为 word_contexts 表添加唯一索引（先清理重复数据）
        _migrate_word_contexts_unique_index(str(DB_PATH))

    except Exception as e:
        logger.error(f"数据库初始化失败: {e}")


    # 启动调度器
    logger.info("启动后台任务调度器...")
    try:
        scheduler.start()
        
        # 启动自检：直接触发一次优先级更新（针对本地客户端补更）
        import threading
        logger.info("触发启动补更：在后台线程中更新单词优先级...")
        threading.Thread(target=scheduled_priority_update, daemon=True).start()
        
    except Exception as e:
        logger.warning(f"调度器启动警告: {e}")
    yield
    # Shutdown: Stop scheduler
    logger.info("关闭后台任务调度器...")
    if scheduler.running:
        scheduler.shutdown()


app = FastAPI(title="多读书 - duodushu API", lifespan=lifespan)

# 允许跨域
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
        "app://.",  # Allow specific app origin
        "app://duodushu-desktop",  # Allow specific app origin
        "*",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

app.include_router(books.router)
app.include_router(dictionary.router)
app.include_router(tts.router)
app.include_router(vocabulary.router)
app.include_router(bookmarks.router)
app.include_router(ai.router)
app.include_router(rag.router)
app.include_router(dicts.router)
app.include_router(config.router)
app.include_router(test_router.router)

# 挂载静态目录
from .config import UPLOADS_DIR

app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")
# app.mount("/extracted", StaticFiles(directory="extracted"), name="extracted")


@app.get("/")
def read_root():
    return {"message": "Welcome to Immersive English API"}


@app.get("/health")
def health_check():
    return {"status": "ok"}
