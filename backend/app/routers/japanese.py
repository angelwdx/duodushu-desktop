from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.services.japanese_text_service import annotate_japanese_texts

router = APIRouter(prefix="/api/japanese", tags=["japanese"])

MAX_BATCH_ITEMS = 200
MAX_BATCH_CHARS = 30000


class FuriganaBatchRequest(BaseModel):
    texts: list[str] = Field(default_factory=list)


@router.post("/furigana")
def generate_furigana(req: FuriganaBatchRequest, db: Session = Depends(get_db)):
    if not req.texts:
        return {"items": []}

    if len(req.texts) > MAX_BATCH_ITEMS:
        raise HTTPException(status_code=400, detail="Too many texts in one request")

    total_chars = sum(len(text or "") for text in req.texts)
    if total_chars > MAX_BATCH_CHARS:
        raise HTTPException(status_code=400, detail="Total text size is too large")

    return {"items": annotate_japanese_texts(req.texts, db)}
