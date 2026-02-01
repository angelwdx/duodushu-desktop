"""
配置管理路由 - 处理多供应商 API keys 和应用配置
支持 Google Gemini、OpenAI、Claude、DeepSeek、Qwen 和自定义供应商
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Dict, Optional, List
import json
import os
from pathlib import Path
from app.config import DATA_DIR
from app.supplier_config import (
    SupplierType,
    SupplierConfig,
    MultiSupplierConfig,
    get_all_suppliers,
    get_supplier_models,
    ModelInfo,
    migrate_old_config,
)
import logging

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/config", tags=["config"])

# 配置文件路径
CONFIG_FILE = DATA_DIR / "app_config.json"


# ========== 旧版配置模型（向后兼容）==========


class APIKeysConfig(BaseModel):
    """API Keys 配置模型（旧版，向后兼容）"""

    gemini_api_key: str = ""
    deepseek_api_key: str = ""


# ========== 新版配置模型 ==========


class SupplierConfigRequest(BaseModel):
    """供应商配置请求模型"""

    supplier_type: str = Field(..., description="供应商类型")
    api_key: str = Field(..., description="API密钥")
    model: str = Field(default="", description="选择的模型ID")
    custom_model: str = Field(default="", description="自定义模型名称")
    api_endpoint: str = Field(default="", description="API端点（仅自定义供应商需要）")


class TestConnectionRequest(BaseModel):
    """测试连接请求模型"""

    supplier_type: str = Field(..., description="供应商类型")
    api_key: str = Field(..., description="API密钥")
    api_endpoint: str = Field(default="", description="API端点（仅自定义供应商需要）")
    model: str = Field(default="", description="要测试的模型")


class SetActiveSupplierRequest(BaseModel):
    """设置活跃供应商请求模型"""

    supplier_type: str = Field(..., description="要设置为活跃的供应商类型")


# ========== 配置文件操作 ==========


def load_config() -> dict:
    """加载配置文件"""
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"加载配置文件失败: {e}")
            return {}
    return {}


def save_config(config: dict) -> None:
    """保存配置文件"""
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
        logger.info("配置文件已保存")
    except Exception as e:
        logger.error(f"保存配置文件失败: {e}")
        raise HTTPException(status_code=500, detail="保存配置失败")


def load_multi_supplier_config() -> MultiSupplierConfig:
    """加载多供应商配置"""
    config = load_config()

    # 如果存在旧版配置，进行迁移
    if "api_keys" in config and "suppliers" not in config:
        logger.info("检测到旧版配置，正在迁移...")
        return migrate_old_config(config)

    # 加载新版配置
    suppliers_data = config.get("suppliers", {})
    suppliers = {}

    for supplier_type_str, supplier_data in suppliers_data.items():
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
        except ValueError:
            logger.warning(f"未知的供应商类型: {supplier_type_str}")
            continue

    active_supplier_str = config.get("active_supplier")
    active_supplier = SupplierType(active_supplier_str) if active_supplier_str else None

    return MultiSupplierConfig(
        suppliers=suppliers,
        active_supplier=active_supplier,
    )


def save_multi_supplier_config(multi_config: MultiSupplierConfig) -> None:
    """保存多供应商配置"""
    config = load_config()

    # 转换供应商配置为字典
    suppliers_dict = {}
    for supplier_type, supplier_config in multi_config.suppliers.items():
        suppliers_dict[supplier_type.value] = {
            "name": supplier_config.name,
            "api_key": supplier_config.api_key,
            "api_endpoint": supplier_config.api_endpoint,
            "model": supplier_config.model,
            "custom_model": supplier_config.custom_model,
            "enabled": supplier_config.enabled,
            "is_active": supplier_config.is_active,
        }

    config["suppliers"] = suppliers_dict
    if multi_config.active_supplier:
        config["active_supplier"] = multi_config.active_supplier.value

    save_config(config)

    # 更新环境变量
    _update_env_variables(multi_config)


def _update_env_variables(multi_config: MultiSupplierConfig) -> None:
    """更新环境变量，使配置立即生效"""
    active = multi_config.get_active_supplier()
    if not active:
        return

    env_key_map = {
        SupplierType.GEMINI: "GEMINI_API_KEY",
        SupplierType.OPENAI: "OPENAI_API_KEY",
        SupplierType.CLAUDE: "CLAUDE_API_KEY",
        SupplierType.DEEPSEEK: "DEEPSEEK_API_KEY",
        SupplierType.QWEN: "QWEN_API_KEY",
        SupplierType.CUSTOM: "CUSTOM_API_KEY",
    }

    # 清除所有旧的 API key 环境变量
    for key in env_key_map.values():
        if key in os.environ:
            del os.environ[key]

    # 设置当前活跃供应商的环境变量
    env_key = env_key_map.get(active.supplier_type)
    if env_key and active.api_key:
        os.environ[env_key] = active.api_key
        logger.info(f"已设置环境变量: {env_key}")


# ========== 旧版API端点（向后兼容）==========


@router.get("/api-keys")
def get_api_keys():
    """获取 API keys 配置（旧版API，向后兼容）"""
    config = load_config()
    api_keys = config.get("api_keys", {})

    # 不返回真实的 API keys，只返回是否已配置
    return {
        "gemini_configured": bool(api_keys.get("gemini_api_key")),
        "deepseek_configured": bool(api_keys.get("deepseek_api_key")),
    }


@router.post("/api-keys")
def save_api_keys(keys: APIKeysConfig):
    """保存 API keys 配置（旧版API，向后兼容）"""
    config = load_config()

    # Merge new keys into config
    if "api_keys" not in config:
        config["api_keys"] = {}

    if keys.gemini_api_key:
        config["api_keys"]["gemini_api_key"] = keys.gemini_api_key
    if keys.deepseek_api_key:
        config["api_keys"]["deepseek_api_key"] = keys.deepseek_api_key

    try:
        save_config(config)

        # Also sync to new multi-supplier config format
        # This ensures that if the user switches to the new UI, the keys are there
        multi_config = load_multi_supplier_config()

        if keys.gemini_api_key:
            multi_config.add_or_update_supplier(
                SupplierConfig(
                    supplier_type=SupplierType.GEMINI, name="Google Gemini", api_key=keys.gemini_api_key, enabled=True
                )
            )

        if keys.deepseek_api_key:
            multi_config.add_or_update_supplier(
                SupplierConfig(
                    supplier_type=SupplierType.DEEPSEEK, name="DeepSeek", api_key=keys.deepseek_api_key, enabled=True
                )
            )

        save_multi_supplier_config(multi_config)

    except Exception as e:
        logger.error(f"Failed to save key config: {e}")
        raise HTTPException(status_code=500, detail="Configuration save failed")

    # 更新环境变量
    if keys.gemini_api_key:
        os.environ["GEMINI_API_KEY"] = keys.gemini_api_key
    if keys.deepseek_api_key:
        os.environ["DEEPSEEK_API_KEY"] = keys.deepseek_api_key

    logger.info("API keys 已更新")

    # 刷新工厂单例配置，使配置立即生效
    from ..services import supplier_factory
    factory = supplier_factory.get_supplier_factory()
    factory.reload_config()

    return {
        "status": "success",
        "message": "API keys 已保存",
        "gemini_configured": bool(keys.gemini_api_key),
        "deepseek_configured": bool(keys.deepseek_api_key),
    }


# ========== 新版API端点 ==========


@router.get("/suppliers")
def get_suppliers():
    """获取所有可用的供应商列表"""
    return {
        "suppliers": get_all_suppliers(),
    }


@router.get("/suppliers/{supplier_type}/models")
def get_supplier_models_endpoint(supplier_type: str):
    """获取指定供应商的可用模型列表"""
    try:
        supplier = SupplierType(supplier_type)
        models = get_supplier_models(supplier)
        return {
            "supplier_type": supplier_type,
            "models": [model.model_dump() for model in models],
        }
    except ValueError:
        raise HTTPException(status_code=400, detail=f"未知的供应商类型: {supplier_type}")


@router.get("/suppliers-status")
def get_suppliers_status():
    """获取所有供应商的配置状态"""
    multi_config = load_multi_supplier_config()

    status = []
    for supplier_info in get_all_suppliers():
        try:
            supplier_type_str = supplier_info["type"]
            supplier_type = SupplierType(supplier_type_str)
            config = multi_config.suppliers.get(supplier_type)

            status.append(
                {
                    "type": supplier_type_str,
                    "name": supplier_info["name"],
                    "configured": config is not None and config.enabled,
                    "model": config.model if config else "",
                    "custom_model": config.custom_model if config else "",
                    "api_endpoint": config.api_endpoint if config else "",
                    "is_active": config.is_active if config else False,
                }
            )
        except ValueError:
            continue

    return {
        "suppliers": status,
        "active_supplier": multi_config.active_supplier.value if multi_config.active_supplier else None,
    }


@router.post("/suppliers")
def save_supplier_config(request: SupplierConfigRequest):
    """保存或更新供应商配置"""
    try:
        supplier_type = SupplierType(request.supplier_type)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"未知的供应商类型: {request.supplier_type}")

    # 验证自定义供应商需要提供API端点
    if supplier_type == SupplierType.CUSTOM and not request.api_endpoint:
        raise HTTPException(status_code=400, detail="自定义供应商必须提供API端点")

    multi_config = load_multi_supplier_config()

    # 获取供应商预设信息
    from app.supplier_config import SUPPLIER_PRESETS

    preset = SUPPLIER_PRESETS.get(supplier_type, {})

    # 创建或更新供应商配置
    supplier_config = SupplierConfig(
        supplier_type=supplier_type,
        name=preset.get("name", request.supplier_type),
        api_key=request.api_key,
        api_endpoint=request.api_endpoint or preset.get("default_api_endpoint", ""),
        model=request.model,
        custom_model=request.custom_model,
        enabled=bool(request.api_key),
        is_active=False,  # 新配置默认不是活跃的
    )

    multi_config.add_or_update_supplier(supplier_config)

    # 如果这是第一个配置的供应商，自动设为活跃
    if not multi_config.active_supplier:
        multi_config.set_active_supplier(supplier_type)

    save_multi_supplier_config(multi_config)

    logger.info(f"供应商配置已保存: {request.supplier_type}")

    # 刷新工厂单例配置，使配置立即生效
    from ..services import supplier_factory
    factory = supplier_factory.get_supplier_factory()
    factory.reload_config()

    return {
        "status": "success",
        "message": f"{preset.get('name', request.supplier_type)} 配置已保存",
        "supplier_type": request.supplier_type,
        "configured": True,
    }


@router.delete("/suppliers/{supplier_type}")
def delete_supplier_config(supplier_type: str):
    """删除指定供应商的配置"""
    try:
        supplier = SupplierType(supplier_type)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"未知的供应商类型: {supplier_type}")

    multi_config = load_multi_supplier_config()

    if supplier_type not in multi_config.suppliers:
        raise HTTPException(status_code=404, detail=f"供应商 {supplier_type} 未配置")

    multi_config.remove_supplier(supplier)
    save_multi_supplier_config(multi_config)

    logger.info(f"供应商配置已删除: {supplier_type}")

    return {
        "status": "success",
        "message": f"{supplier_type} 配置已删除",
    }


@router.post("/set-active-supplier")
def set_active_supplier(request: SetActiveSupplierRequest):
    """设置活跃供应商"""
    try:
        supplier_type = SupplierType(request.supplier_type)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"未知的供应商类型: {request.supplier_type}")

    multi_config = load_multi_supplier_config()

    if supplier_type not in multi_config.suppliers:
        raise HTTPException(status_code=404, detail=f"供应商 {request.supplier_type} 未配置")

    multi_config.set_active_supplier(supplier_type)
    save_multi_supplier_config(multi_config)

    logger.info(f"活跃供应商已设置为: {request.supplier_type}")

    # 刷新工厂单例配置，使配置立即生效
    from ..services import supplier_factory
    factory = supplier_factory.get_supplier_factory()
    factory.reload_config()

    return {
        "status": "success",
        "message": f"已切换到 {multi_config.suppliers[supplier_type].name}",
        "active_supplier": request.supplier_type,
    }


@router.post("/test-connection")
async def test_connection(request: TestConnectionRequest):
    """测试供应商API连接"""
    try:
        supplier_type = SupplierType(request.supplier_type)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"未知的供应商类型: {request.supplier_type}")

    # 导入测试服务（稍后实现）
    try:
        from app.services.supplier_test_service import test_supplier_connection

        result = await test_supplier_connection(
            supplier_type=supplier_type,
            api_key=request.api_key,
            api_endpoint=request.api_endpoint,
            model=request.model,
        )
        return result
    except ImportError:
        # 如果测试服务还未实现，返回模拟响应
        return {
            "success": True,
            "message": "连接测试功能即将推出",
            "supplier_type": request.supplier_type,
        }


@router.post("/reload")
def reload_config():
    """重新加载配置"""
    from ..services import supplier_factory

    try:
        # 重新加载配置
        factory = supplier_factory.get_supplier_factory()
        factory.reload_config()

        return {"status": "success", "message": "配置已重新加载"}
    except Exception as e:
        logger.error(f"重新加载配置失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/")
def get_config():
    """获取所有配置"""
    config = load_config()
    return config
