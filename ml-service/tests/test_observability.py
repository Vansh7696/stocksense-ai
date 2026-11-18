"""
StockSense AI — ML Service Observability & Correlation Tracking Tests (Phase 5C.7.3)
"""

import json
import logging
from fastapi.testclient import TestClient

from app.main import app
from app.core.logging import StructuredJSONFormatter, correlation_id_ctx
from app.services.telemetry import ml_telemetry

client = TestClient(app)


def test_correlation_id_generated_when_missing():
    response = client.get("/health")
    assert response.status_code == 200
    cid = response.headers.get("X-Correlation-ID")
    assert cid is not None
    assert len(cid) > 0


def test_correlation_id_propagated_from_client():
    custom_cid = "e2e-fastapi-test-trace-999"
    response = client.get("/health", headers={"X-Correlation-ID": custom_cid})
    assert response.status_code == 200
    assert response.headers.get("X-Correlation-ID") == custom_cid


def test_structured_json_formatter_serialization():
    formatter = StructuredJSONFormatter()
    record = logging.LogRecord(
        name="test_logger",
        level=logging.INFO,
        pathname="test_path.py",
        lineno=10,
        msg="Inference transaction executed successfully",
        args=(),
        exc_info=None,
    )
    record.endpoint = "POST /api/predict"
    record.status_code = 200
    record.duration_ms = 4.85

    token = correlation_id_ctx.set("ctx-trace-12345")
    try:
        formatted = formatter.format(record)
        data = json.loads(formatted)

        assert data["level"] == "INFO"
        assert data["service"] == "stocksense-ml-service"
        assert data["correlation_id"] == "ctx-trace-12345"
        assert data["endpoint"] == "POST /api/predict"
        assert data["status_code"] == 200
        assert data["duration_ms"] == 4.85
        assert "timestamp" in data
    finally:
        correlation_id_ctx.reset(token)


def test_prometheus_metrics_endpoint():
    ml_telemetry.record_inference("xgboost_h1_v1.0.0", 1, "success", 0.0035)
    ml_telemetry.record_indicator_compute("success")

    response = client.get("/metrics")
    assert response.status_code == 200
    assert "text/plain" in response.headers["content-type"]
    assert "ml_service_uptime_seconds" in response.text
    assert 'ml_inference_requests_total{model_id="xgboost_h1_v1.0.0",horizon="1",status="success"}' in response.text
    assert 'ml_indicator_compute_requests_total{status="success"}' in response.text


def test_json_metrics_endpoint():
    ml_telemetry.record_inference("xgboost_h3_v1.0.0", 3, "success", 0.0042)

    response = client.get("/api/metrics/json")
    assert response.status_code == 200
    data = response.json()
    assert "uptime_seconds" in data
    assert isinstance(data["inference_requests_total"], list)
    assert "latencies_by_horizon" in data
