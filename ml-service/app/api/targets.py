"""
StockSense AI — Target Labeling API Routes
Endpoints for generating multi-horizon executable target labels from OHLCV series.
"""

from fastapi import APIRouter, HTTPException, status
from app.schemas.targets import (
    TargetGenerateRequest,
    TargetGenerateResponse,
)
from app.services.targets import TargetService

router = APIRouter(prefix="/targets", tags=["Target Labeling"])


@router.post(
    "/generate",
    response_model=TargetGenerateResponse,
    status_code=status.HTTP_200_OK,
    summary="Generate Multi-Horizon Executable Target Labels",
)
async def generate_targets_endpoint(request: TargetGenerateRequest) -> TargetGenerateResponse:
    """
    Computes multi-horizon forward returns and discrete 3-class target labels:
    - Executable return: R(t, h) = ((C[t+h] - O[t+1]) / O[t+1]) * 100
    - Thresholds: h=1 (+/-0.50%), h=3 (+/-1.00%), h=5 (+/-1.50%)
    - Classes: DOWN (< -theta), NEUTRAL ([-theta, +theta]), UP (> +theta)

    Enforces zero look-ahead bias and strict data validity.
    """
    if not request.candles or len(request.candles) < 2:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Candle dataset must contain at least 2 chronological records to evaluate targets.",
        )

    if not request.expected_sessions:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="An explicitly verified expected_sessions calendar is required to generate target labels safely and prevent silent trading session bridging.",
        )

    try:
        service = TargetService()
        result = service.generate(
            candles=request.candles,
            symbol=request.symbol or "UNKNOWN",
            stock_id=request.stock_id,
            exchange_id=request.exchange_id or "NSE",
            horizons=request.horizons,
            target_type=request.target_type,
            thresholds=request.thresholds,
            expected_sessions=request.expected_sessions,
            validate_intermediate=request.validate_intermediate,
        )

        return TargetGenerateResponse(
            symbol=result.symbol,
            stock_id=result.stock_id,
            exchange_id=result.exchange_id,
            total_candles=len(request.candles),
            total_signals_evaluated=result.metadata.get("total_signals_evaluated", 0),
            total_targets_generated=result.total_targets,
            total_exclusions=result.total_exclusions,
            targets=result.targets,
            exclusions=result.exclusions,
            metadata=result.metadata,
        )
    except ValueError as val_err:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(val_err),
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Target generation error: {str(exc)}",
        )
