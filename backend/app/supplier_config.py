"""
供应商配置模块 - 定义所有AI供应商的配置信息
包括供应商类型、API端点、模型预设等
"""

from enum import Enum
from typing import List, Dict, Optional
from pydantic import BaseModel, Field


class SupplierType(str, Enum):
    """供应商类型枚举"""
    GEMINI = "gemini"
    OPENAI = "openai"
    CLAUDE = "claude"
    DEEPSEEK = "deepseek"
    QWEN = "qwen"
    CUSTOM = "custom"


class ModelInfo(BaseModel):
    """模型信息"""
    id: str = Field(..., description="模型ID")
    name: str = Field(..., description="模型显示名称")
    description: str = Field(..., description="模型描述")
    context_length: int = Field(default=128000, description="上下文长度")


class SupplierConfig(BaseModel):
    """供应商配置"""
    supplier_type: SupplierType = Field(..., description="供应商类型")
    name: str = Field(..., description="供应商显示名称")
    api_key: str = Field(default="", description="API密钥")
    api_endpoint: str = Field(default="", description="API端点（用于自定义供应商）")
    model: str = Field(default="", description="选择的模型ID")
    custom_model: str = Field(default="", description="自定义模型名称")
    enabled: bool = Field(default=False, description="是否启用")
    is_active: bool = Field(default=False, description="是否为当前活跃供应商")


# ========== 供应商预设配置 ==========

SUPPLIER_PRESETS: Dict[SupplierType, Dict] = {
    SupplierType.GEMINI: {
        "name": "Google Gemini",
        "description": "Google的AI模型服务",
        "default_api_endpoint": "https://generativelanguage.googleapis.com",
        "models": [
            ModelInfo(
                id="gemini-3-pro-preview",
                name="Gemini 3 Pro",
                description="Google最新一代顶级高性能模型",
                context_length=2000000
            ),
            ModelInfo(
                id="gemini-3-flash-preview",
                name="Gemini 3 Flash",
                description="Google最新一代快速且经济的模型",
                context_length=1000000
            ),
            ModelInfo(
                id="gemini-2.5-pro",
                name="Gemini 2.5 Pro",
                description="极高复杂任务处理能力",
                context_length=2000000
            ),
            ModelInfo(
                id="gemini-2.5-flash",
                name="Gemini 2.5 Flash",
                description="平衡性能与响应速度",
                context_length=1000000
            ),
        ],
        "api_key_url": "https://aistudio.google.com/app/apikey",
        "docs_url": "https://ai.google.dev/gemini-api/docs",
    },

    SupplierType.OPENAI: {
        "name": "OpenAI",
        "description": "OpenAI的GPT系列模型",
        "default_api_endpoint": "https://api.openai.com/v1",
        "models": [
            ModelInfo(
                id="gpt-5",
                name="GPT-5",
                description="最新开发模型，专为编码和AI代理优化",
                context_length=200000
            ),
            ModelInfo(
                id="gpt-5.2",
                name="GPT-5.2",
                description="企业级模型，处理复杂知识工作",
                context_length=200000
            ),
            ModelInfo(
                id="gpt-4o",
                name="GPT-4o",
                description="成熟稳定的模型（2026年2月退役）",
                context_length=128000
            ),
        ],
        "api_key_url": "https://platform.openai.com/api-keys",
        "docs_url": "https://platform.openai.com/docs",
    },

    SupplierType.CLAUDE: {
        "name": "Anthropic Claude",
        "description": "Anthropic的Claude系列模型",
        "default_api_endpoint": "https://api.anthropic.com/v1",
        "models": [
            ModelInfo(
                id="claude-opus-4.5",
                name="Claude Opus 4.5",
                description="最强编程模型，深度推理能力",
                context_length=200000
            ),
            ModelInfo(
                id="claude-sonnet-4.5",
                name="Claude Sonnet 4.5",
                description="平衡智能和速度，适合企业应用",
                context_length=200000
            ),
        ],
        "api_key_url": "https://console.anthropic.com/settings/keys",
        "docs_url": "https://docs.anthropic.com/claude/reference",
    },

    SupplierType.DEEPSEEK: {
        "name": "DeepSeek",
        "description": "DeepSeek的开源大模型",
        "default_api_endpoint": "https://api.deepseek.com/v1",
        "models": [
            ModelInfo(
                id="deepseek-chat",
                name="DeepSeek Chat",
                description="DeepSeek-V3 旗舰模型 (通用对话)",
                context_length=128000
            ),
            ModelInfo(
                id="deepseek-reasoner",
                name="DeepSeek Reasoner",
                description="DeepSeek-R1 推理模型 (逻辑/数学/代码)",
                context_length=128000
            ),
        ],
        "api_key_url": "https://platform.deepseek.com/api_keys",
        "docs_url": "https://api-docs.deepseek.com/",
    },

    SupplierType.QWEN: {
        "name": "Alibaba Qwen (通义千问)",
        "description": "阿里的通义千问大模型系列",
        "default_api_endpoint": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "models": [
            ModelInfo(
                id="qwen3-max-thinking",
                name="Qwen3-Max-Thinking",
                description="最新旗舰推理模型，超万亿参数",
                context_length=30000
            ),
            ModelInfo(
                id="qwen3-235b-a22b",
                name="Qwen3-235B-A22B",
                description="高性能模型",
                context_length=32000
            ),
            ModelInfo(
                id="qwen3-coder-480b",
                name="Qwen3-Coder-480B",
                description="专用编码模型",
                context_length=32000
            ),
        ],
        "api_key_url": "https://dashscope.aliyun.com/api",
        "docs_url": "https://help.aliyun.com/zh/model-studio",
    },

    SupplierType.CUSTOM: {
        "name": "自定义OpenAI兼容",
        "description": "任何兼容OpenAI API格式的服务",
        "default_api_endpoint": "",
        "models": [],  # 自定义模式没有预设模型
        "api_key_url": "",
        "docs_url": "",
    },
}


def get_supplier_info(supplier_type: SupplierType) -> Dict:
    """获取供应商信息"""
    return SUPPLIER_PRESETS.get(supplier_type, {})


def get_supplier_models(supplier_type: SupplierType) -> List[ModelInfo]:
    """获取供应商的可用模型列表"""
    info = get_supplier_info(supplier_type)
    return info.get("models", [])


def get_all_suppliers() -> List[Dict]:
    """获取所有供应商的摘要信息"""
    suppliers = []
    for supplier_type, config in SUPPLIER_PRESETS.items():
        suppliers.append({
            "type": supplier_type.value,
            "name": config["name"],
            "description": config["description"],
            "model_count": len(config["models"]),
            "requires_endpoint": supplier_type == SupplierType.CUSTOM,
            "api_key_url": config.get("api_key_url", ""),
            "default_api_endpoint": config.get("default_api_endpoint", ""),
        })
    return suppliers


# ========== 配置数据结构 ==========

class MultiSupplierConfig(BaseModel):
    """多供应商配置"""
    suppliers: Dict[SupplierType, SupplierConfig] = Field(default_factory=dict)
    active_supplier: Optional[SupplierType] = Field(default=None, description="当前活跃的供应商")

    def get_active_supplier(self) -> Optional[SupplierConfig]:
        """获取当前活跃的供应商配置"""
        if self.active_supplier and self.active_supplier in self.suppliers:
            return self.suppliers[self.active_supplier]
        return None

    def set_active_supplier(self, supplier_type: SupplierType) -> None:
        """设置活跃供应商"""
        if supplier_type in self.suppliers:
            # 取消所有供应商的活跃状态
            for s in self.suppliers.values():
                s.is_active = False
            # 设置新的活跃供应商
            self.suppliers[supplier_type].is_active = True
            self.active_supplier = supplier_type

    def add_or_update_supplier(self, config: SupplierConfig) -> None:
        """添加或更新供应商配置"""
        self.suppliers[config.supplier_type] = config

    def remove_supplier(self, supplier_type: SupplierType) -> None:
        """删除供应商配置"""
        if supplier_type in self.suppliers:
            del self.suppliers[supplier_type]
            if self.active_supplier == supplier_type:
                self.active_supplier = None


# ========== 兼容性函数（向后兼容旧配置）==========

def migrate_old_config(old_config: dict) -> MultiSupplierConfig:
    """迁移旧的API key配置到新的多供应商配置"""
    new_config = MultiSupplierConfig()

    api_keys = old_config.get("api_keys", {})

    # 迁移 Gemini
    if api_keys.get("gemini_api_key"):
        new_config.add_or_update_supplier(SupplierConfig(
            supplier_type=SupplierType.GEMINI,
            name=SUPPLIER_PRESETS[SupplierType.GEMINI]["name"],
            api_key=api_keys["gemini_api_key"],
            api_endpoint=SUPPLIER_PRESETS[SupplierType.GEMINI].get("default_api_endpoint", ""),
            model="gemini-2.0-flash-exp",  # 默认模型
            custom_model="",
            enabled=True,
            is_active=False,
        ))

    # 迁移 DeepSeek
    if api_keys.get("deepseek_api_key"):
        new_config.add_or_update_supplier(SupplierConfig(
            supplier_type=SupplierType.DEEPSEEK,
            name=SUPPLIER_PRESETS[SupplierType.DEEPSEEK]["name"],
            api_key=api_keys["deepseek_api_key"],
            api_endpoint=SUPPLIER_PRESETS[SupplierType.DEEPSEEK].get("default_api_endpoint", ""),
            model="deepseek-chat",  # 默认模型
            custom_model="",
            enabled=True,
            is_active=False,
        ))

    # 设置第一个可用的供应商为活跃
    for supplier_type, config in new_config.suppliers.items():
        if config.enabled:
            new_config.set_active_supplier(supplier_type)
            break

    return new_config
