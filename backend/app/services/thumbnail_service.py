import os
import pdfplumber
from typing import Optional
from pathlib import Path


class ThumbnailService:
    """Service for generating and managing PDF page thumbnails"""

    def __init__(self, uploads_dir: Path):
        self.uploads_dir = uploads_dir  # 直接使用 UPLOADS_DIR

    def get_thumbnails_dir(self, book_id: str) -> Path:
        """Get thumbnails directory for a specific book"""
        # 使用 uploads_dir 而不是 base_dir
        thumbnails_dir = self.uploads_dir / "thumbnails" / book_id
        thumbnails_dir.mkdir(parents=True, exist_ok=True)
        return thumbnails_dir

    def generate_thumbnails(self, pdf_path: str, book_id: str, resolution: int = 150) -> Optional[bool]:
        """
        Generate thumbnails for all pages of a PDF

        Args:
            pdf_path: Path to the PDF file
            book_id: Unique identifier for the book
            resolution: Image resolution in DPI (default: 150)

        Returns:
            True if successful, None if failed
        """
        try:
            thumbnails_dir = self.get_thumbnails_dir(book_id)

            with pdfplumber.open(pdf_path) as pdf:
                total_pages = len(pdf.pages)

                for i, page in enumerate(pdf.pages):
                    page_num = i + 1
                    thumbnail_filename = f"page_{page_num}.png"
                    thumbnail_path = thumbnails_dir / thumbnail_filename

                    # Skip if thumbnail already exists
                    if thumbnail_path.exists():
                        continue

                    # Generate thumbnail
                    try:
                        im = page.to_image(resolution=resolution)
                        im.save(str(thumbnail_path), format="PNG")
                        print(f"Generated thumbnail for page {page_num}/{total_pages}")
                    except Exception as e:
                        print(f"Failed to generate thumbnail for page {page_num}: {e}")
                        continue

            print(f"Thumbnail generation complete for book {book_id}")
            return True

        except Exception as e:
            print(f"Error generating thumbnails for book {book_id}: {e}")
            return None

    def get_thumbnail_path(self, book_id: str, page_number: int) -> Optional[str]:
        """
        Get relative path to a thumbnail image

        Args:
            book_id: Unique identifier for book
            page_number: Page number (1-indexed)

        Returns:
            Relative path from uploads directory or None if not found
        """
        thumbnail_filename = f"page_{page_number}.png"
        relative_path = f"thumbnails/{book_id}/{thumbnail_filename}"

        # Check if file exists
        full_path = self.uploads_dir / relative_path
        if full_path.exists():
            return f"uploads/{relative_path}"

        return None

    def delete_thumbnails(self, book_id: str):
        """
        Delete all thumbnails for a book

        Args:
            book_id: Unique identifier for the book
        """
        try:
            thumbnails_dir = self.get_thumbnails_dir(book_id)
            if thumbnails_dir.exists():
                import shutil

                shutil.rmtree(thumbnails_dir)
                print(f"Deleted thumbnails for book {book_id}")
        except Exception as e:
            print(f"Error deleting thumbnails for book {book_id}: {e}")
