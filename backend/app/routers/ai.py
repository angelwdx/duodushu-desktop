from __future__ import annotations
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, List, Literal
from ..services import gemini_service
from ..services import deepseek_service
from sqlalchemy.orm import Session
from sqlalchemy import text
from ..models.database import get_db
from ..models.models import Book
import logging

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ai", tags=["ai"])


# ========== 意图识别 ==========
def classify_user_intent(
    message: str,
) -> Literal[
    "language_learning",
    "content_location",
    "knowledge_retrieval",
    "reading_comprehension",
]:
    """
    识别用户意图

    分类：
    - language_learning: 讲解语法、词汇、翻译句子
    - content_location: 查找内容在哪一页、定位知识点
    - knowledge_retrieval: 某个概念在哪里讲过
    - reading_comprehension: 总结、分析全书内容
    """
    if not message or not message.strip():
        return "language_learning"

    lower_msg = message.lower()

    # 内容定位关键词
    location_keywords = [
        "在哪里",
        "哪一页",
        "第几页",
        "找一下",
        "查找",
        "搜索",
        "多少页",
        "总页数",
        "一共",
        "loc",
        "where",
        "which page",
        "find",
        "search",
        "how many pages",
    ]

    # 知识检索关键词
    retrieval_keywords = [
        "什么知识",
        "讲过",
        "提到",
        "解释过",
        "什么概念",
        "knowledge",
        "explained",
        "mentioned",
        "discussed",
        "concept",
    ]

    # 阅读理解关键词
    comprehension_keywords = [
        "总结",
        "概述",
        "主题",
        "主要观点",
        "讲了什么",
        "结局",
        "情节",
        "故事",
        "summarize",  # 添加英文同义词
        "summary",  # 添加英文同义词
        "overview",
        "theme",
        "main idea",
        "about",
        "ending",
        "plot",
        "story",
        "chapter",
        "chapter summary",
    ]

    # 1. 强制排除项：优先进入单页英语学习模式（具有最高优先级）
    page_keywords = [
        "这一页", "本页", "当前页", "this page", "current page",
        "讲解", "这段", "解析", "下一段", "这段内容", "explain this", "analyze this",
        "翻译", "单词", "语法", "解释", "句子"
    ]
    if any(kw in lower_msg for kw in page_keywords):
        logger.info(f"检测到页面指令关键词，设为单页学习模式: {lower_msg}")
        return "language_learning"

    # 2. 内容定位关键词 (content_location)
    if any(kw in lower_msg for kw in location_keywords):
        return "content_location"

    # 3. 阅读理解关键词 (reading_comprehension)
    if any(kw in lower_msg for kw in comprehension_keywords):
        return "reading_comprehension"

    # 4. 知识检索关键词 (knowledge_retrieval)
    if any(kw in lower_msg for kw in retrieval_keywords):
        return "knowledge_retrieval"

    # 5. 明确的全书范围关键词 (兜底进入检索模式)
    book_scope_keywords = [
        "全书", "整本", "这本书", "whole book", "entire book",
        "位置", "locate", "伏笔", "之前", "后文"
    ]
    if any(kw in lower_msg for kw in book_scope_keywords):
        return "knowledge_retrieval"

    # 默认回落到单页学习模式
    return "language_learning"


# ========== 策略：单页英语学习（现有逻辑） ==========
async def language_learning_chat(request: ChatRequest):
    """单页英语学习模式（复用现有逻辑）"""
    from ..services import supplier_factory
    from ..services.deepseek_service import SYSTEM_PROMPT_TEACHER

    # 构建带上下文的消息
    content_prompt = ""
    if request.page_content and request.book_title and request.current_page:
        content_preview = request.page_content[:5000] if len(request.page_content) > 5000 else request.page_content
        content_prompt = f"【当前阅读内容】\n书名：《{request.book_title}》\n第 {request.current_page} 页\n内容摘要：\n{content_preview}\n\n"

    user_message = content_prompt + request.message

    # 转换历史格式
    history = []
    if request.history:
        for msg in request.history:
            history.append({"role": msg["role"], "content": msg["content"]})

    reply = supplier_factory.chat_with_active_supplier(
        message=user_message,
        history=history,
        system_prompt=SYSTEM_PROMPT_TEACHER,
        temperature=0.7
    )

    if reply:
        return {"reply": reply, "role": "assistant"}
    return None


# ========== 策略：知识库检索 ==========
def extract_citations(reply: str, num_sources: int) -> List[int]:
    """从回答中提取引用编号"""
    citations = []
    for i in range(num_sources):
        # 匹配多种引用格式：【来源1】、[来源1]、来源1 等
        patterns = [
            f"【来源{i + 1}】",
            f"[来源{i + 1}]",
            f"来源{i + 1}",
            f"【{i + 1}】",
            f"[{i + 1}]",
        ]
        if any(pattern in reply for pattern in patterns):
            citations.append(i + 1)
    return citations


def knowledge_based_chat_fts5(request: ChatRequest, db: Session) -> dict:
    """
    基于 FTS5 全文搜索的检索模式（ChromaDB 降级方案）
    """
    try:
        from ..models.database import get_db
        from sqlalchemy import text

        # FTS5 全文搜索（使用外部内容表模式）
        search_query = text(f"""
            SELECT
                p.page_number,
                p.text_content,
                snippet(pages_fts, 0, '<mark>', '</mark>', '...', 64) as snippet,
                rank
            FROM pages_fts
            JOIN pages p ON p.id = pages_fts.rowid
            WHERE p.book_id = :book_id
            AND pages_fts MATCH :query
            ORDER BY rank
            LIMIT :limit
        """)

        # 构建搜索查询（支持多个关键词）
        # 修复：清理搜索词，防止特殊字符导致 FTS5 语法错误
        raw_keywords = request.message.strip()
        # 简单清理：只保留字母、数字、空格和中文字符，限制长度
        import re
        clean_keywords = re.sub(r'[^\w\s\u4e00-\u9fa5]', ' ', raw_keywords)
        keywords = " ".join(clean_keywords.split()[:10]) # 只取前10个单词/词组
        
        if not keywords:
             logger.warning(f"搜索词为空或无效: '{raw_keywords}'")
             return {
                "reply": "关键词不足，请尝试输入更具体的词汇。",
                "role": "assistant",
                "sources": [],
                "intent": "no_content",
            }
        
        logger.info(f"FTS5 搜索原词: '{raw_keywords}' -> 清理后: '{keywords}'")

        result = db.execute(
            search_query,
            {
                "book_id": request.book_id,
                "query": keywords,
                "limit": request.n_contexts,
            },
        )

        rows = result.fetchall()

        # 如果原始搜索没有结果，尝试使用英文同义词搜索
        if not rows:
            logger.info("原始搜索无结果，尝试英文同义词搜索")

            # 中英文关键词映射（用于科学类书籍）
            keyword_mapping = {
                # 阅读/理解类
                "总结": ["summary", "summarize", "overview"],
                "概述": ["summary", "overview"],
                "主题": ["theme", "topic"],
                "主要观点": ["main idea", "key points", "main points"],
                "讲了什么": ["about", "discuss", "talk about"],
                "结局": ["ending", "conclusion", "finale"],
                "情节": ["plot", "storyline"],
                "故事": ["story"],
                "章节": ["chapter"],
                "本章": ["chapter", "current chapter", "this chapter"],
                # 天文学/物理学
                "黑洞": ["black hole"],
                "恒星": ["star", "stellar"],
                "行星": ["planet", "planetary"],
                "星系": ["galaxy", "galactic"],
                "宇宙": ["universe", "cosmic", "cosmos"],
                "引力": ["gravity", "gravitation"],
                "光": ["light"],
                "太阳": ["sun", "solar"],
                "地球": ["earth", "terrestrial"],
                "月亮": ["moon", "lunar"],
                "彗星": ["comet"],
                "小行星": ["asteroid"],
                "星云": ["nebula"],
                "超新星": ["supernova", "supernovae"],
                "中子星": ["neutron star"],
                "白矮星": ["white dwarf"],
                "红巨星": ["red giant"],
                # 地理/地质
                "山脉": ["mountain", "mountains", "mountain range"],
                "海洋": ["ocean", "sea"],
                "河流": ["river"],
                "火山": ["volcano", "volcanic"],
                "地震": ["earthquake", "seismic"],
                "板块": ["plate", "tectonic"],
                # 生物/生态
                "物种": ["species"],
                "进化": ["evolution", "evolutionary"],
                "生态系统": ["ecosystem", "ecological"],
                "生物多样性": ["biodiversity"],
                "细胞": ["cell"],
                "基因": ["gene", "genetic", "DNA"],
                # 化学
                "元素": ["element", "chemical"],
                "原子": ["atom", "atomic"],
                "分子": ["molecule", "molecular"],
                "反应": ["reaction", "chemical reaction"],
                # 物理
                "能量": ["energy"],
                "力": ["force", "forces"],
                "运动": ["motion", "movement"],
                "速度": ["velocity", "speed"],
                "温度": ["temperature"],
                "压力": ["pressure"],
                # 通用词汇
                "关于": ["about", "regarding", "concerning"],
                "什么": ["what", "which"],
                "如何": ["how", "how to"],
                "为什么": ["why", "why does"],
                "哪里": ["where", "where is", "location"],
            }

            # 尝试每个中文关键词对应的英文同义词
            for cn_keyword, en_keywords in keyword_mapping.items():
                if cn_keyword in keywords:
                    logger.info(f"使用英文同义词: {en_keywords}")
                    for en_kw in en_keywords:
                        result = db.execute(
                            search_query,
                            {
                                "book_id": request.book_id,
                                "query": en_kw,
                                "limit": request.n_contexts,
                            },
                        )
                        rows = result.fetchall()
                        if rows:
                            logger.info(f"使用同义词 '{en_kw}' 找到 {len(rows)} 条结果")
                            break
                    if rows:
                        break

        # 如果仍然没有结果，尝试获取当前页及其后续几页
        if not rows and request.current_page:
            logger.info("搜索无结果，使用当前页范围")
            page_range_query = text("""
                SELECT
                    page_number,
                    text_content,
                    '' as snippet,
                    1 as rank
                FROM pages
                WHERE book_id = :book_id
                AND page_number >= :start_page
                ORDER BY page_number
                LIMIT :limit
            """)
            result = db.execute(
                page_range_query,
                {
                    "book_id": request.book_id,
                    "start_page": request.current_page,
                    "limit": request.n_contexts,
                },
            )
            rows = result.fetchall()
            logger.info(f"获取当前页范围: {len(rows)} 页")

        if not rows:
            logger.info("FTS5 未找到相关内容")
            return {
                "reply": "抱歉，我没有在书中找到相关内容。请尝试换个问法或提供更多上下文。",
                "role": "assistant",
                "sources": [],
                "intent": "no_content",
            }

        logger.info(f"FTS5 检索到 {len(rows)} 条结果")

        # 构建上下文
        context_chunks = []
        sources = []
        for i, row in enumerate(rows):
            page_num = row[0]
            text_content = row[1] if row[1] else ""
            snippet = row[2] if row[2] else text_content[:200]
            rank = row[3] if len(row) > 3 else 0

            # 使用完整文本（太长则使用摘要）
            context_text = snippet if snippet else text_content[:500]

            context_chunks.append(context_text)
            sources.append(
                {
                    "book_id": request.book_id,
                    "book_title": request.book_title or "",
                    "page_number": page_num,
                    "chunk_index": i,
                    "distance": rank,  # FTS5 使用 rank 作为相似度指标
                }
            )

        # 构建包含上下文的提示
        context_text = "\n\n".join(
            [
                f"[来源 {i + 1} - 第{src['page_number']}页]\n{chunk}"
                for i, (chunk, src) in enumerate(zip(context_chunks, sources))
            ]
        )

        # 构建对话历史上下文
        history_context = ""
        if request.history and len(request.history) > 0:
            history_parts = []
            for msg in request.history[-5:]:  # 只使用最近 5 条对话
                if msg["role"] == "user":
                    history_parts.append(f"用户：{msg['content']}")
                elif msg["role"] == "assistant":
                    history_parts.append(f"助手：{msg['content']}")
            if history_parts:
                history_context = f"\n\n【对话历史】\n" + "\n".join(history_parts)

        prompt = f"""你是一位英语学习助手和阅读助手。基于以下全书内容和对话历史回答用户问题。

书籍：《{request.book_title}》

相关内容：
{context_text}
{history_context}

用户问题：{request.message}

回答要求：
1. 如果问题问"在哪里"，明确指出页码和位置
2. 如果问题问"某个概念在哪里讲过"，列出所有出现该概念的章节/页码
3. 回答要基于提供的内容，不要编造
4. 使用【来源X】标注引用的内容位置
5. 保持回答简洁、准确（100-150 字）
"""

        # 使用 DeepSeek 生成回答（避免 Gemini 配额限制）
        # 使用 DeepSeek 生成回答
        client = deepseek_service.get_client()
        if not client:
            logger.warning("DeepSeek service unavailable (no API key)")
            return {
                "reply": "抱歉，由于未配置 AI 服务密钥，暂时无法进行智能问答。请在设置中配置 API Key。",
                "role": "assistant",
                "sources": [],
                "intent": "error",
            }

        response = client.chat.completions.create(
            model="deepseek-chat",
            messages=[
                {"role": "system", "content": "你是一位英语学习助手和阅读助手。"},
                {"role": "user", "content": prompt},
            ],
            temperature=0.7,
            max_tokens=500,
        )

        # 安全处理可能的空响应
        reply = response.choices[0].message.content
        if reply:
            reply = reply.strip()
        else:
            reply = ""

        # 提取引用
        citations = extract_citations(reply, len(context_chunks))

        return {
            "reply": reply,
            "role": "assistant",
            "sources": [sources[i - 1] for i in citations],
            "intent": "knowledge_retrieval",
        }

    except Exception as e:
        logger.error(f"FTS5 知识库检索失败：{e}")
        import traceback

        traceback.print_exc()
        return {
            "reply": "抱歉，我暂时无法检索全书内容。请稍后再试。",
            "role": "assistant",
            "sources": [],
            "intent": "error",
        }


def knowledge_based_chat(request: ChatRequest, db: Session) -> dict:
    """
    基于全书知识库的检索模式（使用 FTS5 全文搜索）
    """
    logger.info("使用 FTS5 全文搜索")
    return knowledge_based_chat_fts5(request, db)


# ========== 统一 AI 助手接口 ==========


class ChatRequest(BaseModel):
    message: str
    history: Optional[List[dict]] = None
    page_content: Optional[str] = None
    current_page: Optional[int] = None
    book_title: Optional[str] = None
    book_id: Optional[str] = None
    n_contexts: int = 5  # 检索上下文数量，默认 5


class ChatResponse(BaseModel):
    reply: str
    role: str
    sources: List[dict] = []  # 新增：来源引用
    intent: str = ""  # 新增：识别的意图


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest, db: Session = Depends(get_db)):
    """
    统一 AI 助手：自动判断意图，决定使用当前页还是全书知识库
    """
    try:
        # 记录请求信息
        logger.info(
            f"收到请求: message='{request.message}', page_content_len={len(request.page_content) if request.page_content else 0}"
        )

        # 特殊处理：询问书籍基本信息（如总页数）
        if request.message and request.book_id:
            lower_msg = request.message.lower()
            # 检测是否询问总页数
            if any(kw in lower_msg for kw in ["多少页", "总页数", "一共", "页数", "how many pages"]):
                book = db.query(Book).filter(Book.id == request.book_id).first()
                if (
                    book is not None and book.total_pages is not None and book.total_pages > 0  # type: ignore
                ):
                    logger.info(f"返回书籍总页数: {book.total_pages}")
                    return ChatResponse(
                        reply=f"《{book.title}》共有 {book.total_pages} 页。",
                        role="assistant",
                        sources=[],
                        intent="book_info",
                    )

        # 自动意图识别
        intent = classify_user_intent(request.message) if request.message else "language_learning"
        logger.info(f"识别到的意图: {intent}")

        # 根据意图选择策略
        if intent in [
            "content_location",
            "knowledge_retrieval",
            "reading_comprehension",
        ]:
            # 使用全书知识库检索
            result = knowledge_based_chat(request, db)
            result["intent"] = intent
            return ChatResponse(
                reply=result["reply"],
                role=result["role"],
                sources=result["sources"],
                intent=intent,
            )
        else:
            # 使用当前页内容
            result = await language_learning_chat(request)
            if not result:
                return ChatResponse(
                    reply="抱歉，我暂时无法回答。请稍后再试。",
                    role="assistant",
                    sources=[],
                    intent="language_learning",
                )
            return ChatResponse(
                reply=result.get("reply", ""),
                role=result.get("role", "assistant"),
                sources=[],
                intent="language_learning",
            )

    except Exception as e:
        logger.error(f"AI Chat Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to process request")
