"""测试 ThumbnailService 使用正确的路径"""

import pytest
import tempfile
import shutil
from pathlib import Path
from app.services.thumbnail_service import ThumbnailService


class TestThumbnailServiceInit:
    """测试 ThumbnailService 初始化"""

    def test_init_with_uploads_dir(self):
        """测试使用 uploads_dir 参数初始化"""
        temp_dir = tempfile.mkdtemp()
        uploads_dir = Path(temp_dir) / "uploads"

        service = ThumbnailService(uploads_dir)

        assert service.uploads_dir == uploads_dir

        shutil.rmtree(temp_dir)


class TestThumbnailServiceGetThumbnailsDir:
    """测试 get_thumbnails_dir 方法"""

    def test_get_thumbnails_dir_creates_directory(self):
        """测试缩略图目录自动创建"""
        temp_dir = tempfile.mkdtemp()
        uploads_dir = Path(temp_dir) / "uploads"

        service = ThumbnailService(uploads_dir)
        book_id = "test-book-123"

        thumbnails_dir = service.get_thumbnails_dir(book_id)

        # 验证目录路径正确
        expected_dir = uploads_dir / "thumbnails" / book_id
        assert thumbnails_dir == expected_dir

        # 验证目录已创建
        assert thumbnails_dir.exists()
        assert thumbnails_dir.is_dir()

        shutil.rmtree(temp_dir)

    def test_get_thumbnails_dir_path_structure(self):
        """测试缩略图目录路径结构"""
        temp_dir = tempfile.mkdtemp()
        uploads_dir = Path(temp_dir) / "uploads"

        service = ThumbnailService(uploads_dir)
        book_id = "test-book-456"

        thumbnails_dir = service.get_thumbnails_dir(book_id)

        # 验证路径结构：uploads_dir/thumbnails/{book_id}
        assert "thumbnails" in str(thumbnails_dir)
        assert book_id in str(thumbnails_dir)
        assert str(uploads_dir) in str(thumbnails_dir)

        shutil.rmtree(temp_dir)


class TestThumbnailServiceGetThumbnailPath:
    """测试 get_thumbnail_path 方法"""

    def test_get_thumbnail_path_relative_path(self):
        """测试返回相对路径格式"""
        temp_dir = tempfile.mkdtemp()
        uploads_dir = Path(temp_dir) / "uploads"
        uploads_dir.mkdir()

        service = ThumbnailService(uploads_dir)
        book_id = "test-book-789"
        page_number = 5

        # 创建测试缩略图（使用正确的路径）
        thumbnails_dir = uploads_dir / "thumbnails" / book_id
        thumbnails_dir.mkdir(parents=True, exist_ok=True)
        thumbnail_file = thumbnails_dir / f"page_{page_number}.png"
        thumbnail_file.write_text("dummy content")

        # 获取相对路径
        relative_path = service.get_thumbnail_path(book_id, page_number)

        # 验证返回相对路径
        assert relative_path is not None
        assert "uploads/thumbnails" in relative_path
        assert book_id in relative_path
        assert f"page_{page_number}.png" in relative_path

        shutil.rmtree(temp_dir)

    def test_get_thumbnail_path_not_exists(self):
        """测试缩略图不存在时返回 None"""
        temp_dir = tempfile.mkdtemp()
        uploads_dir = Path(temp_dir) / "uploads"
        uploads_dir.mkdir()

        service = ThumbnailService(uploads_dir)
        book_id = "test-book-999"
        page_number = 10

        # 不创建缩略图
        relative_path = service.get_thumbnail_path(book_id, page_number)

        # 验证返回 None
        assert relative_path is None

        shutil.rmtree(temp_dir)


class TestThumbnailServiceDeleteThumbnails:
    """测试 delete_thumbnails 方法"""

    def test_delete_thumbnails(self):
        """测试删除缩略图"""
        temp_dir = tempfile.mkdtemp()
        uploads_dir = Path(temp_dir) / "uploads"

        service = ThumbnailService(uploads_dir)
        book_id = "test-book-delete"

        # 创建缩略图
        thumbnails_dir = service.get_thumbnails_dir(book_id)
        (thumbnails_dir / "page_1.png").write_text("dummy")
        (thumbnails_dir / "page_2.png").write_text("dummy")

        # 验证缩略图存在
        assert thumbnails_dir.exists()
        assert len(list(thumbnails_dir.glob("*.png"))) == 2

        # 删除缩略图
        service.delete_thumbnails(book_id)

        # 验证缩略图已删除
        assert not thumbnails_dir.exists()

        shutil.rmtree(temp_dir)

    def test_delete_thumbnails_not_exists(self):
        """测试删除不存在的缩略图目录"""
        temp_dir = tempfile.mkdtemp()
        uploads_dir = Path(temp_dir) / "uploads"

        service = ThumbnailService(uploads_dir)
        book_id = "test-book-not-exist"

        # 不创建缩略图目录
        # 删除操作应该不会抛出异常
        try:
            service.delete_thumbnails(book_id)
            # 如果执行到这里，说明没有抛出异常
            assert True
        except Exception as e:
            pytest.fail(f"delete_thumbnails 抛出了异常: {e}")

        shutil.rmtree(temp_dir)
