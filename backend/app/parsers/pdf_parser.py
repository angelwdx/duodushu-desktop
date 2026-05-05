"""
PDF解析器 - 使用 PyMuPDF (fitz) 进行文字提取

提供智能多栏检测、艺术排版处理（首字下沉等）和动态阈值计算。
相比 pdfplumber，速度快 3-5 倍，多栏布局识别更准确。
"""

import fitz  # PyMuPDF
import logging
from pathlib import Path
from .base import BaseParser
from typing import Dict, Any, List, Tuple, Optional
from ..services.thumbnail_service import ThumbnailService

logger = logging.getLogger(__name__)

INLINE_PUNCTUATION = set(",.;:!?)]}%")
OPENING_PUNCTUATION = set("([{")


class PDFParser(BaseParser):
    """
    PDF 文件解析器。

    使用 PyMuPDF 提取文字坐标和内容，支持：
    - 智能多栏布局检测（全宽块优先分离，避免跨栏标题破坏排序）
    - 首字下沉等艺术排版处理
    - 动态阈值计算
    """

    def parse(self, file_path: str, book_id: str) -> Dict[str, Any]:
        """
        解析 PDF 文件，提取元数据、封面和每页文字内容。

        Args:
            file_path: PDF 文件路径
            book_id: 书籍唯一标识符

        Returns:
            包含元数据和页面数据的字典
        """
        pages_data = []
        metadata = {}
        cover_image = None

        doc = fitz.open(file_path)

        try:
            # 提取元数据
            pdf_meta = doc.metadata
            metadata = {
                "title": pdf_meta.get("title") or Path(file_path).name,  # type: ignore
                "author": pdf_meta.get("author") or "Unknown",  # type: ignore
                "total_pages": len(doc),
                "language": None,
            }

            # 提取封面图片（首页）
            cover_image = self._extract_cover(doc, file_path, book_id)

            # 解析每一页
            for page_num, page in enumerate(doc, start=1):  # type: ignore
                page_data = self._parse_page(page, page_num)
                pages_data.append(page_data)

        finally:
            doc.close()

        # 生成缩略图
        self._generate_thumbnails(file_path, book_id)

        return {**metadata, "pages": pages_data, "cover_image": cover_image}

    def _extract_cover(self, doc: fitz.Document, file_path: str, book_id: str) -> Optional[str]:
        """
        提取 PDF 首页作为封面图片。

        Args:
            doc: PyMuPDF 文档对象
            file_path: PDF 文件路径
            book_id: 书籍 ID

        Returns:
            封面图片文件名，提取失败返回 None
        """
        try:
            if len(doc) > 0:
                first_page = doc[0]
                covers_dir = Path(file_path).parent / "covers"
                covers_dir.mkdir(parents=True, exist_ok=True)

                cover_filename = f"{book_id}_cover.png"
                cover_path = covers_dir / cover_filename

                # 渲染页面为图片 (150 DPI)
                mat = fitz.Matrix(150 / 72, 150 / 72)  # 72 DPI -> 150 DPI
                pix = first_page.get_pixmap(matrix=mat)
                pix.save(cover_path)

                return cover_filename
        except Exception as e:
            logger.error(f"Failed to extract cover: {e}")
        return None

    def _parse_page(self, page: fitz.Page, page_num: int) -> Dict[str, Any]:
        """
        解析单页 PDF，提取文字及坐标。

        Args:
            page: PyMuPDF 页面对象
            page_num: 页码（从1开始）

        Returns:
            包含页面文字数据的字典
        """
        # 获取结构化文本数据（使用 rawdict 获取字符级坐标）
        text_dict = page.get_text("rawdict", flags=fitz.TEXT_PRESERVE_WHITESPACE)

        # 1. 收集并初步组织文本块
        blocks_info = []
        for block in text_dict.get("blocks", []):  # type: ignore
            if block.get("type") != 0:
                continue

            bbox = block.get("bbox", [0, 0, 0, 0])
            blocks_info.append(
                {
                    "block": block,
                    "x0": bbox[0],
                    "y0": bbox[1],
                    "x1": bbox[2],
                    "y1": bbox[3],
                    "center_x": (bbox[0] + bbox[2]) / 2,
                }
            )

        if not blocks_info:
            return {
                "page_number": page_num,
                "text_content": "",
                "words_data": [],
                "images": [],
            }

        # 2. 智能多栏检测 — 返回已按正确阅读顺序排列的扁平块列表
        ordered_blocks = self._detect_columns(blocks_info, page.rect.width)

        # 3. 按顺序提取文字和单词坐标（无需再区分单栏/多栏）
        #    额外在 block 内做一次区域拆分，避免 rawdict 把互不相邻的图注/引文
        #    合并进同一个 block 后被逐行交织。
        words_data = []
        text_parts = []

        block_idx = 0
        for block_info in ordered_blocks:
            for region in self._split_block_into_regions(block_info["block"]):
                region_lines = []
                for line in region["lines"]:
                    line_text, line_words = self._extract_line_text_and_words(line, block_idx=block_idx)
                    if line_text:
                        region_lines.append(line_text)
                    if line_words:
                        words_data.extend(line_words)

                if region_lines:
                    text_parts.append("\n".join(region_lines))
                    block_idx += 1

        text_content = "\n\n".join(text_parts)

        return {
            "page_number": page_num,
            "text_content": text_content,
            "words_data": words_data,
            "images": [],
        }

    def _split_block_into_regions(self, block: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        将 rawdict 的单个 block 按实际视觉区域拆分成多个子区域。

        PyMuPDF 偶尔会把互不相邻的文本区（如居中引文 + 左下角图注）合并到同一 block。
        如果直接按行排序，这些区域会因 y 轴重叠而被交织。这里先按行的横向分布做连通域聚类，
        再决定这些区域是“并排栏”还是“上下独立区域”，从而避免混排。
        """
        line_infos: List[Dict[str, Any]] = []
        for line in block.get("lines", []):
            bbox = line.get("bbox", [0, 0, 0, 0])
            if len(bbox) < 4:
                continue

            x0 = float(bbox[0])
            y0 = float(bbox[1])
            x1 = float(bbox[2])
            y1 = float(bbox[3])
            width = max(x1 - x0, 0.0)
            height = max(y1 - y0, 0.0)
            char_count = sum(len(span.get("chars", [])) for span in line.get("spans", []))

            if width <= 0 or height <= 0 or char_count == 0:
                continue

            line_infos.append(
                {
                    "line": line,
                    "x0": x0,
                    "y0": y0,
                    "x1": x1,
                    "y1": y1,
                    "width": width,
                    "height": height,
                    "center_x": (x0 + x1) / 2,
                }
            )

        if not line_infos:
            return []

        if len(line_infos) == 1:
            return [self._build_block_region(line_infos)]

        regions: List[List[Dict[str, Any]]] = []
        visited = [False] * len(line_infos)

        for idx in range(len(line_infos)):
            if visited[idx]:
                continue

            stack = [idx]
            component: List[Dict[str, Any]] = []

            while stack:
                current_idx = stack.pop()
                if visited[current_idx]:
                    continue

                visited[current_idx] = True
                component.append(line_infos[current_idx])

                for other_idx in range(len(line_infos)):
                    if visited[other_idx]:
                        continue
                    if self._lines_share_region(line_infos[current_idx], line_infos[other_idx]):
                        stack.append(other_idx)

            regions.append(component)

        region_infos = [self._build_block_region(region_lines) for region_lines in regions]
        return self._order_block_regions(region_infos)

    def _build_block_region(self, line_infos: List[Dict[str, Any]]) -> Dict[str, Any]:
        ordered_line_infos = PDFParser._sort_visual_line_order(
            line_infos,
            lambda info: info["y0"],
            lambda info: info["y1"],
            lambda info: info["x0"],
        )

        x0 = min(info["x0"] for info in ordered_line_infos)
        y0 = min(info["y0"] for info in ordered_line_infos)
        x1 = max(info["x1"] for info in ordered_line_infos)
        y1 = max(info["y1"] for info in ordered_line_infos)
        avg_line_height = sum(info["height"] for info in ordered_line_infos) / max(len(ordered_line_infos), 1)

        return {
            "lines": [info["line"] for info in ordered_line_infos],
            "x0": x0,
            "y0": y0,
            "x1": x1,
            "y1": y1,
            "center_x": (x0 + x1) / 2,
            "avg_line_height": avg_line_height,
        }

    def _lines_share_region(self, left: Dict[str, Any], right: Dict[str, Any]) -> bool:
        overlap = min(left["x1"], right["x1"]) - max(left["x0"], right["x0"])
        min_width = max(min(left["width"], right["width"]), 1.0)
        max_height = max(left["height"], right["height"], 1.0)
        edge_threshold = max(12.0, max_height * 2.5)
        center_threshold = max(18.0, min_width * 0.45, max_height * 4.0)

        if overlap >= min_width * 0.2:
            return True

        if abs(left["x0"] - right["x0"]) <= edge_threshold:
            return True

        if abs(left["x1"] - right["x1"]) <= edge_threshold:
            return True

        return abs(left["center_x"] - right["center_x"]) <= center_threshold

    def _order_block_regions(self, regions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if len(regions) <= 1:
            return regions

        rough = sorted(regions, key=lambda region: (region["y0"], region["x0"]))
        bands: List[List[Dict[str, Any]]] = []
        current_band: List[Dict[str, Any]] = [rough[0]]

        for region in rough[1:]:
            if any(self._regions_should_share_band(existing, region) for existing in current_band):
                current_band.append(region)
                continue

            bands.append(sorted(current_band, key=lambda item: item["x0"]))
            current_band = [region]

        bands.append(sorted(current_band, key=lambda item: item["x0"]))

        ordered: List[Dict[str, Any]] = []
        for band in bands:
            ordered.extend(band)
        return ordered

    def _regions_should_share_band(self, upper: Dict[str, Any], lower: Dict[str, Any]) -> bool:
        overlap = min(upper["y1"], lower["y1"]) - max(upper["y0"], lower["y0"])
        min_height = max(min(upper["y1"] - upper["y0"], lower["y1"] - lower["y0"]), 1.0)
        min_line_height = max(min(upper["avg_line_height"], lower["avg_line_height"]), 1.0)
        top_threshold = max(12.0, min_line_height * 1.8)
        horizontal_gap = max(upper["x0"], lower["x0"]) - min(upper["x1"], lower["x1"])

        return (
            abs(upper["y0"] - lower["y0"]) <= top_threshold
            and overlap >= min_height * 0.45
            and horizontal_gap >= max(8.0, min_line_height * 1.2)
        )

    def _extract_line_text_and_words(self, line: Dict, block_idx: int = 0) -> Tuple[str, List[Dict[str, Any]]]:
        """
        基于字符级坐标重建单行文本与单词列表。

        这一步不信任 span 的顺序和空格切分，统一用字符 bbox 做排序与 gap 推断，
        可显著降低 PDF 中因多个 span/字偶距导致的丢空格、乱序、断词问题。
        """
        chars: List[Dict[str, Any]] = []
        for span in line.get("spans", []):
            for char in span.get("chars", []):
                bbox = char.get("bbox", [0, 0, 0, 0])
                chars.append(
                    {
                        "c": char.get("c", ""),
                        "bbox": [
                            float(bbox[0]),
                            float(bbox[1]),
                            float(bbox[2]),
                            float(bbox[3]),
                        ],
                    }
                )

        if not chars:
            return "", []

        chars.sort(key=lambda char: (char["bbox"][0], char["bbox"][1], char["bbox"][2]))

        line_parts: List[str] = []
        words: List[Dict[str, Any]] = []
        current_word_chars: List[str] = []
        current_word_bbox: Optional[List[float]] = None
        prev_char: Optional[Dict[str, Any]] = None

        def flush_word() -> None:
            nonlocal current_word_chars, current_word_bbox
            if not current_word_chars or current_word_bbox is None:
                current_word_chars = []
                current_word_bbox = None
                return
            word_text = "".join(current_word_chars)
            words.append(
                {
                    "text": word_text,
                    "x": float(current_word_bbox[0]),
                    "y": float(current_word_bbox[1]),
                    "width": float(current_word_bbox[2] - current_word_bbox[0]),
                    "height": float(current_word_bbox[3] - current_word_bbox[1]),
                    "block_id": block_idx,
                }
            )
            current_word_chars = []
            current_word_bbox = None

        for char in chars:
            c = char["c"]
            bbox = char["bbox"]

            if c.isspace():
                flush_word()
                if line_parts and line_parts[-1] != " ":
                    line_parts.append(" ")
                prev_char = char
                continue

            if prev_char and self._should_insert_space_between_chars(prev_char, char):
                flush_word()
                if line_parts and line_parts[-1] != " ":
                    line_parts.append(" ")

            line_parts.append(c)

            if current_word_bbox is None:
                current_word_bbox = [bbox[0], bbox[1], bbox[2], bbox[3]]
            else:
                current_word_bbox[0] = min(current_word_bbox[0], bbox[0])
                current_word_bbox[1] = min(current_word_bbox[1], bbox[1])
                current_word_bbox[2] = max(current_word_bbox[2], bbox[2])
                current_word_bbox[3] = max(current_word_bbox[3], bbox[3])
            current_word_chars.append(c)
            prev_char = char

        flush_word()

        line_text = "".join(line_parts)
        line_text = " ".join(line_text.split())
        return line_text.strip(), words

    def _should_insert_space_between_chars(self, prev_char: Dict[str, Any], curr_char: Dict[str, Any]) -> bool:
        prev_c = str(prev_char.get("c", ""))
        curr_c = str(curr_char.get("c", ""))
        if not prev_c or not curr_c:
            return False
        if curr_c in INLINE_PUNCTUATION or prev_c in OPENING_PUNCTUATION:
            return False

        prev_bbox = prev_char.get("bbox", [0.0, 0.0, 0.0, 0.0])
        curr_bbox = curr_char.get("bbox", [0.0, 0.0, 0.0, 0.0])
        prev_width = max(float(prev_bbox[2]) - float(prev_bbox[0]), 0.0)
        curr_width = max(float(curr_bbox[2]) - float(curr_bbox[0]), 0.0)
        gap = float(curr_bbox[0]) - float(prev_bbox[2])

        if gap <= 0:
            return False

        # 对英文字体常见 kerning 做保守容忍；gap 明显大于字符宽度时才补空格。
        threshold = max(1.2, min(max(prev_width, curr_width) * 0.35, 8.0))
        return gap > threshold

    @staticmethod
    def _sort_visual_line_order(items: List[Dict], get_y0, get_y1, get_x0) -> List[Dict]:
        """
        按视觉阅读顺序排序文本块/行列表，正确处理上标/下标等偏移元素。

        简单的 y0 排序会把上标（如序数词后缀 "th"、"nd"）排到基线文字前面，
        因为上标的 y0 更小（位置更高）。本方法先粗排，再把 y 范围有重叠的
        相邻项归入同一视觉行，行内按 x0 排序，确保"16"排在"th"之前。

        Args:
            items: 要排序的元素列表。
            get_y0: 取元素顶边 y0 的可调用对象。
            get_y1: 取元素底边 y1 的可调用对象。
            get_x0: 取元素左边 x0 的可调用对象。

        Returns:
            按正确视觉顺序排列的元素列表。
        """
        if not items:
            return []

        # 粗排：以 y0 为主键，x0 为次键
        rough = sorted(items, key=lambda item: (get_y0(item), get_x0(item)))

        # 将 y 范围有重叠的相邻项归入同一视觉行
        groups: List[List] = []
        current_group: List = [rough[0]]
        group_max_y1: float = get_y1(rough[0])

        for item in rough[1:]:
            y0 = get_y0(item)
            y1 = get_y1(item)
            item_h = max(y1 - y0, 0.5)
            overlap = group_max_y1 - y0
            # 重叠量达到当前元素高度的 35%（或至少 1pt）时，视为同一视觉行
            if overlap >= max(item_h * 0.35, 1.0):
                current_group.append(item)
                group_max_y1 = max(group_max_y1, y1)
            else:
                groups.append(current_group)
                current_group = [item]
                group_max_y1 = y1
        groups.append(current_group)

        # 行内按 x0 排序，再展平
        result: List[Dict] = []
        for group in groups:
            group.sort(key=lambda item: get_x0(item))
            result.extend(group)
        return result

    def _detect_columns(self, blocks: List[Dict], page_width: float) -> List[Dict]:
        """
        检测页面是否为多栏布局，返回已按正确阅读顺序排列的扁平块列表。

        算法：
        1. 先分离"全宽块"（宽度 >= 65% 页面宽，如跨栏标题、图注），
           不参与 X 聚类，避免破坏分栏检测。
        2. 仅用剩余"窄块"中的"显著块"（字符数 >= 6）做 X 坐标聚类。
        3. 若无分割点 → 单栏：全部块按 (y0, x0) 排序后返回。
        4. 若有分割点 → 多栏：
           a. 将窄块按分割点分配到各栏，每栏内按 y0 排序。
           b. 各栏按左→右顺序展开为扁平列表。
           c. 如有全宽块，用归并算法按 y0 将其插回正确位置。

        Args:
            blocks: 文本块列表（含 x0/y0/x1/y1/center_x/block 字段）
            page_width: 页面宽度

        Returns:
            List[Dict] — 按正确阅读顺序排列的扁平块列表，调用方直接迭代即可。
        """
        if not blocks:
            return []
        if len(blocks) < 2:
            return PDFParser._sort_visual_line_order(
                blocks, lambda b: b["y0"], lambda b: b["y1"], lambda b: b["x0"]
            )

        # ── 步骤 1：分离全宽块与窄块 ──────────────────────────────────
        FULL_WIDTH_RATIO = 0.65
        full_width_blocks: List[Dict] = []
        narrow_blocks: List[Dict] = []
        for b in blocks:
            block_width = b["x1"] - b["x0"]
            if page_width > 0 and block_width >= page_width * FULL_WIDTH_RATIO:
                full_width_blocks.append(b)
            else:
                narrow_blocks.append(b)

        # ── 步骤 2：用显著窄块做多栏检测 ──────────────────────────────
        significant_narrow: List[Dict] = []
        for b in narrow_blocks:
            block = b["block"]
            text_len = sum(
                len(span.get("chars", []))
                for line in block.get("lines", [])
                for span in line.get("spans", [])
            )
            if text_len >= 6:
                significant_narrow.append(b)

        # 显著窄块不足 → 单栏
        if len(significant_narrow) < 2:
            return PDFParser._sort_visual_line_order(
                blocks, lambda b: b["y0"], lambda b: b["y1"], lambda b: b["x0"]
            )

        # ── 步骤 3：X 聚类找分割点 ────────────────────────────────────
        center_xs = [b["center_x"] for b in significant_narrow]
        gap_threshold = page_width * 0.15

        center_xs_sorted = sorted(set(center_xs))
        split_points: List[float] = []
        for i in range(len(center_xs_sorted) - 1):
            gap = center_xs_sorted[i + 1] - center_xs_sorted[i]
            if gap > gap_threshold:
                split_points.append((center_xs_sorted[i] + center_xs_sorted[i + 1]) / 2)

        # 无分割点 → 单栏
        if not split_points:
            return PDFParser._sort_visual_line_order(
                blocks, lambda b: b["y0"], lambda b: b["y1"], lambda b: b["x0"]
            )

        # ── 步骤 4：窄块分配到各栏，每栏内按 y0 排序 ─────────────────
        columns: List[List[Dict]] = [[] for _ in range(len(split_points) + 1)]
        for b in narrow_blocks:
            col_idx = 0
            for i, split_x in enumerate(split_points):
                if b["center_x"] > split_x:
                    col_idx = i + 1
            columns[col_idx].append(b)

        columns = [col for col in columns if col]
        for col in columns:
            col[:] = PDFParser._sort_visual_line_order(
                col, lambda b: b["y0"], lambda b: b["y1"], lambda b: b["x0"]
            )

        # ── 步骤 5：无全宽块 → 各栏顺序展开（左→右）────────────────
        if not full_width_blocks:
            flat: List[Dict] = []
            for col in columns:
                flat.extend(col)
            return flat

        # ── 步骤 6：有全宽块 → 归并插回 ──────────────────────────────
        # 正确策略：以每个全宽块为分隔符，将各栏中位于该分隔符之前的所有块
        # 按栏顺序（左→右）全部输出后，再插入全宽块。
        # 这避免了逐行交织双栏内容的问题。
        full_width_sorted = sorted(full_width_blocks, key=lambda b: b["y0"])
        final_order: List[Dict] = []
        col_indices = [0] * len(columns)
        fw_idx = 0

        while fw_idx < len(full_width_sorted):
            fw_y = full_width_sorted[fw_idx]["y0"]
            # 先按栏顺序输出所有 y0 < fw_y 的栏内块
            for ci in range(len(columns)):
                while col_indices[ci] < len(columns[ci]) and columns[ci][col_indices[ci]]["y0"] < fw_y:
                    final_order.append(columns[ci][col_indices[ci]])
                    col_indices[ci] += 1
            # 插入全宽块
            final_order.append(full_width_sorted[fw_idx])
            fw_idx += 1

        # 输出所有剩余栏内块
        for ci in range(len(columns)):
            while col_indices[ci] < len(columns[ci]):
                final_order.append(columns[ci][col_indices[ci]])
                col_indices[ci] += 1

        return final_order

    def _generate_thumbnails(self, file_path: str, book_id: str) -> None:
        """
        为 PDF 所有页面生成缩略图。

        Args:
            file_path: PDF 文件路径
            book_id: 书籍 ID
        """
        try:
            from ..models.database import UPLOADS_DIR

            thumbnail_service = ThumbnailService(UPLOADS_DIR)
            thumbnail_service.generate_thumbnails(file_path, book_id, resolution=100)
        except Exception as e:
            logger.error(f"Failed to generate thumbnails: {e}")
