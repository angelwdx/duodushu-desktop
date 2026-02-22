"""
供应商工厂 - 统一管理不同AI供应商的服务
"""

from typing import Optional, Dict, Any, List
from app.supplier_config import SupplierType, MultiSupplierConfig
from app.config import DATA_DIR
import json
from pathlib import Path
import logging

logger = logging.getLogger(__name__)


# ========== 导入各供应商服务 ==========


def get_gemini_client():
    """获取 Gemini 客户端 (google-genai SDK)"""
    try:
        from google import genai
        return genai
    except ImportError:
        logger.error("google-genai 未安装")
        return None


def get_openai_client():
    """获取 OpenAI 客户端"""
    try:
        from openai import OpenAI

        return OpenAI
    except ImportError:
        logger.error("openai 未安装")
        return None


def get_anthropic_client():
    """获取 Anthropic 客户端"""
    try:
        from anthropic import Anthropic

        return Anthropic
    except ImportError:
        logger.error("anthropic 未安装")
        return None


# ========== 供应商工厂 ==========


class SupplierFactory:
    """供应商工厂类 - 根据配置动态选择AI服务"""

    def __init__(self):
        self.config: Optional[MultiSupplierConfig] = None
        self._load_config()

    def _load_config(self):
        """加载配置"""
        config_file = DATA_DIR / "app_config.json"

        if config_file.exists():
            try:
                with open(config_file, "r", encoding="utf-8") as f:
                    config_data = json.load(f)

                # 尝试加载新版配置
                if "suppliers" in config_data:
                    from app.supplier_config import SupplierConfig, SupplierType

                    suppliers = {}
                    for supplier_type_str, supplier_data in config_data.get("suppliers", {}).items():
                        try:
                            supplier_type = SupplierType(supplier_type_str)
                            suppliers[supplier_type] = SupplierConfig(
                                supplier_type=supplier_type,
                                name=supplier_data.get("name", ""),
                                api_key=supplier_data.get("api_key", ""),
                                api_endpoint=supplier_data.get("api_endpoint", ""),
                                model=supplier_data.get("model", ""),
                                custom_model=supplier_data.get("custom_model", ""),
                                enabled=supplier_data.get("enabled", False),
                                is_active=supplier_data.get("is_active", False),
                            )
                            # 从 keyring 恢复真实 API Key
                            from app.services.keyring_service import is_masked, retrieve_api_key
                            if is_masked(suppliers[supplier_type].api_key):
                                real_key = retrieve_api_key(supplier_type_str)
                                if real_key:
                                    suppliers[supplier_type].api_key = real_key
                        except ValueError:
                            continue

                    active_supplier_str = config_data.get("active_supplier")
                    active_supplier = SupplierType(active_supplier_str) if active_supplier_str else None

                    from app.supplier_config import MultiSupplierConfig

                    self.config = MultiSupplierConfig(
                        suppliers=suppliers,
                        active_supplier=active_supplier,
                    )
                else:
                    # 使用旧版配置
                    from app.supplier_config import migrate_old_config

                    self.config = migrate_old_config(config_data)

            except Exception as e:
                logger.error(f"加载配置失败: {e}")
                self.config = None
        else:
            # 首次运行：创建默认配置（空配置）
            logger.info("首次运行：创建默认 AI 配置")
            from app.supplier_config import MultiSupplierConfig

            self.config = MultiSupplierConfig(suppliers={}, active_supplier=None)
            # 保存默认配置
            self._save_config()

    def get_active_supplier_config(self):
        """获取当前活跃的供应商配置"""
        if not self.config:
            return None

        return self.config.get_active_supplier()

    def get_active_supplier_type(self) -> Optional[SupplierType]:
        """获取当前活跃的供应商类型"""
        config = self.get_active_supplier_config()
        if config:
            return config.supplier_type
        return None

    def reload_config(self):
        """重新加载配置"""
        self._load_config()

    def _save_config(self):
        """保存配置到文件（API Key 安全存储到 keyring）"""
        from app.supplier_config import SupplierConfig
        from app.services.keyring_service import store_api_key, mask_api_key, is_keyring_available

        config_file = DATA_DIR / "app_config.json"
        suppliers_dict = {}
        for supplier_type, config in self.config.suppliers.items():
            # 尝试存储到 keyring，成功则用占位符替代明文
            api_key_to_save = config.api_key
            if config.api_key and is_keyring_available():
                if store_api_key(supplier_type.value, config.api_key):
                    api_key_to_save = mask_api_key(config.api_key)

            suppliers_dict[supplier_type.value] = {
                "name": config.name,
                "api_key": api_key_to_save,
                "api_endpoint": config.api_endpoint,
                "model": config.model,
                "custom_model": config.custom_model,
                "enabled": config.enabled,
                "is_active": config.is_active,
            }

        config_data = {
            "suppliers": suppliers_dict,
            "active_supplier": self.config.active_supplier.value if self.config.active_supplier else None,
        }
        with open(config_file, "w", encoding="utf-8") as f:
            json.dump(config_data, f, indent=2, ensure_ascii=False)
        logger.info(f"配置已保存到 {config_file}")


# ========== 单例工厂实例 ==========

_factory_instance: Optional[SupplierFactory] = None


def get_supplier_factory() -> SupplierFactory:
    """获取供应商工厂单例"""
    global _factory_instance
    if _factory_instance is None:
        _factory_instance = SupplierFactory()
    return _factory_instance


# ========== 便捷函数 ==========


def get_active_client():
    """
    获取当前活跃供应商的客户端

    Returns:
        客户端实例或 None
    """
    factory = get_supplier_factory()
    config = factory.get_active_supplier_config()

    if not config:
        logger.warning("没有配置活跃的供应商")
        return None

    supplier_type = config.supplier_type
    api_key = config.api_key
    api_endpoint = config.api_endpoint

    try:
        if supplier_type == SupplierType.GEMINI:
            genai_module = get_gemini_client()
            if genai_module:
                client = genai_module.Client(api_key=api_key)
                return client

        elif supplier_type == SupplierType.OPENAI:
            OpenAI = get_openai_client()
            if OpenAI:
                return OpenAI(api_key=api_key)

        elif supplier_type == SupplierType.CLAUDE:
            Anthropic = get_anthropic_client()
            if Anthropic:
                return Anthropic(api_key=api_key)

        elif supplier_type == SupplierType.DEEPSEEK:
            OpenAI = get_openai_client()
            if OpenAI:
                return OpenAI(api_key=api_key, base_url="https://api.deepseek.com/v1")

        elif supplier_type == SupplierType.QWEN:
            OpenAI = get_openai_client()
            if OpenAI:
                return OpenAI(api_key=api_key, base_url="https://dashscope.aliyuncs.com/compatible-mode/v1")

        elif supplier_type == SupplierType.CUSTOM:
            OpenAI = get_openai_client()
            if OpenAI and api_endpoint:
                return OpenAI(api_key=api_key, base_url=api_endpoint)

        logger.warning(f"无法创建 {supplier_type.value} 客户端")
        return None

    except Exception as e:
        logger.error(f"创建客户端失败: {e}")
        return None


def get_active_model() -> str:
    """
    获取当前活跃供应商的模型ID

    Returns:
        模型ID字符串
    """
    factory = get_supplier_factory()
    config = factory.get_active_supplier_config()

    if not config:
        # 默认返回 DeepSeek 模型
        return "deepseek-chat"

    # 如果有自定义模型，优先使用
    if config.custom_model:
        return config.custom_model

    # 否则使用选择的模型
    if config.model:
        return config.model

    # 根据供应商类型返回默认模型
    default_models = {
        SupplierType.GEMINI: "gemini-2.0-flash-exp",
        SupplierType.OPENAI: "gpt-4o",
        SupplierType.CLAUDE: "claude-3-5-sonnet-20241022",
        SupplierType.DEEPSEEK: "deepseek-chat",
        SupplierType.QWEN: "qwen-plus",
    }

    return default_models.get(config.supplier_type, "deepseek-chat")


def translate_with_active_supplier(text: str) -> Optional[str]:
    """
    使用当前活跃的供应商进行翻译

    Args:
        text: 待翻译的英文文本

    Returns:
        中文翻译或 None
    """
    if not text or not text.strip():
        return None

    client = get_active_client()
    if not client:
        logger.error("无法获取客户端进行翻译")
        return None

    model = get_active_model()
    supplier_type = get_supplier_factory().get_active_supplier_type()

    prompt = f"Translate the following English text to Chinese (Simplified). Only provide the translation, no explanations:\n\n{text}"

    try:
        # 使用 OpenAI 兼容接口 (DeepSeek, Qwen, Custom, OpenAI)
        if supplier_type in [SupplierType.OPENAI, SupplierType.DEEPSEEK, SupplierType.QWEN, SupplierType.CUSTOM]:
            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": "You are a professional translator."},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.1,
                max_tokens=1000,
            )
            result = response.choices[0].message.content
            if result:
                result = result.strip()
                # 去除引号
                if result.startswith('"') and result.endswith('"'):
                    result = result[1:-1].strip()
                return result

        elif supplier_type == SupplierType.GEMINI:
            # Gemini 新版 SDK (google-genai)
            response = client.models.generate_content(
                model=model,
                contents=prompt,
            )
            return response.text.strip()

        elif supplier_type == SupplierType.CLAUDE:
            response = client.messages.create(
                model=model,
                max_tokens=1000,
                messages=[{"role": "user", "content": prompt}],
            )
            return response.content[0].text.strip()

        logger.warning(f"未实现的翻译供应商类型: {supplier_type}")
        return None

    except Exception as e:
        logger.error(f"翻译失败: {e}")
        return None


def chat_with_active_supplier(
    message: str,
    history: Optional[List[Dict]] = None,
    system_prompt: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: int = 2000,
) -> Optional[str]:
    """
    使用当前活跃的供应商进行对话

    Args:
        message: 用户消息
        history: 对话历史
        system_prompt: 系统提示词
        temperature: 温度参数
        max_tokens: 最大token数

    Returns:
        AI回复文本或 None
    """
    client = get_active_client()
    if not client:
        logger.error("无法获取客户端")
        return None

    model = get_active_model()
    supplier_type = get_supplier_factory().get_active_supplier_type()

    try:
        # 构建消息列表
        messages = []

        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        if history:
            messages.extend(history)

        messages.append({"role": "user", "content": message})

        # 根据供应商类型调用不同的API
        if supplier_type in [SupplierType.OPENAI, SupplierType.DEEPSEEK, SupplierType.QWEN, SupplierType.CUSTOM]:
            # OpenAI兼容接口
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            return response.choices[0].message.content

        elif supplier_type == SupplierType.CLAUDE:
            # Anthropic接口
            response = client.messages.create(
                model=model,
                max_tokens=max_tokens,
                messages=messages,
            )
            return response.content[0].text

        elif supplier_type == SupplierType.GEMINI:
            # Gemini 新版 SDK (google-genai)
            # 转换消息格式
            gemini_contents = []
            for msg in messages:
                if msg["role"] == "system":
                    continue
                role = "user" if msg["role"] == "user" else "model"
                gemini_contents.append({"role": role, "parts": [{"text": msg["content"]}]})

            response = client.models.generate_content(
                model=model,
                contents=gemini_contents,
                config={
                    "temperature": temperature,
                    "max_output_tokens": max_tokens,
                },
            )
            return response.text

        logger.warning(f"未实现的供应商类型: {supplier_type}")
        return None

    except Exception as e:
        logger.error(f"对话失败: {e}")
        return None
