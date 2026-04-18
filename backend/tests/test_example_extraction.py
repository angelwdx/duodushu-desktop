from fastapi import BackgroundTasks
from pathlib import Path
import pytest
import sys
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.routers.vocabulary import check_extraction_status, extract_examples_manual
from app.services.extraction_service import find_and_save_example_contexts, get_auto_extracted_context_count


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    session = SessionLocal()

    session.execute(text("""
        CREATE TABLE books (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            author TEXT,
            format TEXT NOT NULL,
            file_path TEXT NOT NULL,
            cover_image TEXT,
            total_pages INTEGER,
            status TEXT,
            book_type TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """))
    session.execute(text("""
        CREATE TABLE vocabulary (
            id INTEGER PRIMARY KEY,
            word TEXT NOT NULL
        )
    """))
    session.execute(text("""
        CREATE TABLE word_contexts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            word TEXT NOT NULL,
            book_id TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            context_sentence TEXT NOT NULL,
            sentence_translation TEXT,
            is_primary INTEGER DEFAULT 0,
            source_type TEXT DEFAULT 'user_collected',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """))
    session.execute(text("""
        CREATE TABLE pages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            text_content TEXT
        )
    """))
    session.execute(text("CREATE VIRTUAL TABLE pages_fts USING fts5(text_content)"))
    session.commit()

    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _insert_book(db_session, book_id: str, book_type: str = "normal"):
    db_session.execute(
        text("""
            INSERT INTO books (id, title, format, file_path, status, book_type)
            VALUES (:id, :title, 'txt', '/tmp/book.txt', 'ready', :book_type)
        """),
        {"id": book_id, "title": f"Book {book_id}", "book_type": book_type},
    )


def _insert_page(db_session, book_id: str, page_number: int, text_content: str):
    result = db_session.execute(
        text("""
            INSERT INTO pages (book_id, page_number, text_content)
            VALUES (:book_id, :page_number, :text_content)
        """),
        {"book_id": book_id, "page_number": page_number, "text_content": text_content},
    )
    page_id = int(result.lastrowid)
    db_session.execute(
        text("INSERT INTO pages_fts (rowid, text_content) VALUES (:rowid, :text_content)"),
        {"rowid": page_id, "text_content": text_content},
    )


def _insert_vocab(db_session, vocab_id: int, word: str):
    db_session.execute(
        text("INSERT INTO vocabulary (id, word) VALUES (:id, :word)"),
        {"id": vocab_id, "word": word},
    )


def _insert_context(
    db_session,
    word: str,
    book_id: str,
    page_number: int,
    context_sentence: str,
    source_type: str,
    is_primary: int = 0,
):
    db_session.execute(
        text("""
            INSERT INTO word_contexts
                (word, book_id, page_number, context_sentence, is_primary, source_type)
            VALUES
                (:word, :book_id, :page_number, :context_sentence, :is_primary, :source_type)
        """),
        {
            "word": word,
            "book_id": book_id,
            "page_number": page_number,
            "context_sentence": context_sentence,
            "is_primary": is_primary,
            "source_type": source_type,
        },
    )


def test_find_and_save_example_contexts_only_uses_example_library_books(db_session):
    _insert_book(db_session, "book-current")
    _insert_book(db_session, "book-other", book_type="example_library")
    _insert_page(db_session, "book-current", 1, "We study English every night.")
    _insert_page(db_session, "book-other", 2, "They study grammar before breakfast.")
    db_session.commit()

    find_and_save_example_contexts("study", db_session, exclude_book_id="book-current", max_total=3)

    rows = db_session.execute(
        text("""
            SELECT book_id, source_type, context_sentence
            FROM word_contexts
            WHERE lower(word) = lower(:word)
        """),
        {"word": "study"},
    ).fetchall()

    assert rows == [("book-other", "example_library", "They study grammar before breakfast.")]
    assert get_auto_extracted_context_count(db_session, "study") == 1


def test_find_and_save_example_contexts_skips_non_body_pages_and_prefers_story_page(db_session):
    _insert_book(db_session, "book-lib", book_type="example_library")
    _insert_page(db_session, "book-lib", 1, "Table of Contents\n1. Study of Birds\n2. Study of Rivers")
    _insert_page(
        db_session,
        "book-lib",
        2,
        "\"We should study the stars tonight,\" Anna said as they walked toward the river.",
    )
    db_session.commit()

    find_and_save_example_contexts("study", db_session, max_total=3)

    rows = db_session.execute(
        text("""
            SELECT page_number, context_sentence
            FROM word_contexts
            WHERE lower(word) = lower(:word)
        """),
        {"word": "study"},
    ).fetchall()

    assert rows == [(2, "\"We should study the stars tonight,\" Anna said as they walked toward the river.")]


def test_find_and_save_example_contexts_skips_when_no_example_library_books_exist(db_session):
    _insert_book(db_session, "book-normal")
    _insert_page(db_session, "book-normal", 1, "We study English every night.")
    db_session.commit()

    find_and_save_example_contexts("study", db_session, max_total=3)

    rows = db_session.execute(
        text("SELECT COUNT(*) FROM word_contexts WHERE lower(word) = lower(:word)"),
        {"word": "study"},
    ).scalar()

    assert rows == 0


def test_check_extraction_status_counts_legacy_normal_rows_as_auto_extracted(db_session):
    _insert_book(db_session, "book-normal")
    _insert_vocab(db_session, 1, "study")
    for page in range(1, 6):
        _insert_context(
            db_session,
            word="study",
            book_id="book-normal",
            page_number=page,
            context_sentence=f"Legacy example {page} for study.",
            source_type="normal",
        )
    db_session.commit()

    result = check_extraction_status(1, db_session)

    assert result["status"] == "completed"
    assert result["example_library_count"] == 5
    assert result["auto_extracted_count"] == 5
    assert "已完成提取" in result["message"]


def test_check_extraction_status_fails_when_no_example_library_books_exist(db_session):
    _insert_book(db_session, "book-normal")
    _insert_vocab(db_session, 1, "study")
    db_session.commit()

    result = check_extraction_status(1, db_session)

    assert result["status"] == "failed"
    assert result["message"] == "未上传例句库书籍"


def test_check_extraction_status_fails_when_example_library_has_no_match(db_session):
    _insert_book(db_session, "book-lib", book_type="example_library")
    _insert_page(db_session, "book-lib", 1, "This sentence does not contain the target.")
    _insert_vocab(db_session, 1, "study")
    db_session.commit()

    result = check_extraction_status(1, db_session)

    assert result["status"] == "failed"
    assert result["message"] == "例句库中未找到可提取的例句"


def test_extract_examples_manual_skips_when_legacy_auto_examples_already_at_limit(db_session):
    _insert_book(db_session, "book-normal")
    _insert_vocab(db_session, 1, "study")
    for page in range(1, 21):
        _insert_context(
            db_session,
            word="study",
            book_id="book-normal",
            page_number=page,
            context_sentence=f"Legacy example {page} for study.",
            source_type="normal",
        )
    db_session.commit()

    background_tasks = BackgroundTasks()
    result = extract_examples_manual(1, background_tasks, db_session)

    assert result["status"] == "skipped"
    assert result["current_count"] == 20
    assert background_tasks.tasks == []
