from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from app.config import settings
from app.api.health import router as health_router
from app.api.indicators import router as indicators_router
from app.api.features import router as features_router
from app.api.targets import router as targets_router
from app.api.inference import router as inference_router


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


@app.get("/")
async def root():
    return {
        "service": settings.app_name,
        "version": settings.version,
        "status": "healthy",
        "docs_url": "/docs",
    }
