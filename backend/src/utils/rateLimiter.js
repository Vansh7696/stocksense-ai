import crypto from 'node:crypto';
import redisClient, { isRedisReady } from '../config/redis.js';
import { config } from '../config/index.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * Atomic Multi-Window Redis Lua script implementing genuine sliding-window rate limiting.
 *
 * Checks all configured windows atomically before consuming quota.
 * If ANY window is exhausted, NO quota is consumed in any window (prevents partial consumption).
 * If all windows have capacity, the request is atomically added to all windows in a single transaction.
 *
 * KEYS: Array of window keys [key1, key2, ...]
 * ARGV[1]: Current timestamp in milliseconds (now)
 * ARGV[2]: Unique request identifier (reqId)
 * ARGV[3]: Number of windows (N)
 * ARGV[4..]: Pairs of (windowMs, limit) for each window
 *
 * Returns array: [allowed (1 or 0), remainingQuota, retryAfterMs]
 */
export const ATOMIC_MULTI_WINDOW_LUA = `
local now = tonumber(ARGV[1])
local reqId = ARGV[2]
local numWindows = tonumber(ARGV[3])

-- Phase 1: Pre-check all windows without adding records (prevents partial quota consumption)
local maxRetryAfterMs = 0
local anyBlocked = false

for i = 1, numWindows do
    local key = KEYS[i]
    local windowMs = tonumber(ARGV[4 + (i - 1) * 2])
    local limit = tonumber(ARGV[5 + (i - 1) * 2])

    -- Purge expired entries older than the sliding threshold
    local clearBefore = now - windowMs
    redis.call('ZREMRANGEBYSCORE', key, '-inf', clearBefore)

    -- Count active entries in this window
    local currentCount = redis.call('ZCARD', key)

    if currentCount >= limit then
        anyBlocked = true
        local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
        local retryAfterMs = 0
        if #oldest > 0 then
            local oldestTime = tonumber(oldest[2])
            retryAfterMs = math.max(0, math.ceil((oldestTime + windowMs) - now))
        else
            retryAfterMs = windowMs
        end
        if retryAfterMs > maxRetryAfterMs then
            maxRetryAfterMs = retryAfterMs
        end
    end
end

-- If any window has exceeded its limit, abort immediately without consuming quota from any window
if anyBlocked then
    return { 0, 0, maxRetryAfterMs }
end

-- Phase 2: All windows have capacity -> Atomically record request across all windows
local minRemaining = 999999
for i = 1, numWindows do
    local key = KEYS[i]
    local windowMs = tonumber(ARGV[4 + (i - 1) * 2])
    local limit = tonumber(ARGV[5 + (i - 1) * 2])

    redis.call('ZADD', key, now, reqId)
    redis.call('PEXPIRE', key, windowMs + 2000)

    local remaining = limit - (redis.call('ZCARD', key))
    if remaining < minRemaining then
        minRemaining = remaining
    end
end

return { 1, math.max(0, minRemaining), 0 }
`;

/**
 * Single-window Lua script for standalone window instances
 */
export const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local reqId = ARGV[4]

local clearBefore = now - window
redis.call('ZREMRANGEBYSCORE', key, '-inf', clearBefore)

local currentCount = redis.call('ZCARD', key)

if currentCount < limit then
    redis.call('ZADD', key, now, reqId)
    redis.call('PEXPIRE', key, window + 2000)
    return { 1, limit - currentCount - 1, 0 }
else
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local retryAfterMs = 0
    if #oldest > 0 then
        local oldestTime = tonumber(oldest[2])
        retryAfterMs = math.max(0, math.ceil((oldestTime + window) - now))
    end
    return { 0, 0, retryAfterMs }
end
`;

/**
 * Distributed Sliding Window Limiter backed by Redis.
 * Defaults to fail_closed policy to prevent unthrottled outbound requests during Redis outages.
 */
export class DistributedSlidingWindowLimiter {
  constructor({
    name = 'default',
    windowMs = 1000,
    limit = 5,
    keyPrefix = 'stocksense:ratelimit',
    client = null,
    failSafePolicy = 'fail_closed', // Default: fail_closed (safest for multi-worker production)
  } = {}) {
    this.name = name;
    this.windowMs = windowMs;
    this.limit = limit;
    this.key = `${keyPrefix}:${name}`;
    this.client = client;
    this.failSafePolicy = failSafePolicy;

    // Optional local in-memory log: documented strictly as NOT guaranteeing multi-worker safety
    this.memoryLog = [];
  }

  getClient() {
    return this.client || (isRedisReady() ? redisClient : null);
  }

  /**
   * Local in-memory sliding window fallback.
   * NOTE: In a multi-worker production cluster, local memory cannot coordinate across processes.
   * This is provided only when explicitly configured and must never be the production default.
   */
  checkMemoryFallback(now) {
    const threshold = now - this.windowMs;
    this.memoryLog = this.memoryLog.filter((ts) => ts > threshold);

    if (this.memoryLog.length < this.limit) {
      this.memoryLog.push(now);
      return {
        allowed: true,
        remaining: this.limit - this.memoryLog.length,
        retryAfterMs: 0,
        source: 'MEMORY_FALLBACK_UNCOORDINATED',
      };
    }

    const oldest = this.memoryLog[0] || now;
    const retryAfterMs = Math.max(0, Math.ceil(oldest + this.windowMs - now));
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs,
      source: 'MEMORY_FALLBACK_UNCOORDINATED',
    };
  }

  /**
   * Atomically evaluate rate limit against Redis using Lua script.
   *
   * @param {number} [customNow] Optional timestamp in ms for deterministic testing
   * @param {string} [customReqId] Optional request identifier for deterministic testing
   * @returns {Promise<{ allowed: boolean, remaining: number, retryAfterMs: number, source: string, error?: string }>}
   */
  async check(customNow = null, customReqId = null) {
    const now = customNow || Date.now();
    const reqId = customReqId || `${now}-${crypto.randomBytes(6).toString('hex')}`;
    const client = this.getClient();

    if (!client || !isRedisReady()) {
      if (this.failSafePolicy === 'fail_closed') {
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: 1000,
          source: 'FAIL_CLOSED_REDIS_UNAVAILABLE',
          error: 'Redis rate limiter unavailable',
        };
      }
      return this.checkMemoryFallback(now);
    }

    try {
      const result = await client.eval(
        SLIDING_WINDOW_LUA,
        1,
        this.key,
        now.toString(),
        this.windowMs.toString(),
        this.limit.toString(),
        reqId
      );

      const allowed = Number(result[0]) === 1;
      const remaining = Number(result[1]);
      const retryAfterMs = Number(result[2]);

      return {
        allowed,
        remaining,
        retryAfterMs,
        source: 'REDIS_LUA',
      };
    } catch (err) {
      console.warn(`[RateLimiter:${this.name}] Redis Lua execution error: ${err.message}. Engaging fail_closed.`);
      if (this.failSafePolicy === 'fail_closed') {
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: 1000,
          source: 'FAIL_CLOSED_ERROR',
          error: err.message,
        };
      }
      return this.checkMemoryFallback(now);
    }
  }

  /**
   * Reset limiter data in Redis (used for test teardown)
   */
  async reset() {
    this.memoryLog = [];
    const client = this.getClient();
    if (client && isRedisReady()) {
      try {
        await client.del(this.key);
      } catch {
        // ignore reset error
      }
    }
  }

  /**
   * Acquire a rate limit slot, waiting asynchronously if throttled.
   * Rejects immediately if Redis is down and policy is fail_closed.
   *
   * @param {object} [options]
   * @param {number} [options.maxWaitMs=30000] Maximum milliseconds to wait before rejecting
   * @returns {Promise<boolean>}
   */
  async acquire({ maxWaitMs = 30000 } = {}) {
    const startTime = Date.now();

    while (Date.now() - startTime <= maxWaitMs) {
      const result = await this.check();
      if (result.allowed) {
        return true;
      }

      if (result.source.startsWith('FAIL_CLOSED')) {
        throw new AppError(
          'Market data provider rate limiter is unavailable (Redis offline). Requests rejected to protect quotas.',
          503,
          'RATE_LIMITER_OFFLINE',
          { limiter: this.name, error: result.error }
        );
      }

      const waitMs = Math.min(Math.max(result.retryAfterMs, 50), 1000);
      if (Date.now() - startTime + waitMs > maxWaitMs) {
        throw new AppError(
          `Rate limit wait timeout exceeded (${maxWaitMs}ms) for ${this.name}. RetryAfter: ${result.retryAfterMs}ms`,
          429,
          'PROVIDER_RATE_LIMITED',
          { limiter: this.name, retryAfterMs: result.retryAfterMs }
        );
      }

      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    throw new AppError(
      `Failed to acquire rate limit slot within ${maxWaitMs}ms for ${this.name}`,
      429,
      'PROVIDER_RATE_LIMITED'
    );
  }
}

// -------------------------------------------------------------
// Configurable Multi-Window Limit Definitions
// -------------------------------------------------------------

export function getRateLimitConfigs() {
  return {
    historicalSec: {
      key: 'stocksense:ratelimit:upstox:sec:historical',
      windowMs: 1000,
      limit: config?.upstox?.historicalRateLimit || 5,
    },
    quoteSec: {
      key: 'stocksense:ratelimit:upstox:sec:quote',
      windowMs: 1000,
      limit: config?.upstox?.quoteRateLimit || 8,
    },
    minute: {
      key: 'stocksense:ratelimit:upstox:sliding:1min',
      windowMs: 60000,
      limit: config?.upstox?.minuteRateLimit || 250,
    },
    thirtyMin: {
      key: 'stocksense:ratelimit:upstox:sliding:30min',
      windowMs: 1800000,
      limit: config?.upstox?.thirtyMinRateLimit || 1000,
    },
  };
}

// Export individual limiter instances
export const historicalSecondLimiter = new DistributedSlidingWindowLimiter({
  name: 'upstox:sec:historical',
  windowMs: 1000,
  limit: config?.upstox?.historicalRateLimit || 5,
});

export const quoteSecondLimiter = new DistributedSlidingWindowLimiter({
  name: 'upstox:sec:quote',
  windowMs: 1000,
  limit: config?.upstox?.quoteRateLimit || 8,
});

export const minuteLimiter = new DistributedSlidingWindowLimiter({
  name: 'upstox:sliding:1min',
  windowMs: 60000,
  limit: config?.upstox?.minuteRateLimit || 250,
});

export const thirtyMinLimiter = new DistributedSlidingWindowLimiter({
  name: 'upstox:sliding:30min',
  windowMs: 1800000,
  limit: config?.upstox?.thirtyMinRateLimit || 1000,
});

/**
 * Atomically check and acquire multi-window rate limit permits in a single Redis Lua call.
 * Checks 30-minute, 1-minute, and 1-second windows simultaneously.
 * If ANY window fails, ZERO quota is consumed from ANY window.
 *
 * @param {'historical' | 'quote'} [type='historical']
 * @param {object} [options]
 * @param {number} [options.customNow] Optional timestamp for deterministic testing
 * @param {string} [options.customReqId] Optional reqId for deterministic testing
 * @returns {Promise<{ allowed: boolean, remaining: number, retryAfterMs: number, source: string }>}
 */
export async function checkMultiWindowAtomic(type = 'historical', options = {}) {
  const configs = getRateLimitConfigs();
  const secondConfig = type === 'quote' ? configs.quoteSec : configs.historicalSec;

  const windows = [
    configs.thirtyMin, // Window 1: 30 min (1000 limit)
    configs.minute,    // Window 2: 1 min (250 limit)
    secondConfig,      // Window 3: 1 sec (5 or 8 limit)
  ];

  const now = options.customNow || Date.now();
  const reqId = options.customReqId || `${now}-${crypto.randomBytes(6).toString('hex')}`;

  if (!isRedisReady() || !redisClient) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: 1000,
      source: 'FAIL_CLOSED_REDIS_UNAVAILABLE',
      error: 'Redis rate limiter unavailable',
    };
  }

  const keys = windows.map((w) => w.key);
  const args = [
    now.toString(),
    reqId,
    windows.length.toString(),
    // Interleave windowMs and limit
    windows[0].windowMs.toString(),
    windows[0].limit.toString(),
    windows[1].windowMs.toString(),
    windows[1].limit.toString(),
    windows[2].windowMs.toString(),
    windows[2].limit.toString(),
  ];

  try {
    const result = await redisClient.eval(ATOMIC_MULTI_WINDOW_LUA, keys.length, ...keys, ...args);

    const allowed = Number(result[0]) === 1;
    const remaining = Number(result[1]);
    const retryAfterMs = Number(result[2]);

    return {
      allowed,
      remaining,
      retryAfterMs,
      source: 'REDIS_MULTI_WINDOW_LUA',
    };
  } catch (err) {
    console.warn(`[RateLimiter] Atomic multi-window Lua error: ${err.message}. Failing closed.`);
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: 1000,
      source: 'FAIL_CLOSED_ERROR',
      error: err.message,
    };
  }
}

/**
 * Acquire a multi-window permit before executing an Upstox API request.
 * Uses atomic multi-window Lua script to eliminate partial quota consumption.
 *
 * @param {'historical' | 'quote'} [type='historical']
 * @param {object} [options]
 * @param {number} [options.maxWaitMs=30000]
 * @returns {Promise<boolean>}
 */
export async function acquireProviderPermit(type = 'historical', options = {}) {
  const maxWaitMs = options.maxWaitMs || 30000;
  const startTime = Date.now();

  while (Date.now() - startTime <= maxWaitMs) {
    const result = await checkMultiWindowAtomic(type);

    if (result.allowed) {
      return true;
    }

    if (result.source.startsWith('FAIL_CLOSED')) {
      throw new AppError(
        'Market data provider rate limiter is unavailable (Redis offline). Requests rejected to protect quotas.',
        503,
        'RATE_LIMITER_OFFLINE',
        { error: result.error }
      );
    }

    const waitMs = Math.min(Math.max(result.retryAfterMs, 50), 1000);
    if (Date.now() - startTime + waitMs > maxWaitMs) {
      throw new AppError(
        `Rate limit wait timeout exceeded (${maxWaitMs}ms) for Upstox provider. RetryAfter: ${result.retryAfterMs}ms`,
        429,
        'PROVIDER_RATE_LIMITED',
        { retryAfterMs: result.retryAfterMs }
      );
    }

    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  throw new AppError(
    `Failed to acquire provider rate limit slot within ${maxWaitMs}ms`,
    429,
    'PROVIDER_RATE_LIMITED'
  );
}

// -------------------------------------------------------------
// Full-Jitter Retry Engine
// -------------------------------------------------------------

/**
 * Calculate full jitter backoff delay:
 * delay = random(0, min(baseDelay * 2^attempt, maxDelay))
 *
 * @param {number} attempt Current retry attempt index (0, 1, 2...)
 * @param {object} [options]
 * @param {number} [options.baseDelay=1000] Base delay in ms
 * @param {number} [options.maxDelay=10000] Maximum delay in ms
 * @returns {number} Delay in milliseconds
 */
export function calculateFullJitterDelay(attempt, { baseDelay = 1000, maxDelay = 10000 } = {}) {
  const cap = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  return Math.floor(Math.random() * cap);
}

/**
 * Parse standard HTTP Retry-After header (seconds or HTTP date string).
 *
 * @param {string | number} headerValue
 * @returns {number | null} Delay in milliseconds, or null if unparseable
 */
export function parseRetryAfterHeader(headerValue) {
  if (!headerValue) return null;

  // If header is integer seconds
  if (typeof headerValue === 'number' || /^\d+$/.test(headerValue.toString().trim())) {
    const seconds = parseInt(headerValue, 10);
    return Math.max(0, seconds * 1000);
  }

  // If header is HTTP date string (e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
  const parsedDate = Date.parse(headerValue);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }

  return null;
}

/**
 * Execute an asynchronous operation with full-jitter exponential backoff and Retry-After support.
 * Only retries HTTP 429 errors. All other errors are immediately rethrown.
 * Standardizes exhaustion to PROVIDER_RATE_LIMITED (AppError, status 429).
 *
 * @param {Function} operationFn Async function returning a promise
 * @param {object} [options]
 * @param {number} [options.maxAttempts=3] Maximum execution attempts
 * @param {number} [options.baseDelayMs=1000] Base delay in ms
 * @param {number} [options.maxDelayMs=10000] Maximum delay in ms
 * @returns {Promise<any>}
 */
export async function executeWithRetry(operationFn, options = {}) {
  const maxAttempts = options.maxAttempts || 3;
  const baseDelayMs = options.baseDelayMs || 1000;
  const maxDelayMs = options.maxDelayMs || 10000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operationFn();
    } catch (error) {
      const is429 = error?.response?.status === 429 || error?.status === 429;
      const isLastAttempt = attempt === maxAttempts - 1;

      // Non-429 errors are NEVER retried; rethrow immediately
      if (!is429) {
        throw error;
      }

      // Exhausted all retries -> Throw standardized PROVIDER_RATE_LIMITED
      if (isLastAttempt) {
        throw new AppError(
          `Market data provider rate limit exceeded. Exhausted all ${maxAttempts} retry attempts.`,
          429,
          'PROVIDER_RATE_LIMITED',
          { provider: 'UPSTOX', attempts: maxAttempts }
        );
      }

      // Check for Retry-After header
      const retryAfterHeader = error?.response?.headers?.['retry-after'];
      const parsedRetryAfterMs = parseRetryAfterHeader(retryAfterHeader);

      let delayMs;
      if (parsedRetryAfterMs !== null && parsedRetryAfterMs > 0) {
        // Respect Retry-After as minimum wait, adding minor jitter (0-250ms) to prevent thundering herd
        delayMs = parsedRetryAfterMs + Math.floor(Math.random() * 250);
      } else {
        // Full jitter exponential backoff: random(0, min(baseDelay * 2^attempt, maxDelay))
        delayMs = calculateFullJitterDelay(attempt, {
          baseDelay: baseDelayMs,
          maxDelay: maxDelayMs,
        });
      }

      console.warn(
        `[RateLimiter] Upstox HTTP 429 received. Retry attempt ${attempt + 1}/${maxAttempts} in ${delayMs}ms...`
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
