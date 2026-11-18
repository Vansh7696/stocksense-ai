"""
StockSense AI — Milestone 6A.3: ML Microservice Concurrency & Latency Benchmarks
Validates multi-worker production configuration, concurrent health check resilience,
and measures empirical inference latency distributions (p50, p95, p99) under controlled concurrency.
"""

import time
import statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.inference import InferenceService
from app.schemas.inference import PredictRequest
from app.services.splitting import APPROVED_FEATURE_ALLOWLIST
import gunicorn_conf


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(scope="module")
def inference_service() -> InferenceService:
    svc = InferenceService()
    svc.load_active_models()
    return svc


@pytest.fixture
def valid_features() -> dict[str, float]:
    return {feat: 0.05 for feat in APPROVED_FEATURE_ALLOWLIST}


# =============================================================================
# 1. Gunicorn Multi-Worker Production Configuration Tests
# =============================================================================
class TestGunicornConfiguration:
    def test_gunicorn_config_parameters(self):
        assert gunicorn_conf.worker_class == "uvicorn.workers.UvicornWorker"
        assert gunicorn_conf.workers >= 1
        assert gunicorn_conf.timeout == 60
        assert gunicorn_conf.graceful_timeout == 30
        assert gunicorn_conf.max_requests == 2000
        assert gunicorn_conf.max_requests_jitter == 100

    def test_worker_calculation_bounds(self):
        # Workers should be bounded by [1, 4] by default to prevent thread thrashing
        assert 1 <= gunicorn_conf.default_workers <= 4


# =============================================================================
# 2. Concurrent Health Check Resilience
# =============================================================================
class TestConcurrentHealthChecks:
    def test_concurrent_health_checks(self, client: TestClient):
        num_requests = 20
        concurrency = 5

        def make_health_request():
            start = time.perf_counter()
            resp = client.get("/health")
            elapsed_ms = (time.perf_counter() - start) * 1000
            return resp.status_code, resp.json(), elapsed_ms

        latencies = []
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            futures = [executor.submit(make_health_request) for _ in range(num_requests)]
            for future in as_completed(futures):
                status_code, body, elapsed_ms = future.result()
                assert status_code == 200
                assert body["status"] == "UP"
                latencies.append(elapsed_ms)

        assert len(latencies) == num_requests
        p95 = statistics.quantiles(latencies, n=20)[18] if len(latencies) >= 20 else max(latencies)
        assert p95 < 100.0, f"Health check p95 ({p95:.2f}ms) exceeded 100ms"


# =============================================================================
# 3. Concurrent Model Inference & Latency Benchmarking
# =============================================================================
class TestConcurrentInference:
    def test_concurrent_predict_latency(
        self, inference_service: InferenceService, valid_features: dict[str, float]
    ):
        concurrency = 10
        total_requests = 30
        latencies_ms = []

        def run_single_inference(idx: int):
            req = PredictRequest(
                symbol="RELIANCE",
                horizon=1,
                features=valid_features,
            )
            t0 = time.perf_counter()
            resp = inference_service.predict(req)
            elapsed = (time.perf_counter() - t0) * 1000.0
            return resp, elapsed

        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            futures = [executor.submit(run_single_inference, i) for i in range(total_requests)]
            for future in as_completed(futures):
                resp, elapsed_ms = future.result()
                assert resp.predicted_class in (0, 1, 2)
                assert str(resp.predicted_label) in ("UP", "DOWN", "NEUTRAL", "DirectionalClass.UP", "DirectionalClass.DOWN", "DirectionalClass.NEUTRAL")
                assert abs(sum(resp.probabilities.values()) - 1.0) < 1e-4
                latencies_ms.append(elapsed_ms)

        assert len(latencies_ms) == total_requests

        mean_lat = statistics.mean(latencies_ms)
        p50 = statistics.median(latencies_ms)
        p95 = statistics.quantiles(latencies_ms, n=20)[18] if len(latencies_ms) >= 20 else max(latencies_ms)
        p99 = max(latencies_ms)

        print(
            f"\n[BENCHMARK] Inference Latency under {concurrency} concurrent workers "
            f"({total_requests} requests): "
            f"mean={mean_lat:.2f}ms, p50={p50:.2f}ms, p95={p95:.2f}ms, p99={p99:.2f}ms"
        )

        # Baseline performance assertion: in-memory inference should execute under 50ms p50
        assert p50 < 50.0, f"Empirical p50 latency ({p50:.2f}ms) exceeded 50ms threshold"

    def test_concurrent_multi_horizon_inference(
        self, inference_service: InferenceService, valid_features: dict[str, float]
    ):
        concurrency = 6
        total_requests = 18

        def run_multi_horizon():
            t0 = time.perf_counter()
            res_h1 = inference_service.predict(
                PredictRequest(symbol="TCS", horizon=1, features=valid_features)
            )
            res_h3 = inference_service.predict(
                PredictRequest(symbol="TCS", horizon=3, features=valid_features)
            )
            res_h5 = inference_service.predict(
                PredictRequest(symbol="TCS", horizon=5, features=valid_features)
            )
            elapsed = (time.perf_counter() - t0) * 1000.0
            return (res_h1, res_h3, res_h5), elapsed

        latencies = []
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            futures = [executor.submit(run_multi_horizon) for _ in range(total_requests)]
            for future in as_completed(futures):
                (h1, h3, h5), elapsed_ms = future.result()
                assert h1.horizon == 1
                assert h3.horizon == 3
                assert h5.horizon == 5
                latencies.append(elapsed_ms)

        assert len(latencies) == total_requests
        p50 = statistics.median(latencies)
        print(f"\n[BENCHMARK] Multi-Horizon (h=1,3,5) Concurrent Latency: p50={p50:.2f}ms")
