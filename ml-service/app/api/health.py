from fastapi import APIRouter
from app.config import settings
import time

router = APIRouter(tags=["Health"])

START_TIME = time.time()


@router.get("/health")
async def health_check():
    return {
        "status": "UP",
        "service": "stocksense-ml-service",
        "version": settings.version,
        "environment": settings.env,
        "uptime_seconds": round(time.time() - START_TIME, 2),
        "engine": "FastAPI / Python",
    }
