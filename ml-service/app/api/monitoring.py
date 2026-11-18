"""
StockSense AI — Model Monitoring & Feature Drift API Endpoints
"""

from typing import Dict, List, Any
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.drift_monitoring import drift_monitor
from app.services.telemetry import ml_telemetry

router = APIRouter(prefix="/api/monitoring", tags=["Model Monitoring & Drift Detection"])


class DriftAnalysisRequest(BaseModel):
    features: Dict[str, List[float]] = Field(
        ...,
        description="Dictionary mapping feature names to arrays of current observation values.",
        json_schema_extra={
            "example": {
                "rsi_14": [48.5, 51.2, 53.0, 49.8],
                "price_to_sma20": [0.012, 0.015, -0.005, 0.008],
            }
        },
    )


@router.post("/drift/analyze", summary="Analyze Batch Feature Drift & Data Quality")
async def analyze_feature_drift(payload: DriftAnalysisRequest) -> Dict[str, Any]:
    """
    Computes Population Stability Index (PSI), two-sample Kolmogorov-Smirnov test,
    missing-value metrics, and range validation against calibrated baselines.
    """
    if not payload.features:
        raise HTTPException(status_code=400, detail="Features dictionary cannot be empty.")

    try:
        results = drift_monitor.analyze_batch(payload.features)
        return {"status": "success", "data": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to analyze feature drift: {str(e)}")


@router.get("/drift/status", summary="Get Current Feature Drift Telemetry Snapshot")
async def get_drift_status() -> Dict[str, Any]:
    """
    Returns the latest recorded feature drift metrics across all monitored features.
    """
    return {
        "status": "success",
        "drift_telemetry": ml_telemetry.drift_metrics,
    }
