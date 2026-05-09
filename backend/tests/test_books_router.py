from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse

from app.routers import books


def test_get_page_thumbnail_reads_from_uploads_dir(tmp_path, monkeypatch):
    """测试缩略图接口会从 uploads 目录定位文件"""
    uploads_dir = tmp_path / "uploads"
    thumbnail_dir = uploads_dir / "thumbnails" / "book-1"
    thumbnail_dir.mkdir(parents=True)
    thumbnail_path = thumbnail_dir / "page_2.png"
    thumbnail_path.write_bytes(b"png")

    monkeypatch.setattr(books, "BASE_DIR", tmp_path)
    monkeypatch.setattr(books, "UPLOADS_DIR", uploads_dir)

    response = books.get_page_thumbnail("book-1", 2)

    assert isinstance(response, FileResponse)
    assert Path(response.path) == thumbnail_path


def test_get_page_thumbnail_returns_404_when_missing(tmp_path, monkeypatch):
    """测试缩略图缺失时返回 404"""
    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir(parents=True)

    monkeypatch.setattr(books, "BASE_DIR", tmp_path)
    monkeypatch.setattr(books, "UPLOADS_DIR", uploads_dir)

    try:
        books.get_page_thumbnail("missing-book", 1)
    except HTTPException as exc:
        assert exc.status_code == 404
        assert exc.detail == "Thumbnail not found"
    else:
        raise AssertionError("Expected HTTPException when thumbnail is missing")
