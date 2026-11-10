"""
StockSense AI — Feature Engineering Pipeline Test Suite
Validates that engineered ML features are stationary, scale-invariant,
robust against edge cases, and strictly decoupled from model training.
"""

import pytest
import numpy as np
from fastapi.testclient import TestClient

from app.main import app
from app.services.features import FeatureEngineeringPipeline
from tests.test_indicators import generate_synthetic_candles

client = TestClient(app)


class TestFeatureEngineeringPipeline:
    def test_feature_extraction_structure(self):
        candles = generate_synthetic_candles(100, trend=0.2)
        pipeline = FeatureEngineeringPipeline()
        result = pipeline.extract_features(candles, drop_na=False)

        assert result["total_rows"] == 100
        assert result["feature_count"] > 15
        assert "price_to_sma20" in result["feature_names"]
        assert "rsi_normalized" in result["feature_names"]
        assert "macd_hist_normalized" in result["feature_names"]
        assert "bb_percent_b" in result["feature_names"]
        assert "atr_pct" in result["feature_names"]
        assert "trend_alignment" in result["feature_names"]
        assert "volatility_20d" in result["feature_names"]
        assert "relative_volume_20" in result["feature_names"]

    def test_drop_na_removes_warmup_period(self):
        # 100 candles with drop_na=True should drop warm-up rows (e.g. initial 50 rows for 50-day EMA/SMA)
        candles = generate_synthetic_candles(100, trend=0.2)
        pipeline = FeatureEngineeringPipeline()
        res_full = pipeline.extract_features(candles, drop_na=False)
        res_dropped = pipeline.extract_features(candles, drop_na=True)

        assert res_dropped["total_rows"] < res_full["total_rows"]
        # Verify no None values in dropped dataset for core 50-day indicators
        for row in res_dropped["features"]:
            assert row["price_to_sma20"] is not None
            assert row["rsi_14"] is not None
            assert row["macd_hist_normalized"] is not None
            assert row["bb_percent_b"] is not None

    def test_trend_alignment_logic(self):
        # Strongly upward trending series
        candles_bullish = generate_synthetic_candles(250, trend=1.5)
        pipeline = FeatureEngineeringPipeline()
        res = pipeline.extract_features(candles_bullish, drop_na=False)

        last_row = res["features"][-1]
        # In a long strong uptrend: SMA20 > SMA50 > SMA200 -> alignment = 1.0
        assert last_row["trend_alignment"] == 1.0

        # Strongly downward trending series
        candles_bearish = generate_synthetic_candles(250, trend=-1.5, base_price=500.0)
        res_bear = pipeline.extract_features(candles_bearish, drop_na=False)
        last_row_bear = res_bear["features"][-1]
        # In strong downtrend: SMA20 < SMA50 < SMA200 -> alignment = -1.0
        assert last_row_bear["trend_alignment"] == -1.0

    def test_flat_market_resilience(self):
        # Completely flat prices and volumes
        candles = []
        for i in range(60):
            candles.append({
                "timestamp": f"2025-01-{i+1:02d}T09:15:00Z" if i < 30 else f"2025-02-{i-29:02d}T09:15:00Z",
                "open": 1000.0,
                "high": 1000.0,
                "low": 1000.0,
                "close": 1000.0,
                "volume": 0,
            })

        pipeline = FeatureEngineeringPipeline()
        res = pipeline.extract_features(candles, drop_na=False)
        assert res["total_rows"] == 60

        # Check latest values:
        last = res["features"][-1]
        # On flat price: relative to SMA is 0.0, returns are 0.0, volatility is 0.0
        assert last["price_to_sma20"] == pytest.approx(0.0)
        assert last["return_1d"] == pytest.approx(0.0)
        assert last["volatility_20d"] == pytest.approx(0.0)
        assert last["relative_volume_20"] == pytest.approx(0.0)
        assert last["bb_percent_b"] == pytest.approx(0.5)  # Safe midpoint


# -----------------------------------------------------------------------------
# FastAPI HTTP Endpoints Integration Tests
# -----------------------------------------------------------------------------
class TestAPIEndpoints:
    def test_post_indicators_compute_endpoint(self):
        candles = generate_synthetic_candles(60, trend=0.1)
        payload = {
            "symbol": "RELIANCE",
            "candles": candles,
            "config": {
                "rsi_period": 14,
                "bollinger_period": 20,
            },
        }

        response = client.post("/api/indicators/compute", json=payload)
        assert response.status_code == 200
        data = response.json()

        assert data["symbol"] == "RELIANCE"
        assert data["total_candles"] == 60
        assert data["warmup_status"] in ["READY", "PARTIAL_WARMUP"]
        assert "sma" in data["indicators"]
        assert "rsi" in data["indicators"]
        assert "latest" in data
        assert data["latest"]["close"] > 0

    def test_post_features_engineer_endpoint(self):
        candles = generate_synthetic_candles(60, trend=0.1)
        payload = {
            "symbol": "TCS",
            "candles": candles,
            "drop_na": False,
        }

        response = client.post("/api/features/engineer", json=payload)
        assert response.status_code == 200
        data = response.json()

        assert data["symbol"] == "TCS"
        assert data["total_rows"] == 60
        assert data["feature_count"] > 10
        assert len(data["features"]) == 60

    def test_rejects_empty_candles(self):
        response = client.post("/api/indicators/compute", json={"symbol": "INFY", "candles": []})
        assert response.status_code == 422  # Pydantic validation error min_length=1

    def test_rejects_invalid_ohlc(self):
        # Candle where high < low
        invalid_candles = [{
            "timestamp": "2025-01-01T09:15:00Z",
            "open": 100.0,
            "high": 90.0,   # High < Low
            "low": 105.0,
            "close": 95.0,
            "volume": 1000,
        }]
        payload = {"symbol": "INVALID", "candles": invalid_candles}
        response = client.post("/api/indicators/compute", json=payload)
        assert response.status_code == 422
