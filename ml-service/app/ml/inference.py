"""
StockSense AI — Model Inference ML Interface
Programmatic interface for high-performance model inference.
"""

from app.services.inference import (
    InferenceService,
    InferenceError,
    ModelNotLoadedError,
)
from app.schemas.inference import (
    DirectionalClass,
    PredictRequest,
    PredictResponse,
    MultiHorizonPredictRequest,
    MultiHorizonPredictResponse,
    ActiveModelDescriptor,
    ActiveModelsResponse,
)

__all__ = [
    "InferenceService",
    "InferenceError",
    "ModelNotLoadedError",
    "DirectionalClass",
    "PredictRequest",
    "PredictResponse",
    "MultiHorizonPredictRequest",
    "MultiHorizonPredictResponse",
    "ActiveModelDescriptor",
    "ActiveModelsResponse",
]
