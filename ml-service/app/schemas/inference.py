"""
StockSense AI — Model Inference Schemas
Pydantic V2 models for single-horizon and multi-horizon prediction requests/responses,
probabilistic calibration guarantees, and active model registry descriptors.
"""

from enum import Enum
import math
from typing import Dict, List, Optional, Any
from pydantic import BaseModel, Field, ConfigDict, model_validator

from app.schemas.market_data import CandleInput
from app.services.splitting import APPROVED_FEATURE_ALLOWLIST


class DirectionalClass(str, Enum):
    """Canonical 3-class directional movement targets."""
    DOWN = "DOWN"
    NEUTRAL = "NEUTRAL"
    UP = "UP"


CLASS_INT_TO_LABEL: Dict[int, DirectionalClass] = {
    -1: DirectionalClass.DOWN,
    0: DirectionalClass.NEUTRAL,
    1: DirectionalClass.UP,
}

CLASS_LABEL_TO_INT: Dict[DirectionalClass, int] = {
    DirectionalClass.DOWN: -1,
    DirectionalClass.NEUTRAL: 0,
    DirectionalClass.UP: 1,
}


class PredictRequest(BaseModel):
    """
    Single-horizon directional inference request.
    Requires either raw OHLCV candles (minimum 200 bars for technical feature warm-up)
    or pre-engineered 23 technical features.
    """
    model_config = ConfigDict(extra="forbid")

    symbol: str = Field(..., min_length=1, description="NSE equity ticker symbol (e.g. 'RELIANCE')")
    horizon: int = Field(..., description="Forecast horizon in trading days (must be 1, 3, or 5)")
    candles: Optional[List[CandleInput]] = Field(
        default=None,
        description="Historical daily OHLCV candles (minimum 200 trading sessions for indicator warm-up)",
    )
    features: Optional[Dict[str, float]] = Field(
        default=None,
        description="Precomputed 23-feature dictionary matching the approved technical feature schema",
    )
    model_override_id: Optional[str] = Field(
        default=None,
        description="Optional registered model_id override (e.g. for benchmark comparison)",
    )

    @model_validator(mode="after")
    def validate_inputs(self) -> "PredictRequest":
        if self.horizon not in (1, 3, 5):
            raise ValueError(f"Forecast horizon must be 1, 3, or 5 trading days (received {self.horizon})")

        has_candles = bool(self.candles and len(self.candles) > 0)
        has_features = bool(self.features and len(self.features) > 0)

        if not has_candles and not has_features:
            raise ValueError("Inference request must provide either 'candles' or 'features'.")
        if has_candles and has_features:
            raise ValueError("Provide either 'candles' or 'features', not both.")

        if has_candles:
            if len(self.candles) < 200:
                raise ValueError(
                    f"At least 200 daily candles are required for technical indicator warm-up (received {len(self.candles)}). "
                    f"Features such as SMA 200 and EMA 50 require 200 historical periods."
                )

        if has_features:
            missing_features = [f for f in APPROVED_FEATURE_ALLOWLIST if f not in self.features]
            if missing_features:
                raise ValueError(
                    f"Provided feature dictionary is missing approved features: {missing_features[:5]}. "
                    f"Expected exactly 23 approved features."
                )
            unexpected_features = [f for f in self.features if f not in APPROVED_FEATURE_ALLOWLIST]
            if unexpected_features:
                raise ValueError(
                    f"Provided feature dictionary contains unexpected features: {unexpected_features[:5]}. "
                    f"Expected only the approved 23 technical features."
                )
            for k, v in self.features.items():
                if not isinstance(v, (int, float)) or not math.isfinite(v):
                    raise ValueError(f"Feature '{k}' contains non-finite value: {v}. Must be finite float.")

        return self


class MultiHorizonPredictRequest(BaseModel):
    """
    Multi-horizon (concurrent h=1, 3, 5) directional inference request.
    """
    model_config = ConfigDict(extra="forbid")

    symbol: str = Field(..., min_length=1, description="NSE equity ticker symbol (e.g. 'RELIANCE')")
    candles: Optional[List[CandleInput]] = Field(
        default=None,
        description="Historical daily OHLCV candles (minimum 200 trading sessions)",
    )
    features: Optional[Dict[str, float]] = Field(
        default=None,
        description="Precomputed 23-feature dictionary matching approved schema",
    )

    @model_validator(mode="after")
    def validate_inputs(self) -> "MultiHorizonPredictRequest":
        has_candles = bool(self.candles and len(self.candles) > 0)
        has_features = bool(self.features and len(self.features) > 0)

        if not has_candles and not has_features:
            raise ValueError("Multi-horizon inference request must provide either 'candles' or 'features'.")
        if has_candles and has_features:
            raise ValueError("Provide either 'candles' or 'features', not both.")

        if has_candles:
            if len(self.candles) < 200:
                raise ValueError(
                    f"At least 200 daily candles are required for technical indicator warm-up (received {len(self.candles)})."
                )

        if has_features:
            missing = [f for f in APPROVED_FEATURE_ALLOWLIST if f not in self.features]
            if missing:
                raise ValueError(f"Missing approved features: {missing[:5]}. Expected 23 features.")
            for k, v in self.features.items():
                if not isinstance(v, (int, float)) or not math.isfinite(v):
                    raise ValueError(f"Feature '{k}' contains non-finite value: {v}.")

        return self


class PredictResponse(BaseModel):
    """
    Directional prediction response with calibrated probabilities and provenance metadata.
    """
    model_config = ConfigDict(extra="forbid")

    symbol: str = Field(..., description="Equity ticker symbol")
    horizon: int = Field(..., description="Forecast horizon in trading days")
    target_threshold_pct: float = Field(..., description="Target threshold theta_h in percentage")
    predicted_class: int = Field(..., description="Discrete class prediction: -1 (DOWN), 0 (NEUTRAL), +1 (UP)")
    predicted_label: DirectionalClass = Field(..., description="Human-readable directional label")
    probabilities: Dict[str, float] = Field(
        ...,
        description="Calibrated probability distribution summing strictly to 1.0: {'DOWN': p, 'NEUTRAL': p, 'UP': p}",
    )
    confidence: float = Field(..., description="Highest class probability max(P)")
    model_id: str = Field(..., description="Unique model identifier")
    algorithm: str = Field(..., description="Algorithm description")
    artifact_sha256: str = Field(..., description="Cryptographic SHA-256 digest of loaded model binary")
    feature_schema_version: str = Field(default="23_scale_invariant_technical_v1")
    inference_timestamp_utc: str = Field(..., description="UTC ISO timestamp of inference execution")
    execution_time_ms: float = Field(..., ge=0.0, description="Inference latency in milliseconds")


class MultiHorizonPredictResponse(BaseModel):
    """
    Unified multi-horizon prediction response spanning h=1, 3, and 5 trading days.
    """
    model_config = ConfigDict(extra="forbid")

    symbol: str = Field(..., description="Equity ticker symbol")
    predictions: Dict[int, PredictResponse] = Field(
        ...,
        description="Mapping horizon (1, 3, 5) to its corresponding prediction response",
    )
    inference_timestamp_utc: str = Field(..., description="UTC ISO timestamp of execution")
    total_execution_time_ms: float = Field(..., ge=0.0, description="Total pipeline latency in milliseconds")


class ActiveModelDescriptor(BaseModel):
    """Summary descriptor for an active registered model champion."""
    model_config = ConfigDict(extra="forbid")

    horizon: int
    model_id: str
    model_family: str
    algorithm: str
    artifact_filename: str
    artifact_sha256: str
    status: str


class ActiveModelsResponse(BaseModel):
    """Active champions routing manifest descriptor."""
    model_config = ConfigDict(extra="forbid")

    manifest_version: str
    updated_at_utc: str
    dataset_sha256: str
    active_champions: Dict[int, ActiveModelDescriptor]
