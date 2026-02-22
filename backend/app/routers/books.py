from typing import Optional
from fastapi import (
    APIRouter,
    UploadFile,
    File,
    BackgroundTasks,
    Depends,
    HTTPException,
    Form,
)
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel, ConfigDict
from datetime import datetime
from pathlib import Path
from ..models.database import get_db, BASE_DIR, UPLOADS_DIR
from ..models.models import Book, Page, ReadingProgress, Vocabulary
from ..services import book_service

router = APIRouter(prefix="/api/books", tags=["books"])


class ProgressUpdate(BaseModel):
    page: int


class BookTypeUpdate(BaseModel):
    book_type: str  # 'normal' | 'example_library'


class BookResponse(BaseModel):
    """Book model for API responses"""

    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    author: Optional[str] = None
    format: str
    file_path: Optional[str] = None
    cover_image: Optional[str] = None
    total_pages: Optional[int] = None
    status: str
    book_type: Optional[str] = None
    created_at: Optional[datetime] = None


@router.post("/upload")
async def upload_book(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    book_type: str = Form("normal"),
    db: Session = Depends(get_db),
):
    # Validate format
    ext = Path(file.filename or "").suffix.lower()
    supported_formats = [".pdf", ".epub", ".txt"]

    if ext not in supported_formats:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported format: {ext}. Supported: PDF, EPUB, TXT",
        )

    # Validate book_type
    if book_type not in ["normal", "example_library"]:
        raise HTTPException(
            status_code=400,
            detail="Invalid book_type. Must be 'normal' or 'example_library'",
        )

    # 1. Save file
    file_id = book_service.save_upload_file(file, file.filename or "unknown")

    # 2. Create DB record
    # UPLOADS_DIR 已经包含了完整路径，存储相对路径
    # 在生产环境 DATA_DIR 就是用户数据目录，uploads/ 在其下
    file_path = f"uploads/{file_id}{ext}"
    format_name = ext[1:]  # Remove dot: .pdf -> pdf
    book_id = book_service.create_book_record(db, file.filename or "Unknown", file_path, format_name, book_type)

    # 3. Trigger background task
    background_tasks.add_task(book_service.verify_and_process_book_task, book_id)

    return {"status": "processing", "book_id": book_id}


@router.get("/cover/{filename}")
def get_book_cover(filename: str):
    """Serve book cover image"""
    # 检查路径遍历攻击
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    covers_dir = UPLOADS_DIR / "covers"
    file_path = covers_dir / filename

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Cover not found")

    return FileResponse(file_path)


@router.delete("/{book_id}")
def delete_book(book_id: str, db: Session = Depends(get_db)):
    """Delete a book and its associated data"""
    book = db.query(Book).filter(Book.id == book_id).first()
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")

    # 1. Delete associated pages
    db.query(Page).filter(Page.book_id == book_id).delete()

    # 2. Delete reading progress
    db.query(ReadingProgress).filter(ReadingProgress.book_id == book_id).delete()

    # 3. Delete files
    try:
        # Delete book file
        book_path_str = book.file_path if isinstance(book.file_path, str) else None
        if book_path_str is not None:
            # 提取文件名，从 UPLOADS_DIR 删除
            filename = Path(book_path_str).name
            book_path = (UPLOADS_DIR / filename).resolve()
            if book_path.exists():
                Path(book_path).unlink()

        # Delete cover image
        if book.cover_image is not None:
            cover_path = (UPLOADS_DIR / "covers" / book.cover_image).resolve()
            if cover_path.exists():
                Path(cover_path).unlink()
    except Exception as e:
        print(f"Error deleting files: {e}")

    # 4. Unlink vocabulary (Preserve words, just remove book association)
    db.query(Vocabulary).filter(Vocabulary.book_id == book_id).update({Vocabulary.book_id: None})

    # 5. Delete book record
    db.delete(book)
    db.commit()

    return {"status": "success", "message": "Book deleted"}


@router.get("/{book_id}/status")
def get_book_status(book_id: str, db: Session = Depends(get_db)):
    book = db.query(Book).filter(Book.id == book_id).first()
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")

    # Get reading progress
    progress = db.query(ReadingProgress).filter(ReadingProgress.book_id == book_id).first()
    last_page = progress.current_page if progress else 1

    # Use API endpoint for content to ensure CORS is handled
    download_url = f"/api/books/{book_id}/content"

    return {
        "id": book.id,
        "status": book.status,
        "title": book.title,
        "format": book.format,
        "total_pages": book.total_pages,
        "download_url": download_url,
        "cover_image": book.cover_image,
        "last_page": last_page,
    }


@router.post("/{book_id}/progress")
def save_progress(book_id: str, data: ProgressUpdate, db: Session = Depends(get_db)):
    """Save reading progress for a book"""
    book = db.query(Book).filter(Book.id == book_id).first()
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")

    # Update or create progress record
    progress = db.query(ReadingProgress).filter(ReadingProgress.book_id == book_id).first()
    if progress:
        progress.current_page = data.page  # type: ignore
    else:
        progress = ReadingProgress(book_id=book_id, current_page=data.page)
        db.add(progress)

    db.commit()
    return {"success": True, "page": data.page}


@router.get("/thumbnail/{book_id}/{page_number}")
def get_page_thumbnail(book_id: str, page_number: int):
    """Serve page thumbnail image"""
    from ..services.thumbnail_service import ThumbnailService

    thumbnail_service = ThumbnailService(BASE_DIR)
    thumbnail_path = thumbnail_service.get_thumbnail_path(book_id, page_number)

    if not thumbnail_path:
        raise HTTPException(status_code=404, detail="Thumbnail not found")

    full_path = (BASE_DIR / thumbnail_path).resolve()
    if not full_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail file missing")

    return FileResponse(full_path)


@router.get("/{book_id}/content")
def get_book_content(book_id: str, db: Session = Depends(get_db)):
    book = db.query(Book).filter(Book.id == book_id).first()

    if not book:
        raise HTTPException(status_code=404, detail="Book content not found")

    # book.file_path 可能是 "uploads/xxx.epub" 或 "data/uploads/xxx.epub"
    # 提取文件名后从 UPLOADS_DIR 读取
    book_path_str = book.file_path if isinstance(book.file_path, str) else None
    if book_path_str is None:
        raise HTTPException(status_code=404, detail="Book content file missing")

    filename = Path(book_path_str).name
    full_path = (UPLOADS_DIR / filename).resolve()

    if not full_path.exists():
        raise HTTPException(status_code=404, detail="Book content file missing")

    # 根据文件格式确定 MIME 类型
    ext = full_path.suffix.lower()
    mime_types = {
        ".pdf": "application/pdf",
        ".epub": "application/epub+zip",
        ".txt": "text/plain; charset=utf-8",
    }
    media_type = mime_types.get(ext, "application/octet-stream")

    return FileResponse(str(full_path), media_type=media_type, content_disposition_type="inline")


@router.get("/{book_id}/pages/{page_number}")
def get_book_page(book_id: str, page_number: int, db: Session = Depends(get_db)):
    page = db.query(Page).filter(Page.book_id == book_id, Page.page_number == page_number).first()

    if not page:
        raise HTTPException(status_code=404, detail="Page not found")

    return {
        "page_number": page.page_number,
        "text_content": page.text_content,
        "words_data": page.words_data,
        "images": page.images,
    }


@router.get("/", response_model=list[BookResponse])
def list_books(db: Session = Depends(get_db)):
    books = db.query(Book).all()
    return books


@router.patch("/{book_id}/type")
def update_book_type(book_id: str, data: BookTypeUpdate, db: Session = Depends(get_db)):
    """更新书籍类型"""
    book = db.query(Book).filter(Book.id == book_id).first()
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")

    # 简化验证：只支持两种类型
    if data.book_type not in ["normal", "example_library"]:
        raise HTTPException(
            status_code=400,
            detail="Invalid book_type. Must be 'normal' or 'example_library'",
        )

    book.book_type = data.book_type  # type: ignore
    db.commit()
    db.refresh(book)

    return {
        "status": "success",
        "book_id": book.id,
        "book_type": book.book_type,
        "book_title": book.title,
        "is_example_library": book.book_type == "example_library",
    }
