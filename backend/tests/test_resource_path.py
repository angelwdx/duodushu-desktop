"""测试资源文件路径回退逻辑（简化版本）"""

import pytest
from pathlib import Path
from app import config


class TestGetResourcePath:
    """测试 get_resource_path 函数"""

    def test_get_resource_path_returns_path(self):
        """测试 get_resource_path 返回 Path 对象"""
        test_fallback = Path("/tmp/fallback")
        result = config.get_resource_path("test_file.txt", test_fallback)

        assert isinstance(result, Path)

    def test_get_resource_path_user_dir_priority(self):
        """测试用户数据目录优先级"""
        # 创建测试文件在 DATA_DIR
        test_file = config.DATA_DIR / "test_resource.txt"
        test_file.write_text("test content")

        try:
            # 调用 get_resource_path
            fallback = Path("/tmp/fallback")
            result = config.get_resource_path("test_resource.txt", fallback)

            # 验证返回 DATA_DIR 中的文件
            assert result == test_file
        finally:
            # 清理
            if test_file.exists():
                test_file.unlink()

    def test_get_resource_path_fallback_when_not_exists(self):
        """测试文件不存在时返回 fallback"""
        # 使用不存在的文件名
        non_existent = "non_existent_file_xyz.txt"
        test_fallback = Path("/tmp/test_fallback")

        result = config.get_resource_path(non_existent, test_fallback)

        # 验证返回 fallback
        assert result == test_fallback


class TestECDICT_DB_PATH:
    """测试 ECDICT_DB_PATH 配置"""

    def test_ecdict_db_path_configured(self):
        """测试 ECDICT_DB_PATH 正确配置"""
        assert isinstance(config.ECDICT_DB_PATH, Path)

    def test_ecdict_db_path_filename(self):
        """测试 ECDICT_DB_PATH 文件名正确"""
        assert config.ECDICT_DB_PATH.name == "ecdict.db"

    def test_ecdict_db_path_absolute(self):
        """测试 ECDICT_DB_PATH 是绝对路径"""
        assert config.ECDICT_DB_PATH.is_absolute()


class TestOPEN_DICT_DB_PATH:
    """测试 OPEN_DICT_DB_PATH 配置"""

    def test_open_dict_db_path_configured(self):
        """测试 OPEN_DICT_DB_PATH 正确配置"""
        assert isinstance(config.OPEN_DICT_DB_PATH, Path)

    def test_open_dict_db_path_filename(self):
        """测试 OPEN_DICT_DB_PATH 文件名正确"""
        assert config.OPEN_DICT_DB_PATH.name == "open_dict.db"

    def test_open_dict_db_path_absolute(self):
        """测试 OPEN_DICT_DB_PATH 是绝对路径"""
        assert config.OPEN_DICT_DB_PATH.is_absolute()
