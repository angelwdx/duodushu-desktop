"""
供应商连接测试服务 - 为每个AI供应商实现连接测试功能
"""

import httpx
import logging
from typing import Optional, Dict, Any
from app.supplier_config import SupplierType

logger = logging.getLogger(__name__)


# ========== 测试结果模型 ==========

class TestResult:
    """测试结果"""
    def __init__(
        self,
        success: bool,
        message: str,
        supplier_type: str,
        details: Optional[Dict[str, Any]] = None,
    ):
        self.success = success
        self.message = message
        self.supplier_type = supplier_type
        self.details = details or {}

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            "success": self.success,
            "message": self.message,
            "supplier_type": self.supplier_type,
            "details": self.details,
        }


# ========== 供应商测试函数 ==========

async def test_gemini_connection(
    api_key: str,
    api_endpoint: str = "",
    model: str = "gemini-1.5-flash",
) -> TestResult:
    """测试 Google Gemini API 连接"""
    try:
        # 允许通过 api_endpoint 覆盖默认的基础 URL
        base_url = api_endpoint.rstrip("/") if api_endpoint else "https://generativelanguage.googleapis.com"
        # Gemini API 端点
        url = f"{base_url}/v1beta/models/{model}:generateContent?key={api_key}"

        payload = {
            "contents": [{
                "parts": [{"text": "Hello"}]
            }],
            "generationConfig": {
                "maxOutputTokens": 10,
            }
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, json=payload)

            if response.status_code == 200:
                return TestResult(
                    success=True,
                    message="连接成功！API密钥有效",
                    supplier_type="gemini",
                    details={"model": model, "provider": "Google"},
                )
            elif response.status_code == 401:
                return TestResult(
                    success=False,
                    message="API密钥无效或已过期",
                    supplier_type="gemini",
                    details={"error": "Unauthorized"},
                )
            else:
                return TestResult(
                    success=False,
                    message=f"连接失败: HTTP {response.status_code}",
                    supplier_type="gemini",
                    details={"error": response.text[:200]},
                )

    except httpx.TimeoutException:
        return TestResult(
            success=False,
            message="连接超时，请检查网络连接",
            supplier_type="gemini",
        )
    except Exception as e:
        logger.error(f"Gemini 连接测试失败: {e}")
        return TestResult(
            success=False,
            message=f"连接测试失败: {str(e)}",
            supplier_type="gemini",
        )


async def test_openai_connection(
    api_key: str,
    api_endpoint: str = "https://api.openai.com/v1",
    model: str = "gpt-4o",
) -> TestResult:
    """测试 OpenAI API 连接"""
    try:
        url = f"{api_endpoint.rstrip('/')}/chat/completions"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "model": model,
            "messages": [{"role": "user", "content": "Hello"}],
            "max_tokens": 10,
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, json=payload, headers=headers)

            if response.status_code == 200:
                return TestResult(
                    success=True,
                    message="连接成功！API密钥有效",
                    supplier_type="openai",
                    details={"model": model, "provider": "OpenAI"},
                )
            elif response.status_code == 401:
                return TestResult(
                    success=False,
                    message="API密钥无效或已过期",
                    supplier_type="openai",
                    details={"error": "Unauthorized"},
                )
            elif response.status_code == 429:
                return TestResult(
                    success=False,
                    message="API配额已用完或速率限制",
                    supplier_type="openai",
                    details={"error": "Rate limit exceeded"},
                )
            else:
                return TestResult(
                    success=False,
                    message=f"连接失败: HTTP {response.status_code}",
                    supplier_type="openai",
                    details={"error": response.text[:200]},
                )

    except httpx.TimeoutException:
        return TestResult(
            success=False,
            message="连接超时，请检查网络连接",
            supplier_type="openai",
        )
    except Exception as e:
        logger.error(f"OpenAI 连接测试失败: {e}")
        return TestResult(
            success=False,
            message=f"连接测试失败: {str(e)}",
            supplier_type="openai",
        )


async def test_claude_connection(
    api_key: str,
    model: str = "claude-3-5-sonnet-20241022",
) -> TestResult:
    """测试 Anthropic Claude API 连接"""
    try:
        url = "https://api.anthropic.com/v1/messages"

        headers = {
            "x-api-key": api_key,
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
        }

        payload = {
            "model": model,
            "max_tokens": 10,
            "messages": [{"role": "user", "content": "Hello"}],
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, json=payload, headers=headers)

            if response.status_code == 200:
                return TestResult(
                    success=True,
                    message="连接成功！API密钥有效",
                    supplier_type="claude",
                    details={"model": model, "provider": "Anthropic"},
                )
            elif response.status_code == 401:
                return TestResult(
                    success=False,
                    message="API密钥无效或已过期",
                    supplier_type="claude",
                    details={"error": "Unauthorized"},
                )
            elif response.status_code == 429:
                return TestResult(
                    success=False,
                    message="API配额已用完或速率限制",
                    supplier_type="claude",
                    details={"error": "Rate limit exceeded"},
                )
            else:
                return TestResult(
                    success=False,
                    message=f"连接失败: HTTP {response.status_code}",
                    supplier_type="claude",
                    details={"error": response.text[:200]},
                )

    except httpx.TimeoutException:
        return TestResult(
            success=False,
            message="连接超时，请检查网络连接",
            supplier_type="claude",
        )
    except Exception as e:
        logger.error(f"Claude 连接测试失败: {e}")
        return TestResult(
            success=False,
            message=f"连接测试失败: {str(e)}",
            supplier_type="claude",
        )


async def test_deepseek_connection(
    api_key: str,
    api_endpoint: str = "",
    model: str = "deepseek-chat",
) -> TestResult:
    """测试 DeepSeek API 连接"""
    try:
        base_url = api_endpoint.rstrip("/") if api_endpoint else "https://api.deepseek.com"
        # DeepSeek API 端点通常是 base_url/chat/completions 或 base_url/v1/chat/completions
        # 兼容性处理
        if "/v1" not in base_url and not base_url.endswith("/v1"):
            url = f"{base_url}/v1/chat/completions"
        else:
            url = f"{base_url}/chat/completions"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "model": model,
            "messages": [{"role": "user", "content": "Hello"}],
            "max_tokens": 10,
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, json=payload, headers=headers)

            if response.status_code == 200:
                return TestResult(
                    success=True,
                    message="连接成功！API密钥有效",
                    supplier_type="deepseek",
                    details={"model": model, "provider": "DeepSeek"},
                )
            elif response.status_code == 401:
                return TestResult(
                    success=False,
                    message="API密钥无效或已过期",
                    supplier_type="deepseek",
                    details={"error": "Unauthorized"},
                )
            elif response.status_code == 429:
                return TestResult(
                    success=False,
                    message="API配额已用完或速率限制",
                    supplier_type="deepseek",
                    details={"error": "Rate limit exceeded"},
                )
            else:
                return TestResult(
                    success=False,
                    message=f"连接失败: HTTP {response.status_code}",
                    supplier_type="deepseek",
                    details={"error": response.text[:200]},
                )

    except httpx.TimeoutException:
        return TestResult(
            success=False,
            message="连接超时，请检查网络连接",
            supplier_type="deepseek",
        )
    except Exception as e:
        logger.error(f"DeepSeek 连接测试失败: {e}")
        return TestResult(
            success=False,
            message=f"连接测试失败: {str(e)}",
            supplier_type="deepseek",
        )


async def test_qwen_connection(
    api_key: str,
    model: str = "qwen-plus",
) -> TestResult:
    """测试 Alibaba Qwen API 连接"""
    try:
        # 使用OpenAI兼容端点
        url = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "model": model,
            "messages": [{"role": "user", "content": "Hello"}],
            "max_tokens": 10,
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, json=payload, headers=headers)

            if response.status_code == 200:
                return TestResult(
                    success=True,
                    message="连接成功！API密钥有效",
                    supplier_type="qwen",
                    details={"model": model, "provider": "Alibaba Qwen"},
                )
            elif response.status_code == 401:
                return TestResult(
                    success=False,
                    message="API密钥无效或已过期",
                    supplier_type="qwen",
                    details={"error": "Unauthorized"},
                )
            elif response.status_code == 429:
                return TestResult(
                    success=False,
                    message="API配额已用完或速率限制",
                    supplier_type="qwen",
                    details={"error": "Rate limit exceeded"},
                )
            else:
                return TestResult(
                    success=False,
                    message=f"连接失败: HTTP {response.status_code}",
                    supplier_type="qwen",
                    details={"error": response.text[:200]},
                )

    except httpx.TimeoutException:
        return TestResult(
            success=False,
            message="连接超时，请检查网络连接",
            supplier_type="qwen",
        )
    except Exception as e:
        logger.error(f"Qwen 连接测试失败: {e}")
        return TestResult(
            success=False,
            message=f"连接测试失败: {str(e)}",
            supplier_type="qwen",
        )


async def test_custom_connection(
    api_key: str,
    api_endpoint: str,
    model: str = "gpt-3.5-turbo",
) -> TestResult:
    """测试自定义OpenAI兼容API连接"""
    if not api_endpoint:
        return TestResult(
            success=False,
            message="请提供API端点URL",
            supplier_type="custom",
        )

    try:
        url = f"{api_endpoint.rstrip('/')}/chat/completions"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "model": model,
            "messages": [{"role": "user", "content": "Hello"}],
            "max_tokens": 10,
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, json=payload, headers=headers)

            if response.status_code == 200:
                return TestResult(
                    success=True,
                    message="连接成功！API密钥有效",
                    supplier_type="custom",
                    details={"model": model, "endpoint": api_endpoint},
                )
            elif response.status_code == 401:
                return TestResult(
                    success=False,
                    message="API密钥无效或已过期",
                    supplier_type="custom",
                    details={"error": "Unauthorized"},
                )
            else:
                return TestResult(
                    success=False,
                    message=f"连接失败: HTTP {response.status_code}",
                    supplier_type="custom",
                    details={"error": response.text[:200]},
                )

    except httpx.TimeoutException:
        return TestResult(
            success=False,
            message="连接超时，请检查网络连接和API端点",
            supplier_type="custom",
        )
    except Exception as e:
        logger.error(f"自定义API 连接测试失败: {e}")
        return TestResult(
            success=False,
            message=f"连接测试失败: {str(e)}",
            supplier_type="custom",
        )


# ========== 统一测试接口 ==========

async def test_supplier_connection(
    supplier_type: SupplierType,
    api_key: str,
    api_endpoint: str = "",
    model: str = "",
) -> Dict[str, Any]:
    """
    测试指定供应商的API连接

    Args:
        supplier_type: 供应商类型
        api_key: API密钥
        api_endpoint: API端点（仅自定义供应商需要）
        model: 要测试的模型（可选）

    Returns:
        测试结果字典
    """
    if not api_key:
        return TestResult(
            success=False,
            message="请提供API密钥",
            supplier_type=supplier_type.value,
        ).to_dict()

    # 根据供应商类型调用对应的测试函数
    test_functions = {
        SupplierType.GEMINI: lambda: test_gemini_connection(api_key, api_endpoint, model or "gemini-1.5-flash"),
        SupplierType.OPENAI: lambda: test_openai_connection(api_key, api_endpoint or "https://api.openai.com/v1", model or "gpt-4o"),
        SupplierType.CLAUDE: lambda: test_claude_connection(api_key, model or "claude-3-5-sonnet-20241022"),
        SupplierType.DEEPSEEK: lambda: test_deepseek_connection(api_key, api_endpoint, model or "deepseek-chat"),
        SupplierType.QWEN: lambda: test_qwen_connection(api_key, model or "qwen-plus"),
        SupplierType.CUSTOM: lambda: test_custom_connection(api_key, api_endpoint, model or "gpt-3.5-turbo"),
    }

    test_func = test_functions.get(supplier_type)
    if not test_func:
        return TestResult(
            success=False,
            message=f"未知的供应商类型: {supplier_type.value}",
            supplier_type=supplier_type.value,
        ).to_dict()

    result = await test_func()
    return result.to_dict()
