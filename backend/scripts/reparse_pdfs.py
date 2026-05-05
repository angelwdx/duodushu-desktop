#!/usr/bin/env python3
"""
PDF 重解析脚本

对数据库中所有 PDF 书籍重新运行解析器，更新 pages.text_content
和 pages.words_data，使其受益于最新的多栏检测优化。

用法：
    cd /Users/tachikoma/build/duodushu-desktop/backend
    .venv/bin/python scripts/reparse_pdfs.py

可选参数：
    --book-id <id>   只重解析指定书籍
    --dry-run        只列出待处理书籍，不实际写入数据库
"""

import sys
import os
import argparse
import logging
import json
from pathlib import Path

# 确保能找到 app 包
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.parsers.pdf_parser import PDFParser
from app.models.database import SessionLocal, UPLOADS_DIR
from sqlalchemy import text

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)


def resolve_book_path(file_path: str) -> Path:
    """兼容历史相对路径格式，统一解析到真实上传文件路径。"""
    path = Path(file_path)
    if path.is_absolute():
        return path

    parts = list(path.parts)
    if "uploads" in parts:
        upload_idx = parts.index("uploads")
        return (UPLOADS_DIR / Path(*parts[upload_idx + 1 :])).resolve()

    return (UPLOADS_DIR / path.name).resolve()


def reparse_book(db, book_id: str, file_path: Path, dry_run: bool = False) -> bool:
    """重解析单本 PDF，更新所有页面的文本和单词坐标。"""
    if not file_path.exists():
        logger.warning(f"  [跳过] 文件不存在: {file_path}")
        return False

    logger.info(f"  解析中... {file_path.name}")
    try:
        parser = PDFParser()
        result = parser.parse(str(file_path), book_id)
        pages = result.get("pages", [])
        logger.info(f"  解析完成，共 {len(pages)} 页")

        if dry_run:
            logger.info("  [dry-run] 跳过数据库写入")
            return True

        for page in pages:
            page_num = page["page_number"]
            text_content = page.get("text_content", "")
            words_data = page.get("words_data", [])

            # 检查是否已有该页记录
            existing = db.execute(
                text("SELECT id FROM pages WHERE book_id = :book_id AND page_number = :page_num"),
                {"book_id": book_id, "page_num": page_num},
            ).fetchone()

            if existing:
                db.execute(
                    text("""
                        UPDATE pages
                        SET text_content = :text_content, words_data = :words_data
                        WHERE book_id = :book_id AND page_number = :page_num
                    """),
                    {
                        "book_id": book_id,
                        "page_num": page_num,
                        "text_content": text_content,
                        "words_data": json.dumps(words_data, ensure_ascii=False),
                    },
                )
            else:
                db.execute(
                    text("""
                        INSERT INTO pages (book_id, page_number, text_content, words_data, images)
                        VALUES (:book_id, :page_num, :text_content, :words_data, '[]')
                    """),
                    {
                        "book_id": book_id,
                        "page_num": page_num,
                        "text_content": text_content,
                        "words_data": json.dumps(words_data, ensure_ascii=False),
                    },
                )

        db.commit()
        logger.info(f"  已写入 {len(pages)} 页到数据库")
        return True

    except Exception as e:
        db.rollback()
        logger.error(f"  [失败] {e}", exc_info=True)
        return False


def main():
    parser = argparse.ArgumentParser(description="重解析数据库中的 PDF 书籍")
    parser.add_argument("--book-id", help="只重解析指定书籍 ID")
    parser.add_argument("--dry-run", action="store_true", help="仅列出，不写入")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        if args.book_id:
            rows = db.execute(
                text("SELECT id, file_path, title FROM books WHERE id = :id AND format = 'pdf'"),
                {"id": args.book_id},
            ).fetchall()
        else:
            rows = db.execute(
                text("SELECT id, file_path, title FROM books WHERE format = 'pdf' ORDER BY created_at")
            ).fetchall()

        if not rows:
            logger.info("未找到 PDF 书籍。")
            return

        logger.info(f"找到 {len(rows)} 本 PDF 书籍{'（dry-run 模式）' if args.dry_run else ''}：")
        success = 0
        failed = 0

        for row in rows:
            book_id, file_path, title = row[0], row[1], row[2]
            resolved_path = resolve_book_path(file_path)

            logger.info(f"\n[{book_id[:8]}...] {title}")
            ok = reparse_book(db, book_id, resolved_path, dry_run=args.dry_run)
            if ok:
                success += 1
            else:
                failed += 1

        logger.info(f"\n完成：成功 {success}，失败 {failed}，共 {len(rows)} 本。")

    finally:
        db.close()


if __name__ == "__main__":
    main()
