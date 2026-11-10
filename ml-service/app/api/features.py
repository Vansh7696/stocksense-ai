"""
StockSense AI — Feature Engineering API Routes
Endpoints for generating stationary, normalized ML features from OHLCV series.
"""

from fastapi import APIRouter, HTTPException, status
from app.schemas.market_data import (
    FeatureEngineerRequest,
    FeatureEngineerResponse,
)
from app.services.features import FeatureEngineeringPipeline

router = APIRouter(prefix="/features", tags=["Feature Engineering"])


@router.post(
    "/engineer",
    response_model=FeatureEngineerResponse,
    status_code=status.HTTP_200_OK,
    summary="Extract ML Features from Candlestick Data",
)
async def engineer_features(request: FeatureEngineerRequest) -> FeatureEngineerResponse:
    """
    Transforms raw OHLCV candlestick series into an analytical ML feature matrix:
    - Price relative to SMAs (20, 50, 200) and EMAs (12, 26, 50)
    - Normalized RSI and 5-day RSI momentum
    - Normalized MACD histogram (relative to close)
    - Bollinger Band position (%B, z-score, bandwidth)
    - ATR percentage (volatility scaled to price)
    - Multi-horizon percentage returns (1-day, 5-day, 21-day)
    - Rolling 20-day annualized volatility
    - Relative volume (volume / 20-day volume SMA)
    - Trend alignment and MA spread features

    Strictly separated from ML model training.
    """
    if not request.candles:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Candle dataset must not be empty.",
        )

    try:
        config_dict = request.config.model_dump() if request.config else {}
        pipeline = FeatureEngineeringPipeline(config_dict)
        res = pipeline.extract_features(request.candles, drop_na=request.drop_na)

        return FeatureEngineerResponse(
            symbol=request.symbol or "UNKNOWN",
            total_rows=res["total_rows"],
            feature_count=res["feature_count"],
            feature_names=res["feature_names"],
            features=res["features"],
            metadata=res["metadata"],
        )
    except ValueError as val_err:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(val_err),
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Feature extraction error: {str(exc)}",
        )
