from sqlalchemy.orm import Session
from ..models.models import Book, Page
from ..models.database import SessionLocal, BASE_DIR, UPLOADS_DIR
from ..parsers.factory import ParserFactory
import uuid
import os
import shutil
import json
from pathlib import Path
import logging

logger = logging.getLogger(__name__)


def save_upload_file(file, filename: str) -> str:
    """保存上传文件到本地"""
    file_id = str(uuid.uuid4())
    ext = Path(filename).suffix
    safe_filename = f"{file_id}{ext}"

    # 使用配置的 UPLOADS_DIR
    upload_dir_path = UPLOADS_DIR
    upload_dir_path.mkdir(parents=True, exist_ok=True)

    file_path = upload_dir_path / safe_filename

    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return file_id  # 返回文件 ID，路径格式由 book_service 内部处理


def create_book_record(db: Session, title: str, file_path: str, file_format: str, book_type: str = "normal") -> str:
    """创建书籍数据库记录"""
    book_id = str(uuid.uuid4())
    book = Book(
        id=book_id,
        title=title,
        file_path=file_path,
        format=file_format,
        book_type=book_type,
        status="processing",
    )
    db.add(book)
    db.commit()
    db.refresh(book)
    return book_id


def verify_and_process_book_task(book_id: str):
    """后台任务：解析书籍并入库"""
    db = SessionLocal()
    book = None
    try:
        book = db.query(Book).filter(Book.id == book_id).first()
        if not book:
            logger.error(f"Book {book_id} not found processing task.")
            return

        # 获取文件路径
        book_path_str = book.file_path if isinstance(book.file_path, str) else None
        if book_path_str is None:
            logger.error(f"Book {book_id} has no file path.")
            book.status = "failed"  # type: ignore
            db.commit()
            return

        # 解析文件名（从路径中提取文件名）
        # 支持 formats: "uploads/xxx.epub", "data/uploads/xxx.epub", "xxx.epub"
        path_obj = Path(book_path_str)
        filename = path_obj.name

        # 统一从 UPLOADS_DIR 读取文件
        full_file_path = (UPLOADS_DIR / filename).resolve()

        logger.info(f"Processing book {book_id}: {filename}, path: {full_file_path}")

        if not full_file_path.exists():
            logger.error(f"File not found: {full_file_path}")
            book.status = "failed"  # type: ignore
            db.commit()
            return

        parser = ParserFactory.get_parser(str(full_file_path))
        result = parser.parse(str(full_file_path), book_id)

        # Update book metadata
        # Only update title if parser found a real title, not just the filename (which is a UUID)
        parsed_title = result.get("title")
        file_stem = full_file_path.stem
        
        logger.info(f"Book {book_id} Title Check - Original: '{book.title}', Parsed: '{parsed_title}', FileStem: '{file_stem}'")
        
        if parsed_title:
             # Case-insensitive check and stripping just in case
             if parsed_title.lower().strip() != file_stem.lower().strip():
                 book.title = parsed_title
             else:
                 logger.info(f"Skipping title update: Parsed title '{parsed_title}' matches file stem (likely UUID).")
            
        book.author = result.get("author")  # type: ignore
        book.total_pages = result.get("total_pages")  # type: ignore
        book.cover_image = result.get("cover_image")  # type: ignore

        # Save pages (批量插入，提升大型书籍的入库性能)
        pages_data = result.get("pages", [])
        batch_size = 500
        for i in range(0, len(pages_data), batch_size):
            batch = pages_data[i:i + batch_size]
            page_objects = [
                Page(
                    book_id=book_id,
                    page_number=p["page_number"],
                    text_content=p["text_content"],
                    words_data=p["words_data"],
                    images=p["images"],
                )
                for p in batch
            ]
            db.bulk_save_objects(page_objects)
            db.flush()  # 刷新到数据库但不提交，确保触发器执行

        book.status = "completed"  # type: ignore
        db.commit()

        logger.info(f"Book {book_id} processing completed: {len(pages_data)} pages")
    except Exception as e:
        logger.error(f"Error processing book {book_id}: {e}", exc_info=True)
        if book is not None:
            book.status = "failed"  # type: ignore
            db.commit()
    finally:
        db.close()
