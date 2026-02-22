from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from sqlalchemy import text
from ..models.database import get_db, SessionLocal
from typing import List, Optional
from pydantic import BaseModel
import json
from datetime import datetime, timedelta
import logging
import traceback

# 从拆分后的模块导入例句提取服务
from ..services.extraction_service import run_example_extraction_task

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/vocabulary", tags=["vocabulary"])


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
                existing_library_count = (
                    db.execute(
                        text("""
                        SELECT COUNT(*) FROM word_contexts 
                        WHERE lower(word) = lower(:word) 
                          AND source_type = 'example_library'
                    """),
                        {"word": target_word},
                    ).scalar()
                    or 0
                )

                if existing_library_count < 5:
                    logger.info(
                        f"[例句提取] 已存在单词 '{target_word}' 只有 {existing_library_count} 个例句库例句，添加后台任务提取更多"
                    )
                    background_tasks.add_task(run_example_extraction_task, target_word)
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
        background_tasks.add_task(run_example_extraction_task, data.word)

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
            text("""
                SELECT wc.id, wc.word, wc.book_id, wc.page_number, wc.context_sentence,
                       b.title as book_title, b.book_type as book_type, wc.is_primary,
                       COALESCE(wc.source_type, 'user_collected') as source_type,
                       b.author as book_author
                FROM word_contexts wc
                JOIN books b ON wc.book_id = b.id
                WHERE lower(wc.word) = lower(:word)
                ORDER BY
                    CASE
                        WHEN wc.is_primary = 1 THEN 0
                        WHEN COALESCE(wc.source_type, 'user_collected') = 'user_collected' THEN 1
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
                           COALESCE(wc.source_type, 'user_collected') as source_type,
                           b.author as book_author
                    FROM word_contexts wc
                    JOIN books b ON wc.book_id = b.id
                    WHERE lower(wc.word) IN ({placeholders})
                    ORDER BY
                        CASE
                            WHEN wc.is_primary = 1 THEN 0
                            WHEN COALESCE(wc.source_type, 'user_collected') = 'user_collected' THEN 1
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


@router.patch("/{vocab_id}/mastery")
def update_mastery(vocab_id: int, data: dict, db: Session = Depends(get_db)):
    """更新生词掌握程度和复习信息"""
    try:
        with db.begin():
            # 检查生词是否存在
            vocab = db.execute(text("SELECT * FROM vocabulary WHERE id = :id"), {"id": vocab_id}).fetchone()

            if not vocab:
                raise HTTPException(status_code=404, detail="Vocabulary not found")

            # 更新字段
            if "mastery_level" in data:
                db.execute(
                    text("""
                    UPDATE vocabulary
                    SET mastery_level = :mastery_level
                    WHERE id = :id
                """),
                    {"mastery_level": data["mastery_level"], "id": vocab_id},
                )

            if "review_count" in data:
                db.execute(
                    text("""
                    UPDATE vocabulary
                    SET review_count = review_count + 1
                    WHERE id = :id
                """),
                    {"review_count": data["review_count"], "id": vocab_id},
                )

            if "last_reviewed_at" in data:
                db.execute(
                    text("""
                    UPDATE vocabulary
                    SET last_reviewed_at = :last_reviewed_at
                    WHERE id = :id
                """),
                    {"last_reviewed_at": data["last_reviewed_at"], "id": vocab_id},
                )

            if "difficulty_score" in data:
                db.execute(
                    text("""
                    UPDATE vocabulary
                    SET difficulty_score = :difficulty_score
                    WHERE id = :id
                """),
                    {"difficulty_score": data["difficulty_score"], "id": vocab_id},
                )

            # 返回更新后的数据
            vocab_updated = db.execute(text("SELECT * FROM vocabulary WHERE id = :id"), {"id": vocab_id}).fetchone()

            if vocab_updated is None:
                raise HTTPException(status_code=404, detail="Vocabulary not found")

            return format_vocab_response_with_db(vocab_updated, db)  # type: ignore

    except Exception as e:
        logger.error(f"Error updating vocabulary: {e}")
        db.rollback()
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
                    "query_count": existing[1] + 1,
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

        # 检查当前例句数量（只统计 example_library 类型的例句）
        current_count = (
            db.execute(
                text("""
                SELECT COUNT(*) FROM word_contexts
                WHERE lower(word) = lower(:word)
                  AND source_type = 'example_library'
            """),
                {"word": word},
            ).scalar()
            or 0
        )

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

        # 统计例句数量
        stats = db.execute(
            text("""
                SELECT
                    COUNT(*) as total,
                    SUM(CASE WHEN source_type = 'example_library' THEN 1 ELSE 0 END) as lib_count
                FROM word_contexts
                WHERE lower(word) = lower(:word)
            """),
            {"word": word},
        ).fetchone()

        if stats is None:
            total_examples = 0
            lib_count = 0
        else:
            total_examples = stats[0] or 0  # type: ignore
            lib_count = stats[1] or 0  # type: ignore

        # 检查是否有例句库书籍
        lib_books = db.execute(text("SELECT COUNT(*) FROM books WHERE book_type = 'example_library'")).scalar()

        # 判断状态
        if lib_books == 0:
            status = "failed"
            message = "未上传例句库书籍"
        elif lib_count >= 5:
            status = "completed"
            message = f"已完成提取（{lib_count}个例句）"
        elif total_examples == 0:
            status = "pending"
            message = "正在提取例句..."
        else:
            status = "pending"
            message = f"提取中（{lib_count}/5）"

        return {
            "word": word,
            "vocab_id": vocab_id,
            "total_examples": total_examples,
            "example_library_count": lib_count,
            "status": status,
            "message": message,
        }

    except Exception as e:
        logger.error(f"Error checking extraction status: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
