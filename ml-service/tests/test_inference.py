"""
StockSense AI — Model Inference Test Suite (Phase 5C.5)
Validates request/response schemas, fail-fast input validation, feature ordering immunity,
cryptographic SHA-256 integrity enforcement, probability calibration normalization,
in-memory caching latency (<15ms), and FastAPI route integration.
"""

import os
import json
import time
import math
import tempfile
import pytest
import numpy as np
import pandas as pd
from pathlib import Path
from fastapi.testclient import TestClient

from app.main import app
from app.schemas.inference import (
    DirectionalClass,
    PredictRequest,
    PredictResponse,
    MultiHorizonPredictRequest,
    MultiHorizonPredictResponse,
    ActiveModelsResponse,
)
from app.schemas.market_data import CandleInput
from app.services.inference import (
    InferenceService,
    ModelNotLoadedError,
)
from app.services.registry import (
    ModelRegistry,
    ArtifactNotFoundError,
    ArtifactIntegrityError,
    IncompatibleFeatureError,
)
from app.services.splitting import (
    APPROVED_FEATURE_ALLOWLIST,
    QUARANTINED_TEST_START_DATE,
    QUARANTINED_TEST_END_DATE,
)


# Fixture: Canonical historical candle slice (first 250 candles from RELIANCE)
@pytest.fixture(scope="module")
def valid_candles() -> list[CandleInput]:
    fixture_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "data", "historical_candles_5stocks.json")
    )
    with open(fixture_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    raw = data["RELIANCE"]["candles"][:250]
    return [CandleInput(**c) for c in raw]


# Fixture: Synthetic valid 23-feature dictionary
@pytest.fixture
def valid_features() -> dict[str, float]:
    return {feat: 0.05 for feat in APPROVED_FEATURE_ALLOWLIST}


# Fixture: Shared InferenceService instance
@pytest.fixture(scope="module")
def inference_service() -> InferenceService:
    svc = InferenceService()
    svc.load_active_models()
    return svc


# =============================================================================
# 1. Schema & Validation Tests
# =============================================================================

class TestInferenceSchemas:
    def test_valid_request_with_features(self, valid_features):
        req = PredictRequest(symbol="RELIANCE", horizon=1, features=valid_features)
        assert req.symbol == "RELIANCE"
        assert req.horizon == 1
        assert req.features is not None
        assert req.candles is None

    def test_valid_request_with_candles(self, valid_candles):
        req = PredictRequest(symbol="RELIANCE", horizon=1, candles=valid_candles)
        assert req.symbol == "RELIANCE"
        assert len(req.candles) == 250

    def test_reject_neither_candles_nor_features(self):
        with pytest.raises(ValueError, match="must provide either 'candles' or 'features'"):
            PredictRequest(symbol="RELIANCE", horizon=1)

    def test_reject_both_candles_and_features(self, valid_candles, valid_features):
        with pytest.raises(ValueError, match="not both"):
            PredictRequest(symbol="RELIANCE", horizon=1, candles=valid_candles, features=valid_features)

    def test_reject_unsupported_horizon(self, valid_features):
        with pytest.raises(ValueError, match="horizon must be 1, 3, or 5"):
            PredictRequest(symbol="RELIANCE", horizon=2, features=valid_features)

        with pytest.raises(ValueError, match="horizon must be 1, 3, or 5"):
            PredictRequest(symbol="RELIANCE", horizon=10, features=valid_features)

    def test_reject_insufficient_candles(self, valid_candles):
        with pytest.raises(ValueError, match="At least 200 daily candles are required"):
            PredictRequest(symbol="RELIANCE", horizon=1, candles=valid_candles[:199])

    def test_reject_missing_feature(self, valid_features):
        incomplete = valid_features.copy()
        del incomplete["rsi_14"]
        with pytest.raises(ValueError, match="missing approved features"):
            PredictRequest(symbol="RELIANCE", horizon=1, features=incomplete)

    def test_reject_unexpected_feature(self, valid_features):
        extra = valid_features.copy()
        extra["future_exit_price"] = 1500.0
        with pytest.raises(ValueError, match="unexpected features"):
            PredictRequest(symbol="RELIANCE", horizon=1, features=extra)

    def test_reject_non_finite_feature_value(self, valid_features):
        bad_nan = valid_features.copy()
        bad_nan["price_to_sma20"] = float("nan")
        with pytest.raises(ValueError, match="non-finite value"):
            PredictRequest(symbol="RELIANCE", horizon=1, features=bad_nan)

        bad_inf = valid_features.copy()
        bad_inf["price_to_sma20"] = float("inf")
        with pytest.raises(ValueError, match="non-finite value"):
            PredictRequest(symbol="RELIANCE", horizon=1, features=bad_inf)


# =============================================================================
# 2. Inference Service Domain Logic Tests
# =============================================================================

class TestInferenceService:
    def test_active_models_manifest_contents(self, inference_service):
        manifest = inference_service.get_active_models_manifest()
        assert manifest.manifest_version == "1.0"
        assert set(manifest.active_champions.keys()) == {1, 3, 5}
        assert manifest.active_champions[1].model_id == "xgboost_h1_v1.0.0"
        assert manifest.active_champions[3].model_id == "xgboost_h3_v1.0.0"
        assert manifest.active_champions[5].model_id == "random_forest_h5_v1.0.0"

    def test_single_horizon_prediction_h1(self, inference_service, valid_features):
        req = PredictRequest(symbol="RELIANCE", horizon=1, features=valid_features)
        res = inference_service.predict(req)
        assert res.symbol == "RELIANCE"
        assert res.horizon == 1
        assert res.model_id == "xgboost_h1_v1.0.0"
        assert res.predicted_class in (-1, 0, 1)
        assert res.predicted_label in (DirectionalClass.DOWN, DirectionalClass.NEUTRAL, DirectionalClass.UP)
        assert set(res.probabilities.keys()) == {"DOWN", "NEUTRAL", "UP"}
        # Probability sum check
        prob_sum = sum(res.probabilities.values())
        assert abs(prob_sum - 1.0) < 1e-4
        assert res.confidence == max(res.probabilities.values())

    def test_single_horizon_prediction_h3(self, inference_service, valid_features):
        req = PredictRequest(symbol="TCS", horizon=3, features=valid_features)
        res = inference_service.predict(req)
        assert res.horizon == 3
        assert res.model_id == "xgboost_h3_v1.0.0"
        assert abs(sum(res.probabilities.values()) - 1.0) < 1e-4

    def test_single_horizon_prediction_h5(self, inference_service, valid_features):
        req = PredictRequest(symbol="INFY", horizon=5, features=valid_features)
        res = inference_service.predict(req)
        assert res.horizon == 5
        assert res.model_id == "random_forest_h5_v1.0.0"
        assert abs(sum(res.probabilities.values()) - 1.0) < 1e-4

    def test_candle_based_feature_extraction_and_inference(self, inference_service, valid_candles):
        req = PredictRequest(symbol="RELIANCE", horizon=1, candles=valid_candles)
        res = inference_service.predict(req)
        assert res.symbol == "RELIANCE"
        assert res.horizon == 1
        assert abs(sum(res.probabilities.values()) - 1.0) < 1e-4
        assert res.execution_time_ms > 0.0

    def test_feature_ordering_immunity(self, inference_service, valid_features):
        # Generate prediction with normal order
        req_normal = PredictRequest(symbol="RELIANCE", horizon=1, features=valid_features)
        res_normal = inference_service.predict(req_normal)

        # Reverse the dictionary key order
        reversed_features = {k: valid_features[k] for k in reversed(list(valid_features.keys()))}
        req_reversed = PredictRequest(symbol="RELIANCE", horizon=1, features=reversed_features)
        res_reversed = inference_service.predict(req_reversed)

        assert res_normal.predicted_class == res_reversed.predicted_class
        assert res_normal.probabilities == res_reversed.probabilities

    def test_multi_horizon_prediction_with_features(self, inference_service, valid_features):
        req = MultiHorizonPredictRequest(symbol="HDFCBANK", features=valid_features)
        res = inference_service.predict_multi_horizon(req)
        assert res.symbol == "HDFCBANK"
        assert set(res.predictions.keys()) == {1, 3, 5}
        for h in [1, 3, 5]:
            p = res.predictions[h]
            assert p.horizon == h
            assert abs(sum(p.probabilities.values()) - 1.0) < 1e-4
        assert res.total_execution_time_ms > 0.0

    def test_multi_horizon_prediction_with_candles(self, inference_service, valid_candles):
        req = MultiHorizonPredictRequest(symbol="ICICIBANK", candles=valid_candles)
        res = inference_service.predict_multi_horizon(req)
        assert res.symbol == "ICICIBANK"
        assert set(res.predictions.keys()) == {1, 3, 5}

    def test_model_override_candidate(self, inference_service, valid_features):
        # Test overriding active h=1 champion (xgboost_h1_v1.0.0) with xgboost_h3_v1.0.0
        req = PredictRequest(
            symbol="RELIANCE",
            horizon=1,
            features=valid_features,
            model_override_id="xgboost_h3_v1.0.0",
        )
        res = inference_service.predict(req)
        assert res.model_id == "xgboost_h3_v1.0.0"
        assert abs(sum(res.probabilities.values()) - 1.0) < 1e-4

    def test_runtime_compatibility_enforcement_on_different_python_minor(self, inference_service, valid_features):
        # LR was serialized under Python 3.15, so loading under Python 3.14 raises RuntimeCompatibilityError
        from app.services.registry import RuntimeCompatibilityError
        req = PredictRequest(
            symbol="RELIANCE",
            horizon=1,
            features=valid_features,
            model_override_id="logistic_regression_h1_v1.0.0",
        )
        with pytest.raises(RuntimeCompatibilityError, match="Incompatible Python runtime"):
            inference_service.predict(req)

    def test_in_memory_inference_latency_benchmark(self, inference_service, valid_features):
        req = PredictRequest(symbol="RELIANCE", horizon=1, features=valid_features)
        # Warm up JIT / caches
        inference_service.predict(req)

        # Benchmark 20 iterations
        times = []
        for _ in range(20):
            t0 = time.perf_counter()
            inference_service.predict(req)
            times.append((time.perf_counter() - t0) * 1000)

        median_ms = float(np.median(times))
        # Verify median latency is strictly under 15ms
        assert median_ms < 15.0, f"Median inference latency {median_ms:.2f}ms exceeds 15ms target."


# =============================================================================
# 3. Security & Cryptographic Integrity Tests
# =============================================================================

class TestInferenceSecurityAndIntegrity:
    def test_sha256_integrity_rejection_on_tampered_model(self, tmp_path):
        # Create a mock registry with tampered artifact
        fake_reg = tmp_path / "fake_reg"
        fake_reg.mkdir()
        fake_model_dir = fake_reg / "xgboost_h1_v1.0.0"
        fake_model_dir.mkdir()

        # Copy authentic metadata
        real_meta_path = Path("ml-service/models/registry/xgboost_h1_v1.0.0/metadata.json")
        if not real_meta_path.exists():
            real_meta_path = Path("models/registry/xgboost_h1_v1.0.0/metadata.json")
        with open(real_meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        with open(fake_model_dir / "metadata.json", "w", encoding="utf-8") as f:
            json.dump(meta, f)

        # Write corrupted model binary
        with open(fake_model_dir / "model.joblib", "wb") as f:
            f.write(b"TAMPERED_OR_CORRUPTED_BINARY")

        svc = InferenceService(registry_dir=str(fake_reg))
        with pytest.raises(ArtifactIntegrityError, match="integrity verification failed"):
            svc.registry.load_model("xgboost_h1_v1.0.0")

    def test_quarantined_test_period_invariance(self):
        # Verify boundary date constants
        assert QUARANTINED_TEST_START_DATE == "2026-07-14"
        assert QUARANTINED_TEST_END_DATE == "2026-11-09"


# =============================================================================
# 4. FastAPI Endpoints Integration Tests
# =============================================================================

class TestInferenceAPIEndpoints:
    def test_get_active_models(self):
        with TestClient(app) as client:
            res = client.get("/api/models/active")
            assert res.status_code == 200
            data = res.json()
            assert "active_champions" in data
            champs = data["active_champions"]
            assert set(champs.keys()) == {"1", "3", "5"}
            assert champs["1"]["model_id"] == "xgboost_h1_v1.0.0"
            assert champs["3"]["model_id"] == "xgboost_h3_v1.0.0"
            assert champs["5"]["model_id"] == "random_forest_h5_v1.0.0"

    def test_post_predict_success(self, valid_features):
        with TestClient(app) as client:
            payload = {
                "symbol": "RELIANCE",
                "horizon": 1,
                "features": valid_features,
            }
            res = client.post("/api/predict", json=payload)
            assert res.status_code == 200
            data = res.json()
            assert data["symbol"] == "RELIANCE"
            assert data["horizon"] == 1
            assert data["predicted_label"] in ["DOWN", "NEUTRAL", "UP"]
            assert "DOWN" in data["probabilities"]
            assert "NEUTRAL" in data["probabilities"]
            assert "UP" in data["probabilities"]
            assert abs(sum(data["probabilities"].values()) - 1.0) < 1e-4

    def test_post_predict_multi_horizon_success(self, valid_features):
        with TestClient(app) as client:
            payload = {
                "symbol": "TCS",
                "features": valid_features,
            }
            res = client.post("/api/predict/multi-horizon", json=payload)
            assert res.status_code == 200
            data = res.json()
            assert data["symbol"] == "TCS"
            assert set(data["predictions"].keys()) == {"1", "3", "5"}

    def test_post_predict_validation_error_missing_candles_and_features(self):
        with TestClient(app) as client:
            payload = {
                "symbol": "RELIANCE",
                "horizon": 1,
            }
            res = client.post("/api/predict", json=payload)
            assert res.status_code == 422
            assert "must provide either 'candles' or 'features'" in str(res.json()["detail"])

    def test_post_predict_validation_error_invalid_horizon(self, valid_features):
        with TestClient(app) as client:
            payload = {
                "symbol": "RELIANCE",
                "horizon": 4,
                "features": valid_features,
            }
            res = client.post("/api/predict", json=payload)
            assert res.status_code == 422
            assert "horizon must be 1, 3, or 5" in str(res.json()["detail"])
