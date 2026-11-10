import { Router } from 'express';
import {
  getCsrfToken,
  register,
  login,
  refresh,
  logout,
  getCurrentUser,
} from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';
import {
  registerRateLimiter,
  checkLoginRateLimit,
} from '../middleware/authRateLimiter.js';

const router = Router();

/**
 * GET /api/auth/csrf
 * CSRF handshake endpoint setting signed HMAC cookie and returning raw token.
 */
router.get('/csrf', getCsrfToken);

/**
 * POST /api/auth/register
 * User registration with IP rate limiting and CSRF protection.
 */
router.post('/register', registerRateLimiter, csrfProtection, register);

/**
 * POST /api/auth/login
 * User login with dual rate limiting, CSRF protection, and timing equalization.
 */
router.post('/login', checkLoginRateLimit, csrfProtection, login);

/**
 * POST /api/auth/refresh
 * One-time refresh token rotation with replay detection.
 */
router.post('/refresh', csrfProtection, refresh);

/**
 * POST /api/auth/logout
 * Session revocation in PostgreSQL and Redis, and cookie clearing.
 */
router.post('/logout', csrfProtection, (req, res, next) => {
  // Try requireAuth but do not block if token expired, so logout always clears cookies
  requireAuth(req, res, (err) => {
    // Proceed to controller regardless of token expiration
    logout(req, res, next);
  });
});

/**
 * GET /api/auth/me
 * Returns authenticated user profile.
 */
router.get('/me', requireAuth, getCurrentUser);

export default router;
