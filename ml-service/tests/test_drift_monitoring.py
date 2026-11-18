"""
StockSense AI — Milestone 6C.3: Feature Drift & Data Quality Monitoring Tests
Validates PSI computation, two-sample Kolmogorov-Smirnov statistical tests,
missing-value tracking, Prometheus metric exposure, and monitoring API endpoints.
"""

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.drift_monitoring import (
    calculate_psi,
    calculate_ks_test,
    calculate_data_quality,
    FeatureDriftMonitor,
)
from app.services.telemetry import ml_telemetry


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)


# =============================================================================
# 1. PSI & KS Statistical Calculations
# =============================================================================
class TestStatisticalCalculations:
    def test_psi_identical_distributions(self):
        np.random.seed(42)
        baseline = np.random.normal(loc=0.0, scale=1.0, size=1000)
        current = np.random.normal(loc=0.0, scale=1.0, size=1000)

        psi = calculate_psi(baseline, current, num_bins=10)
        assert psi < 0.05, f"Expected negligible PSI for identical distributions, got {psi}"

    def test_psi_moderate_drift(self):
        np.random.seed(42)
        baseline = np.random.normal(loc=0.0, scale=1.0, size=1000)
        # Shift mean slightly by 0.35 sigma
        current = np.random.normal(loc=0.35, scale=1.0, size=1000)

        psi = calculate_psi(baseline, current, num_bins=10)
        assert 0.08 <= psi < 0.25, f"Expected moderate PSI (0.08-0.25), got {psi}"

    def test_psi_significant_drift(self):
        np.random.seed(42)
        baseline = np.random.normal(loc=0.0, scale=1.0, size=1000)
        # Shift mean significantly by 1.5 sigma
        current = np.random.normal(loc=1.5, scale=1.0, size=1000)

        psi = calculate_psi(baseline, current, num_bins=10)
        assert psi >= 0.25, f"Expected significant PSI >= 0.25, got {psi}"

    def test_ks_test_detection(self):
        np.random.seed(42)
        baseline = np.random.normal(loc=50.0, scale=10.0, size=500)
        shifted = np.random.normal(loc=65.0, scale=10.0, size=500)

        stat, pval = calculate_ks_test(baseline, shifted)
        assert stat > 0.3
        assert pval < 0.001, "Expected statistical significance for shifted distribution"


# =============================================================================
# 2. Data Quality & Constraint Violations
# =============================================================================
class TestDataQualityEvaluation:
    def test_data_quality_metrics(self):
        # Array with clean values, NaN, Inf, and out-of-bounds
        arr = np.array([10.0, 20.0, np.nan, np.inf, 5.0, 100.0, 30.0, 40.0])
        quality = calculate_data_quality(arr, min_bound=8.0, max_bound=50.0)

        assert quality["total_count"] == 8
        assert quality["nan_count"] == 1
        assert quality["inf_count"] == 1
        assert quality["missing_count"] == 2
        assert quality["missing_ratio"] == 0.25  # 2 / 8
        # Out of bounds: 5.0 (<8.0) and 100.0 (>50.0) = 2
        assert quality["out_of_bounds_ratio"] == 0.25


# =============================================================================
# 3. FeatureDriftMonitor & Telemetry Integration
# =============================================================================
class TestFeatureDriftMonitor:
    def test_batch_drift_analysis(self):
        monitor = FeatureDriftMonitor()
        np.random.seed(101)

        # Create batch with 1 stable feature and 1 heavily shifted feature
        stable_rsi = np.random.normal(loc=50.0, scale=12.0, size=200)
        shifted_sma = np.random.normal(loc=0.25, scale=0.03, size=200)  # Heavily shifted from baseline ~0.005

        batch = {
            "rsi_14": stable_rsi.tolist(),
            "price_to_sma20": shifted_sma.tolist(),
        }

        report = monitor.analyze_batch(batch)
        assert report["features_analyzed"] == 2
        assert "rsi_14" in report["feature_details"]
        assert "price_to_sma20" in report["feature_details"]

        assert report["feature_details"]["rsi_14"]["status"] in ("STABLE", "MODERATE_DRIFT")
        assert report["feature_details"]["price_to_sma20"]["status"] == "SIGNIFICANT_DRIFT"

        # Check telemetry recorded
        assert "rsi_14" in ml_telemetry.drift_metrics
        assert "price_to_sma20" in ml_telemetry.drift_metrics


# =============================================================================
# 4. Monitoring API Endpoints & Prometheus Scrape
# =============================================================================
class TestMonitoringEndpoints:
    def test_drift_analyze_endpoint(self, client: TestClient):
        payload = {
            "features": {
                "rsi_14": [49.0, 52.0, 48.5, 51.0, 50.5],
                "price_to_sma20": [0.005, 0.008, -0.002, 0.004, 0.006],
            }
        }
        res = client.post("/api/monitoring/drift/analyze", json=payload)
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "success"
        assert data["data"]["features_analyzed"] == 2
        assert "overall_health_score" in data["data"]

    def test_drift_status_endpoint(self, client: TestClient):
        res = client.get("/api/monitoring/drift/status")
        assert res.status_code == 200
        assert res.json()["status"] == "success"

    def test_prometheus_metrics_include_drift(self, client: TestClient):
        res = client.get("/metrics")
        assert res.status_code == 200
        content = res.text
        assert "ml_feature_drift_psi" in content
        assert "ml_feature_drift_status" in content
        assert "ml_feature_missing_ratio" in content
