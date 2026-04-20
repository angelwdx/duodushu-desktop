from pathlib import Path
from .base import BaseParser
from .pdf_parser import PDFParser
from .epub_parser import EPUBParser
from .txt_parser import TXTParser


class ParserFactory:
    @staticmethod
    def get_parser(file_path: str) -> BaseParser:
        ext = Path(file_path).suffix.lower()

        if ext == ".pdf":
            return PDFParser()
        elif ext == ".epub":
            return EPUBParser()
        elif ext == ".txt":
            return TXTParser()
        else:
            raise ValueError(f"Unsupported file format: {ext}")
