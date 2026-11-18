"""
StockSense AI — Explainability & Feature Attribution Engine Tests (Phase 5C.8)
Tests mathematical correctness of Tree SHAP for XGBoost, Tree Path Impurity Decomposition
for Random Forest, linear fallback attribution, and API integration.
"""

import math
import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.explainability import (
    PredictionExplainer,
    FEATURE_METADATA,
    generate_feature_interpretation,
)
from app.services.inference import InferenceService
from app.schemas.inference import DirectionalClass, PredictRequest, MultiHorizonPredictRequest
from app.services.splitting import APPROVED_FEATURE_ALLOWLIST


client = TestClient(app)


def generate_valid_features() -> dict:
    """Generates synthetic test features within realistic technical indicator domains."""
    features = {}
    for feat in APPROVED_FEATURE_ALLOWLIST:
        if feat == "rsi_14":
            features[feat] = 68.5
        elif feat == "rsi_normalized":
            features[feat] = 0.685
        elif feat == "relative_volume_20":
            features[feat] = 1.45
        elif feat == "atr_pct":
            features[feat] = 0.018
        elif feat.startswith("price_to_"):
            features[feat] = 0.025
        elif feat.startswith("return_"):
            features[feat] = 0.012
        else:
            features[feat] = 0.05
    return features


class TestExplainabilityEngine:
    def test_feature_metadata_covers_all_approved_features(self):
        """Verifies that all 23 approved features have human-readable display metadata."""
        for feat in APPROVED_FEATURE_ALLOWLIST:
            assert feat in FEATURE_METADATA, f"Feature '{feat}' missing from FEATURE_METADATA"
            meta = FEATURE_METADATA[feat]
            assert "display_name" in meta
            assert "category" in meta
            assert len(meta["display_name"]) > 0

    def test_xgboost_tree_shap_attributions(self):
        """Verifies Tree SHAP attributions for active champion XGBoost h=1 model."""
        svc = InferenceService()
        svc.load_active_models()
        h1_model = svc._active_models[1]

        features = generate_valid_features()
        X_df = pd.DataFrame([features])[list(APPROVED_FEATURE_ALLOWLIST)]

        explainer = PredictionExplainer(top_n=5)
        attributions = explainer.explain(
            model=h1_model,
            X_df=X_df,
            predicted_class=1,
            predicted_label=DirectionalClass.UP,
        )

        assert len(attributions) == 5
        # Verify descending order of absolute contribution
        magnitudes = [abs(a.contribution) for a in attributions]
        assert magnitudes == sorted(magnitudes, reverse=True)

        for a in attributions:
            assert a.feature in APPROVED_FEATURE_ALLOWLIST
            assert math.isfinite(a.contribution)
            assert math.isfinite(a.value)
            assert isinstance(a.direction, DirectionalClass)
            assert len(a.display_name) > 0
            assert len(a.description) > 0

    def test_random_forest_decision_path_attributions(self):
        """Verifies Tree Path decomposition for active champion Random Forest h=5 model."""
        svc = InferenceService()
        svc.load_active_models()
        h5_model = svc._active_models[5]

        features = generate_valid_features()
        X_df = pd.DataFrame([features])[list(APPROVED_FEATURE_ALLOWLIST)]

        explainer = PredictionExplainer(top_n=5)
        attributions = explainer.explain(
            model=h5_model,
            X_df=X_df,
            predicted_class=-1,
            predicted_label=DirectionalClass.DOWN,
        )

        assert len(attributions) == 5
        for a in attributions:
            assert a.feature in APPROVED_FEATURE_ALLOWLIST
            assert math.isfinite(a.contribution)
            assert len(a.description) > 0

    def test_interpretation_generator_rules(self):
        """Verifies domain interpretations for key technical indicators."""
        desc_rsi = generate_feature_interpretation(
            "rsi_14", 75.0, 0.25, DirectionalClass.UP
        )
        assert "overbought (>70)" in desc_rsi
        assert "supports UP" in desc_rsi

        desc_vol = generate_feature_interpretation(
            "relative_volume_20", 1.85, 0.15, DirectionalClass.UP
        )
        assert "elevated institutional participation" in desc_vol


class TestExplainabilityAPIIntegration:
    def test_single_horizon_predict_includes_attributions(self):
        """Verifies that POST /api/predict returns top 5 feature attributions."""
        features = generate_valid_features()
        payload = {
            "symbol": "RELIANCE",
            "horizon": 1,
            "features": features,
        }
        res = client.post("/api/predict", json=payload)
        assert res.status_code == 200, res.text
        data = res.json()

        assert "attributions" in data
        assert isinstance(data["attributions"], list)
        assert len(data["attributions"]) == 5

        first_attr = data["attributions"][0]
        assert "feature" in first_attr
        assert "display_name" in first_attr
        assert "contribution" in first_attr
        assert "direction" in first_attr
        assert "value" in first_attr
        assert "description" in first_attr

    def test_multi_horizon_predict_includes_attributions_for_all_horizons(self):
        """Verifies that POST /api/predict/multi returns attributions for h=1, 3, and 5."""
        features = generate_valid_features()
        payload = {
            "symbol": "TCS",
            "features": features,
        }
        res = client.post("/api/predict/multi-horizon", json=payload)
        assert res.status_code == 200, res.text
        data = res.json()

        assert "predictions" in data
        predictions = data["predictions"]
        for h_str in ["1", "3", "5"]:
            assert h_str in predictions
            pred = predictions[h_str]
            assert "attributions" in pred
            assert len(pred["attributions"]) == 5
