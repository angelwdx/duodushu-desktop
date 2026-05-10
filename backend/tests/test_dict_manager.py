import pytest
import tempfile
import shutil
from pathlib import Path
from app.services.dict_manager import DictManager


@pytest.fixture
def temp_dicts_dir(tmp_path: Path) -> Path:
    """创建临时词典目录 fixture"""
    dicts_dir = tmp_path / "dicts"
    dicts_dir.mkdir()
    return dicts_dir


@pytest.fixture
def dict_manager(temp_dicts_dir: Path):
    """创建 DictManager fixture"""
    return DictManager(dicts_dir=temp_dicts_dir)


def test_dict_manager_initialization(dict_manager: DictManager):
    """测试词典管理器初始化"""
    assert dict_manager.dicts_dir.exists()
    assert dict_manager.index_db.exists()
    assert isinstance(dict_manager.config, dict)


def test_dict_manager_default_config(dict_manager: DictManager):
    """测试默认配置"""
    assert "dicts" in dict_manager.config
    assert "priority" in dict_manager.config
    assert isinstance(dict_manager.config["dicts"], dict)
    assert isinstance(dict_manager.config["priority"], list)


def test_get_dicts_empty(dict_manager: DictManager):
    """测试获取空词典列表"""
    dicts = dict_manager.get_dicts()

    assert isinstance(dicts, list)
    # 至少应该有 ECDICT 和 JMdict
    assert len(dicts) >= 2

    # ECDICT 应该是内置词典
    ecdict = next((d for d in dicts if d["name"] == "ECDICT"), None)
    assert ecdict is not None
    assert ecdict["type"] == "builtin"
    assert ecdict["is_builtin"] is True

    jmdict = next((d for d in dicts if d["name"] == "JMdict"), None)
    assert jmdict is not None
    assert jmdict["type"] == "builtin"
    assert jmdict["is_builtin"] is True


def test_create_index_db(dict_manager: DictManager):
    """测试索引数据库创建"""
    # 验证数据库文件已创建
    assert dict_manager.index_db.exists()

    # 验证表存在
    import sqlite3

    conn = sqlite3.connect(dict_manager.index_db)
    cursor = conn.cursor()

    # 检查表
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [row[0] for row in cursor.fetchall()]

    assert "dicts" in tables
    assert "entries" in tables

    conn.close()


def test_save_and_load_config(dict_manager: DictManager):
    """测试配置保存和加载"""
    import json

    # 修改配置
    original_priority = dict_manager.config["priority"]
    new_priority = ["CUSTOM_DICT", "ECDICT"]

    dict_manager.config["priority"] = new_priority
    dict_manager._save_config(dict_manager.config)

    # 重新加载
    loaded_config = dict_manager._load_config()

    assert loaded_config["priority"] == new_priority


def test_remove_dict(dict_manager: DictManager, temp_dicts_dir: Path):
    """测试删除词典"""
    # 创建测试词典数据库
    test_dict_file = temp_dicts_dir / "test.mdx"
    test_dict_file.write_bytes(b"MIDX" + b"\x00\x00\x00\x00" + b"\x00" * 50)

    # 导入测试词典
    result = dict_manager.import_dict(test_dict_file, "TestDict")
    assert result["name"] == "TestDict"

    # 删除词典
    dict_manager.remove_dict("TestDict")

    # 验证已删除
    dicts = dict_manager.get_dicts()
    test_dict = next((d for d in dicts if d["name"] == "TestDict"), None)
    assert test_dict is None


def test_set_priority(dict_manager: DictManager):
    """测试设置优先级"""
    original_priority = dict_manager.config["priority"]
    new_priority = ["CUSTOM", "ECDICT"]

    dict_manager.set_priority(new_priority)

    assert dict_manager.config["priority"] == new_priority

    # 测试恢复
    original_copy = original_priority.copy()
    try:
        dict_manager.set_priority(original_copy)
        assert dict_manager.config["priority"] == original_copy
    finally:
        # 清理
        dict_manager.config["priority"] = original_priority


def test_lookup_word_not_found(dict_manager: DictManager):
    """测试查询单词（未找到）"""
    result = dict_manager.lookup_word("nonexistentwordxyz")

    assert result is None
