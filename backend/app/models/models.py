from sqlalchemy import (
    Column,
    Integer,
    String,
    Text,
    JSON,
    DateTime as SADateTime,
    ForeignKey,
    LargeBinary,
    Float,
    UniqueConstraint,
)
from sqlalchemy.sql import func
from .database import Base
from typing import Optional


class Book(Base):
    __tablename__ = "books"

    id = Column(String, primary_key=True, index=True)
    title = Column(String, nullable=False)
    author = Column(String)
    format = Column(String, nullable=False)
    file_path = Column(String, nullable=False)
    cover_image = Column(String)
    total_pages = Column(Integer)
    status = Column(String, default="processing")
    book_type = Column(String, default="normal")  # 'normal' | 'webnovel'
    created_at = Column(SADateTime(timezone=True), nullable=False, server_default=func.now())


class Page(Base):
    __tablename__ = "pages"

    id = Column(Integer, primary_key=True, index=True)
    book_id = Column(String, ForeignKey("books.id"), nullable=False)
    page_number = Column(Integer, nullable=False)
    text_content = Column(Text)
    words_data = Column(JSON)  # [{text, x, y, width, height}]
    images = Column(JSON)


class Vocabulary(Base):
    __tablename__ = "vocabulary"

    id = Column(Integer, primary_key=True, index=True)
    word = Column(String, nullable=False, index=True)
    phonetic = Column(String)
    definition = Column(Text)
    translation = Column(Text)
    audio_url = Column(String)
    book_id = Column(String, ForeignKey("books.id"))
    page_number = Column(Integer)
    context = Column(Text)
    mastery_level = Column(Integer, default=1)
    review_count = Column(Integer, default=0)
    query_count = Column(Integer, default=0)  # 查询次数
    last_reviewed_at = Column(SADateTime(timezone=True))
    last_queried_at = Column(SADateTime(timezone=True))  # 最后查询时间
    difficulty_score = Column(Integer, default=0)
    priority_score = Column(Float, default=0.0)  # 优先级分数
    learning_status = Column(String, default="new")  # 学习状态: new, learning, familiar, mastered
    next_review_at = Column(SADateTime(timezone=True))
    created_at = Column(SADateTime(timezone=True), server_default=func.now())


class ReadingProgress(Base):
    __tablename__ = "reading_progress"

    id = Column(Integer, primary_key=True, index=True)
    book_id = Column(String, ForeignKey("books.id"), nullable=False, unique=True)
    current_page = Column(Integer, default=1)
    total_read_time = Column(Integer, default=0)
    updated_at = Column(SADateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class CacheDictionary(Base):
    __tablename__ = "cache_dictionary"

    word = Column(String, primary_key=True, index=True)
    data = Column(JSON, nullable=False)
    created_at = Column(SADateTime(timezone=True), server_default=func.now())


class CacheAudio(Base):
    __tablename__ = "cache_audio"

    text_hash = Column(String, primary_key=True, index=True)
    audio_data = Column(LargeBinary, nullable=False)
    created_at = Column(SADateTime(timezone=True), server_default=func.now())


class Bookmark(Base):
    """用户书签模型"""

    __tablename__ = "bookmarks"

    id = Column(Integer, primary_key=True, index=True)
    book_id = Column(String, ForeignKey("books.id"), nullable=False)
    page_number = Column(Integer, nullable=False)
    title = Column(String)  # 用户自定义标题或自动生成
    note = Column(Text)  # 可选备注
    created_at = Column(SADateTime(timezone=True), server_default=func.now())


class WordContext(Base):
    """单词上下文表"""

    __tablename__ = "word_contexts"
    __table_args__ = (
        UniqueConstraint('word', 'book_id', 'page_number', 'context_sentence', name='uq_word_context'),
    )

    id = Column(Integer, primary_key=True, index=True)
    word = Column(String, nullable=False, index=True)
    book_id = Column(String, ForeignKey("books.id"), nullable=False)
    page_number = Column(Integer, nullable=False)
    context_sentence = Column(Text, nullable=False)
    is_primary = Column(Integer, default=0)  # 0: 额外例句, 1: 主要上下文
    source_type = Column(String, default="user_collected")  # 'user_collected' | 'example_library'
    created_at = Column(SADateTime(timezone=True), server_default=func.now())
