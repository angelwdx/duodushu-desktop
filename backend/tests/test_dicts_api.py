import pytest
from fastapi.testclient import TestClient
from pathlib import Path
import tempfile
from app.main import app


@pytest.fixture
def client(tmp_path: Path):
    """测试客户端 fixture，确保使用独立的临时目录"""
    from app.services.dict_manager import DictManager
    from app.routers.dicts import set_dict_manager
    
    # 注入临时目录的管理器
    test_manager = DictManager(dicts_dir=tmp_path / "test_dicts")
    set_dict_manager(test_manager)
    
    return TestClient(app)


@pytest.fixture
def valid_mdx_file(tmp_path: Path):
    """创建有效的 MDX 测试文件"""
    test_file = tmp_path / "test.mdx"
    test_file.write_bytes(b"MIDX" + b"\x00\x00\x00" + b"\x00" * 20)
    return test_file


class TestGetDicts:
    """测试获取词典列表 API"""

    def test_get_dicts_success(self, client):
        """测试正常获取词典列表"""
        response = client.get("/api/dicts")
        assert response.status_code == 200

        data = response.json()
        assert isinstance(data, list)

        # 至少应该有 ECDICT 和 JMdict
        ecdict = next((d for d in data if d["name"] == "ECDICT"), None)
        assert ecdict is not None
        assert ecdict["type"] == "builtin"
        assert ecdict["is_builtin"] is True

        jmdict = next((d for d in data if d["name"] == "JMdict"), None)
        assert jmdict is not None
        assert jmdict["type"] == "builtin"
        assert jmdict["is_builtin"] is True


class TestImportDict:
    """测试词典导入 API"""

    def test_import_dict_invalid_extension(self, client, tmp_path: Path):
        """测试导入非 MDX 文件"""
        invalid_file = tmp_path / "test.txt"
        invalid_file.write_text("Not a MDX file")

        with open(invalid_file, "rb") as f:
            files = {"file": ("test.txt", f, "text/plain")}
            response = client.post("/api/dicts/import", files=files)

        assert response.status_code == 400
        data = response.json()
        assert "只支持" in data["detail"]

    def test_import_dict_too_large(self, client, tmp_path: Path):
        """测试导入超大文件"""
        # 创建超过 500MB 的文件
        large_file = tmp_path / "large.mdx"
        large_file.write_bytes(b"MIDX" + b"\x00\x00\x00" + (b"x" * (501 * 1024 * 1024)))

        with open(large_file, "rb") as f:
            files = {"file": ("large.mdx", f, "application/octet-stream")}
            response = client.post("/api/dicts/import", files=files)

        assert response.status_code == 413
        data = response.json()
        assert "文件过大" in data["detail"]


class TestDeleteDict:
    """测试删除词典 API"""

    def test_delete_dict_not_found(self, client):
        """测试删除不存在的词典，应该返回 200 (幂等性)"""
        response = client.delete("/api/dicts/NonExistentDict")
        assert response.status_code == 200


class TestSetPriority:
    """测试设置优先级 API"""

    def test_set_priority_success(self, client):
        """测试正常设置优先级"""
        new_priority = ["CUSTOM_DICT", "ECDICT"]
        response = client.post("/api/dicts/priority", json={"priority": new_priority})
        assert response.status_code == 200
        data = response.json()
        assert data["priority"] == new_priority


class TestToggleDict:
    """测试切换词典 API"""

    def test_toggle_dict_enable(self, client, valid_mdx_file):
        """测试启用词典"""
        # 先导入一个词典
        with open(valid_mdx_file, "rb") as f:
            files = {"file": ("test.mdx", f, "application/octet-stream")}
            client.post("/api/dicts/import", files=files)

        # 启用它
        response = client.patch("/api/dicts/test/toggle", json={"active": True})
        assert response.status_code == 200
        data = response.json()
        assert data["is_active"] is True

    def test_toggle_dict_disable(self, client, valid_mdx_file):
        """测试禁用词典"""
        # 先导入一个词典
        with open(valid_mdx_file, "rb") as f:
            files = {"file": ("test.mdx", f, "application/octet-stream")}
            client.post("/api/dicts/import", files=files)

        # 禁用它
        response = client.patch("/api/dicts/test/toggle", json={"active": False})
        assert response.status_code == 200
        data = response.json()
        assert data["is_active"] is False
