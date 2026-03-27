import os
import logging
import re
from pathlib import Path
from typing import Dict, Any, List, Optional

import ebooklib
from bs4 import BeautifulSoup
from ebooklib import epub

from .base import BaseParser


class EPUBParser(BaseParser):
    _IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
    _IMAGE_MEDIA_TYPES = {
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/gif",
        "image/webp",
        "image/svg+xml",
    }

    def parse(self, file_path: str, book_id: str) -> Dict[str, Any]:
        """解析 EPUB 文件"""
        book = epub.read_epub(file_path)

        title = self._get_metadata(book, "DC", "title") or Path(file_path).name
        author = self._get_metadata(book, "DC", "creator") or "Unknown"

        metadata = {
            "title": title,
            "author": author,
            "total_pages": self._count_chapters(book),
        }

        cover_image = self._extract_cover(book, book_id, file_path)

        pages_data = []
        chapter_num = 0

        for item in book.get_items():
            if item.get_type() == ebooklib.ITEM_DOCUMENT:
                chapter_num += 1
                content = item.get_content().decode("utf-8")
                soup = BeautifulSoup(content, "html.parser")
                text_content = soup.get_text(separator=" ", strip=True)
                words_data = self._extract_words_from_text(text_content, chapter_num)

                pages_data.append(
                    {
                        "page_number": chapter_num,
                        "text_content": text_content,
                        "words_data": words_data,
                        "images": [],
                    }
                )

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
        logger = logging.getLogger(__name__)

        try:
            covers_dir = os.path.join(os.path.dirname(file_path), "covers")
            os.makedirs(covers_dir, exist_ok=True)

            logger.info(f"[{book_id}] Starting cover extraction for {os.path.basename(file_path)}")

            result = self._extract_cover_from_opf(file_path, book_id, covers_dir)
            if result:
                logger.info(f"[{book_id}] Cover extracted via Method 0 (OPF direct): {result}")
                return result

            cover_item = None

            cover_id_meta = book.get_metadata("OPF", "cover")
            if cover_id_meta:
                cover_id = cover_id_meta[0][0]
                logger.info(f"[{book_id}] OPF meta cover ID found: {cover_id}")
                cover_item = self._resolve_cover_item(book, book.get_item_with_id(cover_id), book_id)

            if not cover_item:
                for item in book.get_items():
                    item_id = getattr(item, "id", "").lower()
                    if item_id in ["cover", "cover-image", "coverimage", "cover_image"]:
                        logger.info(f"[{book_id}] Found cover candidate by ID: {item_id}")
                        cover_item = self._resolve_cover_item(book, item, book_id)
                        if cover_item:
                            break

            if not cover_item:
                for item in book.get_items():
                    file_name = getattr(item, "file_name", "").lower()
                    if "cover" in file_name:
                        logger.info(f"[{book_id}] Found cover candidate by filename: {file_name}")
                        cover_item = self._resolve_cover_item(book, item, book_id)
                        if cover_item:
                            break

            if not cover_item:
                largest_size = 0
                for item in book.get_items():
                    if not self._is_image_item(item):
                        continue
                    data = item.get_content()
                    if len(data) > largest_size and len(data) > 1024 * 10:
                        largest_size = len(data)
                        cover_item = item
                if cover_item:
                    logger.info(f"[{book_id}] Fallback: selected largest image ({largest_size} bytes)")

            if not cover_item:
                logger.warning(f"[{book_id}] No cover found after all methods")
                return None

            img_data = cover_item.get_content()
            if not img_data or len(img_data) < 100:
                logger.warning(f"[{book_id}] Selected cover item has no data or is too small")
                return None

            media_type = (getattr(cover_item, "media_type", "") or "").lower()
            if self._looks_like_html_document(img_data) and media_type != "image/svg+xml":
                logger.error(f"[{book_id}] Selected cover data is HTML/XML, not an image")
                return None

            file_name = getattr(cover_item, "file_name", "cover.png")
            ext = os.path.splitext(file_name)[1].lower()
            if ext not in self._IMAGE_EXTENSIONS:
                ext = ".jpg"

            cover_filename = f"{book_id}_cover{ext}"
            cover_path = os.path.join(covers_dir, cover_filename)

            with open(cover_path, "wb") as f:
                f.write(img_data)

            logger.info(f"[{book_id}] Successfully saved cover to {cover_filename}")
            return cover_filename
        except Exception as e:
            logger.error(f"[{book_id}] Exception during cover extraction: {e}", exc_info=True)
            return None

    def _extract_cover_from_opf(self, file_path: str, book_id: str, covers_dir: str) -> Optional[str]:
        """直接解析 EPUB zip 中的 OPF XML 提取封面，支持 EPUB2/EPUB3 规范"""
        import posixpath
        import xml.etree.ElementTree as ET
        import zipfile

        logger = logging.getLogger(__name__)

        try:
            with zipfile.ZipFile(file_path, "r") as z:
                container_xml = z.read("META-INF/container.xml").decode("utf-8", errors="ignore")
                opf_match = re.search(r'full-path=["\']([^"\']+\.opf)["\']', container_xml)
                if not opf_match:
                    logger.warning(f"[{book_id}] (OPF) No OPF file path found in container.xml")
                    return None

                opf_path = opf_match.group(1)
                opf_dir = posixpath.dirname(opf_path)
                opf_content = z.read(opf_path).decode("utf-8", errors="ignore")
                root = ET.fromstring(opf_content)

                cover_manifest_id = None
                cover_href = None
                cover_media_type = None

                for el in root.iter():
                    tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
                    if tag == "item" and "cover-image" in (el.get("properties") or ""):
                        cover_href = (el.get("href") or "").strip()
                        cover_media_type = (el.get("media-type") or "").strip().lower()
                        logger.info(f"[{book_id}] (OPF) Found EPUB3 property cover: {cover_href}")
                        break

                for el in root.iter():
                    tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
                    if tag == "meta" and el.get("name") == "cover":
                        cover_manifest_id = (el.get("content") or "").strip()
                        logger.info(f"[{book_id}] (OPF) Meta cover ID: {cover_manifest_id}")
                        break

                if cover_manifest_id and not cover_href:
                    for el in root.iter():
                        tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
                        if tag == "item" and el.get("id") == cover_manifest_id:
                            media_type = (el.get("media-type") or "").lower()
                            item_href = (el.get("href") or "").strip()

                            if "image" in media_type:
                                cover_href = item_href
                                cover_media_type = media_type
                                logger.info(f"[{book_id}] (OPF) Found manifest image: {cover_href}")
                            elif "html" in media_type or "xhtml" in media_type:
                                logger.info(f"[{book_id}] (OPF) Manifest ID points to HTML: {item_href}")
                                full_html_path = posixpath.normpath(posixpath.join(opf_dir, item_href))
                                try:
                                    html_content = z.read(full_html_path).decode("utf-8", errors="ignore")
                                    img_match = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', html_content, re.IGNORECASE)
                                    if not img_match:
                                        img_match = re.search(r'<image[^>]+(?:xlink:href|href)=["\']([^"\']+)["\']', html_content, re.IGNORECASE)

                                    if img_match:
                                        img_rel = img_match.group(1)
                                        html_dir = posixpath.dirname(full_html_path)
                                        cover_href_candidate = posixpath.normpath(posixpath.join(html_dir, img_rel))
                                        logger.info(f"[{book_id}] (OPF) Found image in HTML: {cover_href_candidate}")
                                        if cover_href_candidate in z.namelist():
                                            cover_href = posixpath.relpath(cover_href_candidate, opf_dir)
                                            cover_media_type = self._guess_media_type_from_path(cover_href_candidate)
                                        else:
                                            logger.warning(f"[{book_id}] (OPF) Image in HTML not found in ZIP: {cover_href_candidate}")
                                except Exception as e:
                                    logger.warning(f"[{book_id}] (OPF) Error parsing cover HTML: {e}")
                            break

                if not cover_href:
                    logger.info(f"[{book_id}] (OPF) No cover href found after manifest lookup")
                    return None

                full_img_path = posixpath.normpath(posixpath.join(opf_dir, cover_href)) if opf_dir else cover_href
                if full_img_path not in z.namelist():
                    full_img_path = full_img_path.replace("\\", "/")
                if full_img_path not in z.namelist():
                    logger.warning(f"[{book_id}] (OPF) Target image not found in ZIP: {full_img_path}")
                    return None

                img_data = z.read(full_img_path)
                if not img_data or len(img_data) < 100:
                    logger.warning(f"[{book_id}] (OPF) Extracted image data is empty or too small")
                    return None

                if self._looks_like_html_document(img_data) and cover_media_type != "image/svg+xml":
                    logger.error(f"[{book_id}] (OPF) Extracted file is HTML/XML, not an image")
                    return None

                ext = os.path.splitext(full_img_path)[1].lower()
                if ext not in self._IMAGE_EXTENSIONS:
                    ext = ".jpg"

                cover_filename = f"{book_id}_cover{ext}"
                cover_path = os.path.join(covers_dir, cover_filename)
                with open(cover_path, "wb") as f:
                    f.write(img_data)

                logger.info(f"[{book_id}] (OPF) Successfully saved cover to {cover_filename}")
                return cover_filename
        except Exception as e:
            logger.error(f"[{book_id}] (OPF) Extraction exception: {e}", exc_info=True)
            return None

    def _extract_image_from_cover_doc(self, book: epub.EpubBook, doc_item: Any) -> Optional[Any]:
        """从封面 HTML 文档中提取 <img> 或 <image> 指向的图片 item"""
        logger = logging.getLogger(__name__)

        try:
            content = doc_item.get_content().decode("utf-8", errors="ignore")
            soup = BeautifulSoup(content, "html.parser")

            img_tag = soup.find("img")
            src = img_tag.get("src", "") if img_tag else ""

            if not src:
                image_tag = soup.find("image")
                if image_tag:
                    src = image_tag.get("xlink:href") or image_tag.get("href", "")

            if not src:
                logger.warning("No image reference found in cover document")
                return None

            img_basename = os.path.basename(src).split("?")[0]
            for item in book.get_items():
                if not self._is_image_item(item):
                    continue
                if os.path.basename(getattr(item, "file_name", "")) == img_basename:
                    logger.info(f"Matched image in cover doc: {item.file_name}")
                    return item
        except Exception as e:
            logger.warning(f"Error extracting image from cover doc: {e}")
        return None

    def _is_image_item(self, item: Any) -> bool:
        media_type = (getattr(item, "media_type", "") or "").lower()
        file_name = (getattr(item, "file_name", "") or "").lower()
        ext = os.path.splitext(file_name)[1]
        return item.get_type() == ebooklib.ITEM_IMAGE or media_type in self._IMAGE_MEDIA_TYPES or ext in self._IMAGE_EXTENSIONS

    def _looks_like_html_document(self, data: bytes) -> bool:
        header = data[:200].strip().lower()
        return (
            header.startswith(b"<?xml")
            or header.startswith(b"<!doctype")
            or header.startswith(b"<html")
            or b"<html" in header
            or b"<body" in header
            or b"<section" in header
        )

    def _guess_media_type_from_path(self, path: str) -> str:
        ext = os.path.splitext(path)[1].lower()
        if ext == ".png":
            return "image/png"
        if ext in [".jpg", ".jpeg"]:
            return "image/jpeg"
        if ext == ".gif":
            return "image/gif"
        if ext == ".webp":
            return "image/webp"
        if ext == ".svg":
            return "image/svg+xml"
        return ""

    def _resolve_cover_item(self, book: epub.EpubBook, item: Optional[Any], book_id: str) -> Optional[Any]:
        logger = logging.getLogger(__name__)
        if not item:
            return None

        media_type = (getattr(item, "media_type", "") or "").lower()
        file_name = (getattr(item, "file_name", "") or "").lower()
        ext = os.path.splitext(file_name)[1]

        if self._is_image_item(item):
            return item

        if item.get_type() == ebooklib.ITEM_DOCUMENT or media_type in {"application/xhtml+xml", "text/html"} or ext in {".xhtml", ".html", ".htm"}:
            logger.info(f"[{book_id}] Cover candidate is document ({file_name or media_type}), resolving embedded image")
            return self._extract_image_from_cover_doc(book, item)

        try:
            payload = item.get_content()
            if self._looks_like_html_document(payload):
                logger.info(f"[{book_id}] Cover candidate payload is HTML/XML ({file_name or media_type}), resolving embedded image")
                return self._extract_image_from_cover_doc(book, item)
        except Exception:
            return None

        return None

    def _extract_words_from_text(self, text: str, page_num: int) -> List[Dict]:
        """从文本中提取单词（模拟坐标）"""
        words = re.findall(r"\b[a-zA-ZÀ-ÿ]+(?:\'[a-zA-Z]+)?\b", text)

        words_data = []
        y = 0
        x = 0
        max_x = 800

        for word in words:
            words_data.append(
                {
                    "text": word,
                    "x": x,
                    "y": y,
                    "width": len(word) * 10,
                    "height": 20,
                }
            )

            x += len(word) * 10 + 10
            if x > max_x:
                x = 0
                y += 30

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

                page_number = 1
                if href:
                    try:
                        match = re.search(r"(\d+)", href)
                        if match:
                            page_number = int(match.group(1))
                    except Exception:
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
