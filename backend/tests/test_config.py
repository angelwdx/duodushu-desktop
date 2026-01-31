"""测试 config.py 中的路径计算逻辑（简化版本）"""

import pytest
from pathlib import Path
from app import config


class TestConfigBaseDir:
    """测试 BASE_DIR 配置"""

    def test_base_dir_is_path(self):
        """测试 BASE_DIR 是 Path 对象"""
        assert isinstance(config.BASE_DIR, Path)

    def test_base_dir_is_absolute(self):
        """测试 BASE_DIR 是绝对路径"""
        assert config.BASE_DIR.is_absolute()


class TestConfigDataDir:
    """测试 DATA_DIR 配置"""

    def test_data_dir_is_path(self):
        """测试 DATA_DIR 是 Path 对象"""
        assert isinstance(config.DATA_DIR, Path)

    def test_data_dir_is_absolute(self):
        """测试 DATA_DIR 是绝对路径"""
        assert config.DATA_DIR.is_absolute()

    def test_data_dir_exists(self):
        """测试 DATA_DIR 存在"""
        assert config.DATA_DIR.exists()
        assert config.DATA_DIR.is_dir()


class TestConfigUploadsDir:
    """测试 UPLOADS_DIR 配置"""

    def test_uploads_dir_is_path(self):
        """测试 UPLOADS_DIR 是 Path 对象"""
        assert isinstance(config.UPLOADS_DIR, Path)

    def test_uploads_dir_is_absolute(self):
        """测试 UPLOADS_DIR 是绝对路径"""
        assert config.UPLOADS_DIR.is_absolute()

    def test_uploads_dir_exists(self):
        """测试 UPLOADS_DIR 存在"""
        assert config.UPLOADS_DIR.exists()
        assert config.UPLOADS_DIR.is_dir()

    def test_uploads_dir_based_on_data_dir(self):
        """测试 UPLOADS_DIR 基于 DATA_DIR 计算"""
        # 验证 UPLOADS_DIR 的父目录是 DATA_DIR
        assert config.UPLOADS_DIR.parent == config.DATA_DIR


class TestConfigDictsDir:
    """测试 DICTS_DIR 配置"""

    def test_dicts_dir_is_path(self):
        """测试 DICTS_DIR 是 Path 对象"""
        assert isinstance(config.DICTS_DIR, Path)

    def test_dicts_dir_is_absolute(self):
        """测试 DICTS_DIR 是绝对路径"""
        assert config.DICTS_DIR.is_absolute()

    def test_dicts_dir_exists(self):
        """测试 DICTS_DIR 存在"""
        assert config.DICTS_DIR.exists()
        assert config.DICTS_DIR.is_dir()


class TestConfigDBPath:
    """测试 DB_PATH 配置"""

    def test_db_path_is_path(self):
        """测试 DB_PATH 是 Path 对象"""
        assert isinstance(config.DB_PATH, Path)

    def test_db_path_is_absolute(self):
        """测试 DB_PATH 是绝对路径"""
        assert config.DB_PATH.is_absolute()

    def test_db_path_filename(self):
        """测试 DB_PATH 文件名正确"""
        assert config.DB_PATH.name == "app.db"


class TestConfigECDICT_DB_PATH:
    """测试 ECDICT_DB_PATH 配置"""

    def test_ecdict_db_path_is_path(self):
        """测试 ECDICT_DB_PATH 是 Path 对象"""
        assert isinstance(config.ECDICT_DB_PATH, Path)

    def test_ecdict_db_path_filename(self):
        """测试 ECDICT_DB_PATH 文件名正确"""
        assert config.ECDICT_DB_PATH.name == "ecdict.db"
