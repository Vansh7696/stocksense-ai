import redisClient from '../config/redis.js';
import { config } from '../config/index.js';
import { AppError } from './errorHandler.js';

// Atomic Lua script to increment counter and set TTL on first key creation
const ATOMIC_INCR_EXPIRE_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return { current, ttl }
`;

/**
 * Extracts client IP address safely considering reverse proxies.
 */
export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const list = String(forwarded).split(',');
    return list[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || '127.0.0.1';
}

/**
 * Atomic Redis increment with TTL using Lua script.
 *
 * @param {string} key
 * @param {number} ttlSeconds
 * @returns {Promise<{ count: number, ttl: number }>}
 */
async function atomicIncrement(key, ttlSeconds) {
  try {
    const res = await redisClient.eval(ATOMIC_INCR_EXPIRE_LUA, 1, key, ttlSeconds);
    const count = parseInt(res[0], 10);
    const ttl = parseInt(res[1], 10);
    return { count, ttl: ttl > 0 ? ttl : ttlSeconds };
  } catch (err) {
    if (config.env === 'production') {
      throw new AppError(
        'Authentication service temporarily unavailable: Distributed rate limiter offline.',
        503,
        'RATE_LIMITER_OFFLINE'
      );
    }
    // In test environment when Redis is stopped or mocked
    throw err;
  }
}

/**
 * Query current counter value and remaining TTL without incrementing.
 *
 * @param {string} key
 * @returns {Promise<{ count: number, ttl: number }>}
 */
async function getCounterState(key) {
  try {
    const pipe = redisClient.pipeline();
    pipe.get(key);
    pipe.ttl(key);
    const results = await pipe.exec();
    const count = results[0][1] ? parseInt(results[0][1], 10) : 0;
    const ttl = results[1][1] ? parseInt(results[1][1], 10) : 0;
    return { count, ttl: ttl > 0 ? ttl : 0 };
  } catch (err) {
    if (config.env === 'production') {
      throw new AppError(
        'Authentication service temporarily unavailable: Distributed rate limiter offline.',
        503,
        'RATE_LIMITER_OFFLINE'
      );
    }
    throw err;
  }
}

/**
 * Registration Rate Limiter: Max 3 registration requests per 1 hour per IP.
 */
export async function registerRateLimiter(req, res, next) {
  const ip = getClientIp(req);
  const key = `stocksense:ratelimit:register:ip:${ip}`;
  const windowSec = 3600; // 1 hour
  const maxAttempts = 3;

  try {
    const { count, ttl } = await atomicIncrement(key, windowSec);
    if (count > maxAttempts) {
      res.setHeader('Retry-After', String(ttl));
      return next(
        new AppError(
          `Too many registration requests from this IP. Please try again in ${Math.ceil(ttl / 60)} minutes.`,
          429,
          'TOO_MANY_REGISTRATIONS'
        )
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Login Pre-Check Rate Limiter: Evaluates IP and (IP, Account) limits BEFORE password verification.
 */
export async function checkLoginRateLimit(req, res, next) {
  const ip = getClientIp(req);
  const rawEmail = req.body?.email;
  const normalizedEmail = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';

  const ipKey = `stocksense:ratelimit:login:ip:${ip}`;
  const pairKey = normalizedEmail
    ? `stocksense:ratelimit:login:pair:${ip}:${normalizedEmail}`
    : null;

  try {
    const ipState = await getCounterState(ipKey);
    if (ipState.count >= 10) {
      res.setHeader('Retry-After', String(ipState.ttl));
      return next(
        new AppError(
          `Too many failed login attempts from this network. Please try again in ${Math.ceil(ipState.ttl / 60)} minutes.`,
          429,
          'TOO_MANY_REQUESTS'
        )
      );
    }

    if (pairKey) {
      const pairState = await getCounterState(pairKey);
      if (pairState.count >= 5) {
        res.setHeader('Retry-After', String(pairState.ttl));
        return next(
          new AppError(
            `Too many failed login attempts for this account from your IP. Please try again in ${Math.ceil(pairState.ttl / 60)} minutes.`,
            429,
            'TOO_MANY_REQUESTS'
          )
        );
      }
    }

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Records a failed login attempt for the client IP, (IP, Account) pair,
 * and tracks account-level failure volume for security monitoring without account lockout.
 *
 * @param {string} ip
 * @param {string} normalizedEmail
 */
export async function recordFailedLogin(ip, normalizedEmail) {
  const windowSec = 900; // 15 minutes
  const ipKey = `stocksense:ratelimit:login:ip:${ip}`;
  const pairKey = normalizedEmail
    ? `stocksense:ratelimit:login:pair:${ip}:${normalizedEmail}`
    : null;
  const accountKey = normalizedEmail
    ? `stocksense:ratelimit:login:account:${normalizedEmail}`
    : null;

  try {
    const pipe = redisClient.pipeline();
    pipe.eval(ATOMIC_INCR_EXPIRE_LUA, 1, ipKey, windowSec);
    if (pairKey) {
      pipe.eval(ATOMIC_INCR_EXPIRE_LUA, 1, pairKey, windowSec);
    }
    if (accountKey) {
      pipe.eval(ATOMIC_INCR_EXPIRE_LUA, 1, accountKey, windowSec);
    }
    const results = await pipe.exec();

    // Account-level monitoring threshold: 15 failures per 15 minutes across any IPs (audit warning, NO lockout)
    if (accountKey && results && results.length >= 3 && results[2] && results[2][1]) {
      const accountFailures = parseInt(results[2][1][0], 10);
      if (accountFailures >= 15) {
        console.warn(
          `[Security Audit] High failed login volume detected for account "${normalizedEmail}": ${accountFailures} attempts within 15 minutes. Monitoring threshold reached (account lockout disabled to prevent DoS).`
        );
      }
    }
  } catch (err) {
    if (config.env === 'production') {
      throw new AppError(
        'Authentication service error: Failed to record security attempt.',
        503,
        'RATE_LIMITER_OFFLINE'
      );
    }
  }
}

/**
 * Resets failed attempt counter for the specific (IP, Account) pair upon successful login.
 * Note: The client IP failure counter is deliberately preserved.
 *
 * @param {string} ip
 * @param {string} normalizedEmail
 */
export async function recordSuccessfulLogin(ip, normalizedEmail) {
  if (!normalizedEmail) return;
  const pairKey = `stocksense:ratelimit:login:pair:${ip}:${normalizedEmail}`;
  try {
    await redisClient.del(pairKey);
  } catch (err) {
    // Non-fatal if reset fails
  }
}
