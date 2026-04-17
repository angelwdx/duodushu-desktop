"""全局内容搜索 API 路由（基于 FTS5 全文索引）"""

import sqlite3
from fastapi import APIRouter, Query
from typing import List, Optional
from pydantic import BaseModel
from app.config import DB_PATH

router = APIRouter(prefix="/api/search", tags=["search"])


class PageResult(BaseModel):
    """书内页面搜索结果"""
    book_id: str
    book_title: str
    page_number: int
    snippet: str  # 上下文摘要，含高亮标记


class BookResult(BaseModel):
    """书名搜索结果"""
    id: str
    title: str
    author: Optional[str] = None
    format: str


class SearchResponse(BaseModel):
    books: List[BookResult]
    pages: List[PageResult]


@router.get("/", response_model=SearchResponse)
def search(
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(20, ge=1, le=50),
):
    """
    全局内容搜索。
    - books: 书名包含关键词的书籍
    - pages: FTS5 全文搜索匹配的页面（含上下文摘要）
    """
    q = q.strip()
    if not q:
        return SearchResponse(books=[], pages=[])

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        # 1. 书名模糊匹配
        book_rows = conn.execute(
            """
            SELECT id, title, author, format
            FROM books
            WHERE status = 'completed'
              AND (title LIKE ? OR author LIKE ?)
            LIMIT ?
            """,
            (f"%{q}%", f"%{q}%", limit),
        ).fetchall()

        books = [
            BookResult(
                id=r["id"],
                title=r["title"],
                author=r["author"],
                format=r["format"],
            )
            for r in book_rows
        ]

        # 2. FTS5 全文搜索（带上下文摘要；FTS5 snippet 函数自动高亮）
        # snippet(table, col_idx, start_mark, end_mark, ellipsis, token_count)
        # col_idx=3 对应 text_content 列
        try:
            page_rows = conn.execute(
                """
                SELECT
                    pf.book_id,
                    b.title AS book_title,
                    pf.page_number,
                    snippet(pages_fts, 3, '<mark>', '</mark>', '...', 20) AS snippet
                FROM pages_fts pf
                JOIN books b ON b.id = pf.book_id
                WHERE pages_fts MATCH ?
                  AND b.status = 'completed'
                ORDER BY rank
                LIMIT ?
                """,
                (q, limit),
            ).fetchall()

            pages = [
                PageResult(
                    book_id=r["book_id"],
                    book_title=r["book_title"],
                    page_number=r["page_number"],
                    snippet=r["snippet"] or "",
                )
                for r in page_rows
            ]
        except sqlite3.OperationalError:
            # FTS5 不可用或索引未初始化，降级为空结果
            pages = []

        return SearchResponse(books=books, pages=pages)

    finally:
        conn.close()
