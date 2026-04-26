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


async def test_local_connection(
    api_endpoint: str,
    model: str = "",
    api_key: str = "",
) -> TestResult:
    """测试本地 LLM 服务连接（OpenAI 兼容格式，如 LM Studio、Ollama）"""
    if not api_endpoint:
        return TestResult(
            success=False,
            message="请提供本地服务地址（如 http://127.0.0.1:1234/v1）",
            supplier_type="local",
        )

    try:
        # 先查询可用模型列表，快速验证服务是否在线
        models_url = f"{api_endpoint.rstrip('/')}/models"
        bearer = api_key or "local"
        headers = {"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=10.0) as client:
            models_resp = await client.get(models_url, headers=headers)

        if models_resp.status_code != 200:
            return TestResult(
                success=False,
                message=f"连接失败: HTTP {models_resp.status_code}",
                supplier_type="local",
                details={"error": models_resp.text[:200]},
            )

        available_models = [m["id"] for m in models_resp.json().get("data", [])]

        # 若指定了模型，校验是否已加载
        if model and model not in available_models:
            return TestResult(
                success=False,
                message=f"模型 {model} 未加载，当前可用: {', '.join(available_models) or '无'}",
                supplier_type="local",
                details={"available_models": available_models},
            )

        model_to_use = model or (available_models[0] if available_models else "")
        if not model_to_use:
            return TestResult(
                success=False,
                message="服务在线，但没有已加载的模型",
                supplier_type="local",
                details={"endpoint": api_endpoint},
            )

        # 发送一条简短对话验证推理能力
        chat_url = f"{api_endpoint.rstrip('/')}/chat/completions"
        payload = {
            "model": model_to_use,
            "messages": [{"role": "user", "content": "Hi"}],
            "max_tokens": 20,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        async with httpx.AsyncClient(timeout=30.0) as client:
            chat_resp = await client.post(chat_url, json=payload, headers=headers)

        if chat_resp.status_code == 200:
            content = chat_resp.json()["choices"][0]["message"]["content"].strip()[:60]
            return TestResult(
                success=True,
                message=f"连接成功！模型返回: {content}",
                supplier_type="local",
                details={"model": model_to_use, "endpoint": api_endpoint, "available_models": available_models},
            )
        else:
            return TestResult(
                success=False,
                message=f"模型推理失败: HTTP {chat_resp.status_code}",
                supplier_type="local",
                details={"error": chat_resp.text[:200]},
            )

    except httpx.ConnectError:
        return TestResult(
            success=False,
            message=f"无法连接到 {api_endpoint}，请确认本地服务已启动",
            supplier_type="local",
        )
    except httpx.TimeoutException:
        return TestResult(
            success=False,
            message="连接超时，请检查服务是否正常运行",
            supplier_type="local",
        )
    except Exception as e:
        logger.error(f"本地模型连接测试失败: {e}")
        return TestResult(
            success=False,
            message=f"连接测试失败: {str(e)}",
            supplier_type="local",
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
        api_endpoint: API端点（仅自定义/本地供应商需要）
        model: 要测试的模型（可选）

    Returns:
        测试结果字典
    """
    # 本地模型不需要 API Key
    if supplier_type != SupplierType.LOCAL and not api_key:
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
        SupplierType.LOCAL: lambda: test_local_connection(api_endpoint or "http://127.0.0.1:1234/v1", model, api_key),
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
