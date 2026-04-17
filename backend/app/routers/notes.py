"""笔记管理 API 路由"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import Optional, List
from pydantic import BaseModel
from ..models.database import get_db
from ..models.models import Note, Book

router = APIRouter(prefix="/api/notes", tags=["notes"])


class NoteCreate(BaseModel):
    """创建笔记请求"""
    book_id: str
    page_number: int
    highlighted_text: str
    comment: Optional[str] = ""
    color: Optional[str] = "#fef08a"


class NoteUpdate(BaseModel):
    """更新笔记评论"""
    comment: str


class NoteResponse(BaseModel):
    """笔记响应"""
    id: int
    book_id: str
    page_number: int
    highlighted_text: str
    comment: str
    color: str
    created_at: str

    class Config:
        from_attributes = True


def _format(note: Note) -> NoteResponse:
    return NoteResponse(
        id=note.id,  # type: ignore
        book_id=note.book_id,  # type: ignore
        page_number=note.page_number,  # type: ignore
        highlighted_text=note.highlighted_text,  # type: ignore
        comment=note.comment or "",  # type: ignore
        color=note.color or "#fef08a",  # type: ignore
        created_at=note.created_at.isoformat() if note.created_at else "",  # type: ignore
    )


@router.post("/", response_model=NoteResponse, status_code=201)
def create_note(item: NoteCreate, db: Session = Depends(get_db)):
    """创建划线笔记"""
    book = db.query(Book).filter(Book.id == item.book_id).first()
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")

    note = Note(
        book_id=item.book_id,
        page_number=item.page_number,
        highlighted_text=item.highlighted_text,
        comment=item.comment or "",
        color=item.color or "#fef08a",
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return _format(note)


@router.get("/", response_model=List[NoteResponse])
def get_notes(book_id: Optional[str] = None, db: Session = Depends(get_db)):
    """获取笔记列表（可按书籍过滤）"""
    query = db.query(Note)
    if book_id:
        query = query.filter(Note.book_id == book_id)
    notes = query.order_by(Note.created_at.desc()).all()
    return [_format(n) for n in notes]


@router.patch("/{note_id}", response_model=NoteResponse)
def update_note(note_id: int, item: NoteUpdate, db: Session = Depends(get_db)):
    """更新笔记评论"""
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    note.comment = item.comment  # type: ignore
    db.commit()
    db.refresh(note)
    return _format(note)


@router.delete("/{note_id}")
def delete_note(note_id: int, db: Session = Depends(get_db)):
    """删除笔记"""
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    db.delete(note)
    db.commit()
    return {"status": "success"}
