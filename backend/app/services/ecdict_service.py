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
    获取 ecdict.db 路径。
    
    使用 config.py 中统一配置的 ECDICT_DB_PATH，
    该路径已正确处理开发环境和 PyInstaller 打包环境。
    """
    from app.config import ECDICT_DB_PATH
    return str(ECDICT_DB_PATH)



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

        # 2. Basic Lemmatization (for inflections)
        candidates = []
        seen = set()

        def add_candidate(candidate: str):
            if not candidate:
                return
            lower_candidate = candidate.lower()
            if lower_candidate == word.lower() or lower_candidate in seen:
                return
            seen.add(lower_candidate)
            candidates.append(candidate)

        if word.endswith("ed"):
            # spotted -> spot, stopped -> stop
            if len(word) > 4 and word[-3].lower() == word[-4].lower():
                add_candidate(word[:-3])
            # cringed -> cringe, baked -> bake, played -> play
            add_candidate(word[:-1])
            add_candidate(word[:-2])
            # Double consonant: clapped -> clap, robbed -> rob
            if len(word) > 5 and word[-3] == word[-4]:
                add_candidate(word[:-3])
        if word.endswith("ing"):
            if len(word) > 5:
                # playing -> play
                add_candidate(word[:-3])
                # baking -> bake
                add_candidate(word[:-3] + "e")
                # Double consonant: clapping -> clap, robbing -> rob
                if len(word) > 6 and word[-4] == word[-5]:
                    add_candidate(word[:-4])
                # panicking -> panic
                if word.endswith("cking"):
                    add_candidate(word[:-4])
        if word.endswith("ies"):
            add_candidate(word[:-3] + "y")  # studies -> study
        if word.endswith(("ses", "xes", "zes", "ches", "shes", "oes")):
            add_candidate(word[:-2])  # boxes -> box
        elif word.endswith("es") and len(word) > 3:
            add_candidate(word[:-1])
            add_candidate(word[:-2])
        if word.endswith("s") and not word.endswith("ss"):
            add_candidate(word[:-1])  # cats -> cat

        for cand in candidates:
            if not cand: continue
            result = _query(cand)
            if result:
                logger.debug(f"ECDICT: Found lemma '{cand}' for '{word}'")
                return result

        return None
    except Exception as e:
        logger.error(f"Error querying ECDICT: {e}")
        return None
