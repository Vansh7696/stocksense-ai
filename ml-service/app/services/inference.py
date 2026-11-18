"""
StockSense AI — Model Inference Service
Orchestrates high-performance, deterministic directional model inference for Indian equities.
Enforces SHA-256 pre-verification, in-memory model caching, feature ordering immunity,
probabilistic calibration guarantees, and fail-fast validation.
"""

import os
import json
import time
import math
import datetime
from typing import Dict, List, Optional, Any, Union
import numpy as np
import pandas as pd

from app.schemas.inference import (
    DirectionalClass,
    CLASS_INT_TO_LABEL,
    PredictRequest,
    PredictResponse,
    MultiHorizonPredictRequest,
    MultiHorizonPredictResponse,
    ActiveModelDescriptor,
    ActiveModelsResponse,
)
from app.schemas.market_data import CandleInput
from app.services.registry import (
    ModelRegistry,
    RegisteredInferenceModel,
    TARGET_THRESHOLDS_PCT,
    ArtifactNotFoundError,
    ArtifactIntegrityError,
    IncompatibleFeatureError,
)
from app.services.features import FeatureEngineeringPipeline
from app.services.splitting import (
    APPROVED_FEATURE_ALLOWLIST,
    QUARANTINED_TEST_START_DATE,
    QUARANTINED_TEST_END_DATE,
    QuarantinedTestDataLeakageError,
)


class InferenceError(Exception):
    """Base exception for inference pipeline failures."""
    pass


class ModelNotLoadedError(InferenceError):
    """Raised when an inference request is routed to an uninitialized model."""
    pass


class InferenceService:
    """
    High-performance inference engine for StockSense AI.

    Key Architectural Guarantees:
    - Pre-loads and caches active models in memory during startup (zero per-request disk I/O).
    - Cryptographically verifies SHA-256 checksums before loading model binaries.
    - Standardizes incoming features when a scaler is bundled (LR), or passes raw features (XGBoost, RF).
    - Re-orders features strictly to the approved 23-column schema, immune to dictionary/DataFrame key order.
    - Guarantees valid 3-class probability distribution: P(DOWN) + P(NEUTRAL) + P(UP) == 1.0.
    - Fail-fast: Rejects missing features, non-finite values (NaN/Inf), or insufficient candles with explicit errors.
    """

    DEFAULT_REGISTRY_DIR = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "models", "registry")
    )

    def __init__(self, registry_dir: Optional[str] = None):
        self.registry_dir = os.path.abspath(registry_dir or self.DEFAULT_REGISTRY_DIR)
        self.manifest_path = os.path.join(self.registry_dir, "active_models.json")
        self.registry = ModelRegistry(registry_dir=self.registry_dir)
        self._active_models: Dict[int, RegisteredInferenceModel] = {}
        self._manifest_cache: Optional[Dict[str, Any]] = None

    def load_active_models(self, force_reload: bool = False) -> None:
        """
        Loads all active champion models declared in active_models.json into memory.
        Enforces cryptographic verification on each model binary.
        """
        if not os.path.exists(self.manifest_path):
            raise ArtifactNotFoundError(
                f"Active models routing manifest not found at: {self.manifest_path}. "
                f"Run Milestone 5C.5.1 promotion before serving inference."
            )

        with open(self.manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)

        self._manifest_cache = manifest
        active_champs = manifest.get("active_champions", {})

        for h_str, champ_info in active_champs.items():
            h = int(h_str)
            model_id = champ_info["model_id"]
            if not force_reload and h in self._active_models and self._active_models[h].model_id == model_id:
                continue

            # Load model through registry (includes SHA-256 check, compatibility checks, and bundle validation)
            inference_model = self.registry.load_model(model_id)
            self._active_models[h] = inference_model

    def get_active_models_manifest(self) -> ActiveModelsResponse:
        """
        Returns the active models descriptor manifest.
        """
        if self._manifest_cache is None or not os.path.exists(self.manifest_path):
            self.load_active_models()

        with open(self.manifest_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        champs_dict: Dict[int, ActiveModelDescriptor] = {}
        for h_str, info in data.get("active_champions", {}).items():
            h = int(h_str)
            champs_dict[h] = ActiveModelDescriptor(
                horizon=info["horizon"],
                model_id=info["model_id"],
                model_family=info["model_family"],
                algorithm=info["algorithm"],
                artifact_filename=info["artifact_filename"],
                artifact_sha256=info["artifact_sha256"],
                status=info["status"],
            )

        return ActiveModelsResponse(
            manifest_version=data.get("manifest_version", "1.0"),
            updated_at_utc=data.get("updated_at_utc", datetime.datetime.now(datetime.timezone.utc).isoformat()),
            dataset_sha256=data.get("dataset_sha256", ""),
            active_champions=champs_dict,
        )

    def _extract_features_from_candles(
        self, candles: List[CandleInput], drop_na: bool = True
    ) -> pd.DataFrame:
        """
        Converts raw OHLCV candle list into a 1-row DataFrame containing the most recent session's
        23 engineered features.
        """
        pipeline = FeatureEngineeringPipeline()
        extracted = pipeline.extract_features(candles, drop_na=drop_na)
        rows = extracted["features"]

        if not rows:
            raise ValueError(
                f"Feature extraction yielded 0 valid rows from {len(candles)} candles after warm-up drop. "
                f"Ensure at least 200 candles are provided."
            )

        # Take the most recent bar (the last row)
        latest_row = rows[-1]
        feature_dict = {f: latest_row.get(f) for f in APPROVED_FEATURE_ALLOWLIST}

        for k, v in feature_dict.items():
            if v is None or not math.isfinite(v):
                raise ValueError(f"Extracted feature '{k}' contains non-finite value: {v}")

        return pd.DataFrame([feature_dict])[list(APPROVED_FEATURE_ALLOWLIST)]

    def _prepare_feature_dataframe(
        self,
        candles: Optional[List[CandleInput]] = None,
        features: Optional[Dict[str, float]] = None,
    ) -> pd.DataFrame:
        """
        Validates and standardizes input into a 1-row DataFrame with exact approved feature columns.
        """
        if features is not None:
            # Reorder explicitly according to approved allowlist
            ordered_features = {f: float(features[f]) for f in APPROVED_FEATURE_ALLOWLIST}
            return pd.DataFrame([ordered_features])[list(APPROVED_FEATURE_ALLOWLIST)]
        elif candles is not None:
            return self._extract_features_from_candles(candles)
        else:
            raise ValueError("Either 'candles' or 'features' must be provided.")

    def predict(self, request: PredictRequest) -> PredictResponse:
        """
        Executes single-horizon inference.
        """
        t0 = time.perf_counter()
        h = request.horizon

        # Resolve model
        if request.model_override_id:
            model = self.registry.load_model(request.model_override_id)
        else:
            if h not in self._active_models:
                self.load_active_models()
            if h not in self._active_models:
                raise ModelNotLoadedError(f"No active model loaded for horizon h={h}.")
            model = self._active_models[h]

        # Prepare feature DataFrame
        X_df = self._prepare_feature_dataframe(
            candles=request.candles,
            features=request.features,
        )

        # Generate discrete class prediction and probability vector
        preds = model.predict(X_df)
        probs = model.predict_proba(X_df)

        pred_class_int = int(preds[0])
        pred_label = CLASS_INT_TO_LABEL.get(pred_class_int, DirectionalClass.NEUTRAL)

        # Build calibrated probability dictionary
        prob_dict: Dict[str, float] = {
            "DOWN": round(float(probs[0, 0]), 6),
            "NEUTRAL": round(float(probs[0, 1]), 6),
            "UP": round(float(probs[0, 2]), 6),
        }
        confidence = round(float(np.max(probs[0])), 6)

        t1 = time.perf_counter()
        execution_time_ms = round((t1 - t0) * 1000, 3)

        threshold_pct = TARGET_THRESHOLDS_PCT.get(h, 0.50)

        return PredictResponse(
            symbol=request.symbol,
            horizon=h,
            target_threshold_pct=threshold_pct,
            predicted_class=pred_class_int,
            predicted_label=pred_label,
            probabilities=prob_dict,
            confidence=confidence,
            model_id=model.model_id,
            algorithm=model.metadata.algorithm,
            artifact_sha256=model.metadata.artifact_sha256,
            feature_schema_version=model.metadata.feature_schema_version,
            inference_timestamp_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            execution_time_ms=execution_time_ms,
        )

    def predict_multi_horizon(self, request: MultiHorizonPredictRequest) -> MultiHorizonPredictResponse:
        """
        Executes concurrent multi-horizon inference across h=1, 3, 5.
        Optimized to compute features only once when candles are supplied.
        """
        t0 = time.perf_counter()

        # Compute or validate features once for all three horizons
        X_df = self._prepare_feature_dataframe(
            candles=request.candles,
            features=request.features,
        )

        if not self._active_models:
            self.load_active_models()

        predictions: Dict[int, PredictResponse] = {}
        for h in [1, 3, 5]:
            t_h0 = time.perf_counter()
            if h not in self._active_models:
                raise ModelNotLoadedError(f"No active model loaded for horizon h={h}.")
            model = self._active_models[h]

            preds = model.predict(X_df)
            probs = model.predict_proba(X_df)

            pred_class_int = int(preds[0])
            pred_label = CLASS_INT_TO_LABEL.get(pred_class_int, DirectionalClass.NEUTRAL)

            prob_dict: Dict[str, float] = {
                "DOWN": round(float(probs[0, 0]), 6),
                "NEUTRAL": round(float(probs[0, 1]), 6),
                "UP": round(float(probs[0, 2]), 6),
            }
            confidence = round(float(np.max(probs[0])), 6)
            t_h1 = time.perf_counter()
            exec_ms = round((t_h1 - t_h0) * 1000, 3)

            threshold_pct = TARGET_THRESHOLDS_PCT.get(h, 0.50)
            predictions[h] = PredictResponse(
                symbol=request.symbol,
                horizon=h,
                target_threshold_pct=threshold_pct,
                predicted_class=pred_class_int,
                predicted_label=pred_label,
                probabilities=prob_dict,
                confidence=confidence,
                model_id=model.model_id,
                algorithm=model.metadata.algorithm,
                artifact_sha256=model.metadata.artifact_sha256,
                feature_schema_version=model.metadata.feature_schema_version,
                inference_timestamp_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                execution_time_ms=exec_ms,
            )

        t1 = time.perf_counter()
        total_execution_time_ms = round((t1 - t0) * 1000, 3)

        return MultiHorizonPredictResponse(
            symbol=request.symbol,
            predictions=predictions,
            inference_timestamp_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            total_execution_time_ms=total_execution_time_ms,
        )
