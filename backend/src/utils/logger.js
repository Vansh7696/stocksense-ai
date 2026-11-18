/**
 * StockSense AI — Structured JSON Logging Utility
 * Standardizes log formatting across services with correlation ID traceability,
 * sub-millisecond execution duration, and secret redaction.
 */

import { redactString, redactSecrets } from './crypto.js';

const SERVICE_NAME = 'stocksense-backend';
const LOG_LEVELS = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

const currentEnv = process.env.NODE_ENV || 'development';
const configuredLevel = (process.env.LOG_LEVEL || (currentEnv === 'production' ? 'INFO' : 'DEBUG')).toUpperCase();
const activeLevelWeight = LOG_LEVELS[configuredLevel] || LOG_LEVELS.INFO;

/**
 * Emits a structured log entry.
 *
 * @param {'DEBUG'|'INFO'|'WARN'|'ERROR'} level
 * @param {string} message
 * @param {Object} [meta]
 */
function emitLog(level, message, meta = {}) {
  if (currentEnv === 'test' && !process.env.ENABLE_TEST_LOGS) {
    return;
  }

  const levelWeight = LOG_LEVELS[level] || LOG_LEVELS.INFO;
  if (levelWeight < activeLevelWeight) {
    return;
  }

  const timestamp = new Date().toISOString();
  const correlationId = meta.correlationId || meta.correlation_id || undefined;
  const endpoint = meta.endpoint ? redactString(meta.endpoint) : undefined;
  const statusCode = meta.statusCode || meta.status_code || undefined;
  const durationMs = typeof meta.durationMs === 'number' ? Math.round(meta.durationMs * 100) / 100 : undefined;

  let sanitizedDetails = undefined;
  if (meta.details !== undefined && meta.details !== null) {
    sanitizedDetails = typeof meta.details === 'object' ? redactSecrets(meta.details) : redactString(String(meta.details));
  } else if (meta.error !== undefined && meta.error !== null) {
    sanitizedDetails = meta.error instanceof Error
      ? {
          name: meta.error.name,
          message: redactString(meta.error.message),
          stack: currentEnv !== 'production' ? redactString(meta.error.stack || '') : undefined,
        }
      : redactSecrets(meta.error);
  }

  const logEntry = {
    timestamp,
    level,
    service: SERVICE_NAME,
    message: redactString(message),
    ...(correlationId && { correlationId }),
    ...(endpoint && { endpoint }),
    ...(statusCode !== undefined && { statusCode }),
    ...(durationMs !== undefined && { durationMs }),
    ...(sanitizedDetails && { details: sanitizedDetails }),
  };

  if (currentEnv === 'production') {
    const jsonString = JSON.stringify(logEntry);
    if (level === 'ERROR') {
      process.stderr.write(jsonString + '\n');
    } else {
      process.stdout.write(jsonString + '\n');
    }
  } else {
    // Human-readable dev output
    const prefix = `[${timestamp}] [${level}]${correlationId ? ` [${correlationId.slice(0, 8)}]` : ''}`;
    const extra = [
      endpoint ? `(${endpoint})` : '',
      statusCode ? `Status: ${statusCode}` : '',
      durationMs ? `${durationMs}ms` : '',
    ].filter(Boolean).join(' ');

    const out = `${prefix} ${logEntry.message} ${extra}`.trim();
    if (level === 'ERROR') {
      console.error(out, sanitizedDetails || '');
    } else if (level === 'WARN') {
      console.warn(out, sanitizedDetails || '');
    } else {
      console.log(out, sanitizedDetails || '');
    }
  }
}

export const logger = {
  debug: (msg, meta) => emitLog('DEBUG', msg, meta),
  info: (msg, meta) => emitLog('INFO', msg, meta),
  warn: (msg, meta) => emitLog('WARN', msg, meta),
  error: (msg, meta) => emitLog('ERROR', msg, meta),
};

/**
 * Express middleware that measures HTTP request execution duration and emits
 * a structured log entry on response finish.
 */
export function httpLoggingMiddleware(req, res, next) {
  const startTime = process.hrtime.bigint();

  res.on('finish', () => {
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1e6;
    const statusCode = res.statusCode;
    const safeUrl = redactString(req.originalUrl || req.url || '');
    const endpoint = `${req.method} ${safeUrl}`;
    const correlationId = req.correlationId;

    const level = statusCode >= 500 ? 'ERROR' : statusCode >= 400 ? 'WARN' : 'INFO';
    const message = `HTTP ${req.method} ${safeUrl} completed`;

    emitLog(level, message, {
      correlationId,
      endpoint,
      statusCode,
      durationMs,
    });
  });

  next();
}

export default logger;
