"""
StockSense AI — ML Service Metrics Endpoints
Exposes Prometheus OpenMetrics scrape output and JSON operational telemetry.
"""

from fastapi import APIRouter, Response, Request
from app.services.telemetry import ml_telemetry

router = APIRouter(tags=["Observability & Metrics"])


def _get_loaded_models_count(request: Request) -> int:
    if hasattr(request.app.state, "inference_service") and request.app.state.inference_service is not None:
        return len(getattr(request.app.state.inference_service, "_active_models", {}))
    return 0


@router.get("/metrics", summary="Prometheus Scrape Endpoint")
async def prometheus_metrics(request: Request):
    """
    Exposes application metrics formatted for Prometheus scraping (text/plain).
    """
    count = _get_loaded_models_count(request)
    content = ml_telemetry.to_prometheus_format(loaded_models_count=count)
    return Response(content=content, media_type="text/plain; version=0.0.4; charset=utf-8")


@router.get("/metrics/json", summary="JSON Metrics Snapshot")
async def json_metrics(request: Request):
    """
    Exposes application metrics as a structured JSON object.
    """
    count = _get_loaded_models_count(request)
    return ml_telemetry.to_json_snapshot(loaded_models_count=count)
