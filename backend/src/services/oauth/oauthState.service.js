import crypto from 'node:crypto';
import defaultRedisClient, { isRedisReady } from '../../config/redis.js';
import { config } from '../../config/index.js';
import { AppError } from '../../middleware/errorHandler.js';

const STATE_TTL_SECONDS = 300; // 5 minutes
const STATE_KEY_PREFIX = 'stocksense:oauth:state:';

/**
 * Atomic Redis Lua script for single-use OAuth state consumption.
 * Fetches the stored state metadata and deletes the key in a single atomic transaction.
 * If key does not exist or was already deleted, returns nil.
 */
export const ATOMIC_CONSUME_STATE_LUA = `
local val = redis.call('GET', KEYS[1])
if val then
    redis.call('DEL', KEYS[1])
    return val
else
    return nil
end
`;

export class OAuthStateService {
  /**
   * @param {Object} [options]
   * @param {Object} [options.redisClient] Injected Redis client
   * @param {number} [options.ttlSeconds=300] State TTL in seconds
   * @param {boolean} [options.allowMemoryFallback=false] Whether to allow in-memory fallback (exclusively for isolated automated tests)
   */
  constructor(options = {}) {
    const isProduction = (config?.env === 'production') || (process.env.NODE_ENV === 'production');
    this.redisClient = options.redisClient !== undefined ? options.redisClient : defaultRedisClient;
    this.ttlSeconds = options.ttlSeconds || STATE_TTL_SECONDS;
    // In production, memory fallback is strictly prohibited to guarantee distributed safety
    this.allowMemoryFallback = isProduction ? false : Boolean(options.allowMemoryFallback);
    this.memoryStore = new Map();
  }

  /**
   * Hashes a raw state string with SHA-256 for secure Redis key lookup.
   * Storing only the SHA-256 hash prevents state enumeration or leakage if cache is inspected.
   *
   * @param {string} rawState
   * @returns {string} SHA-256 hex digest
   */
  hashState(rawState) {
    return crypto.createHash('sha256').update(rawState).digest('hex');
  }

  /**
   * Generate a cryptographically secure random OAuth state and persist its hash in Redis with a 5-minute TTL.
   * Fails closed with HTTP 503 if Redis is unavailable.
   *
   * @param {Object} [metadata={}] Optional context (e.g. client IP or session info)
   * @returns {Promise<{ state: string, expiresAt: Date }>}
   */
  async createState(metadata = {}) {
    // Generate 32 bytes of cryptographically secure randomness (64 hex characters)
    const rawState = crypto.randomBytes(32).toString('hex');
    const stateHash = this.hashState(rawState);
    const redisKey = `${STATE_KEY_PREFIX}${stateHash}`;

    const now = Date.now();
    const expiresAt = new Date(now + this.ttlSeconds * 1000);

    const payload = JSON.stringify({
      createdAt: now,
      expiresAt: expiresAt.toISOString(),
      ...metadata,
    });

    if (this.redisClient && isRedisReady()) {
      try {
        await this.redisClient.set(redisKey, payload, 'EX', this.ttlSeconds);
      } catch (err) {
        if (!this.allowMemoryFallback) {
          throw new AppError(
            `OAuth state service unavailable: Redis write failed (${err.message}). Failing closed for security.`,
            503,
            'REDIS_OFFLINE'
          );
        }
        this._setMemoryState(redisKey, payload, this.ttlSeconds);
      }
    } else {
      if (!this.allowMemoryFallback) {
        throw new AppError(
          'OAuth state service unavailable: Redis cache is offline. Failing closed for security.',
          503,
          'REDIS_OFFLINE'
        );
      }
      this._setMemoryState(redisKey, payload, this.ttlSeconds);
    }

    return {
      state: rawState,
      expiresAt,
    };
  }

  /**
   * Atomically consume an OAuth state.
   * Guarantees strictly single-use consumption: if state exists, it is deleted and returned.
   * If state was already consumed, expired, or tampered with, returns { valid: false }.
   * Fails closed with HTTP 503 if Redis is unavailable.
   *
   * @param {string} rawState - Raw state parameter from callback
   * @returns {Promise<{ valid: boolean, metadata?: Object, reason?: string }>}
   */
  async consumeState(rawState) {
    if (!rawState || typeof rawState !== 'string') {
      return { valid: false, reason: 'MISSING_OR_INVALID_STATE' };
    }

    // Must be exactly 64 hexadecimal characters
    const trimmed = rawState.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return { valid: false, reason: 'MALFORMED_STATE_FORMAT' };
    }

    const stateHash = this.hashState(trimmed);
    const redisKey = `${STATE_KEY_PREFIX}${stateHash}`;

    let storedPayload = null;

    if (this.redisClient && isRedisReady()) {
      try {
        storedPayload = await this.redisClient.eval(ATOMIC_CONSUME_STATE_LUA, 1, redisKey);
      } catch (err) {
        if (!this.allowMemoryFallback) {
          throw new AppError(
            `OAuth state service unavailable: Redis read failed (${err.message}). Failing closed for security.`,
            503,
            'REDIS_OFFLINE'
          );
        }
        storedPayload = this._consumeMemoryState(redisKey);
      }
    } else {
      if (!this.allowMemoryFallback) {
        throw new AppError(
          'OAuth state service unavailable: Redis cache is offline. Failing closed for security.',
          503,
          'REDIS_OFFLINE'
        );
      }
      storedPayload = this._consumeMemoryState(redisKey);
    }

    if (!storedPayload) {
      return {
        valid: false,
        reason: 'STATE_EXPIRED_OR_ALREADY_USED',
      };
    }

    try {
      const metadata = JSON.parse(storedPayload);
      return {
        valid: true,
        metadata,
      };
    } catch {
      return {
        valid: false,
        reason: 'CORRUPTED_STATE_METADATA',
      };
    }
  }

  // In-memory fallback helper for test/offline environments
  _setMemoryState(key, payload, ttlSeconds) {
    const expires = Date.now() + ttlSeconds * 1000;
    this.memoryStore.set(key, { payload, expires });
  }

  _consumeMemoryState(key) {
    const entry = this.memoryStore.get(key);
    if (!entry) return null;
    this.memoryStore.delete(key);
    if (Date.now() > entry.expires) return null;
    return entry.payload;
  }
}

export default new OAuthStateService();
