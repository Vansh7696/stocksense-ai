"""
StockSense AI — Structured JSON Logging Architecture
Provides deterministic JSON log serialization, request correlation tracking via ContextVar,
and centralized formatters for the ML microservice.
"""

import json
import logging
import sys
from datetime import datetime, timezone
from contextvars import ContextVar
from typing import Optional, Dict, Any

# ContextVar for request-scoped correlation ID propagation
correlation_id_ctx: ContextVar[str] = ContextVar("correlation_id", default="")

SERVICE_NAME = "stocksense-ml-service"


class StructuredJSONFormatter(logging.Formatter):
    """
    Serializes standard library LogRecords into standardized JSON lines.
    Output schema:
      timestamp, level, service, correlation_id, endpoint, status_code, duration_ms, message, error_details
    """

    def format(self, record: logging.LogRecord) -> str:
        log_payload: Dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "service": SERVICE_NAME,
            "message": record.getMessage(),
        }

        # Inject context correlation ID if present
        cid = correlation_id_ctx.get()
        if cid:
            log_payload["correlation_id"] = cid
        elif hasattr(record, "correlation_id") and record.correlation_id:
            log_payload["correlation_id"] = record.correlation_id

        # Inject optional HTTP transaction metadata
        if hasattr(record, "endpoint") and record.endpoint:
            log_payload["endpoint"] = record.endpoint
        if hasattr(record, "status_code") and record.status_code is not None:
            log_payload["status_code"] = record.status_code
        if hasattr(record, "duration_ms") and record.duration_ms is not None:
            log_payload["duration_ms"] = round(record.duration_ms, 2)

        # Inject exception traceback details
        if record.exc_info:
            log_payload["error_details"] = self.formatException(record.exc_info)
        elif hasattr(record, "error_details") and record.error_details:
            log_payload["error_details"] = record.error_details

        return json.dumps(log_payload)


def setup_logging(is_production: bool = False, log_level: str = "INFO") -> logging.Logger:
    """
    Initializes and configures the root logger.
    In production: outputs JSON lines to stdout.
    In development: outputs human-friendly readable formatted lines.
    """
    root_logger = logging.getLogger()
    root_logger.setLevel(getattr(logging, log_level.upper(), logging.INFO))

    # Clear existing handlers to prevent duplicate lines
    root_logger.handlers.clear()

    handler = logging.StreamHandler(sys.stdout)
    if is_production:
        handler.setFormatter(StructuredJSONFormatter())
    else:
        # Development readable format with correlation ID
        dev_fmt = "[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s"
        handler.setFormatter(logging.Formatter(dev_fmt))

    root_logger.addHandler(handler)

    # Silence noisy third-party loggers if needed
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

    return root_logger


logger = logging.getLogger(SERVICE_NAME)
