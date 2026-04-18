"""书签管理 API 路由"""

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from sqlalchemy import text
import logging

from ..models.database import get_db
from ..services.extraction_service import run_example_extraction_task

router = APIRouter(prefix="/api/vocabulary_snippet", tags=["vocabulary_snippet"])
logger = logging.getLogger(__name__)


@router.post("/{vocab_id}/extract_examples")
def extract_examples_manual(vocab_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """
    手动触发例句提取任务
    """
    try:
        vocab = db.execute(text("SELECT word FROM vocabulary WHERE id = :id"), {"id": vocab_id}).fetchone()

        if not vocab:
            raise HTTPException(status_code=404, detail="Vocabulary not found")

        word = vocab[0]

        # Add to background tasks
        background_tasks.add_task(run_example_extraction_task, word)

        return {"status": "success", "message": f"Example extraction started for '{word}'"}

    except Exception as e:
        logger.error(f"Error triggering manual extraction: {e}")
        raise HTTPException(status_code=500, detail=str(e))
