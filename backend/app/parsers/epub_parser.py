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
            covers_dir = os.path.join(os.path.dirname(file_path), "covers")
            os.makedirs(covers_dir, exist_ok=True)

            # 方法0 (最优先): 直接解析 OPF XML，绕过 ebooklib 命名空间解析限制
            # 支持 EPUB2 (<meta name="cover" content="id">) 和 EPUB3 (properties="cover-image")
            result = self._extract_cover_from_opf(file_path, book_id, covers_dir)
            if result:
                return result

            cover_item = None

            # 方法1: ebooklib API 读取 OPF 元数据 cover ID（EPUB3 标准方式）
            cover_id_meta = book.get_metadata("OPF", "cover")
            if cover_id_meta:
                cover_id = cover_id_meta[0][0]
                cover_item = book.get_item_with_id(cover_id)
                # 如果拿到的是 HTML 文档，尝试从中提取 img 标签指向的图片
                if cover_item and cover_item.get_type() == ebooklib.ITEM_DOCUMENT:
                    cover_item = self._extract_image_from_cover_doc(book, cover_item)

            # 方法2: 查找 ID 为 'cover' / 'cover-image' 的图片 item
            if not cover_item:
                for item in book.get_items():
                    if item.get_type() != ebooklib.ITEM_IMAGE:
                        continue
                    item_id = getattr(item, "id", "").lower()
                    if item_id in ["cover", "cover-image", "coverimage", "cover_image"]:
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

            # 方法4: 兜底 - 取体积最大的图片（通常是封面，避免取到小 logo/图标）
            if not cover_item:
                largest_size = 0
                for item in book.get_items():
                    if item.get_type() == ebooklib.ITEM_IMAGE:
                        data = item.get_content()
                        if len(data) > largest_size:
                            largest_size = len(data)
                            cover_item = item

            if not cover_item:
                print(f"EPUB cover not found for {book_id}")
                return None

            # 保存封面
            file_name = getattr(cover_item, "file_name", "cover.png")
            ext = os.path.splitext(file_name)[1].lower()
            if ext not in [".png", ".jpg", ".jpeg", ".gif", ".webp"]:
                ext = ".png"

            cover_filename = f"{book_id}_cover{ext}"
            cover_path = os.path.join(covers_dir, cover_filename)

            with open(cover_path, "wb") as f:
                f.write(cover_item.get_content())

            print(f"EPUB cover extracted (ebooklib): {cover_filename}")
            return cover_filename
        except Exception as e:
            print(f"Failed to extract EPUB cover: {e}")
            return None

    def _extract_cover_from_opf(self, file_path: str, book_id: str, covers_dir: str) -> Optional[str]:
        """直接解析 EPUB zip 中的 OPF XML 提取封面，支持 EPUB2/EPUB3 规范"""
        import zipfile
        import posixpath
        import xml.etree.ElementTree as ET

        try:
            with zipfile.ZipFile(file_path, "r") as z:
                # 1. 找到 OPF 文件路径
                container_xml = z.read("META-INF/container.xml").decode("utf-8", errors="ignore")
                import re
                opf_match = re.search(r'full-path=["\']([^"\']+\.opf)["\']', container_xml)
                if not opf_match:
                    return None
                opf_path = opf_match.group(1)
                opf_dir = posixpath.dirname(opf_path)

                # 2. 解析 OPF
                opf_content = z.read(opf_path).decode("utf-8", errors="ignore")
                root = ET.fromstring(opf_content)

                # 3a. EPUB2: <meta name="cover" content="manifest-id">
                cover_manifest_id = None
                cover_href = None
                for el in root.iter():
                    tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
                    if tag == "meta" and el.get("name") == "cover":
                        cover_manifest_id = el.get("content", "").strip()
                        break

                # 3b. EPUB3: <item properties="cover-image" href="...">
                if not cover_manifest_id:
                    for el in root.iter():
                        tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
                        if tag == "item" and "cover-image" in el.get("properties", ""):
                            cover_href = el.get("href", "").strip()
                            break

                # 4. 在 manifest 中找对应 href
                if cover_manifest_id and not cover_href:
                    for el in root.iter():
                        tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
                        if tag == "item" and el.get("id") == cover_manifest_id:
                            media_type = el.get("media-type", "")
                            if "image" in media_type:
                                cover_href = el.get("href", "").strip()
                            # 若 cover id 指向 HTML 文档，则从 HTML 中提取 <img>
                            elif "html" in media_type or "xhtml" in media_type:
                                html_href = el.get("href", "").strip()
                                full_html_path = posixpath.normpath(posixpath.join(opf_dir, html_href))
                                try:
                                    html_content = z.read(full_html_path).decode("utf-8", errors="ignore")
                                    img_match = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', html_content)
                                    if img_match:
                                        img_rel = img_match.group(1)
                                        html_dir = posixpath.dirname(full_html_path)
                                        cover_href_candidate = posixpath.normpath(posixpath.join(html_dir, img_rel))
                                        # 验证文件存在
                                        if cover_href_candidate in z.namelist():
                                            cover_href = posixpath.relpath(cover_href_candidate, opf_dir)
                                except Exception:
                                    pass
                            break

                if not cover_href:
                    return None

                # 5. 组合完整路径并读取图片
                full_img_path = posixpath.normpath(posixpath.join(opf_dir, cover_href)) if opf_dir else cover_href
                # 兼容 zip 内路径斜杠
                if full_img_path not in z.namelist():
                    full_img_path = full_img_path.replace("\\", "/")
                if full_img_path not in z.namelist():
                    return None

                img_data = z.read(full_img_path)
                if not img_data or len(img_data) < 100:
                    return None

                ext = os.path.splitext(full_img_path)[1].lower()
                if ext not in [".png", ".jpg", ".jpeg", ".gif", ".webp"]:
                    ext = ".jpg"

                cover_filename = f"{book_id}_cover{ext}"
                cover_path = os.path.join(covers_dir, cover_filename)
                with open(cover_path, "wb") as f:
                    f.write(img_data)

                print(f"EPUB cover extracted (OPF direct): {cover_filename} ({len(img_data)} bytes)")
                return cover_filename

        except Exception as e:
            print(f"OPF direct cover extraction failed: {e}")
            return None

    def _extract_image_from_cover_doc(self, book: epub.EpubBook, doc_item) -> Optional[Any]:
        """从封面 HTML 文档中提取 <img> 指向的图片 item"""
        try:
            from bs4 import BeautifulSoup
            import re
            content = doc_item.get_content().decode("utf-8", errors="ignore")
            soup = BeautifulSoup(content, "html.parser")
            img_tag = soup.find("img")
            if not img_tag:
                return None
            src = img_tag.get("src", "")
            # src 通常是相对路径，如 ../Images/cover.jpg，取文件名部分匹配
            img_basename = os.path.basename(src)
            for item in book.get_items():
                if item.get_type() == ebooklib.ITEM_IMAGE:
                    if os.path.basename(getattr(item, "file_name", "")) == img_basename:
                        return item
        except Exception:
            pass
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
