"""
API Key 安全存储模块

使用系统 Keychain（macOS Keychain, Windows Credential Locker, Linux Secret Service）
安全存储 API Keys，避免明文存储在 JSON 配置文件中。

对于不支持 keyring 的环境（如 PyInstaller 打包后），
自动回退到配置文件存储模式。
"""

import logging
from typing import Optional

logger = logging.getLogger(__name__)

SERVICE_NAME = "duodushu-desktop"

# keyring 可用性标记
_keyring_available = False
_keyring = None

try:
    import keyring as _kr
    # 测试 keyring 是否可用（某些环境下导入成功但不能用）
    _kr.get_password(SERVICE_NAME, "__test__")
    _keyring = _kr
    _keyring_available = True
    logger.info("系统密钥管理器已启用 (keyring)")
except Exception:
    logger.info("系统密钥管理器不可用，API Key 将存储在配置文件中")


def is_keyring_available() -> bool:
    """检查 keyring 是否可用"""
    return _keyring_available


def store_api_key(supplier_type: str, api_key: str) -> bool:
    """
    安全存储 API Key

    Args:
        supplier_type: 供应商类型（如 'gemini', 'openai'）
        api_key: API 密钥

    Returns:
        True 如果成功存储到 keyring，False 如果回退到配置文件
    """
    if not _keyring_available or not api_key:
        return False

    try:
        _keyring.set_password(SERVICE_NAME, supplier_type, api_key)
        logger.debug(f"API Key 已安全存储: {supplier_type}")
        return True
    except Exception as e:
        logger.warning(f"无法存储到密钥管理器: {e}")
        return False


def retrieve_api_key(supplier_type: str) -> Optional[str]:
    """
    从安全存储中获取 API Key

    Args:
        supplier_type: 供应商类型

    Returns:
        API Key 或 None（若未找到）
    """
    if not _keyring_available:
        return None

    try:
        return _keyring.get_password(SERVICE_NAME, supplier_type)
    except Exception as e:
        logger.warning(f"无法从密钥管理器读取: {e}")
        return None


def delete_api_key(supplier_type: str) -> bool:
    """
    从安全存储中删除 API Key

    Args:
        supplier_type: 供应商类型

    Returns:
        True 如果成功删除
    """
    if not _keyring_available:
        return False

    try:
        _keyring.delete_password(SERVICE_NAME, supplier_type)
        logger.debug(f"API Key 已从密钥管理器删除: {supplier_type}")
        return True
    except Exception as e:
        logger.warning(f"无法从密钥管理器删除: {e}")
        return False


# API key 在配置文件中的占位符
KEYRING_PLACEHOLDER = "***KEYRING***"


def mask_api_key(api_key: str) -> str:
    """将 API Key 替换为占位符（用于保存到配置文件）"""
    return KEYRING_PLACEHOLDER if api_key else ""


def is_masked(api_key: str) -> bool:
    """检查 API Key 是否为占位符"""
    return api_key == KEYRING_PLACEHOLDER
