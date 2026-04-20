"""
MDX 词典解析器
使用 mdict_utils 库提取词条信息，支持标准 MDX/MDD 格式
"""

from pathlib import Path
from typing import Dict, List, Optional, Generator, Union
import logging
from mdict_utils.reader import MDX

logger = logging.getLogger(__name__)

class MDXParser:
    """MDX 文件解析器 (基于 mdict_utils)"""

    def __init__(self, mdx_path: Path):
        self.mdx_path = mdx_path
        self.dict_name = mdx_path.stem
        self._mdx = None

    @property
    def mdx(self):
        if self._mdx is None:
            self._mdx = MDX(str(self.mdx_path))
        return self._mdx

    def get_encoding(self) -> str:
        """从词典头部获取编码"""
        try:
            # mdict_utils 的 MDX 对象有 header 属性
            header = getattr(self.mdx, 'header', {})
            # 常见的 MDX 编码标识是 Encoding
            enc = header.get(b'Encoding', b'UTF-8').decode('utf-8', errors='ignore')
            if not enc or enc.lower() == 'utf-8':
                return 'utf-8'
            if enc.lower() in ['utf-16', 'utf16']:
                return 'utf-16'
            if enc.lower() in ['gbk', 'gb2312', 'gb18030']:
                return 'gb18030' # 使用最全的 GB 编码
            return enc
        except Exception as e:
            logger.warning(f"获取词典编码失败，恢复默认 UTF-8: {e}")
            return 'utf-8'

    def parse(self) -> Generator[Dict, None, None]:
        """
        解析 MDX 文件，生成词条信息
        """
        logger.info(f"开始解析 MDX 文件: {self.mdx_path}")
        
        try:
            encoding = self.get_encoding()
            logger.info(f"词典使用编码: {encoding}")

            # MDX.items() 返回 (word, content) 的生成器
            # content 在这里是 bytes
            entry_count = 0
            is_mdd = self.mdx_path.suffix.lower() == ".mdd"
            
            for word_bytes, content_bytes in self.mdx.items():
                try:
                    word = word_bytes.decode(encoding)
                except UnicodeDecodeError:
                    # 容错处理
                    try:
                        word = word_bytes.decode('utf-8', errors='ignore')
                    except UnicodeDecodeError:
                        word = word_bytes.decode('latin1', errors='ignore')

                entry_count += 1
                
                decoded_content = None
                if not is_mdd and content_bytes is not None:
                    try:
                        decoded_content = content_bytes.decode(encoding)
                    except UnicodeDecodeError:
                        try:
                            decoded_content = content_bytes.decode('utf-8', errors='ignore')
                        except UnicodeDecodeError:
                            decoded_content = content_bytes.decode('latin1', errors='ignore')

                yield {
                    "word": word,
                    "content": decoded_content,
                    "offset": 0,
                    "length": 0,
                    "dict_name": self.dict_name,
                }

                if entry_count % 10000 == 0:
                    logger.info(f"已处理 {entry_count} 个词条")

            logger.info(f"MDX 解析完成，共 {entry_count} 个词条")
        except Exception as e:
            logger.error(f"解析 MDX 失败: {e}", exc_info=True)

    def get_entry_content(self, offset: int, length: int) -> str:
        """
        此方法在旧版本中用于通过偏移量读取，新版本建议直接通过单词查询。
        为了兼容性，这里保留签名，但如果不提供 word，它将无法工作。
        """
        return ""

    def get_content_by_word(self, word: str) -> Optional[str]:
        """直接通过单词获取内容"""
        try:
            results = self.mdx.get(word.encode('utf-8'))
            if not results:
                # 尝试小写匹配或去空格
                results = self.mdx.get(word.lower().encode('utf-8'))
            
            if results:
                content_bytes = results[0]
                try:
                    return content_bytes.decode('utf-8')
                except UnicodeDecodeError:
                    return content_bytes.decode('latin1', errors='ignore')
        except Exception as e:
            logger.error(f"查询单词内容失败 {word}: {e}")
        return None

    def get_resource_bytes(self, path: str) -> Optional[bytes]:
        """读取 MDD 资源二进制数据"""
        try:
            # MDD 中的路径通常以 \ 或 / 开头
            paths_to_try = [
                path.encode('utf-8'),
                f"\\{path.lstrip('/')}".encode('utf-8'),
                f"/{path.lstrip('/')}".encode('utf-8'),
                path.replace('/', '\\').encode('utf-8')
            ]
            
            for p in paths_to_try:
                results = self.mdx.get(p)
                if results:
                    return results[0]
            return None
        except Exception as e:
            logger.error(f"读取资源失败 {path}: {e}")
            return None

    def get_stats(self) -> Dict:
        return {
            "file_path": str(self.mdx_path),
            "file_size": self.mdx_path.stat().st_size if self.mdx_path.exists() else 0,
            "dict_name": self.dict_name,
        }
