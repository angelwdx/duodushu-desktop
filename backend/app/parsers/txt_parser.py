import os
import logging
from pathlib import Path
from typing import Dict, Any, List
from .base import BaseParser

logger = logging.getLogger(__name__)

# 每页约 2000 字符
CHARS_PER_PAGE = 2000


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

        # 按固定字符数分页，尽量在换行处分割
        pages_content = self._split_into_pages(content, CHARS_PER_PAGE)
        total_pages = len(pages_content)

        logger.info(f"[TXTParser] 分页数量: {total_pages}")

        # 构建页面数据
        pages_data = []
        for i, page_text in enumerate(pages_content):
            words_data = self._extract_words_from_text(page_text, i + 1)

            pages_data.append(
                {
                    "page_number": i + 1,
                    "text_content": page_text,
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

        result = {
            **metadata,
            "pages": pages_data,
            "cover_image": cover_image,
            "outline": [],  # TXT 没有目录
        }

        logger.info(
            f"[TXTParser] 解析完成 - 页数: {total_pages}, 第一页长度: {len(pages_data[0]['text_content']) if pages_data else 0}"
        )
        return result

    def _split_into_pages(self, content: str, chars_per_page: int) -> List[str]:
        """按字符数分页，尽量在换行处分割"""
        pages = []
        lines = content.split("\n")
        current_page = ""

        for line in lines:
            # 如果当前页加上这行会超过限制，且当前页不为空
            if len(current_page) + len(line) + 1 > chars_per_page and current_page:
                pages.append(current_page.strip())
                current_page = line + "\n"
            else:
                current_page += line + "\n"

        # 添加最后一页
        if current_page.strip():
            pages.append(current_page.strip())

        # 确保至少有一页
        if not pages:
            pages.append(content.strip() if content.strip() else "（空文件）")

        return pages

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
        """从文本中提取英文单词（用于点击查词）"""
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
