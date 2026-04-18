"""
例句提取服务模块

负责从书籍中为生词提取例句的后台任务逻辑。
从 vocabulary.py 路由文件中拆分出来，降低单文件复杂度。
"""

import threading
import time
import traceback
import logging

from sqlalchemy.orm import Session
from sqlalchemy import text
from typing import Optional

from app.models.database import SessionLocal
from app.services.sentence_utils import extract_sentences_with_word, page_body_text_score, should_skip_page_text

logger = logging.getLogger(__name__)

AUTO_EXTRACTED_SOURCE_TYPE = "example_library"
USER_COLLECTED_SOURCE_TYPE = "user_collected"

# 配置专门的例句提取日志
extraction_logger = logging.getLogger("extraction")
extraction_logger.setLevel(logging.INFO)
if not extraction_logger.handlers:
    try:
        from app.config import DATA_DIR
        log_path = DATA_DIR / "extraction.log"
        file_handler = logging.FileHandler(log_path, encoding="utf-8")
    except Exception:
        file_handler = logging.FileHandler("extraction.log", encoding="utf-8")
    file_handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
    extraction_logger.addHandler(file_handler)

# 后台任务锁，防止并发冲突
extraction_lock = threading.Lock()

# 跟踪正在处理的单词（避免重复处理）
processing_words: set = set()


def normalized_context_source_sql(alias: str = "") -> str:
    """
    统一上下文来源类型。

    历史数据里曾出现 `source_type='normal'`，语义上它仍属于系统自动提取的例句。
    这里统一归并为：
    - user_collected
    - example_library
    """
    prefix = f"{alias}." if alias else ""
    return (
        f"COALESCE(NULLIF({prefix}source_type, 'normal'), "
        f"CASE WHEN {prefix}is_primary = 0 THEN '{AUTO_EXTRACTED_SOURCE_TYPE}' "
        f"ELSE '{USER_COLLECTED_SOURCE_TYPE}' END)"
    )


def get_auto_extracted_context_count(db: Session, word: str) -> int:
    """统计某个单词已保存的自动提取例句数量（兼容历史 `normal` 数据）。"""
    source_expr = normalized_context_source_sql()
    count = db.execute(
        text(f"""
            SELECT COUNT(*) FROM word_contexts
            WHERE lower(word) = lower(:word)
              AND {source_expr} = :source_type
        """),
        {"word": word, "source_type": AUTO_EXTRACTED_SOURCE_TYPE},
    ).scalar()
    return int(count or 0)


def is_example_extraction_in_progress(word: str) -> bool:
    """检查单词是否仍在后台提取中。"""
    with extraction_lock:
        return word.lower() in processing_words


def run_example_extraction_task(word: str, exclude_book_id: Optional[str] = None, max_total: int = 10):
    """
    后台任务：异步执行例句提取（改进版）

    Args:
        word: 要提取例句的单词
        max_total: 最多保留的例句总数（默认10，手动提取时为20）

    改进：
    - 使用锁机制避免并发冲突
    - 添加重试机制（最多3次）
    - 跟踪正在处理的单词避免重复
    - 独立数据库会话避免阻塞主请求
    - 根据已有例句数量动态计算需要提取的数量
    """
    word_lower = word.lower()

    # 检查是否正在处理
    if word_lower in processing_words:
        extraction_logger.info(f"[后台任务] 单词 '{word}' 正在处理中，跳过")
        return

    # 在整个重试流程开始前标记，退出后统一清除（避免重试间产生竞态窗口）
    with extraction_lock:
        if word_lower in processing_words:
            extraction_logger.info(f"[后台任务] 单词 '{word}' 正在处理中（锁检查），跳过")
            return
        processing_words.add(word_lower)

    retry_count = 0
    max_retries = 3

    try:
        while retry_count < max_retries:
            db = None
            try:
                extraction_logger.info(
                    f"[后台任务] 开始为单词 '{word}' 提取例句，上限 {max_total} 个（尝试 {retry_count + 1}/{max_retries}）"
                )
                logger.info(f"[后台任务] 开始为单词 '{word}' 提取例句，上限 {max_total} 个")

                db = SessionLocal()
                find_and_save_example_contexts(word, db, exclude_book_id=exclude_book_id, max_total=max_total)
                extraction_logger.info(f"[后台任务] 完成单词 '{word}' 的例句提取")
                logger.info(f"[后台任务] 完成单词 '{word}' 的例句提取")
                break  # 成功，退出重试

            except Exception as e:
                retry_count += 1
                extraction_logger.error(f"[后台任务] 单词 '{word}' 例句提取失败（尝试 {retry_count}/{max_retries}）: {e}")
                extraction_logger.error(f"[后台任务] 错误详情: {traceback.format_exc()}")
                logger.error(f"[后台任务] 单词 '{word}' 例句提取失败（尝试 {retry_count}/{max_retries}）: {e}")

                if retry_count >= max_retries:
                    extraction_logger.error(f"[后台任务] 单词 '{word}' 达到最大重试次数，放弃")
                else:
                    wait_time = 2 ** (retry_count - 1)
                    extraction_logger.info(f"[后台任务] 单词 '{word}' 等待 {wait_time} 秒后重试")
                    time.sleep(wait_time)

            finally:
                if db:
                    db.close()
                    db = None

    finally:
        with extraction_lock:
            processing_words.discard(word_lower)


def find_and_save_example_contexts(
    word: str, db: Session, exclude_book_id: Optional[str] = None, max_total: int = 10
):
    """
    仅在例句库书籍中查找这个词的例句并保存
    使用 FTS5 全文搜索提升性能和准确性

    Args:
        word: 要提取例句的单词
        db: 数据库会话
        exclude_book_id: 要排除的书籍ID（可选）
        max_total: 最多保留的例句总数（默认10，手动提取时可设为20）
    """
    try:
        extraction_logger.info(f"[例句提取] 开始为单词 '{word}' 提取例句，上限 {max_total} 个")

        # 查询已有的自动提取例句数量（兼容历史 `normal` 数据）
        existing_count = get_auto_extracted_context_count(db, word)

        extraction_logger.info(f"[例句提取] 单词 '{word}' 已有 {existing_count} 个自动提取例句")

        # 计算还需要提取多少个
        need_to_extract = max_total - existing_count
        if need_to_extract <= 0:
            extraction_logger.info(f"[例句提取] 单词 '{word}' 已达到 {max_total} 个例句上限，跳过提取")
            return

        extraction_logger.info(f"[例句提取] 单词 '{word}' 还需要提取 {need_to_extract} 个例句")

        # 使用 FTS5 全文搜索
        lib_books_count = (
            db.execute(text("SELECT COUNT(*) FROM books WHERE book_type = 'example_library'")).scalar() or 0
        )

        if lib_books_count <= 0:
            extraction_logger.info(f"[例句提取] 未发现例句库书籍，停止提取")
            return

        extraction_logger.info(f"[例句提取] 发现 {lib_books_count} 本例句库书籍，仅在例句库中搜索")
            
        # 仅在例句库书中查找
        query_str = """
            SELECT p.id, p.book_id, p.page_number, p.text_content, b.book_type
            FROM pages p
            INNER JOIN pages_fts fts ON p.id = fts.rowid
            INNER JOIN books b ON p.book_id = b.id
            WHERE fts.text_content MATCH :word
              AND b.book_type = 'example_library'
            ORDER BY
                p.id DESC
        """

        params = {"word": ""}
        if exclude_book_id:
            query_str = query_str.replace(
                "WHERE fts.text_content MATCH :word",
                "WHERE fts.text_content MATCH :word AND p.book_id != :exclude_book_id",
            )
            params["exclude_book_id"] = exclude_book_id

        # 使用引号包裹搜索词以进行精确匹配
        search_variants = [f'"{word}"']
        if word[0].islower():
            search_variants.append(f'"{word.capitalize()}"')

        search_match_str = " OR ".join(search_variants)
        params["word"] = search_match_str
        extraction_logger.info(f"[例句提取] FTS5搜索表达式: {search_match_str}")

        pages = db.execute(
            text(query_str),
            params,
        ).fetchall()

        extraction_logger.info(f"[例句提取] FTS5搜索到 {len(pages)} 页包含单词 '{word}'")

        if not pages:
            extraction_logger.info(f"[例句提取] 例句库中未找到单词 '{word}' 的页面，停止提取")
            return

        scored_pages = []
        skipped_pages = 0
        for page in pages:
            page_text = page[3] or ""
            if should_skip_page_text(page_text):
                skipped_pages += 1
                extraction_logger.info(
                    f"[例句提取] 跳过非正文页面 {page[2]} (book_id: {page[1][:8]}...)"
                )
                continue
            scored_pages.append((page_body_text_score(page_text), page))

        if skipped_pages:
            extraction_logger.info(f"[例句提取] 页面预过滤跳过 {skipped_pages} 页非正文内容")

        if not scored_pages:
            extraction_logger.info(f"[例句提取] 例句库命中的页面均被判定为非正文，停止提取")
            return

        scored_pages.sort(key=lambda item: (-item[0], -item[1][0]))

        # 提取句子并保存
        contexts_found = 0
        total_sentences = 0
        for page_score, page in scored_pages:
            if contexts_found >= need_to_extract:
                extraction_logger.info(
                    f"[例句提取] 已提取足够数量的例句 ({contexts_found}/{need_to_extract})，停止提取"
                )
                break

            sentences = extract_sentences_with_word(page[3], word)
            total_sentences += len(sentences)
            extraction_logger.info(
                f"[例句提取] 从页面 {page[2]} (book_id: {page[1][:8]}..., score={page_score}) 提取到 {len(sentences)} 个句子"
            )

            for sentence in sentences:
                existing = db.execute(
                    text("""
                    SELECT 1 FROM word_contexts
                    WHERE lower(word) = lower(:word)
                      AND book_id = :book_id
                      AND page_number = :page_number
                      AND context_sentence = :sentence
                """),
                    {
                        "word": word,
                        "book_id": page[1],
                        "page_number": page[2],
                        "sentence": sentence,
                    },
                ).fetchone()

                if not existing:
                    # 尝试翻译例句（允许失败，不阻断提取）
                    # 注意：AI 翻译在 INSERT 之前执行，此时不持有 DB 写锁
                    sentence_translation = None
                    try:
                        from app.services import supplier_factory as _sf
                        sentence_translation = _sf.translate_with_active_supplier(sentence)
                    except Exception:
                        pass

                    db.execute(
                        text("""
                        INSERT OR IGNORE INTO word_contexts
                            (word, book_id, page_number, context_sentence, sentence_translation,
                             is_primary, source_type)
                            VALUES (:word, :book_id, :page_number, :context_sentence,
                                    :sentence_translation, 0, :source_type)
                    """),
                        {
                            "word": word,
                            "book_id": page[1],
                            "page_number": page[2],
                            "context_sentence": sentence,
                            "sentence_translation": sentence_translation,
                            "source_type": AUTO_EXTRACTED_SOURCE_TYPE,
                        },
                    )
                    # 每条例句立即 commit，释放 SQLite 写锁，
                    # 避免长时间持锁导致主线程的收藏操作报 "database is locked"
                    db.commit()
                    contexts_found += 1
                    extraction_logger.info(f"[例句提取] 保存例句 #{contexts_found}: {sentence[:50]}...")
                    break  # 每页只取一个例句

        extraction_logger.info(
            f"[例句提取] ✓ 成功为单词 '{word}' 保存 {contexts_found} 个新例句 "
            f"(处理了 {total_sentences} 个句子，来自 {len(scored_pages)} 页候选)"
        )
        logger.info(f"例句提取完成：'{word}' -> {contexts_found} 个新例句")

    except Exception as e:
        extraction_logger.error(f"[例句提取] ✗ 错误：为单词 '{word}' 提取例句时失败: {e}")
        error_msg = traceback.format_exc()
        extraction_logger.error(f"[例句提取] 完整错误信息:\n{error_msg}")
        logger.error(f"例句提取异常：{e}", exc_info=True)
