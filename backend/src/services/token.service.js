import prisma from '../config/prisma.js';
import redisClient, { isRedisReady } from '../config/redis.js';
import { config } from '../config/index.js';
import { encrypt, decrypt } from '../utils/crypto.js';

const SYSTEM_CONFIG_KEY = 'UPSTOX_AUTH_TOKEN_ENCRYPTED';
const REDIS_TOKEN_CACHE_KEY = 'stocksense:auth:upstox:token';

class TokenService {
  /**
   * Calculate 03:30 AM IST of the following calendar day (or today if currently before 03:30 AM IST).
   * Upstox access tokens strictly expire at 03:30 AM IST every trading day.
   *
   * @param {Date | number | string} [referenceDate] Optional reference date for deterministic testing
   * @returns {Date} Expiry timestamp in UTC representing 03:30 AM IST
   */
  calculateUpstoxExpiryDate(referenceDate = null) {
    const now = referenceDate ? new Date(referenceDate) : new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(now.getTime() + istOffsetMs);

    const istHours = istTime.getUTCHours();
    const istMinutes = istTime.getUTCMinutes();

    const targetIst = new Date(istTime);
    // If it's already past 03:30 AM IST today, expiry boundary is tomorrow at 03:30 AM IST
    if (istHours > 3 || (istHours === 3 && istMinutes >= 30)) {
      targetIst.setUTCDate(targetIst.getUTCDate() + 1);
    }
    targetIst.setUTCHours(3, 30, 0, 0);

    return new Date(targetIst.getTime() - istOffsetMs);
  }

  /**
   * Encrypt and persist Upstox Access Token in PostgreSQL and Redis.
   *
   * @param {string} token Raw access token
   * @param {Date} [customExpiresAt] Optional custom expiration date (defaults to 03:30 AM IST)
   * @returns {Promise<{ success: boolean, expiresAt: string }>}
   */
  async saveAccessToken(token, customExpiresAt = null) {
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      throw new Error('[TokenService] Invalid access token provided: Must be a non-empty string');
    }

    const encrypted = encrypt(token);
    const expiresAt = customExpiresAt || this.calculateUpstoxExpiryDate();

    const payload = {
      ...encrypted,
      expiresAt: expiresAt.toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const serialized = JSON.stringify(payload);

    // 1. Persist encrypted payload in PostgreSQL system_configs
    await prisma.systemConfig.upsert({
      where: { key: SYSTEM_CONFIG_KEY },
      update: { value: serialized },
      create: { key: SYSTEM_CONFIG_KEY, value: serialized },
    });

    // 2. Cache encrypted payload in Redis with TTL strictly bounded by expiresAt
    if (isRedisReady() && redisClient) {
      try {
        const remainingMs = expiresAt.getTime() - Date.now();
        // Redis TTL must NEVER extend past the token's real expiresAt timestamp
        if (remainingMs > 0) {
          const ttlSeconds = Math.max(1, Math.floor(remainingMs / 1000));
          await redisClient.set(REDIS_TOKEN_CACHE_KEY, serialized, 'EX', ttlSeconds);
        }
      } catch (err) {
        console.warn(`[TokenService] Redis token caching warning: ${err.message}`);
      }
    }

    return { success: true, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Retrieve active decrypted token (returns null if missing, corrupted, or expired at 03:30 AM IST).
   *
   * @param {Date | number | string} [customNow] Optional clock injection for deterministic testing
   * @returns {Promise<string | null>} Decrypted access token or null
   */
  async getAccessToken(customNow = null) {
    // If an environment variable token override exists, respect it
    if (config?.upstox?.accessToken) {
      return config.upstox.accessToken;
    }

    let payload = null;

    // 1. Try Redis cache
    if (isRedisReady() && redisClient) {
      try {
        const cached = await redisClient.get(REDIS_TOKEN_CACHE_KEY);
        if (cached) {
          payload = JSON.parse(cached);
        }
      } catch {
        // Fall back to database
      }
    }

    // 2. Try PostgreSQL system_configs
    if (!payload) {
      try {
        const record = await prisma.systemConfig.findUnique({
          where: { key: SYSTEM_CONFIG_KEY },
        });
        if (record) {
          payload = JSON.parse(record.value);
        }
      } catch (err) {
        console.warn(`[TokenService] Database query error or malformed JSON: ${err.message}`);
        return null;
      }
    }

    if (!payload) {
      return null;
    }

    // 3. Verify 03:30 AM IST expiration against customNow or current time
    if (!payload.expiresAt) {
      return null;
    }

    const expiry = new Date(payload.expiresAt);
    const nowTime = customNow ? new Date(customNow).getTime() : Date.now();

    if (Number.isNaN(expiry.getTime()) || nowTime >= expiry.getTime()) {
      return null;
    }

    // 4. Decrypt token using AES-256-GCM
    try {
      return decrypt({
        iv: payload.iv,
        authTag: payload.authTag,
        ciphertext: payload.ciphertext,
      });
    } catch (err) {
      console.error(`[TokenService] Failed to decrypt stored token: ${err.message}`);
      return null;
    }
  }

  /**
   * Return token status metadata without exposing the raw secret.
   * Explicitly returns REAUTHORIZATION_REQUIRED when token is missing, expired, or invalid.
   *
   * @param {Date | number | string} [customNow] Optional clock injection for deterministic testing
   * @returns {Promise<{ configured: boolean, active: boolean, code: string, expiresAt?: string, source: string, reason: string }>}
   */
  async getTokenStatus(customNow = null) {
    try {
      if (config?.upstox?.accessToken) {
        return {
          configured: true,
          active: true,
          code: 'ACTIVE',
          source: 'ENVIRONMENT_VARIABLE',
          expiresAt: 'Static .env override',
          reason: 'Active (Static Override)',
        };
      }

      const record = await prisma.systemConfig.findUnique({
        where: { key: SYSTEM_CONFIG_KEY },
      });

      if (!record) {
        return {
          configured: false,
          active: false,
          code: 'REAUTHORIZATION_REQUIRED',
          source: 'DATABASE',
          reason: 'No token stored. Complete OAuth login at /api/auth/upstox/login',
        };
      }

      let payload;
      try {
        payload = JSON.parse(record.value);
      } catch {
        return {
          configured: true,
          active: false,
          code: 'REAUTHORIZATION_REQUIRED',
          source: 'DATABASE',
          reason: 'Stored token payload is corrupted JSON. Re-authorization required.',
        };
      }

      if (!payload.expiresAt || !payload.iv || !payload.authTag || !payload.ciphertext) {
        return {
          configured: true,
          active: false,
          code: 'REAUTHORIZATION_REQUIRED',
          source: 'DATABASE',
          reason: 'Stored token payload is incomplete or malformed. Re-authorization required.',
        };
      }

      const expiry = new Date(payload.expiresAt);
      const nowTime = customNow ? new Date(customNow).getTime() : Date.now();
      const isExpired = Number.isNaN(expiry.getTime()) || nowTime >= expiry.getTime();

      if (isExpired) {
        return {
          configured: true,
          active: false,
          code: 'REAUTHORIZATION_REQUIRED',
          expiresAt: payload.expiresAt,
          source: 'DATABASE_ENCRYPTED_AES256GCM',
          reason: 'Daily token expired at 03:30 AM IST. Re-authorization required.',
        };
      }

      return {
        configured: true,
        active: true,
        code: 'ACTIVE',
        expiresAt: payload.expiresAt,
        source: 'DATABASE_ENCRYPTED_AES256GCM',
        reason: 'Active',
      };
    } catch (err) {
      return {
        configured: false,
        active: false,
        code: 'REAUTHORIZATION_REQUIRED',
        source: 'ERROR',
        reason: err.message,
      };
    }
  }

  /**
   * Clear active token from database and cache.
   *
   * @returns {Promise<{ success: boolean }>}
   */
  async clearToken() {
    try {
      await prisma.systemConfig.deleteMany({
        where: { key: SYSTEM_CONFIG_KEY },
      });
      if (isRedisReady() && redisClient) {
        await redisClient.del(REDIS_TOKEN_CACHE_KEY);
      }
      return { success: true };
    } catch (err) {
      console.warn(`[TokenService] Clear token warning: ${err.message}`);
      return { success: false, error: err.message };
    }
  }
}

export default new TokenService();
