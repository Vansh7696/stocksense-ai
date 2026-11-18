"""
StockSense AI — ML Microservice Observability & Telemetry Metrics Registry
Captures model inference counts, inference latencies, indicator calculations, and system health telemetry.
"""

import time
from typing import Dict, List, Tuple, Any

START_TIME = time.time()


class MLMetricsRegistry:
    def __init__(self):
        # Key: (model_id, horizon, status) -> count
        self.inference_requests: Dict[Tuple[str, int, str], int] = {}
        # Key: (status,) -> count
        self.indicator_requests: Dict[str, int] = {}
        # Key: (horizon,) -> list of latencies in seconds (FIFO circular buffer)
        self.latencies: Dict[int, List[float]] = {}
        self.max_latency_samples = 1000

    def record_inference(self, model_id: str, horizon: int, status: str, duration_seconds: float) -> None:
        key = (model_id, horizon, status)
        self.inference_requests[key] = self.inference_requests.get(key, 0) + 1

        if horizon not in self.latencies:
            self.latencies[horizon] = []
        if len(self.latencies[horizon]) >= self.max_latency_samples:
            self.latencies[horizon].pop(0)
        self.latencies[horizon].append(duration_seconds)

    def record_indicator_compute(self, status: str) -> None:
        self.indicator_requests[status] = self.indicator_requests.get(status, 0) + 1

    def get_percentiles(self, horizon: int) -> Dict[str, float]:
        samples = sorted(self.latencies.get(horizon, []))
        if not samples:
            return {"p50": 0.0, "p90": 0.0, "p99": 0.0, "count": 0}

        n = len(samples)
        return {
            "p50": round(samples[int(n * 0.50)], 4),
            "p90": round(samples[int(n * 0.90)], 4),
            "p99": round(samples[int(min(n - 1, int(n * 0.99)))], 4),
            "count": n,
        }

    def to_prometheus_format(self, loaded_models_count: int = 0) -> str:
        lines: List[str] = []

        uptime = round(time.time() - START_TIME, 2)
        lines.append("# HELP ml_service_uptime_seconds Total runtime of the ML microservice in seconds.")
        lines.append("# TYPE ml_service_uptime_seconds gauge")
        lines.append(f"ml_service_uptime_seconds {uptime}")

        lines.append("# HELP ml_loaded_models_count Number of active champion inference models loaded in memory.")
        lines.append("# TYPE ml_loaded_models_count gauge")
        lines.append(f"ml_loaded_models_count {loaded_models_count}")

        lines.append("# HELP ml_inference_requests_total Total number of inference invocations by model, horizon, and status.")
        lines.append("# TYPE ml_inference_requests_total counter")
        for (model_id, horizon, status), count in self.inference_requests.items():
            lines.append(
                f'ml_inference_requests_total{{model_id="{model_id}",horizon="{horizon}",status="{status}"}} {count}'
            )

        lines.append("# HELP ml_indicator_compute_requests_total Technical indicator computation requests.")
        lines.append("# TYPE ml_indicator_compute_requests_total counter")
        for status, count in self.indicator_requests.items():
            lines.append(f'ml_indicator_compute_requests_total{{status="{status}"}} {count}')

        lines.append("# HELP ml_inference_duration_seconds Summary of model inference execution latency.")
        lines.append("# TYPE ml_inference_duration_seconds summary")
        for horizon in [1, 3, 5]:
            p = self.get_percentiles(horizon)
            lines.append(f'ml_inference_duration_seconds{{horizon="{horizon}",quantile="0.5"}} {p["p50"]}')
            lines.append(f'ml_inference_duration_seconds{{horizon="{horizon}",quantile="0.9"}} {p["p90"]}')
            lines.append(f'ml_inference_duration_seconds{{horizon="{horizon}",quantile="0.99"}} {p["p99"]}')
            lines.append(f'ml_inference_duration_seconds_count{{horizon="{horizon}"}} {p["count"]}')

        return "\n".join(lines) + "\n"

    def to_json_snapshot(self, loaded_models_count: int = 0) -> Dict[str, Any]:
        return {
            "uptime_seconds": round(time.time() - START_TIME, 2),
            "loaded_models_count": loaded_models_count,
            "inference_requests_total": [
                {"model_id": k[0], "horizon": k[1], "status": k[2], "count": v}
                for k, v in self.inference_requests.items()
            ],
            "indicator_requests_total": [
                {"status": k, "count": v} for k, v in self.indicator_requests.items()
            ],
            "latencies_by_horizon": {h: self.get_percentiles(h) for h in [1, 3, 5]},
        }

    def reset(self) -> None:
        self.inference_requests.clear()
        self.indicator_requests.clear()
        self.latencies.clear()


ml_telemetry = MLMetricsRegistry()
