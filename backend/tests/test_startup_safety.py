import sqlite3

import app.main as main_module


def test_scheduled_priority_update_handles_session_creation_failure(monkeypatch):
    """测试定时任务在创建会话失败时不会再次抛出异常"""

    def raise_session_error():
        raise RuntimeError("session init failed")

    monkeypatch.setattr(main_module, "SessionLocal", raise_session_error)

    main_module.scheduled_priority_update()


def test_migrate_word_contexts_handles_connect_failure(monkeypatch):
    """测试索引迁移在连接失败时能安全退出"""

    def raise_connect_error(*args, **kwargs):
        raise RuntimeError("connect failed")

    monkeypatch.setattr(sqlite3, "connect", raise_connect_error)

    main_module._migrate_word_contexts_unique_index("/tmp/test.db")


def test_ensure_fts5_index_handles_connect_failure(monkeypatch):
    """测试 FTS 初始化在连接失败时返回 False"""

    def raise_connect_error(*args, **kwargs):
        raise RuntimeError("connect failed")

    monkeypatch.setattr(sqlite3, "connect", raise_connect_error)

    assert main_module.ensure_fts5_index("/tmp/test.db") is False
