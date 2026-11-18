"""
StockSense AI — Technical Pattern & Breakout API Endpoints
Provides candlestick pattern recognition, S/R zone clustering, and breakout momentum detection.
"""

from typing import List, Dict, Any, Optional
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.schemas.patterns import TechnicalAnalysisResponse
from app.services.patterns import TechnicalPatternAnalyzer


router = APIRouter(
    prefix="/api/patterns",
    tags=["Technical Patterns"],
)


class AnalyzePatternsRequest(BaseModel):
    candles: List[Dict[str, Any]] = Field(..., description="Array of historical OHLCV candle dictionaries")
    symbol: Optional[str] = Field(None, description="Ticker symbol or instrument identifier")


@router.post(
    "/analyze",
    response_model=TechnicalAnalysisResponse,
    summary="Detect candlestick patterns, S/R zones, and breakout signals",
    description=(
        "Analyzes historical OHLCV candles to detect classical Japanese candlestick patterns "
        "(Hammer, Engulfing, Morning/Evening Star, Doji, etc.), cluster local extrema into "
        "support and resistance levels, and identify momentum/Donchian breakouts."
    ),
)
async def analyze_technical_patterns(payload: AnalyzePatternsRequest):
    if not payload.candles:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one historical OHLCV candle is required for technical analysis.",
        )

    try:
        result = TechnicalPatternAnalyzer.analyze(
            candles=payload.candles,
            symbol=payload.symbol,
        )
        return result
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Technical pattern analysis failed: {str(exc)}",
        )
