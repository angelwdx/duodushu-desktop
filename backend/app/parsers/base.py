from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional

class BaseParser(ABC):
    @abstractmethod
    def parse(self, file_path: str, book_id: str) -> Dict[str, Any]:
        """
        解析文档，返回书籍元数据和页面内容。
        
        Args:
            file_path: 文档绝对路径
            book_id: 书籍ID

        Returns:
            Dict containing:
            - title: str
            - author: str
            - total_pages: int
            - language: str
            - pages: List[Dict] (page_number, text_content, words_data, images)
            - cover_image: str (path)
        """
        pass
