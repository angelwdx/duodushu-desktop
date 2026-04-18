from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Response
from sqlalchemy.orm import Session
from sqlalchemy import text
from ..models.database import get_db, SessionLocal
from typing import List, Optional
from pydantic import BaseModel
import json
import csv
import io
from datetime import datetime, timedelta
import logging
import traceback

# 从拆分后的模块导入例句提取服务
from ..services.extraction_service import (
    AUTO_EXTRACTED_SOURCE_TYPE,
    get_auto_extracted_context_count,
    is_example_extraction_in_progress,
    normalized_context_source_sql,
    run_example_extraction_task,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/vocabulary", tags=["vocabulary"])


def _normalized_context_source_sql(alias: str) -> str:
    return normalized_context_source_sql(alias)


class VocabularyResponse(BaseModel):
    id: int
    word: str
    phonetic: Optional[str] = None
    definition: Optional[dict] = None
    translation: Optional[str] = None
    primary_context: Optional[dict] = None
    example_contexts: List[dict] = []
    review_count: int = 0
    query_count: int = 0  # 新增：查询次数
    mastery_level: int = 1
    difficulty_score: int = 0
    priority_score: float = 0.0  # 新增：优先级分数
    learning_status: str = "new"  # 新增：学习状态
    created_at: str
    last_queried_at: Optional[str] = None  # 新增：最后查询时间

    class Config:
        from_attributes = True


class VocabularyCreate(BaseModel):
    word: str
    book_id: Optional[str] = None
    context_sentence: Optional[str] = None
    definition: Optional[dict] = None
    translation: Optional[str] = None
    page_number: Optional[int] = 0




@router.post("/", response_model=VocabularyResponse)
def add_vocabulary(
    data: VocabularyCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """添加生词"""
    try:
        with db.begin():
            # Check if exists (case-insensitive)
            # Use lower(:word) consistently
            normalized_word = data.word.strip().lower()
            existing = db.execute(
                text("""
                SELECT id, translation, created_at, review_count, mastery_level, difficulty_score, definition, word, phonetic
                FROM vocabulary
                WHERE lower(word) = :word
                LIMIT 1
            """),
                {"word": normalized_word},
            ).fetchone()

            if existing:
                # Use the existing word casing (index 7 based on SELECT order)
                target_word = existing[7]
                existing_id = existing[0]

                # Always update context and page_number to the latest selection
                db.execute(
                    text("""
                    UPDATE vocabulary
                    SET translation = COALESCE(:translation, translation),
                        context = :context,
                        page_number = :page_number
                    WHERE id = :existing_id
                """),
                    {
                        "translation": data.translation,
                        "context": data.context_sentence,
                        "page_number": data.page_number,
                        "existing_id": existing_id,
                    },
                )

                # Update word_contexts: Demote old primary contexts using target_word (case-insensitive)
                db.execute(
                    text("UPDATE word_contexts SET is_primary = 0 WHERE lower(word) = lower(:word) AND is_primary = 1"),
                    {"word": target_word},
                )

                # Insert or Update primary context using target_word
                if data.context_sentence and data.book_id:
                    # Check if this exact context exists
                    existing_ctx = db.execute(
                        text("""
                        SELECT id FROM word_contexts 
                        WHERE lower(word) = lower(:word) 
                          AND context_sentence = :context_sentence 
                          AND book_id = :book_id
                        LIMIT 1
                    """),
                        {
                            "word": target_word,
                            "context_sentence": data.context_sentence,
                            "book_id": data.book_id,
                        },
                    ).fetchone()

                    if existing_ctx:
                        db.execute(
                            text("""
                            UPDATE word_contexts 
                            SET is_primary = 1, page_number = :page_number 
                            WHERE id = :id
                        """),
                            {"id": existing_ctx[0], "page_number": data.page_number},
                        )
                    else:
                        db.execute(
                            text("""
                            INSERT INTO word_contexts
                                (word, book_id, page_number, context_sentence, is_primary)
                            VALUES (:word, :book_id, :page_number, :context_sentence, 1)
                        """),
                            {
                                "word": target_word,  # Use the existing casing from DB if found
                                "book_id": data.book_id,
                                "page_number": data.page_number,
                                "context_sentence": data.context_sentence,
                            },
                        )

                # 使用后台任务异步提取例句（不阻塞API响应）
                # 检查该单词是否已有足够的 example_library 例句
                existing_library_count = get_auto_extracted_context_count(db, target_word)

                if existing_library_count < 5:
                    logger.info(
                        f"[例句提取] 已存在单词 '{target_word}' 只有 {existing_library_count} 个例句库例句，添加后台任务提取更多"
                    )
                    background_tasks.add_task(run_example_extraction_task, target_word, exclude_book_id=data.book_id)
                else:
                    logger.info(
                        f"[例句提取] 已存在单词 '{target_word}' 已有 {existing_library_count} 个例句库例句，跳过提取"
                    )

                return VocabularyResponse(
                    id=existing_id,
                    word=target_word,
                    phonetic=existing[8],
                    definition=json.loads(existing[6]) if existing[6] else None,
                    translation=data.translation or existing[1],
                    primary_context={
                        "book_id": data.book_id,
                        "page_number": data.page_number,
                        "context_sentence": data.context_sentence,
                    }
                    if data.context_sentence
                    else None,
                    example_contexts=[],
                    review_count=existing[3] if existing[3] else 0,
                    mastery_level=existing[4] if existing[4] else 1,
                    difficulty_score=existing[5] if existing[5] else 0,
                    created_at=existing[2].isoformat() if hasattr(existing[2], "isoformat") else str(existing[2]),
                )

            # Try to extract translation from definition if not provided
            translation = data.translation
            if not translation and data.definition and "chinese_summary" in data.definition:
                translation = data.definition["chinese_summary"]

            # Try to get phonetic from definition or ECDICT
            phonetic = None
            if data.definition and "phonetic" in data.definition:
                phonetic = data.definition["phonetic"]
            
            if not phonetic:
                # Fallback to ECDICT lookup
                from ..services import ecdict_service
                ecdict_data = ecdict_service.get_word_details(data.word)
                if ecdict_data and ecdict_data.get("phonetic"):
                    phonetic = ecdict_data["phonetic"]

            # Create new vocabulary
            result = db.execute(
                text("""
                INSERT INTO vocabulary
                    (word, book_id, page_number, context, translation, definition, phonetic)
                VALUES (:word, :book_id, :page_number, :context, :translation, :definition, :phonetic)
            """),
                {
                    "word": data.word,
                    "book_id": data.book_id,
                    "page_number": data.page_number,
                    "context": data.context_sentence,
                    "translation": translation,
                    "definition": json.dumps(data.definition) if data.definition else None,
                    "phonetic": phonetic,
                },
            )

            vocab_id = result.lastrowid  # type: ignore

            # Update word_contexts: Demote any existing primary contexts (handles orphaned records)
            db.execute(
                text("UPDATE word_contexts SET is_primary = 0 WHERE lower(word) = lower(:word) AND is_primary = 1"),
                {"word": data.word},
            )

            # Insert or Update primary context
            if data.context_sentence and data.book_id:
                # Check if this exact context exists
                existing_ctx = db.execute(
                    text("""
                    SELECT id FROM word_contexts 
                    WHERE lower(word) = lower(:word) 
                      AND context_sentence = :context_sentence 
                      AND book_id = :book_id
                    LIMIT 1
                """),
                    {
                        "word": data.word,
                        "context_sentence": data.context_sentence,
                        "book_id": data.book_id,
                    },
                ).fetchone()

                if existing_ctx:
                    db.execute(
                        text("""
                        UPDATE word_contexts 
                        SET is_primary = 1, page_number = :page_number 
                        WHERE id = :id
                    """),
                        {"id": existing_ctx[0], "page_number": data.page_number},
                    )
                else:
                    db.execute(
                        text("""
                        INSERT INTO word_contexts
                            (word, book_id, page_number, context_sentence, is_primary)
                        VALUES (:word, :book_id, :page_number, :context_sentence, 1)
                    """),
                        {
                            "word": normalized_word,  # Use normalized lowercase for new words
                            "book_id": data.book_id,
                            "page_number": data.page_number,
                            "context_sentence": data.context_sentence,
                        },
                    )

        # 使用后台任务异步提取例句（不阻塞API响应）
        logger.info(f"[例句提取] 为新单词 '{data.word}' 添加后台任务, exclude_book_id='{data.book_id}'")
        background_tasks.add_task(run_example_extraction_task, data.word, exclude_book_id=data.book_id)

        # Fetch the new row
        new_vocab = db.execute(text("SELECT * FROM vocabulary WHERE id = :id"), {"id": vocab_id}).fetchone()

        if new_vocab is None:
            raise HTTPException(status_code=404, detail="Failed to create vocabulary")

        return VocabularyResponse(
            id=new_vocab.id,  # type: ignore
            word=new_vocab.word,  # type: ignore
            phonetic=new_vocab.phonetic,  # type: ignore
            definition=json.loads(new_vocab.definition) if new_vocab.definition else None,  # type: ignore
            translation=new_vocab.translation,  # type: ignore
            primary_context={"context_sentence": data.context_sentence} if data.context_sentence else None,
            example_contexts=[],
            review_count=new_vocab.review_count if new_vocab.review_count else 0,  # type: ignore
            mastery_level=new_vocab.mastery_level if new_vocab.mastery_level else 1,  # type: ignore
            difficulty_score=new_vocab.difficulty_score if new_vocab.difficulty_score else 0,  # type: ignore
            created_at=new_vocab.created_at.isoformat()  # type: ignore
            if hasattr(new_vocab.created_at, "isoformat")  # type: ignore
            else str(new_vocab.created_at)  # type: ignore
            if new_vocab.created_at  # type: ignore
            else "",
        )

    except Exception as e:
        logger.error(f"Error adding vocabulary: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/high_priority")
def get_high_priority_words(threshold: float = 70.0, limit: int = 10, db: Session = Depends(get_db)):
    """
    获取高优先级单词列表（用于智能提醒）

    Args:
        threshold: 优先级阈值（默认70）
        limit: 返回数量限制

    Returns:
        高优先级单词列表
    """
    try:
        with db.begin():
            words = db.execute(
                text("""
                SELECT 
                        v.id, v.word, v.translation, v.definition,
                        v.query_count, v.review_count, v.mastery_level,
                        v.priority_score, v.learning_status,
                        b.title, b.book_type
                    FROM vocabulary v
                LEFT JOIN books b ON v.book_id = b.id
                WHERE v.priority_score >= :threshold
                ORDER BY v.priority_score DESC
                LIMIT :limit
            """),
                {"threshold": threshold, "limit": limit},
            ).fetchall()

        result = []
        for word in words:
            result.append(
                {
                    "id": word[0],
                    "word": word[1],
                    "translation": word[2],
                    "query_count": word[4],
                    "priority_score": word[7] if word[7] else 0.0,
                    "learning_status": word[8],
                    "book_title": word[9],
                }
            )

        return {"count": len(result), "threshold": threshold, "words": result}

    except Exception as e:
        logger.error(f"Error fetching high priority words: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/test-word/{word}")
def test_word_examples(word: str, db: Session = Depends(get_db)):
    """
    测试端点：检查指定单词的例句
    用于调试后台任务是否正常工作
    """
    try:
        # 检查该单词的所有例句
        result = db.execute(
            text("""
                SELECT word, source_type, is_primary, COUNT(*) as count
                FROM word_contexts
                WHERE LOWER(word) = LOWER(:word)
                GROUP BY source_type, is_primary
            """),
            {"word": word},
        )

        contexts = result.fetchall()

        return {
            "word": word,
            "total_contexts": sum(c[3] for c in contexts),
            "contexts": [{"source_type": c[0], "is_primary": c[1], "count": c[2]} for c in contexts],
        }

    except Exception as e:
        logger.error(f"Error in test_word_examples: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{vocab_id:int}", response_model=VocabularyResponse)
def get_vocabulary_detail(vocab_id: int, db: Session = Depends(get_db)):
    """获取单个生词详情"""
    try:
        normalized_source_expr = _normalized_context_source_sql("wc")
        # 1. Get Vocabulary Basic Info
        vocab_row = db.execute(
            text("""
                SELECT 
                    v.id, v.word, v.phonetic, v.definition, v.translation, 
                    v.book_id, v.context, v.review_count, v.query_count, 
                    v.mastery_level, v.difficulty_score, v.priority_score,
                    v.learning_status, v.last_queried_at, v.created_at,
                    b.title, b.book_type, b.author
                FROM vocabulary v
                LEFT JOIN books b ON v.book_id = b.id
                WHERE v.id = :id
            """),
            {"id": vocab_id},
        ).fetchone()

        if not vocab_row:
            raise HTTPException(status_code=404, detail="Vocabulary not found")

        v_word = vocab_row[1]

        # 2. Get Contexts
        context_rows = db.execute(
            text(f"""
                SELECT wc.id, wc.word, wc.book_id, wc.page_number, wc.context_sentence,
                       b.title as book_title, b.book_type as book_type, wc.is_primary,
                       {normalized_source_expr} as source_type,
                       b.author as book_author
                FROM word_contexts wc
                JOIN books b ON wc.book_id = b.id
                WHERE lower(wc.word) = lower(:word)
                ORDER BY
                    CASE
                        WHEN wc.is_primary = 1 THEN 0
                        WHEN {normalized_source_expr} = 'user_collected' THEN 1
                        ELSE 2
                    END,
                    wc.id DESC
            """),
            {"word": v_word},
        ).fetchall()

        # 3. Process Contexts
        primary_ctx = None
        example_ctxs = []

        for ctx in context_rows:
            if ctx[7] == 1:  # is_primary
                if primary_ctx is None:
                    primary_ctx = ctx
                else:
                    example_ctxs.append(ctx)
            else:
                example_ctxs.append(ctx)

        sorted_examples = sorted(
            example_ctxs,
            key=lambda x: x[0],
            reverse=True,
        )[:20]  # 详情页最多返回20个例句

        # Construct Response
        primary_context_data = None
        if primary_ctx:
            primary_context_data = {
                "book_id": primary_ctx[2],
                "book_title": primary_ctx[5],
                "page_number": primary_ctx[3],
                "context_sentence": primary_ctx[4],
            }
        elif vocab_row[6]:  # v.context fallback
            primary_context_data = {
                "book_id": vocab_row[5],
                "book_title": vocab_row[15],
                "page_number": 0,
                "context_sentence": vocab_row[6],
            }

        return VocabularyResponse(
            id=vocab_row[0],
            word=vocab_row[1],
            phonetic=vocab_row[2],
            definition=json.loads(vocab_row[3]) if vocab_row[3] else None,
            translation=vocab_row[4],
            primary_context=primary_context_data,
            example_contexts=[
                {
                    "book_id": ctx[2],
                    "book_title": ctx[5],
                    "book_type": ctx[6],
                    "page_number": ctx[3],
                    "context_sentence": ctx[4],
                    "source_type": ctx[8],
                }
                for ctx in sorted_examples
            ],
            review_count=vocab_row[7] if vocab_row[7] else 0,
            query_count=vocab_row[8] if vocab_row[8] else 0,
            mastery_level=vocab_row[9] if vocab_row[9] else 1,
            difficulty_score=vocab_row[10] if vocab_row[10] else 0,
            priority_score=vocab_row[11] if vocab_row[11] else 0.0,
            learning_status=vocab_row[12] if vocab_row[12] else "new",
            last_queried_at=vocab_row[13].isoformat()
            if vocab_row[13] and hasattr(vocab_row[13], "isoformat")
            else None,
            created_at=vocab_row[14].isoformat() if hasattr(vocab_row[14], "isoformat") else str(vocab_row[14]),
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching vocabulary detail: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/", response_model=List[VocabularyResponse])
def get_vocabulary(
    page: int = 1,
    per_page: int = 20,
    filter_type: str = "all",
    search: Optional[str] = None,
    sort_by: str = "newest",
    book_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """获取生词列表，包含主要上下文和额外例句"""
    try:
        normalized_source_expr = _normalized_context_source_sql("wc")
        # Explicit column selection to avoid index errors
        query = """
            SELECT
                v.id, v.word, v.phonetic, v.definition, v.translation,
                v.book_id, v.context, v.review_count, v.query_count,
                v.mastery_level, v.difficulty_score, v.priority_score,
                v.learning_status, v.last_queried_at, v.created_at,
                b.title, b.book_type, b.author
            FROM vocabulary v
            LEFT JOIN books b ON v.book_id = b.id
            WHERE 1=1
        """

        # 查询参数字典
        query_params = {}

        # 搜索条件
        if search:
            query += " AND v.word LIKE :search"
            query_params["search"] = f"%{search}%"

        # 按书籍筛选
        if book_id:
            query += " AND v.book_id = :book_id"
            query_params["book_id"] = book_id

        # 筛选书籍类型
        if filter_type == "webnovel":
            query += " AND b.book_type = :filter_type"
            query_params["filter_type"] = "webnovel"
        elif filter_type == "normal":
            query += " AND b.book_type = :filter_type"
            query_params["filter_type"] = "normal"

        # 排序
        if sort_by == "alphabetical":
            query += " ORDER BY lower(v.word) ASC"
        elif sort_by == "review_count":
            query += " ORDER BY v.review_count DESC"
        elif sort_by == "query_count":
            query += " ORDER BY v.query_count DESC, v.last_queried_at DESC"
        elif sort_by == "priority_score":
            query += " ORDER BY v.priority_score DESC, v.last_queried_at DESC"
        else:  # newest
            query += " ORDER BY v.created_at DESC"

        # 分页
        offset = (page - 1) * per_page
        query += " LIMIT :per_page OFFSET :offset"
        query_params["per_page"] = per_page
        query_params["offset"] = offset

        # 执行查询
        vocab_rows = db.execute(text(query), query_params).fetchall()

        # 获取所有上下文
        context_rows = []
        if vocab_rows:
            words = [row[1] for row in vocab_rows]
            params = {}
            for i, word in enumerate(words):
                params[f"word{i}"] = word.lower()

            # Fix: Ensure words are quoted properly or handled by parameter binding safely
            # SQLAlchemy handles list binding for IN clause natively usually, but with text() we need to be careful.
            # Using individual params is safer for SQLite.
            placeholders = ",".join([f":word{i}" for i in range(len(words))])

            if placeholders:
                context_sql = f"""
                    SELECT wc.id, wc.word, wc.book_id, wc.page_number, wc.context_sentence,
                           b.title as book_title, b.book_type as book_type, wc.is_primary,
                           {normalized_source_expr} as source_type,
                           b.author as book_author
                    FROM word_contexts wc
                    JOIN books b ON wc.book_id = b.id
                    WHERE lower(wc.word) IN ({placeholders})
                    ORDER BY
                        CASE
                            WHEN wc.is_primary = 1 THEN 0
                            WHEN {normalized_source_expr} = 'user_collected' THEN 1
                            ELSE 2
                        END,
                        wc.id DESC
                """
                context_rows = db.execute(text(context_sql), params).fetchall()

        # Group contexts by word
        word_to_contexts = {}
        for ctx in context_rows:
            # Fix: Check for None before accessing index 1 (word)
            if not ctx or not ctx[1]:
                continue
            w_lower = ctx[1].lower()
            if w_lower not in word_to_contexts:
                word_to_contexts[w_lower] = []
            if len(word_to_contexts[w_lower]) < 10:
                word_to_contexts[w_lower].append(ctx)

        # Assemble result
        result = []
        for row in vocab_rows:
            v_word = row[1]
            ctx_list = word_to_contexts.get(v_word.lower(), [])
            primary_ctx = None
            example_ctxs = []

            for ctx_item in ctx_list:
                if ctx_item[7] == 1:
                    if primary_ctx is None:
                        primary_ctx = ctx_item
                    else:
                        example_ctxs.append(ctx_item)
                else:
                    example_ctxs.append(ctx_item)

            sorted_examples = sorted(
                example_ctxs,
                key=lambda x: x[0],
                reverse=True,
            )[:5]

            primary_context_data = None
            if primary_ctx:
                primary_context_data = {
                    "book_id": primary_ctx[2],
                    "book_title": primary_ctx[5],
                    "page_number": primary_ctx[3],
                    "context_sentence": primary_ctx[4],
                }
            elif row[6]:  # v_context
                primary_context_data = {
                    "book_id": row[5],
                    "book_title": row[15],
                    "page_number": 0,
                    "context_sentence": row[6],
                }

            result.append(
                {
                    "id": row[0],
                    "word": row[1],
                    "phonetic": row[2],
                    "definition": json.loads(row[3]) if row[3] else None,
                    "translation": row[4],
                    "primary_context": primary_context_data,
                    "example_contexts": [
                        {
                            "book_id": ctx[2],
                            "book_title": ctx[5],
                            "book_type": ctx[6],
                            "page_number": ctx[3],
                            "context_sentence": ctx[4],
                            "source_type": ctx[8],
                        }
                        for ctx in sorted_examples
                    ],
                    "review_count": row[7] if row[7] else 0,
                    "query_count": row[8] if row[8] else 0,
                    "mastery_level": row[9] if row[9] else 1,
                    "difficulty_score": row[10] if row[10] else 0,
                    "priority_score": row[11] if row[11] else 0.0,
                    "learning_status": row[12] if row[12] else "new",
                    "last_queried_at": row[13].isoformat() if row[13] and hasattr(row[13], "isoformat") else None,
                    "created_at": row[14].isoformat() if hasattr(row[14], "isoformat") else str(row[14]),
                }
            )
        return result

    except Exception as e:
        logger.error(f"Error fetching vocabulary: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))




def format_vocab_response_with_db(vocab_row: tuple, db: Session):
    """格式化生词响应（使用原生SQL）"""
    definition_data = None
    if vocab_row[3]:
        try:
            definition_data = json.loads(vocab_row[3])
        except:
            pass

    book_title = None
    if vocab_row[6]:
        book = db.execute(text("SELECT title FROM books WHERE id = :id"), {"id": vocab_row[6]}).fetchone()
        if book:
            book_title = book[0]

    return VocabularyResponse(
        id=vocab_row[0],
        word=vocab_row[1],
        phonetic=vocab_row[2],
        definition=definition_data,
        translation=vocab_row[4],
        primary_context=None,  # 需要重新查询
        example_contexts=[],
        review_count=vocab_row[11] if vocab_row[11] else 0,
        query_count=vocab_row[15] if vocab_row[15] else 0,
        mastery_level=vocab_row[9] if vocab_row[9] else 1,
        difficulty_score=vocab_row[13] if vocab_row[13] else 0,
        priority_score=vocab_row[17] if vocab_row[17] else 0.0,
        learning_status=vocab_row[18] if vocab_row[18] else "new",
        created_at=vocab_row[10].isoformat() if hasattr(vocab_row[10], "isoformat") else str(vocab_row[10]),
        last_queried_at=vocab_row[16].isoformat() if vocab_row[16] and hasattr(vocab_row[16], "isoformat") else None,
    )


@router.delete("/{vocab_id}")
def delete_vocabulary(vocab_id: int, db: Session = Depends(get_db)):
    """删除生词"""
    try:
        with db.begin():
            # 删除关联的上下文
            db.execute(
                text("""
                DELETE FROM word_contexts
                WHERE word = (SELECT word FROM vocabulary WHERE id = :vocab_id)
            """),
                {"vocab_id": vocab_id},
            )

            # 删除生词
            db.execute(
                text("DELETE FROM vocabulary WHERE id = :vocab_id"),
                {"vocab_id": vocab_id},
            )

            db.commit()

        return {"status": "success"}

    except Exception as e:
        logger.error(f"Error deleting vocabulary: {e}")
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


def _sm2(quality: int, repetitions: int, ease_factor: float, interval: int):
    """
    SM-2 间隔重复算法核心。

    quality:   0=完全忘记, 3=模糊记得, 5=完美记得
    返回: (new_interval_days, new_ease_factor, new_repetitions)
    """
    if quality >= 3:
        if repetitions == 0:
            new_interval = 1
        elif repetitions == 1:
            new_interval = 6
        else:
            new_interval = max(1, round(interval * ease_factor))
        new_repetitions = repetitions + 1
        new_ef = ease_factor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
        new_ef = max(1.3, round(new_ef, 4))
    else:
        new_interval = 1
        new_repetitions = 0
        new_ef = ease_factor  # 失败不降低 EF，只重置间隔
    return new_interval, new_ef, new_repetitions


@router.patch("/{vocab_id}/mastery")
def update_mastery(vocab_id: int, data: dict, db: Session = Depends(get_db)):
    """
    更新生词掌握程度和复习信息。

    支持传入 quality（0/3/5）触发 SM-2 计算：
      quality=0  忘了 → 重置间隔为 1 天
      quality=3  模糊 → 间隔缓慢增长
      quality=5  记得 → 间隔正常增长

    返回值额外包含 next_review_days（距下次复习的天数）。
    """
    try:
        with db.begin():
            vocab = db.execute(text("SELECT * FROM vocabulary WHERE id = :id"), {"id": vocab_id}).fetchone()

            if not vocab:
                raise HTTPException(status_code=404, detail="Vocabulary not found")

            now = datetime.utcnow()

            # --- SRS：若传入 quality，运行 SM-2 ---
            next_review_days = None
            if "quality" in data:
                quality = int(data["quality"])
                # 从数据库读取当前 SRS 状态（列可能不存在则用默认值）
                vocab_keys = vocab._fields if hasattr(vocab, "_fields") else []
                srs_interval = vocab[vocab_keys.index("srs_interval")] if "srs_interval" in vocab_keys else 1
                srs_ease = vocab[vocab_keys.index("srs_ease_factor")] if "srs_ease_factor" in vocab_keys else 2.5
                srs_reps = vocab[vocab_keys.index("srs_repetitions")] if "srs_repetitions" in vocab_keys else 0

                new_interval, new_ef, new_reps = _sm2(
                    quality,
                    srs_reps or 0,
                    srs_ease or 2.5,
                    srs_interval or 1,
                )
                next_review_at = now + timedelta(days=new_interval)
                next_review_days = new_interval

                db.execute(
                    text("""
                        UPDATE vocabulary
                        SET srs_interval = :interval,
                            srs_ease_factor = :ef,
                            srs_repetitions = :reps,
                            next_review_at = :next_review,
                            review_count = review_count + 1,
                            last_reviewed_at = :now
                        WHERE id = :id
                    """),
                    {
                        "interval": new_interval,
                        "ef": new_ef,
                        "reps": new_reps,
                        "next_review": next_review_at,
                        "now": now,
                        "id": vocab_id,
                    },
                )
                # 根据质量同步更新 mastery_level
                vocab_row = db.execute(text("SELECT mastery_level FROM vocabulary WHERE id = :id"), {"id": vocab_id}).fetchone()
                current_mastery = vocab_row[0] if vocab_row else 1
                if quality >= 4:
                    new_mastery = min(5, current_mastery + 1)
                elif quality <= 1:
                    new_mastery = max(1, current_mastery - 1)
                else:
                    new_mastery = current_mastery
                db.execute(
                    text("UPDATE vocabulary SET mastery_level = :m WHERE id = :id"),
                    {"m": new_mastery, "id": vocab_id},
                )
            else:
                # 兼容旧版调用（直接设置 mastery_level / difficulty_score 等字段）
                if "mastery_level" in data:
                    db.execute(
                        text("UPDATE vocabulary SET mastery_level = :mastery_level WHERE id = :id"),
                        {"mastery_level": data["mastery_level"], "id": vocab_id},
                    )
                if "review_count" in data:
                    db.execute(
                        text("UPDATE vocabulary SET review_count = review_count + 1 WHERE id = :id"),
                        {"id": vocab_id},
                    )
                if "last_reviewed_at" in data:
                    db.execute(
                        text("UPDATE vocabulary SET last_reviewed_at = :last_reviewed_at WHERE id = :id"),
                        {"last_reviewed_at": data["last_reviewed_at"], "id": vocab_id},
                    )
                if "difficulty_score" in data:
                    db.execute(
                        text("UPDATE vocabulary SET difficulty_score = :difficulty_score WHERE id = :id"),
                        {"difficulty_score": data["difficulty_score"], "id": vocab_id},
                    )

            # 同步 learning_status
            vocab_updated = db.execute(text("SELECT * FROM vocabulary WHERE id = :id"), {"id": vocab_id}).fetchone()
            if vocab_updated is None:
                raise HTTPException(status_code=404, detail="Vocabulary not found")

            cols = vocab_updated._fields if hasattr(vocab_updated, "_fields") else []
            mastery_idx = cols.index("mastery_level") if "mastery_level" in cols else 9
            review_idx = cols.index("review_count") if "review_count" in cols else 7
            status_idx = cols.index("learning_status") if "learning_status" in cols else 12

            new_status = vocab_updated[status_idx]
            if vocab_updated[mastery_idx] >= 5 and vocab_updated[review_idx] >= 3:
                new_status = "mastered"
            elif vocab_updated[review_idx] > 0:
                new_status = "learning"

            if new_status != vocab_updated[status_idx]:
                db.execute(
                    text("UPDATE vocabulary SET learning_status = :status WHERE id = :id"),
                    {"status": new_status, "id": vocab_id},
                )

            db.commit()

            result = format_vocab_response_with_db(vocab_updated, db)
            if next_review_days is not None:
                result["next_review_days"] = next_review_days
            return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating mastery: {e}")
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/due")
def get_due_vocabulary(
    limit: int = 20,
    db: Session = Depends(get_db)
):
    """
    获取当前到期需要复习的生词（SRS 调度）。

    排序规则：
      1. 从未复习过的新词（next_review_at IS NULL）优先
      2. 按到期时间升序（最早到期的优先）
    """
    try:
        now = datetime.utcnow()
        rows = db.execute(
            text("""
                SELECT v.id, v.word, v.phonetic, v.translation,
                       v.mastery_level, v.review_count, v.difficulty_score,
                       v.priority_score, v.learning_status,
                       v.next_review_at, v.srs_interval, v.srs_repetitions
                FROM vocabulary v
                WHERE v.next_review_at IS NULL
                   OR v.next_review_at <= :now
                ORDER BY v.next_review_at ASC NULLS FIRST
                LIMIT :limit
            """),
            {"now": now, "limit": limit},
        ).fetchall()

        result = []
        for row in rows:
            next_review_at = row[9]
            # 计算逾期天数（负数表示逾期，正数不应出现）
            overdue_days = None
            if next_review_at:
                try:
                    if isinstance(next_review_at, str):
                        nra = datetime.fromisoformat(next_review_at)
                    else:
                        nra = next_review_at
                    overdue_days = (now - nra).days
                except Exception:
                    pass

            result.append({
                "id": row[0],
                "word": row[1],
                "phonetic": row[2],
                "translation": row[3],
                "mastery_level": row[4] or 1,
                "review_count": row[5] or 0,
                "difficulty_score": row[6] or 0,
                "priority_score": row[7] or 0.0,
                "learning_status": row[8] or "new",
                "next_review_at": next_review_at.isoformat() if hasattr(next_review_at, "isoformat") else next_review_at,
                "overdue_days": overdue_days,
                "srs_interval": row[10] or 1,
                "srs_repetitions": row[11] or 0,
            })

        return {"items": result, "total": len(result), "reviewed_at": now.isoformat()}
    except Exception as e:
        logger.error(f"Error fetching due vocabulary: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/export/csv")
def export_vocabulary_csv(db: Session = Depends(get_db)):
    """导出所有生词为 CSV（Excel 兼容格式）"""
    try:
        rows = db.execute(text("""
            SELECT v.word, v.phonetic, v.translation, v.definition,
                   (SELECT wc2.context_sentence FROM word_contexts wc2
                    WHERE lower(wc2.word) = lower(v.word) AND wc2.is_primary = 1
                    LIMIT 1) AS primary_context,
                   b.title AS book_title, v.created_at
            FROM vocabulary v
            LEFT JOIN books b ON v.book_id = b.id
            ORDER BY v.created_at DESC
        """)).fetchall()

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(['Word', 'Phonetic', 'Translation', 'Definition', 'Context', 'Book Title', 'Created At'])

        for row in rows:
            word = row[0] or ""
            phonetic = row[1] or ""
            translation = row[2] or ""
            definition_text = _extract_definition_text(row[3])
            context = row[4] or ""
            book_title = row[5] or ""
            created_at = row[6][:10] if row[6] else ""
            writer.writerow([word, phonetic, translation, definition_text, context, book_title, created_at])

        output.seek(0)
        return Response(
            content=output.getvalue(),
            media_type="text/csv",
            headers={
                "Content-Disposition": f"attachment; filename=vocabulary_{datetime.now().strftime('%Y%m%d')}.csv"
            }
        )
    except Exception as e:
        logger.error(f"Error exporting vocabulary CSV: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def _extract_definition_text(raw: str) -> str:
    """从 JSON 或纯文本中提取可读释义"""
    if not raw:
        return ""
    try:
        df = json.loads(raw)
        if isinstance(df, dict):
            for key in ("chinese_summary", "translation", "en_definition"):
                if df.get(key):
                    return str(df[key])
            return str(raw)[:200]
    except Exception:
        pass
    return str(raw)[:200]


@router.get("/export/anki")
def export_vocabulary_anki(db: Session = Depends(get_db)):
    """
    导出生词为 Anki 可导入的 TSV 文本文件。

    字段顺序（在 Anki 导入时按此顺序映射字段）：
    单词 | 读音 | 翻译/释义 | 例句（HTML，含翻译）| 来源书名

    首次导出时会调用 AI 翻译未翻译的例句并缓存，后续导出直接复用缓存。
    若 AI 未配置，例句不含翻译。

    导入步骤：
      1. Anki → 文件 → 导入
      2. 选择此 .txt 文件，分隔符选 Tab
      3. 将字段映射到对应的笔记类型字段
    """
    try:
        # 获取所有生词及其全部例句（主例句 + 自动提取例句）
        vocab_rows = db.execute(text("""
            SELECT v.id, v.word, v.phonetic, v.translation, v.definition,
                   b.title AS book_title
            FROM vocabulary v
            LEFT JOIN books b ON v.book_id = b.id
            ORDER BY v.created_at DESC
        """)).fetchall()

        if not vocab_rows:
            return Response(
                content="",
                media_type="text/plain",
                headers={"Content-Disposition": "attachment; filename=vocabulary_anki.txt"}
            )

        # 批量查询所有例句（含已缓存翻译），按 word 聚合
        ctx_rows = db.execute(text("""
            SELECT lower(wc.word) AS word_key,
                   wc.id,
                   wc.context_sentence,
                   wc.sentence_translation,
                   wc.is_primary
            FROM word_contexts wc
            ORDER BY wc.is_primary DESC, wc.id ASC
        """)).fetchall()

        # 取所有例句（主例句在前，按 id 排序），直接使用数据库已缓存的翻译，不在导出时发起 AI 调用
        ctx_map: dict = {}  # word_key -> [(ctx_id, sentence, translation), ...]

        for ctx in ctx_rows:
            word_key, ctx_id, sentence, translation, _is_primary = ctx[0], ctx[1], ctx[2], ctx[3], ctx[4]
            if not sentence:
                continue
            if word_key not in ctx_map:
                ctx_map[word_key] = []
            ctx_map[word_key].append([ctx_id, sentence, translation or ""])

        output = io.StringIO()
        # Anki 识别的元数据注释（可选，让导入时自动选对分隔符和 HTML 模式）
        output.write("#separator:tab\n")
        output.write("#html:true\n")
        output.write("#notetype:Basic\n")

        for row in vocab_rows:
            word = row[1] or ""
            phonetic = f"[{row[2]}]" if row[2] else ""
            translation = row[3] or ""
            definition = _extract_definition_text(row[4])
            book_title = row[5] or ""

            # 合并翻译和释义
            back_text = translation
            if definition and definition != translation:
                back_text = f"{translation}<br><small>{definition}</small>" if translation else definition

            # 例句：主例句在前，最多取 3 条，每条附上翻译
            entries = ctx_map.get(word.lower(), [])
            example_parts = []
            for _ctx_id, sentence, sent_trans in entries:
                if not sentence or not sentence.strip():
                    continue
                part = f"<i>{sentence.strip()}</i>"
                if sent_trans and sent_trans.strip():
                    part += f"<br><span style='color:#888;font-size:0.85em'>{sent_trans.strip()}</span>"
                example_parts.append(part)
            examples_html = "<br><br>".join(example_parts)

            # 字段：正面（word + 读音），背面（翻译 + 释义 + 例句 + 书名）
            front = f"{word}<br><span style='color:#888;font-size:0.85em'>{phonetic}</span>" if phonetic else word
            back_parts = [back_text]
            if examples_html:
                back_parts.append(examples_html)
            if book_title:
                back_parts.append(f"<small style='color:#aaa'>📖 {book_title}</small>")
            back = "<br><br>".join(p for p in back_parts if p)

            # TSV 中 tab 和换行需要转义
            front_clean = front.replace("\t", " ")
            back_clean = back.replace("\t", " ")
            output.write(f"{front_clean}\t{back_clean}\n")

        output.seek(0)
        filename = f"vocabulary_anki_{datetime.now().strftime('%Y%m%d')}.txt"
        return Response(
            content=output.getvalue().encode("utf-8"),
            media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )
    except Exception as e:
        logger.error(f"Error exporting Anki vocabulary: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/query")
def track_word_query(data: dict, db: Session = Depends(get_db)):
    """
    用户点击词典查询单词时调用

    只对已收藏（存在于vocabulary表）的单词记录查询次数
    未收藏的单词不记录
    """
    try:
        word = data.get("word", "").strip()
        book_id = data.get("book_id", "")
        page_number = data.get("page_number", 0)

        if not word:
            raise HTTPException(status_code=400, detail="Word is required")

        with db.begin():
            # 检查单词是否已收藏（不区分大小写）
            existing = db.execute(
                text("""
                    SELECT id, query_count, learning_status, mastery_level, 
                           last_queried_at, last_reviewed_at, created_at
                    FROM vocabulary
                    WHERE lower(word) = lower(:word)
                    LIMIT 1
                """),
                {"word": word},
            ).fetchone()

            if existing:
                # 已收藏：更新查询次数
                vocab_id = existing[0]

                # 更新查询次数和最后查询时间
                db.execute(
                    text("""
                        UPDATE vocabulary 
                        SET query_count = query_count + 1,
                            last_queried_at = :now
                        WHERE id = :id
                    """),
                    {"id": vocab_id, "now": datetime.utcnow()},
                )

                # 实时重新计算优先级（使用安全版本）
                from app.utils.priority_calculator_safe import (
                    calculate_priority_score,
                    get_learning_status,
                )

                word_dict = {
                    "query_count": existing[1] + 1 if existing[1] is not None else 1,
                    "mastery_level": existing[3] if existing[3] is not None else 1,
                    "last_queried_at": datetime.utcnow(),
                    "last_reviewed_at": existing[5],
                    "created_at": existing[6],
                }

                priority = calculate_priority_score(word_dict)
                status = get_learning_status(priority)

                # 更新优先级和状态
                db.execute(
                    text("""
                        UPDATE vocabulary 
                        SET priority_score = :priority,
                            learning_status = :status
                        WHERE id = :id
                    """),
                    {"priority": priority, "status": status, "id": vocab_id},
                )

                return {
                    "success": True,
                    "tracked": True,
                    "query_count": (existing[1] or 0) + 1,
                    "priority_score": priority,
                    "learning_status": status,
                }
            else:
                # 未收藏：不记录
                return {
                    "success": True,
                    "tracked": False,
                    "message": "Word not in vocabulary, not tracking",
                }

    except Exception as e:
        logger.error(f"Error tracking word query: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/update_priorities")
def update_all_priorities(db: Session = Depends(get_db)):
    """
    批量更新所有单词的优先级分数
    建议每天定时运行（如凌晨3点）
    """
    try:
        from app.utils.priority_calculator_safe import batch_update_priorities

        # 批量更新
        stats = batch_update_priorities(db)

        db.commit()

        logger.info(f"Priority update completed: {stats}")

        return {
            "success": True,
            "total": stats["total"],
            "updated": stats["updated"],
            "errors": len(stats["errors"]),
        }

    except Exception as e:
        logger.error(f"Error updating priorities: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{vocab_id}/extract_examples")
def extract_examples_manual(vocab_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """
    手动触发例句提取任务
    只有当例句总数少于20个时才允许提取
    """
    try:
        vocab = db.execute(text("SELECT word FROM vocabulary WHERE id = :id"), {"id": vocab_id}).fetchone()

        if not vocab:
            raise HTTPException(status_code=404, detail="Vocabulary not found")

        word = vocab[0]

        # 检查当前自动提取例句数量（兼容历史 `normal` 数据）
        current_count = get_auto_extracted_context_count(db, word)

        # 最多20个例句，已达到上限则不提取
        if current_count >= 20:
            return {
                "status": "skipped",
                "message": f"Already have {current_count} examples (max: 20)",
                "current_count": current_count,
                "max_count": 20,
            }

        logger.info(f"[手动提取] 单词 '{word}' 当前有 {current_count} 个例句，将提取到 20 个")

        # Add to background tasks
        background_tasks.add_task(run_example_extraction_task, word, max_total=20)

        return {
            "status": "success",
            "message": f"Example extraction started for '{word}' (current: {current_count}, max: 20)",
            "current_count": current_count,
        }

    except Exception as e:
        logger.error(f"Error triggering manual extraction: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{vocab_id}/context")
def add_word_context(vocab_id: int, data: dict, db: Session = Depends(get_db)):
    """
    为已收藏的单词添加新的上下文（用户收藏的上下文）

    Args:
        vocab_id: 单词ID
        data: 包含 word, book_id, page_number, context_sentence

    Returns:
        添加结果
    """
    try:
        word = data.get("word", "").strip()
        book_id = data.get("book_id", "")
        page_number = data.get("page_number", 0)
        context_sentence = data.get("context_sentence", "")
        is_primary = data.get("is_primary", 0)
        source_type = "user_collected"  # 用户主动收藏的上下文

        # 验证 vocab_id 是否存在，并且对应的单词是否匹配
        vocab = db.execute(text("SELECT word FROM vocabulary WHERE id = :id"), {"id": vocab_id}).fetchone()

        if not vocab:
            raise HTTPException(status_code=404, detail="Vocabulary not found")

        if vocab[0].lower() != word.lower():
            raise HTTPException(
                status_code=400,
                detail=f"Word '{word}' does not match vocabulary ID {vocab_id}",
            )

        if not word or not context_sentence:
            raise HTTPException(
                status_code=400,
                detail="Missing required fields: word and context_sentence",
            )

        if not book_id:
            raise HTTPException(status_code=400, detail="Missing required field: book_id")

        # 验证 book_id 是否存在
        book_exists = db.execute(text("SELECT 1 FROM books WHERE id = :book_id"), {"book_id": book_id}).fetchone()

        if not book_exists:
            raise HTTPException(status_code=404, detail=f"Book with ID '{book_id}' not found")

        with db.begin():
            # 检查上下文是否已存在
            existing = db.execute(
                text("""
                    SELECT 1 FROM word_contexts
                    WHERE lower(word) = lower(:word)
                      AND book_id = :book_id
                      AND context_sentence = :sentence
                """),
                {"word": word, "book_id": book_id, "sentence": context_sentence},
            ).fetchone()

            if existing:
                return {
                    "success": True,
                    "message": "Context already exists",
                    "existed": True,
                }

            # 插入新的用户收藏上下文
            db.execute(
                text("""
                    INSERT INTO word_contexts
                        (word, book_id, page_number, context_sentence, is_primary, source_type)
                    VALUES (:word, :book_id, :page_number, :sentence, :is_primary, :source_type)
                """),
                {
                    "word": word,
                    "book_id": book_id,
                    "page_number": page_number,
                    "sentence": context_sentence,
                    "is_primary": is_primary,
                    "source_type": source_type,
                },
            )

            return {
                "success": True,
                "message": "Context added successfully",
                "tracked": True,
            }

    except Exception as e:
        logger.error(f"Error adding word context: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{vocab_id}/extraction_status")
def check_extraction_status(vocab_id: int, db: Session = Depends(get_db)):
    """
    检查单词的例句提取状态

    返回：
        - total_examples: 总例句数
        - example_library_count: 例句库例句数
        - status: 提取状态
            - 'completed': 已完成（>=5个例句库例句）
            - 'pending': 进行中或数量不足
            - 'failed': 失败（无例句库书籍或其他错误）
    """
    try:
        # 获取单词信息
        vocab = db.execute(text("SELECT word FROM vocabulary WHERE id = :id"), {"id": vocab_id}).fetchone()

        if not vocab:
            raise HTTPException(status_code=404, detail="Vocabulary not found")

        word = vocab[0]
        normalized_source_expr = _normalized_context_source_sql("word_contexts")

        # 统计例句数量
        stats = db.execute(
            text(f"""
                SELECT
                    COUNT(*) as total,
                    SUM(CASE WHEN {normalized_source_expr} = :source_type THEN 1 ELSE 0 END) as lib_count
                FROM word_contexts
                WHERE lower(word) = lower(:word)
            """),
            {"word": word, "source_type": AUTO_EXTRACTED_SOURCE_TYPE},
        ).fetchone()

        if stats is None:
            total_examples = 0
            lib_count = 0
        else:
            total_examples = stats[0] or 0  # type: ignore
            lib_count = stats[1] or 0  # type: ignore

        # 检查是否有例句库书籍
        lib_books = db.execute(text("SELECT COUNT(*) FROM books WHERE book_type = 'example_library'")).scalar() or 0
        extraction_in_progress = is_example_extraction_in_progress(word)

        # 判断状态
        if lib_count >= 5:
            status = "completed"
            message = f"已完成提取（{lib_count}个例句）"
        elif lib_books == 0:
            status = "failed"
            message = "未上传例句库书籍"
        elif extraction_in_progress:
            status = "pending"
            message = "正在提取例句..."
        elif total_examples == 0:
            status = "failed"
            message = "例句库中未找到可提取的例句"
        else:
            status = "pending"
            message = f"提取中（{lib_count}/5）"

        return {
            "word": word,
            "vocab_id": vocab_id,
            "total_examples": total_examples,
            "example_library_count": lib_count,
            "auto_extracted_count": lib_count,
            "status": status,
            "message": message,
        }

    except Exception as e:
        logger.error(f"Error checking extraction status: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
