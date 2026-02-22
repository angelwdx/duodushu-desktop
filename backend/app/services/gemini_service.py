"""
Gemini AI 服务 - 使用新版 google-genai SDK

从已弃用的 google.generativeai 迁移到官方推荐的 google-genai 包。
新 SDK 使用 Client 模式，支持最新的 Gemini 模型。
"""

import os
import logging
from typing import Optional, List, Dict
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

# 配置日志
logger = logging.getLogger(__name__)

# 获取 API Key
API_KEY = os.environ.get("GEMINI_API_KEY")

# 模型配置
MODEL_NAME = "gemini-2.0-flash"
GENERATION_CONFIG = {
    "temperature": 0.2,
    "top_p": 0.8,
    "top_k": 40,
}

_client = None


def _get_client():
    """获取 Gemini 客户端（懒加载单例）"""
    global _client
    if _client is not None:
        return _client

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        logger.warning("GEMINI_API_KEY 未设置，Gemini 功能将不可用")
        return None

    try:
        from google import genai
        _client = genai.Client(api_key=api_key)
        logger.info("Gemini API 客户端已创建")
        return _client
    except Exception as e:
        logger.error(f"创建 Gemini 客户端失败: {e}")
        return None


def get_client_with_key(api_key: str):
    """使用指定 API Key 创建客户端（用于 supplier_factory）"""
    try:
        from google import genai
        return genai.Client(api_key=api_key)
    except Exception as e:
        logger.error(f"创建 Gemini 客户端失败: {e}")
        return None


async def chat_with_ai(
    prompt: str,
    history: List[Dict] = None,
    stream: bool = False
):
    """
    与 Gemini 进行对话的通用接口
    """
    client = _get_client()
    if not client:
        return None

    try:
        # 构建消息内容
        contents = []
        if history:
            for msg in history:
                role = "user" if msg["role"] == "user" else "model"
                contents.append({"role": role, "parts": [{"text": msg["content"]}]})

        contents.append({"role": "user", "parts": [{"text": prompt}]})

        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=contents,
            config={
                "temperature": GENERATION_CONFIG["temperature"],
                "top_p": GENERATION_CONFIG["top_p"],
                "top_k": GENERATION_CONFIG["top_k"],
            },
        )
        return response.text
    except Exception as e:
        logger.error(f"Gemini 对话失败: {e}")
        return None


def translate_text(text: str, target_lang: str = "中文") -> Optional[str]:
    """使用 Gemini 翻译文本"""
    client = _get_client()
    if not client:
        return None

    prompt = f"请将以下文本翻译成{target_lang}，只返回翻译结果，不要有任何解释：\n\n{text}"
    try:
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=prompt,
        )
        return response.text.strip()
    except Exception as e:
        logger.error(f"Gemini 翻译失败: {e}")
        return None
