import defaultRedisClient, { isRedisReady } from '../config/redis.js';
import { safeJsonStringify } from '../utils/json.js';

export const CACHE_PREFIX = 'stocksense:cache';

export const CACHE_TTL = {
  DEFAULT: 300,            // 5 minutes default
  STOCKS_LIST: 300,        // 5 minutes
  STOCK_DETAIL: 600,       // 10 minutes
  STOCK_SEARCH: 120,       // 2 minutes
  MARKET_OVERVIEW: 30,     // 30 seconds
  MARKET_INDICES: 300,     // 5 minutes
  STOCK_PRICES: 300,       // 5 minutes
  STOCK_INDICATORS: 300,   // 5 minutes
};

/**
 * Normalizes query parameters into a deterministic, sorted query string
 * to prevent cache key collisions from argument reordering.
 *
 * @param {Object} [params]
 * @returns {string} e.g. "exchange=NSE&limit=20&page=1"
 */
export function buildDeterministicQueryString(params = {}) {
  if (!params || typeof params !== 'object') return '';

  const entries = Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) return '';

  return entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v).trim())}`)
    .join('&');
}

export class CacheService {
  /**
   * @param {Object} [options]
   * @param {Object} [options.redisClient] Injected Redis client
   */
  constructor(options = {}) {
    this.redisClient = options.redisClient !== undefined ? options.redisClient : defaultRedisClient;
  }

  /**
   * Checks whether the active Redis client is connected and ready.
   *
   * @returns {boolean}
   */
  isAvailable() {
    if (!this.redisClient) return false;
    if (this.redisClient === defaultRedisClient) {
      return isRedisReady();
    }
    return this.redisClient.status === undefined || this.redisClient.status === 'ready';
  }

  /**
   * Builds a standardized, namespaced cache key.
   *
   * @param {string} namespace e.g. "stocks:list", "market:overview"
   * @param {string} [identifier] e.g. stock ID, query string
   * @returns {string}
   */
  buildKey(namespace, identifier = '') {
    const cleanNs = namespace.replace(/^:+|:+$/g, '');
    if (!identifier) {
      return `${CACHE_PREFIX}:${cleanNs}`;
    }
    return `${CACHE_PREFIX}:${cleanNs}:${identifier}`;
  }

  /**
   * Builds a standardized cache key with normalized query parameters.
   *
   * @param {string} namespace
   * @param {Object} params
   * @returns {string}
   */
  buildDeterministicKey(namespace, params = {}) {
    const queryString = buildDeterministicQueryString(params);
    return this.buildKey(namespace, queryString);
  }

  /**
   * Retrieves a cached value from Redis.
   * Graceful degradation: returns null on Redis outage or deserialization error.
   *
   * @param {string} key
   * @returns {Promise<any|null>}
   */
  async get(key) {
    if (!this.isAvailable()) return null;

    try {
      const raw = await this.redisClient.get(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      // Pass through on Redis read error
      return null;
    }
  }

  /**
   * Sets a value in Redis with TTL expiration.
   * Only caches truthy, successful responses.
   *
   * @param {string} key
   * @param {any} data
   * @param {number} ttlSeconds
   * @returns {Promise<boolean>}
   */
  async set(key, data, ttlSeconds) {
    if (!this.isAvailable() || data === undefined || data === null) {
      return false;
    }

    try {
      const serialized = safeJsonStringify(data);
      const res = await this.redisClient.set(key, serialized, 'EX', ttlSeconds);
      return res === 'OK';
    } catch {
      // Fail open on Redis write error
      return false;
    }
  }

  /**
   * Deletes a specific cache key.
   *
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async del(key) {
    if (!this.isAvailable()) return false;

    try {
      await this.redisClient.del(key);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Invalidates all cache keys matching a pattern.
   * Safe pattern scanner that never blocks the Redis event loop.
   *
   * @param {string} pattern e.g. "stocksense:cache:stocks:*"
   * @returns {Promise<number>} Number of keys removed
   */
  async invalidatePattern(pattern) {
    if (!this.isAvailable()) return 0;

    try {
      // In ioredis, scanStream is safe and non-blocking
      let cursor = '0';
      let deletedCount = 0;

      do {
        const [nextCursor, keys] = await this.redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;

        if (keys.length > 0) {
          const deleted = await this.redisClient.del(...keys);
          deletedCount += deleted;
        }
      } while (cursor !== '0');

      return deletedCount;
    } catch {
      return 0;
    }
  }

  /**
   * Invalidates historical price caches for a specific stock (or all stocks if not provided).
   * Targeted invalidation that never purges unrelated stock detail or market overview caches.
   *
   * @param {string} [stockId]
   * @returns {Promise<number>}
   */
  async invalidateStockPricesCache(stockId = null) {
    const pricesPattern = stockId
      ? `${CACHE_PREFIX}:stocks:prices:${stockId}:*`
      : `${CACHE_PREFIX}:stocks:prices:*`;
    const indicatorsPattern = stockId
      ? `${CACHE_PREFIX}:stocks:indicators:${stockId}:*`
      : `${CACHE_PREFIX}:stocks:indicators:*`;
    const [c1, c2] = await Promise.all([
      this.invalidatePattern(pricesPattern),
      this.invalidatePattern(indicatorsPattern),
    ]);
    return c1 + c2;
  }

  /**
   * Invalidates all stock catalogue and market overview caches following instrument ingestion.
   *
   * @returns {Promise<number>}
   */
  async invalidateStockCatalogueCache() {
    const p1 = this.invalidatePattern(`${CACHE_PREFIX}:stocks:*`);
    const p2 = this.invalidatePattern(`${CACHE_PREFIX}:market:*`);
    const [c1, c2] = await Promise.all([p1, p2]);
    return c1 + c2;
  }

  /**
   * Cache-aside helper: retrieves from cache or fetches from primary source and caches.
   *
   * @param {string} key
   * @param {number} ttlSeconds
   * @param {Function} fetcherFn Async function returning fresh data
   * @returns {Promise<{ data: any, cached: boolean }>}
   */
  async getOrSet(key, ttlSeconds, fetcherFn) {
    const cached = await this.get(key);
    if (cached !== null) {
      return { data: cached, cached: true };
    }

    const freshData = await fetcherFn();
    if (freshData !== undefined && freshData !== null) {
      await this.set(key, freshData, ttlSeconds);
    }

    return { data: freshData, cached: false };
  }
}

export default new CacheService();
