"""
test_pdf_parser_columns.py

验证 PDFParser._detect_columns 的多栏检测与全宽块插回逻辑。
不依赖真实 PDF 文件，直接构造 blocks_info 数据。
"""

import pytest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.parsers.pdf_parser import PDFParser


def make_block(x0: float, y0: float, x1: float, y1: float, text_len: int = 50) -> dict:
    """构造一个最小的 block_info 字典，text_len 控制显著性（>= 6 即显著）。"""
    chars = [{"c": "a", "bbox": [x0, y0, x0 + 5, y1]}] * text_len
    span = {"chars": chars, "bbox": [x0, y0, x1, y1]}
    line = {"spans": [span]}
    block = {"type": 0, "bbox": [x0, y0, x1, y1], "lines": [line]}
    return {
        "block": block,
        "x0": x0,
        "y0": y0,
        "x1": x1,
        "y1": y1,
        "center_x": (x0 + x1) / 2,
    }


PAGE_W = 600.0


class TestDetectColumns:

    def setup_method(self):
        self.parser = PDFParser()

    # ── 单栏 ──────────────────────────────────────────────────────────

    def test_single_column_sorted_by_y(self):
        """单栏页面应按 y0 升序返回。"""
        blocks = [
            make_block(50, 300, 550, 330),
            make_block(50, 100, 550, 130),
            make_block(50, 200, 550, 230),
        ]
        result = self.parser._detect_columns(blocks, PAGE_W)
        assert isinstance(result, list)
        assert all(isinstance(b, dict) for b in result)
        ys = [b["y0"] for b in result]
        assert ys == sorted(ys), f"单栏应按 y0 升序，实际: {ys}"

    def test_empty_blocks(self):
        """空输入应返回空列表。"""
        assert self.parser._detect_columns([], PAGE_W) == []

    def test_single_block(self):
        """只有一个块时直接返回。"""
        b = make_block(50, 100, 550, 130)
        result = self.parser._detect_columns([b], PAGE_W)
        assert result == [b]

    # ── 双栏（无全宽块）────────────────────────────────────────────────

    def test_double_column_left_before_right(self):
        """
        双栏布局：左栏应全部在右栏之前输出。
        构造：左栏 3 行（y=100/200/300），右栏 3 行（y=100/200/300）
        期望顺序：左栏 100→200→300，右栏 100→200→300
        """
        # 左栏：x 中心 ~150，右栏：x 中心 ~450
        left_col = [
            make_block(50,  100, 270, 130),
            make_block(50,  200, 270, 230),
            make_block(50,  300, 270, 330),
        ]
        right_col = [
            make_block(330, 100, 550, 130),
            make_block(330, 200, 550, 230),
            make_block(330, 300, 550, 330),
        ]
        blocks = left_col + right_col
        result = self.parser._detect_columns(blocks, PAGE_W)

        # 结果应是扁平列表
        assert len(result) == 6

        # 找左/右各自的 y 序列
        left_results  = [b for b in result if b["center_x"] < PAGE_W / 2]
        right_results = [b for b in result if b["center_x"] >= PAGE_W / 2]

        # 左栏全部应先于右栏
        left_indices  = [result.index(b) for b in left_results]
        right_indices = [result.index(b) for b in right_results]
        assert max(left_indices) < min(right_indices), \
            "左栏所有块应出现在右栏所有块之前"

        # 各栏内部应按 y0 升序
        left_ys  = [b["y0"] for b in left_results]
        right_ys = [b["y0"] for b in right_results]
        assert left_ys  == sorted(left_ys),  f"左栏内应按 y0 升序，实际: {left_ys}"
        assert right_ys == sorted(right_ys), f"右栏内应按 y0 升序，实际: {right_ys}"

    # ── 双栏 + 全宽块 ─────────────────────────────────────────────────

    def test_full_width_block_inserted_at_correct_position(self):
        """
        全宽块（跨栏标题）应按 y0 插回正确位置。
        布局：
          y=50  全宽标题
          y=100 左栏正文 A
          y=100 右栏正文 B
          y=200 左栏正文 C
          y=200 右栏正文 D
          y=250 全宽图注
          y=300 左栏正文 E
          y=300 右栏正文 F

        期望读序：标题 → A → C → B → D → 图注 → E → F
        （左栏全部先于右栏，全宽块按 y 插入）

        实际上算法实现：无全宽块时左栏顺序展开+右栏；有全宽块时用归并。
        此测试仅验证：
        - 全宽标题（y=50）出现在左/右栏所有块之前
        - 全宽图注（y=250）出现在 y<=200 的栏块之后、y>=300 的栏块之前
        """
        title  = make_block(0,   50,  600, 80)   # 全宽
        lA     = make_block(50,  100, 270, 130)
        rB     = make_block(330, 100, 550, 130)
        lC     = make_block(50,  200, 270, 230)
        rD     = make_block(330, 200, 550, 230)
        caption = make_block(0,  250, 600, 280)   # 全宽
        lE     = make_block(50,  300, 270, 330)
        rF     = make_block(330, 300, 550, 330)

        blocks = [lA, rB, lC, rD, lE, rF, title, caption]
        result = self.parser._detect_columns(blocks, PAGE_W)

        assert len(result) == 8

        idx = {id(b): i for i, b in enumerate(result)}

        # 全宽标题排在最前
        assert idx[id(title)] == 0, \
            f"全宽标题应排第 0 位，实际: {idx[id(title)]}"

        # 全宽图注应在 y=200 的块之后、y=300 的块之前
        cap_idx = idx[id(caption)]
        for b in [lC, rD]:
            assert idx[id(b)] < cap_idx, \
                f"y=200 的块应在图注之前，实际顺序 {idx[id(b)]} vs {cap_idx}"
        for b in [lE, rF]:
            assert idx[id(b)] > cap_idx, \
                f"y=300 的块应在图注之后，实际顺序 {idx[id(b)]} vs {cap_idx}"

    def test_noise_blocks_not_create_false_column(self):
        """
        页脚噪声块（字符数 < 20）不应触发分栏检测。
        """
        # 页面左侧一个噪声块（字符数 = 5）
        noise = make_block(10, 800, 80, 820, text_len=5)
        # 正常正文块分布在中心两侧（但字符数足够才显著）
        col1 = make_block(50, 100, 270, 130, text_len=80)
        col2 = make_block(330, 100, 550, 130, text_len=80)
        col3 = make_block(50, 200, 270, 230, text_len=80)
        col4 = make_block(330, 200, 550, 230, text_len=80)

        # 只有 col1~col4 触发双栏，noise 不干扰
        blocks = [noise, col1, col2, col3, col4]
        result = self.parser._detect_columns(blocks, PAGE_W)

        # 左栏应全部先于右栏
        left_r  = [b for b in result if b["center_x"] < PAGE_W / 2 and b is not noise]
        right_r = [b for b in result if b["center_x"] >= PAGE_W / 2 and b is not noise]
        if left_r and right_r:
            left_max  = max(result.index(b) for b in left_r)
            right_min = min(result.index(b) for b in right_r)
            assert left_max < right_min, "噪声块不应破坏双栏顺序"

    # ── 行内字符重建 ─────────────────────────────────────────────────────

    def test_extract_line_text_and_words_merges_multiple_spans_in_order(self):
        line = {
            "spans": [
                {
                    "chars": [
                        {"c": "H", "bbox": [10, 10, 18, 22]},
                        {"c": "e", "bbox": [18, 10, 25, 22]},
                    ]
                },
                {
                    "chars": [
                        {"c": "l", "bbox": [25, 10, 29, 22]},
                        {"c": "l", "bbox": [29, 10, 33, 22]},
                        {"c": "o", "bbox": [33, 10, 41, 22]},
                    ]
                },
                {
                    "chars": [
                        {"c": "W", "bbox": [52, 10, 63, 22]},
                        {"c": "o", "bbox": [63, 10, 71, 22]},
                        {"c": "r", "bbox": [71, 10, 77, 22]},
                        {"c": "l", "bbox": [77, 10, 81, 22]},
                        {"c": "d", "bbox": [81, 10, 89, 22]},
                    ]
                },
            ]
        }

        text, words = self.parser._extract_line_text_and_words(line, block_idx=3)

        assert text == "Hello World"
        assert [word["text"] for word in words] == ["Hello", "World"]
        assert all(word["block_id"] == 3 for word in words)

    def test_extract_line_text_and_words_keeps_punctuation_without_extra_space(self):
        line = {
            "spans": [
                {
                    "chars": [
                        {"c": "H", "bbox": [10, 10, 18, 22]},
                        {"c": "i", "bbox": [18, 10, 21, 22]},
                        {"c": ",", "bbox": [26, 10, 29, 22]},
                        {"c": "!", "bbox": [34, 10, 37, 22]},
                    ]
                }
            ]
        }

        text, words = self.parser._extract_line_text_and_words(line)

        assert text == "Hi,!"
        assert [word["text"] for word in words] == ["Hi,!"]

    def test_short_blocks_still_detect_double_columns(self):
        left_col = [
            make_block(50, 100, 180, 130, text_len=8),
            make_block(50, 200, 180, 230, text_len=8),
        ]
        right_col = [
            make_block(330, 100, 470, 130, text_len=9),
            make_block(330, 200, 470, 230, text_len=9),
        ]

        result = self.parser._detect_columns(left_col + right_col, PAGE_W)

        left_results = [b for b in result if b["center_x"] < PAGE_W / 2]
        right_results = [b for b in result if b["center_x"] >= PAGE_W / 2]
        assert max(result.index(b) for b in left_results) < min(result.index(b) for b in right_results)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
