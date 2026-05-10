import json
import logging
import sqlite3
import threading
import zlib
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_connection_pool: Dict[int, sqlite3.Connection] = {}
_pool_lock = threading.Lock()
_metadata_cache: dict[str, str] | None = None

JMDICT_SOURCE_URL = "https://www.edrdg.org/pub/Nihongo/JMdict_e.gz"
JMDICT_LICENSE_URL = "https://www.edrdg.org/edrdg/licence.html"
JMDICT_PROJECT_URL = "https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project"


def get_db_path() -> str:
    from app.config import JMDICT_DB_PATH

    return str(JMDICT_DB_PATH)


def _get_connection() -> Optional[sqlite3.Connection]:
    db_path = get_db_path()
    if not Path(db_path).exists():
        logger.error("JMdict database not found at %s", db_path)
        return None

    thread_id = threading.get_ident()
    if thread_id not in _connection_pool:
        with _pool_lock:
            if thread_id not in _connection_pool:
                try:
                    conn = sqlite3.connect(db_path, check_same_thread=False)
                    conn.row_factory = sqlite3.Row
                    conn.execute("PRAGMA journal_mode=WAL")
                    _connection_pool[thread_id] = conn
                except Exception as exc:
                    logger.error("Error connecting to JMdict at %s: %s", db_path, exc)
                    return None

    return _connection_pool[thread_id]


def _load_metadata() -> dict[str, str]:
    global _metadata_cache
    if _metadata_cache is not None:
        return _metadata_cache

    conn = _get_connection()
    if not conn:
        _metadata_cache = {}
        return _metadata_cache

    try:
        cursor = conn.cursor()
        cursor.execute("SELECT key, value FROM metadata")
        _metadata_cache = {str(row["key"]): str(row["value"]) for row in cursor.fetchall()}
    except Exception:
        _metadata_cache = {}
    return _metadata_cache


def get_entry_count() -> int:
    metadata = _load_metadata()
    try:
        return int(metadata.get("entry_count", "0"))
    except ValueError:
        return 0


def get_word_details(word: str) -> Optional[Dict[str, Any]]:
    if not word:
        return None

    conn = _get_connection()
    if not conn:
        return None

    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT e.entry_id, e.word, e.reading, e.summary, e.payload
            FROM terms t
            JOIN entries e ON e.entry_id = t.entry_id
            WHERE t.term = ?
            ORDER BY t.score DESC, e.rank DESC, e.entry_id ASC
            LIMIT 8
            """,
            (word,),
        )
        rows = cursor.fetchall()
        if not rows:
            return None

        entries: list[dict[str, Any]] = []
        meanings: list[dict[str, Any]] = []

        for row in rows:
            raw_payload = row["payload"]
            if isinstance(raw_payload, bytes):
                payload = json.loads(zlib.decompress(raw_payload).decode("utf-8"))
            else:
                payload = json.loads(raw_payload)
            entry_word = payload.get("word") or row["word"] or word
            entry_reading = payload.get("reading") or row["reading"]
            entry_senses = payload.get("senses", [])

            entries.append(
                {
                    "word": entry_word,
                    "reading": entry_reading,
                    "summary": payload.get("summary") or row["summary"],
                    "kanji_forms": payload.get("kanji_forms", []),
                    "reading_forms": payload.get("reading_forms", []),
                    "senses": entry_senses,
                }
            )

            for sense in entry_senses:
                definitions = [
                    {"definition": gloss}
                    for gloss in sense.get("glosses", [])
                    if gloss
                ]
                if not definitions:
                    continue
                meanings.append(
                    {
                        "partOfSpeech": sense.get("part_of_speech") or "Japanese",
                        "definitions": definitions,
                    }
                )

        first_entry = entries[0]
        reading = first_entry.get("reading")
        display_word = first_entry.get("word") or word

        return {
            "word": display_word,
            "source": "JMdict",
            "is_jmdict": True,
            "phonetic": reading if reading and reading != display_word else None,
            "meanings": meanings,
            "raw_data": {
                "entries": entries,
                "attribution": {
                    "name": "JMdict / EDICT",
                    "project_url": JMDICT_PROJECT_URL,
                    "license_name": "CC BY-SA 4.0",
                    "license_url": JMDICT_LICENSE_URL,
                    "source_url": JMDICT_SOURCE_URL,
                },
            },
        }
    except Exception as exc:
        logger.error("Error querying JMdict: %s", exc)
        return None
