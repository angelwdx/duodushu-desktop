import os
import sys
import logging
from pathlib import Path

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 代码根目录 (backend/)
# 检查是否在 PyInstaller 打包环境中
if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    # 打包环境：使用临时目录作为 BASE_DIR（用于资源文件访问）
    BASE_DIR = Path(sys._MEIPASS)
    logger.info(f"检测到 PyInstaller 打包环境，BASE_DIR: {BASE_DIR}")
else:
    # 开发环境：使用 __file__ 计算
    # 假设 config.py 在 backend/app/config.py，所以 parent.parent 是 backend/
    BASE_DIR = Path(__file__).resolve().parent.parent
    logger.info(f"开发环境，BASE_DIR: {BASE_DIR}")

# 获取数据目录
# 优先使用环境变量 APP_DATA_DIR，否则默认使用 backend/data (开发环境)
env_data_dir = os.getenv("APP_DATA_DIR")
if env_data_dir:
    DATA_DIR = Path(env_data_dir).resolve()
    logger.info(f"使用环境变量 APP_DATA_DIR: {DATA_DIR}")
else:
    DATA_DIR = BASE_DIR / "data"
    logger.warning(f"未设置 APP_DATA_DIR 环境变量，使用默认开发环境路径: {DATA_DIR}")

# 确保数据目录存在
os.makedirs(DATA_DIR, exist_ok=True)

# 关键路径定义
# 1. 主数据库 (app.db)
DB_PATH = DATA_DIR / "app.db"

# 2. 上传文件目录
UPLOADS_DIR = DATA_DIR / "uploads"
os.makedirs(UPLOADS_DIR, exist_ok=True)

# 3. 词典相关路径
# 注意：原本 dicts 在根目录下，现在我们将其移动到 DATA_DIR 下以便便携
# 如果是开发环境且未指定 DATA_DIR，可能需要兼容旧路径
# 这里我们统一策略：所有数据都在 DATA_DIR 下
DICTS_DIR = DATA_DIR / "dicts"
os.makedirs(DICTS_DIR, exist_ok=True)

MDX_INDEX_DB_PATH = DICTS_DIR / "mdx_index.db"
IMPORTED_DICTS_DIR = DICTS_DIR / "imported"
os.makedirs(IMPORTED_DICTS_DIR, exist_ok=True)


# 4. 其他数据库 (ECDICT, OpenDict)
# 这些通常是只读的资源数据，打包时会包含在资源文件中
# 但为了简单，我们也支持放在 DATA_DIR 下，或者回退到 BASE_DIR/static
# 策略：如果 DATA_DIR 下有，就用 DATA_DIR 的（允许用户覆盖），否则用内置的
def get_resource_path(filename: str, fallback_path: Path) -> Path:
    # 1. 优先使用用户数据目录中的文件
    user_path = DATA_DIR / filename
    if user_path.exists():
        return user_path

    # 2. 回退到 BASE_DIR（开发环境）或打包目录（打包环境）
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        # 打包环境：从临时目录读取资源（根目录级别）
        fallback_from_base = Path(sys._MEIPASS) / filename
        if fallback_from_base.exists():
            logger.info(f"从打包资源目录加载: {fallback_from_base}")
            return fallback_from_base

    # 3. 最后回退到传入的 fallback_path（开发环境）
    return fallback_path


# ECDICT_DB_PATH：打包时包含在 PyInstaller 的 datas 中
# 开发环境：BASE_DIR/static/ecdict.db
# 打包环境：sys._MEIPASS/ecdict.db（如果打包时包含）
ECDICT_DB_PATH = get_resource_path("ecdict.db", BASE_DIR / "static" / "ecdict.db")

# OPEN_DICT_DB_PATH：通常只在开发环境使用
OPEN_DICT_DB_PATH = get_resource_path("open_dict.db", BASE_DIR / "data" / "open_dict.db")  # Legacy fallback

# 导出配置信息摘要
CONFIG_SUMMARY = {
    "data_dir": str(DATA_DIR),
    "db_path": str(DB_PATH),
    "uploads_dir": str(UPLOADS_DIR),
    "dicts_dir": str(DICTS_DIR),
}

logger.info(f"配置加载完成 - DATA_DIR: {DATA_DIR}")

# 添加配置摘要日志
logger.info(f"=== 配置摘要 ===")
logger.info(f"BASE_DIR: {BASE_DIR}")
logger.info(f"DATA_DIR: {DATA_DIR}")
logger.info(f"UPLOADS_DIR: {UPLOADS_DIR}")
logger.info(f"DICTS_DIR: {DICTS_DIR}")
logger.info(f"ECDICT_DB_PATH: {ECDICT_DB_PATH}")
logger.info(f"DB_PATH: {DB_PATH}")
logger.info(f"PyInstaller 环境: {getattr(sys, 'frozen', False)}")
if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    logger.info(f"sys._MEIPASS: {sys._MEIPASS}")
logger.info(f"================")
