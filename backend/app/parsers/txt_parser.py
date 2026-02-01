import os
import logging
from pathlib import Path
from typing import Dict, Any, List
from .base import BaseParser

logger = logging.getLogger(__name__)


class TXTParser(BaseParser):
    def parse(self, file_path: str, book_id: str) -> Dict[str, Any]:
        """解析 TXT 文件"""

        logger.info(f"[TXTParser] 开始解析文件: {file_path}")

        # 尝试多种编码
        content = self._read_file_with_encoding(file_path)
        logger.info(f"[TXTParser] 文件内容长度: {len(content) if content else 0}")

        if not content:
            raise Exception("无法读取 TXT 文件（编码问题）")

        # 提取元数据
        title = Path(file_path).stem  # 文件名作为标题
        author = "Unknown"

        # 按段落分割
        paragraphs = [p.strip() for p in content.split("\n\n") if p.strip()]

        # 每段作为一个"页面"
        pages_data = []
        total_pages = len(paragraphs)

        for i, paragraph in enumerate(paragraphs):
            words_data = self._extract_words_from_text(paragraph, i + 1)

            pages_data.append(
                {
                    "page_number": i + 1,
                    "text_content": paragraph,
                    "words_data": words_data,
                    "images": [],
                }
            )

        metadata = {
            "title": title,
            "author": author,
            "total_pages": total_pages,
        }

        # TXT 没有封面
        cover_image = None

        return {
            **metadata,
            "pages": pages_data,
            "cover_image": cover_image,
            "outline": [],  # TXT 没有目录
        }

    def _read_file_with_encoding(self, file_path: str) -> str:
        """尝试多种编码读取文件"""
        encodings = ["utf-8", "utf-8-sig", "gbk", "gb18030", "big5", "latin-1"]

        for encoding in encodings:
            try:
                with open(file_path, "r", encoding=encoding) as f:
                    return f.read()
            except UnicodeDecodeError:
                continue
            except Exception as e:
                print(f"Failed to read with {encoding}: {e}")
                continue

        return ""

    def _extract_words_from_text(self, text: str, page_num: int) -> List[Dict]:
        """从文本中提取单词（模拟坐标）"""
        import re

        words = re.findall(r"\b[a-zA-ZÀ-ÿ]+(?:\'[a-zA-Z]+)?\b", text)

        words_data = []
        y = 0
        x = 0
        max_x = 800

        for word in words:
            words_data.append({"text": word, "x": x, "y": y, "width": len(word) * 10, "height": 20})

            x += len(word) * 10 + 10
            if x > max_x:
                x = 0
                y += 30

        return words_data
