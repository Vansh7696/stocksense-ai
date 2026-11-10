import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Prioritize backend/.env regardless of current working directory
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

export const INSECURE_JWT_SECRETS = new Set([
  'dev_super_secret_jwt_key_stocksense',
  'super_secret_jwt_key_change_in_production_stocksense_ai',
  'your_jwt_secret_minimum_32_characters_here',
  'your_jwt_secret_key_minimum_32_characters_here',
  'secret',
  'jwt_secret',
  'changeme',
]);

export const INSECURE_ENCRYPTION_KEYS = new Set([
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
  'your_64_character_hex_encryption_key_here',
]);

/**
 * Validates the JWT secret for the specified runtime environment.
 * In production:
 * - Throws a fatal error if JWT_SECRET is missing or empty.
 * - Throws a fatal error if JWT_SECRET matches a known insecure placeholder or fallback.
 * - Throws a fatal error if JWT_SECRET is shorter than 32 characters.
 * In non-production (development / test):
 * - Returns the provided secret, or a safe development fallback if unset.
 *
 * @param {string} [secret]
 * @param {string} [env]
 * @returns {string} Validated secret
 */
export function validateJwtSecret(secret, env) {
  const resolvedEnv = env !== undefined ? env : (process.env.NODE_ENV || 'development');
  const resolvedSecret = arguments.length >= 1 ? secret : process.env.JWT_SECRET;
  const isProduction = resolvedEnv === 'production';

  if (!resolvedSecret || typeof resolvedSecret !== 'string' || resolvedSecret.trim().length === 0) {
    if (isProduction) {
      throw new Error(
        'Fatal configuration error: JWT_SECRET environment variable is mandatory in production.'
      );
    }
    return 'dev_super_secret_jwt_key_stocksense';
  }

  const trimmed = resolvedSecret.trim();

  if (isProduction) {
    if (INSECURE_JWT_SECRETS.has(trimmed)) {
      throw new Error(
        'Fatal configuration error: Insecure or placeholder JWT_SECRET cannot be used in production.'
      );
    }
    if (trimmed.length < 32) {
      throw new Error(
        `Fatal configuration error: JWT_SECRET in production must be at least 32 characters long for cryptographic security (was ${trimmed.length}).`
      );
    }
  }

  return trimmed;
}

/**
 * Validates the AES-256-GCM application encryption key.
 * In non-test environments (production, development):
 * - Throws a fatal configuration error if APP_ENCRYPTION_KEY is missing or empty.
 * - Throws a fatal configuration error if APP_ENCRYPTION_KEY is not a valid 64-hex character string.
 * - In production: throws a fatal error if APP_ENCRYPTION_KEY matches a known sample or placeholder key.
 * In test environment:
 * - Injects an isolated deterministic test key if APP_ENCRYPTION_KEY is unset to preserve test execution.
 *
 * @param {string} [key]
 * @param {string} [env]
 * @returns {string} 64-character hexadecimal key
 */
export function validateAppEncryptionKey(key, env) {
  const resolvedEnv = env !== undefined ? env : (process.env.NODE_ENV || 'development');
  const resolvedKey = arguments.length >= 1 ? key : process.env.APP_ENCRYPTION_KEY;
  const isTest = resolvedEnv === 'test';
  const isProduction = resolvedEnv === 'production';

  if (!resolvedKey || typeof resolvedKey !== 'string' || resolvedKey.trim().length === 0) {
    if (isTest) {
      // In isolated test environments, use deterministic test-only key if none provided
      return '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    }
    throw new Error(
      'Fatal configuration error: APP_ENCRYPTION_KEY environment variable is mandatory in non-test environments. A 64-character hexadecimal key (32 bytes) is required.'
    );
  }

  const trimmed = resolvedKey.trim();
  const hexRegex = /^[0-9a-fA-F]{64}$/;

  if (!hexRegex.test(trimmed)) {
    throw new Error(
      `Fatal configuration error: APP_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes), received ${trimmed.length} characters.`
    );
  }

  if (isProduction && INSECURE_ENCRYPTION_KEYS.has(trimmed.toLowerCase())) {
    throw new Error(
      'Fatal configuration error: Known sample or placeholder APP_ENCRYPTION_KEY cannot be used in production.'
    );
  }

  return trimmed;
}

/**
 * Validates the HMAC CSRF secret for the specified runtime environment.
 *
 * @param {string} [secret]
 * @param {string} [env]
 * @returns {string} Validated CSRF secret
 */
export function validateCsrfSecret(secret, env) {
  const resolvedEnv = env !== undefined ? env : (process.env.NODE_ENV || 'development');
  const resolvedSecret = arguments.length >= 1 ? secret : process.env.CSRF_SECRET;
  const isProduction = resolvedEnv === 'production';

  if (!resolvedSecret || typeof resolvedSecret !== 'string' || resolvedSecret.trim().length === 0) {
    if (isProduction) {
      throw new Error(
        'Fatal configuration error: CSRF_SECRET environment variable is mandatory in production.'
      );
    }
    return 'dev_super_secret_csrf_hmac_signing_key_32chars!';
  }

  const trimmed = resolvedSecret.trim();

  if (isProduction) {
    if (trimmed === 'dev_super_secret_csrf_hmac_signing_key_32chars!') {
      throw new Error(
        'Fatal configuration error: Insecure or placeholder CSRF_SECRET cannot be used in production.'
      );
    }
    if (trimmed.length < 32) {
      throw new Error(
        `Fatal configuration error: CSRF_SECRET in production must be at least 32 characters long (was ${trimmed.length}).`
      );
    }
  }

  return trimmed;
}

const currentEnv = process.env.NODE_ENV || 'development';

export const config = {
  env: currentEnv,
  port: parseInt(process.env.PORT || '5001', 10),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  jwt: {
    secret: validateJwtSecret(process.env.JWT_SECRET, currentEnv),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    algorithm: 'HS256',
    userAuthSecret: validateJwtSecret(
      process.env.JWT_USER_AUTH_SECRET || process.env.JWT_SECRET,
      currentEnv
    ),
    accessTokenExpiresIn: '15m',
    issuer: 'stocksense-api',
    audience: 'stocksense-client',
  },
  auth: {
    csrfSecret: validateCsrfSecret(process.env.CSRF_SECRET, currentEnv),
    idleSessionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    absoluteSessionMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    cookieDomain: process.env.COOKIE_DOMAIN || undefined,
    cookieSameSite: (process.env.COOKIE_SAMESITE || 'lax').toLowerCase(),
    maxConcurrentHashes: parseInt(process.env.AUTH_MAX_CONCURRENT_HASHES || '4', 10),
    argon2: {
      memoryCost: 32768, // 32 MiB
      timeCost: 3,
      parallelism: 1,
    },
    bcrypt: {
      saltRounds: 12,
      maxBytes: 72,
    },
    passwordPolicy: {
      minCodePoints: 15,
      maxCodePoints: 128,
      maxBytes: 512,
    },
  },
  security: {
    encryptionKey: validateAppEncryptionKey(process.env.APP_ENCRYPTION_KEY, currentEnv),
  },
  database: {
    url: (currentEnv === 'test' && process.env.TEST_DATABASE_URL)
      ? process.env.TEST_DATABASE_URL
      : (process.env.DATABASE_URL || ''),
    testUrl: process.env.TEST_DATABASE_URL || '',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10)
  },
  mlService: {
    url: process.env.ML_SERVICE_URL || 'http://localhost:8000'
  },
  upstox: {
    apiKey: process.env.UPSTOX_API_KEY || (process.env.NODE_ENV === 'test' ? 'test_upstox_api_key' : ''),
    apiSecret: process.env.UPSTOX_API_SECRET || (process.env.NODE_ENV === 'test' ? 'test_upstox_api_secret' : ''),
    redirectUri: process.env.UPSTOX_REDIRECT_URI || 'http://localhost:5001/api/auth/upstox/callback',
    accessToken: process.env.NODE_ENV === 'test' ? '' : (process.env.UPSTOX_ACCESS_TOKEN || ''),
    baseUrl: process.env.UPSTOX_BASE_URL || 'https://api.upstox.com/v2',
    instrumentsUrl: process.env.UPSTOX_INSTRUMENTS_URL || 'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz',
    historicalRateLimit: parseInt(process.env.UPSTOX_HISTORICAL_RATE_LIMIT || '5', 10),
    quoteRateLimit: parseInt(process.env.UPSTOX_QUOTE_RATE_LIMIT || '8', 10),
    minuteRateLimit: parseInt(process.env.UPSTOX_MINUTE_RATE_LIMIT || '250', 10),
    thirtyMinRateLimit: parseInt(process.env.UPSTOX_30MIN_RATE_LIMIT || '1000', 10),
  }
};
