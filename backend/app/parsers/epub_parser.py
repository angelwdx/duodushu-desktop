import os
import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup
from pathlib import Path
from typing import Dict, Any, List, Optional, Union
from .base import BaseParser


class EPUBParser(BaseParser):
    def parse(self, file_path: str, book_id: str) -> Dict[str, Any]:
        """解析 EPUB 文件"""
        book = epub.read_epub(file_path)

        # 提取元数据
        title = self._get_metadata(book, "DC", "title") or Path(file_path).name
        author = self._get_metadata(book, "DC", "creator") or "Unknown"

        metadata = {
            "title": title,
            "author": author,
            "total_pages": self._count_chapters(book),
        }

        # 提取封面
        cover_image = self._extract_cover(book, book_id, file_path)

        # 解析章节内容
        pages_data = []
        chapter_num = 0

        for item in book.get_items():
            if item.get_type() == ebooklib.ITEM_DOCUMENT:
                chapter_num += 1
                content = item.get_content().decode("utf-8")
                soup = BeautifulSoup(content, "html.parser")

                # 提取文本
                text_content = soup.get_text(separator=" ", strip=True)

                # 提取单词数据（简化版，EPUB 的坐标系统不同）
                words_data = self._extract_words_from_text(text_content, chapter_num)

                pages_data.append(
                    {
                        "page_number": chapter_num,
                        "text_content": text_content,
                        "words_data": words_data,
                        "images": [],
                    }
                )

        # 提取目录（用于导航）
        outline = self._extract_toc(book)

        return {
            **metadata,
            "pages": pages_data,
            "cover_image": cover_image,
            "outline": outline,
        }

    def _get_metadata(self, book: epub.EpubBook, namespace: str, name: str) -> Optional[str]:
        """提取元数据"""
        try:
            data = book.get_metadata(namespace, name)
            return data[0][0] if data else None  # type: ignore
        except Exception as e:
            print(f"Failed to extract metadata {namespace}:{name}: {e}")
            return None

    def _count_chapters(self, book: epub.EpubBook) -> int:
        """统计章节数"""
        return len([item for item in book.get_items() if item.get_type() == ebooklib.ITEM_DOCUMENT])

    def _extract_cover(self, book: epub.EpubBook, book_id: str, file_path: str) -> Optional[str]:
        """提取封面图片 - 支持多种 EPUB 封面格式"""
        try:
            cover_item = None

            # 方法1: 尝试从 OPF 元数据获取 cover ID
            cover_id = book.get_metadata("OPF", "cover")
            if cover_id:
                cover_id = cover_id[0][0]
                cover_item = book.get_item_with_id(cover_id)

            # 方法2: 查找 ID 为 'cover' 或 'cover-image' 的项目
            if not cover_item:
                for item in book.get_items():
                    item_id = getattr(item, "id", "").lower()
                    if item_id in ["cover", "cover-image", "coverimage"]:
                        cover_item = item
                        break

            # 方法3: 查找文件名包含 'cover' 的图片
            if not cover_item:
                for item in book.get_items():
                    if item.get_type() == ebooklib.ITEM_IMAGE:
                        file_name = getattr(item, "file_name", "").lower()
                        if "cover" in file_name:
                            cover_item = item
                            break

            # 方法4: 使用第一张图片作为封面
            if not cover_item:
                for item in book.get_items():
                    if item.get_type() == ebooklib.ITEM_IMAGE:
                        cover_item = item
                        break

            if not cover_item:
                print(f"EPUB cover not found for {book_id}")
                return None

            # 确定文件扩展名
            file_name = getattr(cover_item, "file_name", "cover.png")
            ext = os.path.splitext(file_name)[1].lower()
            if ext not in [".png", ".jpg", ".jpeg", ".gif", ".webp"]:
                ext = ".png"

            # 保存封面
            covers_dir = os.path.join(os.path.dirname(file_path), "covers")
            os.makedirs(covers_dir, exist_ok=True)

            cover_filename = f"{book_id}_cover{ext}"
            cover_path = os.path.join(covers_dir, cover_filename)

            with open(cover_path, "wb") as f:
                f.write(cover_item.get_content())

            print(f"EPUB cover extracted: {cover_filename}")
            return cover_filename
        except Exception as e:
            print(f"Failed to extract EPUB cover: {e}")
            return None

    def _extract_words_from_text(self, text: str, page_num: int) -> List[Dict]:
        """从文本中提取单词（模拟坐标）"""
        import re

        words = re.findall(r"\b[a-zA-ZÀ-ÿ]+(?:\'[a-zA-Z]+)?\b", text)

        words_data = []
        y = 0
        x = 0
        max_x = 800  # 假设每行最大宽度

        for word in words:
            words_data.append(
                {
                    "text": word,
                    "x": x,
                    "y": y,
                    "width": len(word) * 10,  # 简化计算
                    "height": 20,
                }
            )

            x += len(word) * 10 + 10  # 单词间隔
            if x > max_x:
                x = 0
                y += 30  # 换行

        return words_data

    def _extract_toc(self, book: epub.EpubBook) -> List[Dict]:
        """提取目录结构"""
        try:
            toc = book.get_toc()  # type: ignore
            return self._flatten_toc(toc)
        except Exception as e:
            print(f"Failed to extract TOC: {e}")
            return []

    def _flatten_toc(self, toc_list: List, level: int = 0) -> List[Dict]:
        """扁平化目录"""
        result = []
        for item in toc_list:
            if isinstance(item, (ebooklib.Link, ebooklib.Section)):  # type: ignore
                title = item.title or "Chapter"
                href = item.href if hasattr(item, "href") else None

                # 尝试从 href 获取章节号
                page_number = 1
                if href:
                    try:
                        # 从 href 中提取数字，如 "chapter-01.xhtml" -> 1
                        import re

                        match = re.search(r"(\d+)", href)
                        if match:
                            page_number = int(match.group(1))
                    except:
                        pass

                result.append(
                    {
                        "title": title,
                        "dest": href,
                        "pageNumber": page_number,
                        "level": level,
                    }
                )

                if hasattr(item, "children"):
                    result.extend(self._flatten_toc(item.children, level + 1))
        return result
