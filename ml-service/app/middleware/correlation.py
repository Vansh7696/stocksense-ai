"""
StockSense AI — ML Service Correlation ID & Request Logging Middleware
Extracts incoming X-Correlation-ID headers, sets request context, measures processing latencies,
and emits structured transaction logs.
"""

import time
import uuid
import re
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from app.core.logging import correlation_id_ctx, logger

# Strict regex matching alphanumeric, hyphens, and underscores up to 64 chars
SANITY_REGEX = re.compile(r"[^a-zA-Z0-9_-]")


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    """
    HTTP Middleware enforcing distributed request correlation and structured transaction telemetry.
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        # 1. Extract or generate correlation ID
        incoming_cid = request.headers.get("X-Correlation-ID") or request.headers.get("x-correlation-id")

        if incoming_cid:
            cleaned_cid = SANITY_REGEX.sub("", incoming_cid.strip())[:64]
            correlation_id = cleaned_cid if cleaned_cid else str(uuid.uuid4())
        else:
            correlation_id = str(uuid.uuid4())

        # 2. Store in ContextVar for request-scoped logger access
        token = correlation_id_ctx.set(correlation_id)
        request.state.correlation_id = correlation_id

        start_time = time.perf_counter()
        endpoint = f"{request.method} {request.url.path}"

        try:
            response = await call_next(request)
            duration_ms = (time.perf_counter() - start_time) * 1000.0

            # Attach correlation ID to response headers
            response.headers["X-Correlation-ID"] = correlation_id

            # Emit structured access log
            level = logger.error if response.status_code >= 500 else (logger.warning if response.status_code >= 400 else logger.info)
            level(
                f"HTTP {request.method} {request.url.path} completed with status {response.status_code}",
                extra={
                    "endpoint": endpoint,
                    "status_code": response.status_code,
                    "duration_ms": duration_ms,
                    "correlation_id": correlation_id,
                },
            )

            return response
        except Exception as exc:
            duration_ms = (time.perf_counter() - start_time) * 1000.0
            logger.error(
                f"Unhandled exception processing {endpoint}: {exc}",
                exc_info=True,
                extra={
                    "endpoint": endpoint,
                    "status_code": 500,
                    "duration_ms": duration_ms,
                    "correlation_id": correlation_id,
                },
            )
            raise exc
        finally:
            correlation_id_ctx.reset(token)
