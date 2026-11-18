/**
 * StockSense AI — Request Correlation ID Middleware
 * Enforces distributed request traceability across Frontend -> Express API Gateway -> FastAPI ML Microservice.
 */

import crypto from 'node:crypto';

/**
 * Middleware that extracts or generates a unique correlation ID for every incoming HTTP request.
 *
 * Capabilities:
 * - Checks incoming 'X-Correlation-ID' header
 * - Sanitizes client-provided IDs (alphanumeric, hyphen, underscore; max 64 chars)
 * - Generates a cryptographically strong UUID v4 if absent or invalid
 * - Attaches `req.correlationId` to the request object
 * - Sets `X-Correlation-ID` on the outgoing response headers
 */
export function correlationIdMiddleware(req, res, next) {
  let correlationId = req.headers['x-correlation-id'];

  if (typeof correlationId === 'string' && correlationId.trim().length > 0) {
    // Sanitize client-supplied correlation ID to prevent header injection or log pollution
    correlationId = correlationId.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  }

  if (!correlationId || correlationId.length === 0) {
    correlationId = crypto.randomUUID();
  }

  req.correlationId = correlationId;
  res.setHeader('X-Correlation-ID', correlationId);

  next();
}

/**
 * Safely extracts the correlation ID from a request object.
 *
 * @param {import('express').Request} req
 * @returns {string|undefined}
 */
export function getCorrelationId(req) {
  return req?.correlationId || (typeof req?.headers?.['x-correlation-id'] === 'string' ? req.headers['x-correlation-id'] : undefined);
}

export default correlationIdMiddleware;
