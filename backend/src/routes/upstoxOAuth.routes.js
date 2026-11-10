import { Router } from 'express';
import upstoxOAuthController from '../controllers/upstoxOAuth.controller.js';
import defaultRedisClient, { isRedisReady } from '../config/redis.js';
import { config } from '../config/index.js';
import { AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * Atomic Redis Lua script for shared distributed rate limiting.
 * Evaluates current count and sets expiry atomically in a single transaction.
 */
export const ATOMIC_OAUTH_RATE_LIMIT_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])

local current = redis.call('INCR', key)
if current == 1 then
    redis.call('EXPIRE', key, window)
end

if current > limit then
    local ttl = redis.call('TTL', key)
    return { 0, current, ttl }
else
    return { 1, limit - current, 0 }
end
`;

/**
 * Safely extracts client IP for rate limiting.
 * Avoids trusting arbitrary spoofed X-Forwarded-For headers from untrusted proxies.
 * Normalizes IPv6 loopback addresses (::1 / ::ffff:127.0.0.1) to 127.0.0.1.
 *
 * @param {import('express').Request} req
 * @returns {string} Sanitized client IP
 */
export function getSafeClientIp(req) {
  const rawIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
  if (rawIp === '::1' || rawIp === '::ffff:127.0.0.1') {
    return '127.0.0.1';
  }
  return rawIp.replace(/^::ffff:/, '');
}

export class DistributedOAuthRateLimiter {
  /**
   * @param {Object} [options]
   * @param {Object} [options.redisClient] Injected Redis client
   * @param {number} [options.limit=10] Max attempts allowed in window
   * @param {number} [options.windowSeconds=60] Sliding window in seconds
   * @param {boolean} [options.allowMemoryFallback=false] Whether in-memory fallback is allowed (tests only)
   */
  constructor(options = {}) {
    const isProduction = (config?.env === 'production') || (process.env.NODE_ENV === 'production');
    this.redisClient = options.redisClient !== undefined ? options.redisClient : defaultRedisClient;
    this.limit = options.limit || 10; // 10 attempts
    this.windowSeconds = options.windowSeconds || 60; // 1 minute
    // In production, memory fallback is strictly prohibited to guarantee cross-worker safety
    this.allowMemoryFallback = isProduction ? false : Boolean(options.allowMemoryFallback);
    this.memoryStore = new Map();
  }

  /**
   * Check rate limit quota for client IP.
   *
   * @param {string} clientIp
   * @returns {Promise<{ allowed: boolean, currentCount: number, retryAfter: number }>}
   */
  async checkLimit(clientIp) {
    const key = `stocksense:ratelimit:oauth:start:${clientIp}`;

    if (this.redisClient && isRedisReady()) {
      try {
        const res = await this.redisClient.eval(
          ATOMIC_OAUTH_RATE_LIMIT_LUA,
          1,
          key,
          this.limit,
          this.windowSeconds
        );
        const allowed = Number(res[0]) === 1;
        const currentCount = Number(res[1]);
        const retryAfter = Number(res[2]);
        return { allowed, currentCount, retryAfter };
      } catch (err) {
        if (!this.allowMemoryFallback) {
          throw new AppError(
            `OAuth rate limiter unavailable: Redis error (${err.message}). Failing closed for security.`,
            503,
            'RATE_LIMITER_OFFLINE'
          );
        }
      }
    } else {
      if (!this.allowMemoryFallback) {
        throw new AppError(
          'OAuth rate limiter unavailable: Redis cache is offline. Failing closed for security.',
          503,
          'RATE_LIMITER_OFFLINE'
        );
      }
    }

    // In-memory fallback exclusively for isolated unit testing
    const now = Date.now();
    const entry = this.memoryStore.get(clientIp) || { count: 0, resetTime: now + this.windowSeconds * 1000 };
    if (now > entry.resetTime) {
      entry.count = 1;
      entry.resetTime = now + this.windowSeconds * 1000;
    } else {
      entry.count += 1;
    }
    this.memoryStore.set(clientIp, entry);

    if (entry.count > this.limit) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetTime - now) / 1000));
      return { allowed: false, currentCount: entry.count, retryAfter };
    }
    return { allowed: true, currentCount: entry.count, retryAfter: 0 };
  }

  middleware = async (req, res, next) => {
    try {
      const clientIp = getSafeClientIp(req);
      const result = await this.checkLimit(clientIp);

      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfter || this.windowSeconds));
        return next(
          new AppError(
            `Too many OAuth initiation requests. Please wait ${result.retryAfter || this.windowSeconds}s before retrying.`,
            429,
            'TOO_MANY_REQUESTS'
          )
        );
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

export const defaultOAuthRateLimiter = new DistributedOAuthRateLimiter();
export const oauthRateLimiter = defaultOAuthRateLimiter.middleware;

/**
 * Strict anti-caching and privacy headers for all OAuth routes.
 * Ensures credentials, tokens, authorization codes, and states are never cached by proxies or browsers.
 */
export const oauthSecurityHeadersMiddleware = (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Referrer-Policy', 'no-referrer');
  next();
};

router.use(oauthSecurityHeadersMiddleware);

// 1. Authorization initiation (official endpoint and alias)
router.get('/start', oauthRateLimiter, upstoxOAuthController.start);
router.get('/login', oauthRateLimiter, upstoxOAuthController.start);

// 2. OAuth callback endpoint (receives code and state)
router.get('/callback', upstoxOAuthController.callback);

// 3. Token configuration & health status (safe metadata only)
router.get('/status', upstoxOAuthController.status);

// 4. Session disconnect & credential clear (Protected: Requires authenticated user/admin)
router.post('/disconnect', requireAuth, upstoxOAuthController.disconnect);

export default router;
