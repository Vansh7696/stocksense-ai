"""
StockSense AI — Python AI/ML Intelligence Microservice
Core FastAPI application bootstrap with structured logging, correlation tracking,
multi-horizon model inference, and Prometheus telemetry.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from app.config import settings
from app.core.logging import setup_logging
from app.middleware.correlation import CorrelationIdMiddleware
from app.api.health import router as health_router
from app.api.indicators import router as indicators_router
from app.api.features import router as features_router
from app.api.targets import router as targets_router
from app.api.inference import router as inference_router
from app.api.metrics import router as metrics_router
from app.api.sentiment import router as sentiment_router

# Initialize centralized structured logging
setup_logging(is_production=(settings.env == "production"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup lifecycle hook
    print(f"[ML Service] Initializing {settings.app_name} (v{settings.version})")
    print(f"[ML Service] Connected to environment: {settings.env}")
    try:
        from app.services.inference import InferenceService
        inference_service = InferenceService()
        inference_service.load_active_models()
        app.state.inference_service = inference_service
        print("[ML Service] Active inference model champions loaded into memory.")
    except Exception as e:
        print(f"[ML Service] Warning: Failed to pre-load active inference models: {e}")
        app.state.inference_service = None
    yield
    # Teardown lifecycle hook
    print("[ML Service] Shutting down AI/ML compute engine")


app = FastAPI(
    title=settings.app_name,
    version=settings.version,
    description="Microservice providing machine learning predictions, sentiment analysis, and explainability for Indian equities.",
    lifespan=lifespan,
)

# Distributed tracing & transaction logging middleware (registered first to capture full pipeline duration)
app.add_middleware(CorrelationIdMiddleware)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Route registrations
app.include_router(health_router, prefix="/api")
app.include_router(health_router)  # Also expose /health at root for health checks
app.include_router(indicators_router, prefix="/api")
app.include_router(features_router, prefix="/api")
app.include_router(targets_router, prefix="/api")
app.include_router(inference_router, prefix="/api")
app.include_router(sentiment_router)
app.include_router(metrics_router, prefix="/api")
app.include_router(metrics_router)  # Also expose /metrics at root for Prometheus scraper


@app.get("/")
async def root():
    return {
        "service": settings.app_name,
        "version": settings.version,
        "status": "healthy",
        "docs_url": "/docs",
        "metrics_url": "/metrics",
    }
