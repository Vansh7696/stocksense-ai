import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { AppError } from './errorHandler.js';

export const CSRF_COOKIE_NAME = 'stocksense_csrf_token';

/**
 * Returns whitelisted origins for CORS and CSRF origin verification.
 */
export function getWhitelistedOrigins() {
  const origins = new Set();
  if (config.corsOrigin) {
    config.corsOrigin.split(',').forEach((o) => {
      const trimmed = o.trim();
      if (trimmed) origins.add(trimmed);
    });
  }
  origins.add('https://stocksense.ai');
  origins.add('http://localhost:5173');
  origins.add('http://localhost:5001');
  return origins;
}

/**
 * Generates a signed CSRF token pair (raw token + HMAC-signed cookie payload).
 *
 * @returns {{ rawToken: string, cookieValue: string }}
 */
export function generateCsrfToken() {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hmac = crypto
    .createHmac('sha256', config.auth.csrfSecret)
    .update(rawToken)
    .digest('hex');
  return {
    rawToken,
    cookieValue: `${rawToken}.${hmac}`,
  };
}

/**
 * Verifies a raw token against the HMAC-signed cookie value using constant-time comparisons.
 *
 * @param {string} rawToken Token from X-CSRF-Token header
 * @param {string} cookieValue Token.HMAC from stocksense_csrf_token cookie
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyCsrfToken(rawToken, cookieValue) {
  if (!rawToken || typeof rawToken !== 'string') {
    return { valid: false, reason: 'MISSING_CSRF_HEADER' };
  }
  if (!cookieValue || typeof cookieValue !== 'string') {
    return { valid: false, reason: 'MISSING_CSRF_COOKIE' };
  }

  const parts = cookieValue.split('.');
  if (parts.length !== 2) {
    return { valid: false, reason: 'INVALID_CSRF_SIGNATURE' };
  }

  const [cookieRaw, cookieHmac] = parts;

  // 1. Verify HMAC integrity of the cookie payload
  const expectedHmac = crypto
    .createHmac('sha256', config.auth.csrfSecret)
    .update(cookieRaw)
    .digest('hex');

  const cookieHmacBuf = Buffer.from(cookieHmac, 'utf8');
  const expectedHmacBuf = Buffer.from(expectedHmac, 'utf8');

  if (
    cookieHmacBuf.length !== expectedHmacBuf.length ||
    !crypto.timingSafeEqual(cookieHmacBuf, expectedHmacBuf)
  ) {
    return { valid: false, reason: 'INVALID_CSRF_SIGNATURE' };
  }

  // 2. Verify header rawToken matches the signed cookie raw token
  const rawTokenBuf = Buffer.from(rawToken, 'utf8');
  const cookieRawBuf = Buffer.from(cookieRaw, 'utf8');

  if (
    rawTokenBuf.length !== cookieRawBuf.length ||
    !crypto.timingSafeEqual(rawTokenBuf, cookieRawBuf)
  ) {
    return { valid: false, reason: 'CSRF_TOKEN_MISMATCH' };
  }

  return { valid: true };
}

/**
 * Validates request Origin and Referer headers against whitelisted origins.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function validateRequestOrigin(req) {
  const whitelisted = getWhitelistedOrigins();

  // 1. Check Origin header
  const originHeader = req.headers.origin;
  if (originHeader) {
    return whitelisted.has(originHeader);
  }

  // 2. Fallback to Referer header if Origin is omitted by browser
  const refererHeader = req.headers.referer;
  if (refererHeader) {
    try {
      const parsed = new URL(refererHeader);
      return whitelisted.has(parsed.origin);
    } catch {
      return false;
    }
  }

  // If neither Origin nor Referer is provided on a browser mutation, reject
  return false;
}

/**
 * CSRF and Origin Protection Middleware.
 *
 * Rules:
 * 1. Safe methods (GET, HEAD, OPTIONS) bypass CSRF validation.
 * 2. Pure Bearer requests (Authorization: Bearer <token> with NO auth cookies) bypass CSRF validation.
 * 3. Requests carrying auth cookies (even if an Authorization header is ALSO present) MUST pass:
 *    a) Exact Origin/Referer verification.
 *    b) Signed double-submit X-CSRF-Token validation.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function csrfProtection(req, res, next) {
  const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
  if (safeMethods.has(req.method)) {
    return next();
  }

  const hasAuthCookies = Boolean(
    req.cookies?.stocksense_access_token || req.cookies?.stocksense_refresh_token
  );
  const hasBearerHeader = Boolean(
    req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
  );

  // Exemption: Pure Bearer-token requests without any auth cookies
  if (!hasAuthCookies && hasBearerHeader) {
    return next();
  }

  // Strict Origin / Referer Validation
  if (!validateRequestOrigin(req)) {
    return next(
      new AppError(
        'Forbidden: Cross-site request rejected. Untrusted or missing request origin.',
        403,
        'FORBIDDEN_ORIGIN'
      )
    );
  }

  // Double-Submit Token & Signed Cookie Verification
  const rawToken = req.headers['x-csrf-token'];
  const cookieValue = req.cookies?.[CSRF_COOKIE_NAME];

  const verification = verifyCsrfToken(rawToken, cookieValue);
  if (!verification.valid) {
    if (verification.reason === 'MISSING_CSRF_HEADER' || verification.reason === 'MISSING_CSRF_COOKIE') {
      return next(
        new AppError(
          'Forbidden: Missing CSRF token in request header (X-CSRF-Token) or cookie.',
          403,
          'MISSING_CSRF_TOKEN'
        )
      );
    }
    if (verification.reason === 'INVALID_CSRF_SIGNATURE') {
      return next(
        new AppError(
          'Forbidden: CSRF cookie signature verification failed.',
          403,
          'INVALID_CSRF_SIGNATURE'
        )
      );
    }
    return next(
      new AppError(
        'Forbidden: CSRF token in header does not match authenticated session cookie.',
        403,
        'CSRF_TOKEN_MISMATCH'
      )
    );
  }

  next();
}
