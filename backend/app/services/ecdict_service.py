import sqlite3
import os
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


import threading
from typing import Dict

logger = logging.getLogger(__name__)

# 全局连接池和锁
_connection_pool: Dict[int, sqlite3.Connection] = {}
_pool_lock = threading.Lock()


def get_db_path():
    """
    Locate ecdict.db in multiple possible locations.
    Priority (for packaged app):
    1. _internal/data/ecdict.db (PyInstaller packaged)
    2. Project Root data/ (development)
    3. Backend data/ (development)
    4. CWD data/ (fallback)
    """
    current_file = Path(__file__).resolve()
    # current_file: .../backend/app/services/ecdict_service.py (dev)
    #            or .../backend/_internal/app/services/ecdict_service.py (packaged)

    # .../backend/app/services
    services_dir = current_file.parent

    # .../backend/app
    app_dir = services_dir.parent

    # .../backend (or .../backend/_internal in packaged app)
    backend_dir = app_dir.parent

    # 1. Check PyInstaller packaged location: _internal/data/ecdict.db
    path_internal = backend_dir / "_internal" / "data" / "ecdict.db"
    if path_internal.exists():
        logger.info(f"Found ecdict.db in packaged location: {path_internal}")
        return str(path_internal)

    # 2. Check Root data/ (development)
    # .../duodushu (Root)
    project_root = backend_dir.parent
    path_root = project_root / "data" / "ecdict.db"
    if path_root.exists():
        logger.info(f"Found ecdict.db in project root: {path_root}")
        return str(path_root)

    # 3. Check Backend data/ (development)
    path_backend = backend_dir / "data" / "ecdict.db"
    if path_backend.exists():
        logger.info(f"Found ecdict.db in backend dir: {path_backend}")
        return str(path_backend)

    # 4. Check relative CWD (fallback)
    path_cwd = Path("data/ecdict.db").resolve()
    if path_cwd.exists():
        logger.info(f"Found ecdict.db in CWD: {path_cwd}")
        return str(path_cwd)

    # Default to packaged location for error reporting
    logger.error(f"ecdict.db not found in any location. Checked: {path_internal}, {path_root}, {path_backend}, {path_cwd}")
    return str(path_internal)


def _get_connection() -> Optional[sqlite3.Connection]:
    """
    获取线程安全的数据库连接。
    """
    db_path = get_db_path()
    if not os.path.exists(db_path):
        logger.error(f"ECDICT database not found at {db_path}")
        return None

    thread_id = threading.get_ident()
    if thread_id not in _connection_pool:
        with _pool_lock:
            # 双重检查
            if thread_id not in _connection_pool:
                try:
                    conn = sqlite3.connect(db_path, check_same_thread=False)
                    # 启用 WAL 模式提升并发性能
                    conn.execute("PRAGMA journal_mode=WAL")
                    _connection_pool[thread_id] = conn
                except Exception as e:
                    logger.error(f"Error connecting to ECDICT at {db_path}: {e}")
                    return None

    return _connection_pool[thread_id]


def get_translation(word: str) -> Optional[str]:
    """
    Get Chinese translation for a word from ECDICT database.
    """
    res = get_word_details(word)
    return res.get("translation") if res else None


def get_word_details(word: str) -> Optional[Dict]:
    """
    Get all fields for a word from ECDICT database with basic lemmatization.
    """
    try:
        conn = _get_connection()
        if not conn:
            return None

        cursor = conn.cursor()

        # Get column names
        cursor.execute("PRAGMA table_info(stardict)")
        columns = [row[1] for row in cursor.fetchall()]

        def _query(w):
            cursor.execute("SELECT * FROM stardict WHERE word = ?", (w,))
            res = cursor.fetchone()
            if not res and w != w.lower():
                cursor.execute("SELECT * FROM stardict WHERE word = ?", (w.lower(),))
                res = cursor.fetchone()
            return dict(zip(columns, res)) if res else None

        # 1. Direct query
        result = _query(word)
        if result:
            return result

        # 2. Basic Lemmatization (for inflections like cringed -> cringe)
        candidates = []
        if word.endswith("ed"):
            candidates.extend([word[:-1], word[:-2]])  # cringed -> cringe, baked -> bake, played -> play
        if word.endswith("ing"):
            if len(word) > 5:  # playing -> play
                candidates.append(word[:-3])
                candidates.append(word[:-3] + "e")  # baking -> bake
        if word.endswith("ies"):
            candidates.append(word[:-3] + "y")  # studies -> study
        if word.endswith("es"):
            candidates.append(word[:-2])  # boxes -> box
        if word.endswith("s") and not word.endswith("ss"):
            candidates.append(word[:-1])  # cats -> cat

        for cand in candidates:
            result = _query(cand)
            if result:
                logger.info(f"ECDICT: Found lemma '{cand}' for '{word}'")
                return result

        return None
    except Exception as e:
        logger.error(f"Error querying ECDICT: {e}")
        return None
