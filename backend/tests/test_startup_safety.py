import sqlite3

import app.main as main_module


class _RecordingCursor:
    def __init__(self, cursor, statements):
        self._cursor = cursor
        self._statements = statements

    def execute(self, sql, *args, **kwargs):
        self._statements.append(" ".join(sql.split()).lower())
        return self._cursor.execute(sql, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._cursor, name)


class _RecordingConnection:
    def __init__(self, conn, statements):
        self._conn = conn
        self._statements = statements

    def cursor(self):
        return _RecordingCursor(self._conn.cursor(), self._statements)

    def __getattr__(self, name):
        return getattr(self._conn, name)


def _create_pages_db(db_path: str, row_count: int = 1):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE pages (
            id INTEGER PRIMARY KEY,
            book_id INTEGER NOT NULL,
            page_number INTEGER NOT NULL,
            text_content TEXT
        )
    """)
    for index in range(row_count):
        cursor.execute(
            "INSERT INTO pages (id, book_id, page_number, text_content) VALUES (?, ?, ?, ?)",
            (index + 1, 1, index + 1, f"page {index + 1}"),
        )
    conn.commit()
    conn.close()


def _record_sqlite_statements(monkeypatch):
    statements = []
    real_connect = sqlite3.connect

    def recording_connect(*args, **kwargs):
        conn = real_connect(*args, **kwargs)
        return _RecordingConnection(conn, statements)

    monkeypatch.setattr(sqlite3, "connect", recording_connect)
    return statements


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


def test_ensure_fts5_index_skips_rebuild_when_counts_match(tmp_path, monkeypatch):
    """测试已有且一致的 FTS 索引不会在启动时重复 rebuild"""

    db_path = tmp_path / "app.db"
    _create_pages_db(str(db_path), row_count=1)

    assert main_module.ensure_fts5_index(str(db_path)) is True

    statements = _record_sqlite_statements(monkeypatch)

    assert main_module.ensure_fts5_index(str(db_path)) is True
    assert not any("values('rebuild')" in statement for statement in statements)


def test_ensure_fts5_index_rebuilds_when_counts_mismatch(tmp_path, monkeypatch):
    """测试 FTS 索引数量不一致时会触发 rebuild 修复"""

    db_path = tmp_path / "app.db"
    _create_pages_db(str(db_path), row_count=2)

    assert main_module.ensure_fts5_index(str(db_path)) is True

    conn = sqlite3.connect(str(db_path))
    conn.execute("DROP TRIGGER IF EXISTS pages_ai")
    conn.execute("DROP TRIGGER IF EXISTS pages_au")
    conn.execute("DROP TRIGGER IF EXISTS pages_ad")
    conn.execute(
        "INSERT INTO pages (id, book_id, page_number, text_content) VALUES (?, ?, ?, ?)",
        (3, 1, 3, "page 3"),
    )
    conn.commit()
    conn.close()

    statements = _record_sqlite_statements(monkeypatch)

    assert main_module.ensure_fts5_index(str(db_path)) is True
    assert any("values('rebuild')" in statement for statement in statements)
