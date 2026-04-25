"""
DeepSeek 服务
DeepSeek API 完全兼容 OpenAI 格式，使用 OpenAI SDK 调用
文档：https://api-docs.deepseek.com
"""

import os
import json
import logging
from typing import Optional, List
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

# DeepSeek 客户端（单例）
_deepseek_client = None
_deepseek_api_key_used = None  # 记录上次创建客户端时使用的 key，用于失效检测


def get_client():
    """获取 DeepSeek 客户端（单例模式，key 变更时自动重建）"""
    global _deepseek_client, _deepseek_api_key_used

    api_key = os.environ.get("DEEPSEEK_API_KEY")
    if not api_key:
        logging.warning("DeepSeek: 未配置 API Key")
        return None

    # API key 变更时重建客户端
    if _deepseek_client is None or api_key != _deepseek_api_key_used:
        _deepseek_client = OpenAI(api_key=api_key, base_url="https://api.deepseek.com")
        _deepseek_api_key_used = api_key

    return _deepseek_client


def lookup_word_ai(word: str, context: Optional[str] = None) -> Optional[dict]:
    """
    使用 DeepSeek 查询单词

    Args:
        word: 单词
        context: 上下文（可选）

    Returns:
        单词释义字典，格式与 gemini_service.lookup_word_ai() 兼容
    """
    client = get_client()
    if not client:
        logging.error(f"DeepSeek: 未配置 API Key，无法查询单词: {word}")
        return None

    try:
        prompt = f"""Explain the English word '{word}' for an English learner.
Provide the response in JSON format with the following structure:
{{
    "word": "{word}",
    "phonetic": "IPA phonetic transcription",
    "meanings": [
        {{
            "partOfSpeech": "noun/verb/adj...",
            "definitions": [
                {{
                    "definition": "English definition",
                    "translation": "Chinese translation",
                    "example": "A simple example sentence"
                }}
            ]
        }}
    ]
}}
Ensure Chinese translations are natural and accurate.
If the word has multiple common parts of speech, include them.
Limit to top 3 most common meanings."""

        response = client.chat.completions.create(
            model="deepseek-chat",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
            response_format={"type": "json_object"},
        )

        content = response.choices[0].message.content
        if content is None:
            raise ValueError("DeepSeek returned empty content")

        result_text = content.strip()
        result = json.loads(result_text)

        logging.info(f"DeepSeek: 成功查询单词 '{word}'")
        return result

    except Exception as e:
        logging.error(f"DeepSeek: 查询单词 '{word}' 失败: {e}")
        import traceback

        logging.error(traceback.format_exc())
        return None


def translate_text(text: str) -> Optional[str]:
    """
    使用 DeepSeek 翻译文本

    Args:
        text: 待翻译的英文文本

    Returns:
        中文翻译
    """
    client = get_client()
    if not client:
        logging.error(f"DeepSeek: 未配置 API Key，无法翻译")
        return None

    # 验证输入：空文本或只有空格不需要翻译
    if not text or not text.strip():
        logging.debug(f"DeepSeek: 输入为空，跳过翻译")
        return None

    try:
        response = client.chat.completions.create(
            model="deepseek-chat",
            messages=[
                {
                    "role": "user",
                    "content": f"""Translate the following English text to Chinese (Simplified).
Only provide the translation, no explanations.
Text: {text}
Translation:""",
                }
            ],
            temperature=0.1,
            max_tokens=1000,
        )

        content = response.choices[0].message.content
        if content is None:
            raise ValueError("DeepSeek returned empty content")

        result = content.strip()

        # 清理结果：去除最外层的引号（如果存在）
        if (result.startswith('"') and result.endswith('"')) or (result.startswith('""') and result.endswith('""')):
            result = result[1:-1].strip()

        # 验证结果有效性
        if not result or result == text or len(result) == 0:
            logging.warning(f"DeepSeek: 返回无效翻译: {repr(result)}")
            return None

        logging.info(f"DeepSeek: 成功翻译文本（长度: {len(text)} → {len(result)}）")
        return result

    except Exception as e:
        logging.error(f"DeepSeek: 翻译失败: {e}")
        import traceback

        logging.error(traceback.format_exc())
        return None


# AI 老师的系统提示（与 gemini_service 保持一致）
SYSTEM_PROMPT_TEACHER = """你是一位经验丰富的英语老师，正在一对一辅导学生。

你的回答风格：自然、直接、不啰嗦。像真人说话一样，而不是机器人。

## 回复原则

1. **简洁明了**：一句话能说清的不说两句，一个词能概括的不用一句话
2. **自然对话**：用日常教学的语气，避免过多的格式标记
3. **抓重点**：直接讲核心，不铺垫、不重复
4. **灵活应对**：如果是在阅读小说或文学作品，侧重于情节总结和人物分析；如果是在学习课本，侧重于语法和知识点。

## 不同场景的回答方式

    ### 总结页面内容时
    一定要基于提供的“当前阅读内容”进行总结，严禁脱离原文瞎编。结构清晰，逻辑连贯。

    ### 解释词汇时
    简单直接，解释含义并给出场景用法。

    ### 分析语法/长难句时
    拆解句子结构，讲清楚核心成分和修饰关系。

    ## 推荐问题

    每次回答后，在最后给出3个相关问题，格式必须严格是：

    【推荐问题】
    - 问题1
    - 问题2
    - 问题3

    要求：
    - 必须以【推荐问题】开头
    - 每个问题占一行，用 - 开头
    - 问题要具体、可操作，围绕刚才讲的内容
    - 不要加其他说明文字

    ## 记住

    你是在和人对话，不是在写文档。自然、简洁、有用。
    """


def chat_with_teacher(
    user_message: str,
    history: Optional[List[dict]] = None,
    page_content: Optional[str] = None,
    current_page: Optional[int] = None,
    book_title: Optional[str] = None,
) -> Optional[dict]:
    """
    使用 DeepSeek 与 AI 英语老师对话

    Args:
        user_message: 用户的问题
        history: 对话历史
        page_content: 当前页面的文本内容
        current_page: 当前页码
        book_title: 书名

    Returns:
        {"reply": str, "role": "assistant"}
    """
    client = get_client()
    if not client:
        logging.error(f"DeepSeek: 未配置 API Key，无法对话")
        return None

    try:
        # Enhanced logging for content tracking
        if page_content:
            content_len = len(page_content)
            content_preview = page_content[:200] if content_len > 200 else page_content
            logging.info(
                f"DeepSeek: Received page context - Length: {content_len}, Page: {current_page}, Book: {book_title}"
            )
            logging.debug(f"DeepSeek: Content preview: {content_preview}...")
        else:
            user_msg_preview = user_message[:50] if user_message else ""
            logging.warning(
                f"DeepSeek: No page context provided. Message: {user_msg_preview}..., Page: {current_page}, Book: {book_title}"
            )

        # 构建对话上下文
        messages = [{"role": "system", "content": SYSTEM_PROMPT_TEACHER}]

        # 添加页面上下文（如果有）
        if page_content and book_title and current_page:
            content_preview = page_content[:5000] if len(page_content) > 5000 else page_content
            messages.append(
                {
                    "role": "user",
                    "content": f"【当前阅读内容】\n书名：《{book_title}》\n第 {current_page} 页\n内容摘要：\n{content_preview}",
                }
            )

        # 添加历史对话
        if history:
            for msg in history:
                if msg["role"] == "user":
                    messages.append({"role": "user", "content": msg["content"]})
                elif msg["role"] == "assistant":
                    messages.append({"role": "assistant", "content": msg["content"]})

        # 当前问题
        messages.append({"role": "user", "content": user_message})

        response = client.chat.completions.create(
            model="deepseek-chat",
            messages=messages,  # type: ignore
            temperature=0.7,
            max_tokens=2000,
        )

        content = response.choices[0].message.content
        if content is None:
            raise ValueError("DeepSeek returned empty content")

        reply = content.strip()

        logging.info(f"DeepSeek: 成功生成 AI 老师回复（长度: {len(reply)}）")
        return {"reply": reply, "role": "assistant"}

    except Exception as e:
        logging.error(f"DeepSeek: AI 老师对话失败: {e}")
        import traceback

        logging.error(traceback.format_exc())
        return None
