"""
StockSense AI — Model Inference API Routes
Endpoints for single-horizon and multi-horizon directional model predictions,
probabilistic calibration distributions, and active model registry introspection.
"""

from fastapi import APIRouter, HTTPException, Request, Depends, status

from app.schemas.inference import (
    PredictRequest,
    PredictResponse,
    MultiHorizonPredictRequest,
    MultiHorizonPredictResponse,
    ActiveModelsResponse,
)
from app.services.inference import (
    InferenceService,
    InferenceError,
    ModelNotLoadedError,
)
from app.services.registry import (
    ArtifactNotFoundError,
    ArtifactIntegrityError,
    IncompatibleFeatureError,
)
from app.services.splitting import QuarantinedTestDataLeakageError
from app.services.telemetry import ml_telemetry

router = APIRouter(tags=["Model Inference"])

_default_inference_service: InferenceService = InferenceService()


def get_inference_service(request: Request) -> InferenceService:
    """Dependency provider returning the pre-warmed application-level InferenceService."""
    if hasattr(request.app.state, "inference_service") and request.app.state.inference_service is not None:
        return request.app.state.inference_service
    return _default_inference_service


@router.post(
    "/predict",
    response_model=PredictResponse,
    status_code=status.HTTP_200_OK,
    summary="Generate Directional Prediction (Single Horizon)",
)
async def predict_endpoint(
    request: PredictRequest,
    service: InferenceService = Depends(get_inference_service),
) -> PredictResponse:
    """
    Generates a directional forecast {-1 (DOWN), 0 (NEUTRAL), +1 (UP)} with calibrated probabilities
    for a single trading horizon (h=1, 3, or 5 days).

    Accepts either:
    - Raw daily OHLCV candles (minimum 200 bars for technical feature calculation)
    - Pre-engineered 23 technical features matching the approved schema
    """
    try:
        resp = service.predict(request)
        ml_telemetry.record_inference(
            resp.model_id,
            resp.horizon,
            "success",
            resp.execution_time_ms / 1000.0,
        )
        return resp
    except (ValueError, IncompatibleFeatureError) as val_err:
        ml_telemetry.record_inference("unknown", request.horizon, "validation_error", 0.0)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(val_err),
        )
    except QuarantinedTestDataLeakageError as q_err:
        ml_telemetry.record_inference("unknown", request.horizon, "quarantine_violation", 0.0)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Quarantined test partition violation: {q_err}",
        )
    except ModelNotLoadedError as m_err:
        ml_telemetry.record_inference("unknown", request.horizon, "not_loaded", 0.0)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(m_err),
        )
    except (ArtifactNotFoundError, ArtifactIntegrityError) as art_err:
        ml_telemetry.record_inference("unknown", request.horizon, "integrity_error", 0.0)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(art_err),
        )
    except Exception as exc:
        ml_telemetry.record_inference("unknown", request.horizon, "error", 0.0)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Inference execution failure: {str(exc)}",
        )


@router.post(
    "/predict/multi-horizon",
    response_model=MultiHorizonPredictResponse,
    status_code=status.HTTP_200_OK,
    summary="Generate Multi-Horizon Directional Predictions (h=1, 3, 5)",
)
async def predict_multi_horizon_endpoint(
    request: MultiHorizonPredictRequest,
    service: InferenceService = Depends(get_inference_service),
) -> MultiHorizonPredictResponse:
    """
    Generates concurrent directional forecasts across all three approved horizons (h=1, 3, and 5)
    for an equity. Optimizes execution by extracting technical features once.
    """
    try:
        resp = service.predict_multi_horizon(request)
        for h, pred in resp.predictions.items():
            ml_telemetry.record_inference(
                pred.model_id,
                pred.horizon,
                "success",
                resp.total_execution_time_ms / 1000.0,
            )
        return resp
    except (ValueError, IncompatibleFeatureError) as val_err:
        ml_telemetry.record_inference("unknown", 0, "validation_error", 0.0)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(val_err),
        )
    except QuarantinedTestDataLeakageError as q_err:
        ml_telemetry.record_inference("unknown", 0, "quarantine_violation", 0.0)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Quarantined test partition violation: {q_err}",
        )
    except ModelNotLoadedError as m_err:
        ml_telemetry.record_inference("unknown", 0, "not_loaded", 0.0)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(m_err),
        )
    except (ArtifactNotFoundError, ArtifactIntegrityError) as art_err:
        ml_telemetry.record_inference("unknown", 0, "integrity_error", 0.0)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(art_err),
        )
    except Exception as exc:
        ml_telemetry.record_inference("unknown", 0, "error", 0.0)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Multi-horizon inference execution failure: {str(exc)}",
        )


@router.get(
    "/models/active",
    response_model=ActiveModelsResponse,
    status_code=status.HTTP_200_OK,
    summary="Introspect Active Model Champions",
)
@router.get(
    "/predict/models",
    response_model=ActiveModelsResponse,
    status_code=status.HTTP_200_OK,
    summary="Introspect Active Champion Models Routing Manifest",
)
async def get_active_models_endpoint(
    service: InferenceService = Depends(get_inference_service),
) -> ActiveModelsResponse:
    """
    Returns the active champion model manifest detailing promoted model IDs,
    target horizons, classification thresholds, validation metrics, and cryptographic SHA-256 digests.
    """
    try:
        return service.get_active_models_manifest()
    except ArtifactNotFoundError as enf:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(enf),
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to retrieve active champion manifest: {str(exc)}",
        )
