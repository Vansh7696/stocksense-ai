"""
StockSense AI — Production Gunicorn Configuration for ML Microservice
Orchestrates multi-worker Uvicorn ASGI processes based on CPU availability,
with graceful teardown, request jitter to prevent memory leaks, and pre-fork optimization.
"""

import multiprocessing
import os

# Server socket
host = os.getenv("HOST", "0.0.0.0")
port = os.getenv("PORT", "8000")
bind = f"{host}:{port}"

# Worker processes
# For ML/compute-intensive inference workloads with internal multi-threading (XGBoost/OpenMP),
# recommended workers = max(1, min(cpu_count, 4)) to avoid thrashing and lock contention.
cpu_cores = multiprocessing.cpu_count()
default_workers = max(1, min(cpu_cores, 4))
workers = int(os.getenv("WEB_CONCURRENCY", str(default_workers)))
worker_class = "uvicorn.workers.UvicornWorker"

# Worker lifecycle & timeouts
timeout = int(os.getenv("WORKER_TIMEOUT", "60"))
graceful_timeout = int(os.getenv("GRACEFUL_TIMEOUT", "30"))
keepalive = int(os.getenv("KEEP_ALIVE", "5"))

# Memory recycling: restart workers periodically after max_requests to combat memory fragmentation
max_requests = int(os.getenv("MAX_REQUESTS", "2000"))
max_requests_jitter = int(os.getenv("MAX_REQUESTS_JITTER", "100"))

# Preload app: Loads models in master process before forking to leverage OS Copy-on-Write (CoW)
# saving substantial RAM across multi-worker deployments.
preload_app = os.getenv("PRELOAD_APP", "false").lower() in ("true", "1", "yes")

# Logging
loglevel = os.getenv("LOG_LEVEL", "info").lower()
accesslog = "-" if os.getenv("ACCESS_LOG", "false").lower() in ("true", "1") else None
errorlog = "-"


def on_starting(server):
    server.log.info(
        f"[Gunicorn] Initializing StockSense ML Service with {workers} Uvicorn worker(s) "
        f"(CPU cores detected: {cpu_cores}, preload_app={preload_app})"
    )


def worker_exit(server, worker):
    server.log.info(f"[Gunicorn] Worker {worker.pid} exited cleanly.")
