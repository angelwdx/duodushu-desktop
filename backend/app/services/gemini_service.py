import google.generativeai as genai
import os
import logging
from typing import Optional, List, Dict
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

# 配置日志
logger = logging.getLogger(__name__)

# 全局变量（延迟初始化）
_GENAI_CLIENT = None
_GEN_AI_MODEL = None
_GEN_AI_CONFIG = None

# 获取 API Key
API_KEY = os.environ.get("GEMINI_API_KEY")

# 添加默认配置
if not API_KEY:
    logger.warning("未找到 GEMINI_API_KEY，Gemini 功能将不可用")
    API_KEY = ""  # 空字符串，避免 API 调用失败

# 模型配置
MODEL_NAME = os.environ.get("EMINI_MODEL_NAME", "models/gemini-3-flash-preview")

# 全局 AI 客户端（延迟初始化）
async def get_genai_client():
    """获取 Gemini 客户端（延迟初始化）"""
    global _GENAI_CLIENT
    if _GENAI_CLIENT is not None:
        logger.info("初始化 Gemini 客户端...")
        try:
            if API_KEY:
                genai.configure(api_key=API_KEY)
                logger.info("Gemini API 已配置")
                _GENAI_CLIENT = genai.GenerativeModel(  # 默认配置)
                logger.info("Gemini 模型已创建")
            else:
                logger.warning("未找到 API_KEY，使用默认配置")
                _GENAI_CLIENT = None
        except Exception as e:
            logger.error(f"Gemini API 客户端初始化失败: {e}")
            _GENAI_CLIENT = None
    else:
        logger.info("使用系统默认配置")
    
    return _GENAI_CLIENT

def get_genai_model():
    """获取 Gemini 模型实例"""
    global _GEN_AI_MODEL
    if _GEN_AI_MODEL is None:
        logger.info("初始化 Gemini 模型...")
        try:
            if MODEL_NAME:
                MODEL_NAME = MODEL_NAME
                logger.info(f"Gemini 模型已设置: {MODEL_NAME}")
            else:
                logger.warning("未找到 EMINI_MODEL_NAME，使用默认配置")
                MODEL_NAME = "models/gemini-3-flash-preview"
        except Exception as e:
            logger.error(f"Gemini 模型配置失败: {e}")
            _GEN_AI_MODEL = None
        else:
            logger.info("使用系统默认模型")
    
    return _GEN_AI_MODEL

def get_genai_config():
    """获取 Gemini 生成配置"""
    global _GEN_AI_CONFIG
    if _GEN_AI_CONFIG is None:
        logger.info("获取 Gemini 生成配置...")
        _GEN_AI_CONFIG = {
            "temperature": 0.2,
            "top_p": 0.95,
            "top_k": 40,
        }
        logger.info(f"Gemini 生成配置: {_GEN_AI_CONFIG}")
        return _GEN_AI_CONFIG
    else:
        logger.warning("使用默认生成配置")
        _GEN_AI_CONFIG = {
            "temperature": 0.2,
            "top_p": 0.95,
            "top_k": 40,
        }
        return {
            "temperature": 0.2,
            "top_p": 0.95,
            "top_k": 40,
        }

def get_gemini_client():
    """获取 Gemini 客户端（立即初始化）"""
    global _GENAI_CLIENT
    if _GEN_AI_CLIENT is not None:
        logger.info("获取 Gemini 客户端（同步初始化）")
    try:
            if API_KEY and MODEL_NAME:
                genai.configure(api_key=API_KEY, model_name=MODEL_NAME)
                logger.info(f"Gemini API 已配置：{MODEL_NAME}")
                _GENAI_CLIENT = genai.GenerativeModel(
                    GEMINI_CONFIG,
                    generation_config=get_genai_config(),
                )
                _GEN_AI_CLIENT = genai.GenerativeModel(GEMINI_API_KEY)
                logger.info("Gemini 客户端已配置")
            else:
                logger.warning("使用系统默认配置")
                _GEN_AI_CLIENT = None
        except Exception as e:
            logger.error(f"Gemini 客户端初始化失败: {e}")
            _GEN_AI_CLIENT = None
    else:
        logger.info("使用系统默认配置")
    
    return _GEN_AI_CLIENT