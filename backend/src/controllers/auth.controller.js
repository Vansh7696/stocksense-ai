import { config } from '../config/index.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  generateCsrfToken,
  CSRF_COOKIE_NAME,
} from '../middleware/csrf.js';
import {
  getClientIp,
  recordFailedLogin,
  recordSuccessfulLogin,
} from '../middleware/authRateLimiter.js';
import * as authService from '../services/auth.service.js';

export const COOKIE_ACCESS_TOKEN = 'stocksense_access_token';
export const COOKIE_REFRESH_TOKEN = 'stocksense_refresh_token';

/**
 * Returns standard cookie options based on runtime environment.
 * RFC 6265bis: If SameSite is 'none', Secure MUST be true.
 */
export function getCookieOptions(maxAgeMs, path = '/') {
  const isProd = config.env === 'production';
  const sameSite = config.auth?.cookieSameSite || 'lax';
  const secure = sameSite === 'none' ? true : isProd;
  const domain = config.auth?.cookieDomain || undefined;

  const options = {
    httpOnly: true,
    secure,
    sameSite,
    path,
  };

  if (maxAgeMs !== undefined && maxAgeMs !== null) {
    options.maxAge = maxAgeMs;
  }
  if (domain) {
    options.domain = domain;
  }

  return options;
}

/**
 * Returns matching cookie options for clearing cookies (must match path, domain, secure, sameSite).
 */
export function getClearCookieOptions(path = '/') {
  const base = getCookieOptions(0, path);
  delete base.maxAge;
  return base;
}

/**
 * Attaches access and refresh token cookies to the outgoing response.
 */
function attachAuthCookies(res, accessToken, refreshToken) {
  res.cookie(
    COOKIE_ACCESS_TOKEN,
    accessToken,
    getCookieOptions(15 * 60 * 1000, '/api') // 15 minutes, scoped to /api
  );

  res.cookie(
    COOKIE_REFRESH_TOKEN,
    refreshToken,
    getCookieOptions(7 * 24 * 60 * 60 * 1000, '/api/auth') // 7 days, scoped to /api/auth
  );
}

/**
 * Clears all authentication and CSRF cookies using matching cookie attributes.
 */
function clearAuthCookies(res) {
  res.clearCookie(COOKIE_ACCESS_TOKEN, getClearCookieOptions('/api'));
  res.clearCookie(COOKIE_REFRESH_TOKEN, getClearCookieOptions('/api/auth'));
  res.clearCookie(CSRF_COOKIE_NAME, getClearCookieOptions('/api'));
}

/**
 * GET /api/auth/csrf
 * CSRF Handshake endpoint. Sets HMAC-signed CSRF cookie and returns raw token for header.
 */
export async function getCsrfToken(req, res) {
  const { rawToken, cookieValue } = generateCsrfToken();

  res.cookie(
    CSRF_COOKIE_NAME,
    cookieValue,
    getCookieOptions(7 * 24 * 60 * 60 * 1000, '/api')
  );

  return res.json({
    success: true,
    data: {
      csrfToken: rawToken,
    },
  });
}

/**
 * POST /api/auth/register
 * User registration with password policy checks and default watchlist creation.
 */
export async function register(req, res, next) {
  const { fullName, email, password } = req.body || {};

  if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) {
    return next(new AppError('Full name must be at least 2 characters.', 400, 'INVALID_REGISTRATION_DATA'));
  }

  if (!email || typeof email !== 'string') {
    return next(new AppError('A valid email address is required.', 400, 'INVALID_REGISTRATION_DATA'));
  }

  const ipAddress = getClientIp(req);
  const userAgent = req.headers['user-agent'] || null;

  try {
    const result = await authService.register({
      fullName,
      email,
      password,
      ipAddress,
      userAgent,
    });

    attachAuthCookies(res, result.accessToken, result.refreshToken);

    return res.status(201).json({
      success: true,
      data: {
        user: result.user,
      },
      message: 'User registered successfully.',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/auth/login
 * User login with dual rate limiting and timing equalization.
 */
export async function login(req, res, next) {
  const { email, password } = req.body || {};

  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    return next(new AppError('Email and password are required.', 400, 'INVALID_LOGIN_INPUT'));
  }

  const ipAddress = getClientIp(req);
  const userAgent = req.headers['user-agent'] || null;
  const normalizedEmail = email.trim().toLowerCase();

  try {
    const result = await authService.login({
      email,
      password,
      ipAddress,
      userAgent,
    });

    // Reset failed counter for this (IP, Account) pair upon success
    await recordSuccessfulLogin(ipAddress, normalizedEmail);

    attachAuthCookies(res, result.accessToken, result.refreshToken);

    return res.json({
      success: true,
      data: {
        user: result.user,
      },
      message: 'Login successful.',
    });
  } catch (err) {
    // Record failed attempt for rate limiting
    if (err.code === 'INVALID_CREDENTIALS') {
      await recordFailedLogin(ipAddress, normalizedEmail);
    }
    next(err);
  }
}

/**
 * POST /api/auth/refresh
 * One-time refresh token rotation with replay detection.
 */
export async function refresh(req, res, next) {
  const rawRefreshToken = req.cookies?.[COOKIE_REFRESH_TOKEN] || req.body?.refreshToken;

  if (!rawRefreshToken) {
    return next(
      new AppError(
        'Missing refresh token cookie or parameter.',
        400,
        'MISSING_REFRESH_TOKEN'
      )
    );
  }

  const ipAddress = getClientIp(req);
  const userAgent = req.headers['user-agent'] || null;

  try {
    const result = await authService.refresh({
      rawRefreshToken,
      ipAddress,
      userAgent,
    });

    attachAuthCookies(res, result.accessToken, result.refreshToken);

    return res.json({
      success: true,
      data: {
        user: result.user,
      },
      message: 'Session refreshed successfully.',
    });
  } catch (err) {
    // If token reuse detected, expired, revoked, or invalid, clear cookies
    if (
      err.code === 'TOKEN_REUSE_DETECTED' ||
      err.code === 'SESSION_REVOKED' ||
      err.code === 'SESSION_EXPIRED' ||
      err.code === 'REAUTHENTICATION_REQUIRED' ||
      err.code === 'INVALID_TOKEN'
    ) {
      clearAuthCookies(res);
    }
    next(err);
  }
}

/**
 * POST /api/auth/logout
 * Server-side session revocation in PostgreSQL and Redis, and cookie clearing.
 */
export async function logout(req, res, next) {
  try {
    const sessionId = req.session?.id || req.user?.sid;
    await authService.logout(sessionId);
    clearAuthCookies(res);

    return res.json({
      success: true,
      message: 'Logged out successfully.',
    });
  } catch (err) {
    clearAuthCookies(res);
    next(err);
  }
}

/**
 * GET /api/auth/me
 * Returns authenticated user profile.
 */
export async function getCurrentUser(req, res, next) {
  try {
    return res.json({
      success: true,
      data: {
        user: req.user,
      },
    });
  } catch (err) {
    next(err);
  }
}
