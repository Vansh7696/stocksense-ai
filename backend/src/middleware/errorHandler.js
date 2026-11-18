import { redactString, redactSecrets } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { getCorrelationId } from './correlationId.js';

export const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const message = redactString(err.message || 'Internal Server Error');
  const safeUrl = redactString(req.originalUrl || req.url || '');
  const correlationId = getCorrelationId(req);

  logger.error(message, {
    correlationId,
    endpoint: `${req.method} ${safeUrl}`,
    statusCode,
    error: err,
  });

  res.status(statusCode).json({
    success: false,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message,
      details: err.details
        ? (typeof err.details === 'object' ? redactSecrets(err.details) : redactString(String(err.details)))
        : null,
    },
    meta: {
      timestamp: new Date().toISOString(),
      path: safeUrl,
      ...(correlationId && { correlationId }),
    },
  });
};

export class AppError extends Error {
  constructor(message, statusCode = 500, code = 'APP_ERROR', details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}
