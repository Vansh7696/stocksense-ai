"""
StockSense AI — Technical Indicators API Routes
Endpoints for computing the 10 required technical indicators on OHLCV series.
"""

from fastapi import APIRouter, HTTPException, status
from app.schemas.market_data import (
    IndicatorComputeRequest,
    IndicatorComputeResponse,
    IndicatorSeries,
)
from app.services.indicators import TechnicalAnalysisEngine

router = APIRouter(prefix="/indicators", tags=["Technical Indicators"])


@router.post(
    "/compute",
    response_model=IndicatorComputeResponse,
    status_code=status.HTTP_200_OK,
    summary="Compute Technical Indicators on OHLCV Candlestick Data",
)
async def compute_indicators(request: IndicatorComputeRequest) -> IndicatorComputeResponse:
    """
    Computes 10 standard technical indicators on the submitted candlestick series:
    - SMA (20, 50, 200)
    - EMA (12, 26, 50)
    - RSI (14 periods, Wilder's smoothing)
    - MACD (12, 26, 9)
    - Bollinger Bands (20 periods, 2 std dev)
    - ATR (14 periods)
    - Daily percentage returns
    - Rolling volatility (20 periods, annualized)
    - Volume moving average (20 periods)
    - Relative volume (RVOL)

    Avoids look-ahead bias and handles warm-up periods explicitly.
    """
    if not request.candles:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Candle dataset must not be empty.",
        )

    try:
        config_dict = request.config.model_dump() if request.config else {}
        engine = TechnicalAnalysisEngine(config_dict)
        res = engine.compute(request.candles)

        return IndicatorComputeResponse(
            symbol=request.symbol or "UNKNOWN",
            total_candles=res["total_candles"],
            warmup_status=res["warmup_status"],
            indicators=IndicatorSeries(**res["indicators"]),
            latest=res["latest"],
            metadata={
                "max_period_needed": res["max_period_needed"],
                "config": config_dict,
            },
        )
    except ValueError as val_err:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(val_err),
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Indicator calculation error: {str(exc)}",
        )
