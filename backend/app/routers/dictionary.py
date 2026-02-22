from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session
from pydantic import BaseModel
from ..models.database import get_db
from ..services import dict_service, open_dict_service

router = APIRouter(prefix="/api/dict", tags=["dictionary"])


@router.get("/{word}/sources")
def check_sources(word: str):
    """Check availability of word in different dictionaries"""
    # Debug log
    sources = dict_service.get_word_sources(word)
    return sources


@router.get("/{word}")
def get_definition(word: str, source: Optional[str] = None, db: Session = Depends(get_db)):
    # 注意: source 为 None 时触发多词典模式, 空字符串则不会
    # 所以这里不能用 source or "", 必须保持 None
    result = dict_service.lookup_word(db, word, source)
    if not result:
        raise HTTPException(status_code=404, detail="Word not found")
    return result


@router.get("/{word}/examples")
def get_word_examples(word: str):
    """Get example sentences from open source database (Tatoeba)"""
    examples = open_dict_service.get_examples_open(word)
    return {"word": word, "examples": examples}


class TranslationRequest(BaseModel):
    text: str


@router.post("/translate")
def translate_text_endpoint(req: TranslationRequest):
    from ..services import supplier_factory

    try:
        print(f"[DEBUG translate_text] Received: text='{req.text}'")
        translation = supplier_factory.translate_with_active_supplier(req.text)
        print(f"[DEBUG translate_text] Result: {repr(translation)}")
        if not translation:
             raise HTTPException(status_code=500, detail="Translation returned empty")
        return {"translation": translation}
    except Exception as e:
        print(f"[DEBUG translate_text] Exception: {type(e).__name__}: {e}")
        raise HTTPException(status_code=500, detail=f"Translation failed: {str(e)}")
