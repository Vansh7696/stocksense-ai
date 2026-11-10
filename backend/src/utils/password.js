import argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import { config } from '../config/index.js';
import { AppError } from '../middleware/errorHandler.js';

// Pre-computed Argon2id dummy hash matching exact production parameters (m=32MiB, t=3, p=1)
export const DUMMY_ARGON2_HASH =
  '$argon2id$v=19$m=32768,t=3,p=1$ols/F+a77ky5r5DB1oN1EQ$KnVtFM08mFlAM3eAJ3aDipwVZb5fkMXBZDyapH21U+Y';

// Common breached and trivial passwords blocklist (top NIST/SecLists offline sample)
export const COMMON_PASSWORDS_BLOCKLIST = new Set([
  '123456789012345',
  '1234567890123456',
  'password12345678',
  'qwertyuiopasdfg',
  'correcthorsebatterystaple',
  'administrator12',
  'changeme1234567',
  'stocksense12345',
  'stocksensepassword',
  'welcome12345678',
  'letmein12345678',
  'trustnoone12345',
  'iloveyou1234567',
]);

/**
 * In-process concurrency semaphore to prevent Argon2 memory exhaustion under load.
 * Limits concurrent hashing operations to config.auth.maxConcurrentHashes (default 4).
 */
class HashingConcurrencyLimiter {
  constructor(maxConcurrency = 4, maxQueue = 8) {
    this.maxConcurrency = maxConcurrency;
    this.maxQueue = maxQueue;
    this.current = 0;
    this.queue = [];
  }

  async run(task) {
    if (this.current < this.maxConcurrency) {
      this.current++;
      try {
        return await task();
      } finally {
        this.current--;
        this._next();
      }
    }

    if (this.queue.length >= this.maxQueue) {
      throw new AppError(
        'Authentication server busy. Please retry in a few moments.',
        503,
        'SERVER_BUSY'
      );
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
    });
  }

  _next() {
    if (this.queue.length > 0 && this.current < this.maxConcurrency) {
      const { task, resolve, reject } = this.queue.shift();
      this.current++;
      task()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          this.current--;
          this._next();
        });
    }
  }
}

export const hashingLimiter = new HashingConcurrencyLimiter(
  config.auth?.maxConcurrentHashes || 4,
  8
);

/**
 * Normalizes password string using Unicode Normalization Form C (NFC).
 *
 * @param {string} password
 * @returns {string}
 */
export function normalizePassword(password) {
  if (typeof password !== 'string') return '';
  return password.normalize('NFC');
}

/**
 * Validates password rules according to NIST SP 800-63B.
 *
 * Rules:
 * 1. Minimum 15 Unicode code points.
 * 2. Maximum 128 Unicode code points.
 * 3. Maximum 512 UTF-8 bytes.
 * 4. Must not be in common password blocklist.
 * 5. Must not contain user-context tokens (email local part, full name words, 'stocksense').
 *
 * @param {string} password Raw password string
 * @param {Object} [context] User context for contextual blocklist check
 * @param {string} [context.email]
 * @param {string} [context.fullName]
 */
export function validatePasswordPolicy(password, context = {}) {
  if (!password || typeof password !== 'string') {
    throw new AppError('Password is required.', 400, 'INVALID_PASSWORD');
  }

  const normalized = normalizePassword(password);

  // Unicode code-point length (accurate measurement across emojis and multi-byte chars)
  const codePointCount = Array.from(normalized).length;
  if (codePointCount < 15) {
    throw new AppError(
      'Password must be at least 15 characters in length per security policy.',
      400,
      'PASSWORD_TOO_SHORT'
    );
  }

  if (codePointCount > 128) {
    throw new AppError(
      'Password cannot exceed 128 characters.',
      400,
      'PASSWORD_TOO_LONG'
    );
  }

  const byteLength = Buffer.byteLength(normalized, 'utf8');
  if (byteLength > 512) {
    throw new AppError(
      'Password payload exceeds maximum permitted 512 bytes.',
      400,
      'PASSWORD_TOO_LONG'
    );
  }

  // Check common password blocklist
  if (COMMON_PASSWORDS_BLOCKLIST.has(normalized.toLowerCase())) {
    throw new AppError(
      'This password is too common or easily guessable. Please choose a more unique passphrase.',
      400,
      'WEAK_PASSWORD'
    );
  }

  // Contextual blocklist checks
  if (context.email) {
    const localPart = context.email.split('@')[0]?.toLowerCase();
    if (localPart && localPart.length >= 3 && normalized.toLowerCase().includes(localPart)) {
      throw new AppError(
        'Password cannot contain your email username.',
        400,
        'WEAK_PASSWORD'
      );
    }
  }

  if (context.fullName) {
    const nameWords = context.fullName.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
    for (const word of nameWords) {
      if (normalized.toLowerCase().includes(word)) {
        throw new AppError(
          'Password cannot contain parts of your name.',
          400,
          'WEAK_PASSWORD'
        );
      }
    }
  }

  if (normalized.toLowerCase().includes('stocksense')) {
    throw new AppError(
      'Password cannot contain the platform name "stocksense".',
      400,
      'WEAK_PASSWORD'
    );
  }

  return normalized;
}

/**
 * Hashes a password using Argon2id with memory-bounded concurrency control.
 *
 * @param {string} password Raw password string
 * @returns {Promise<string>} Argon2id hash string
 */
export async function hashPassword(password) {
  const normalized = normalizePassword(password);
  return hashingLimiter.run(async () => {
    return argon2.hash(normalized, {
      type: argon2.argon2id,
      memoryCost: config.auth?.argon2?.memoryCost || 32768,
      timeCost: config.auth?.argon2?.timeCost || 3,
      parallelism: config.auth?.argon2?.parallelism || 1,
    });
  });
}

/**
 * Verifies a password against a stored hash string.
 * Supports Argon2id hashes and fallback Bcrypt hashes.
 *
 * @param {string} hash Stored hash
 * @param {string} password Plaintext password
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(hash, password) {
  if (!hash || !password) return false;
  const normalized = normalizePassword(password);

  return hashingLimiter.run(async () => {
    try {
      // Argon2 format starts with $argon2
      if (hash.startsWith('$argon2')) {
        return await argon2.verify(hash, normalized);
      }
      // Bcrypt format starts with $2a$ or $2b$
      if (hash.startsWith('$2a$') || hash.startsWith('$2b$')) {
        return await bcrypt.compare(normalized, hash);
      }
      return false;
    } catch {
      return false;
    }
  });
}

/**
 * Executes a dummy password comparison to equalize response timing when a user is not found.
 * Uses pre-computed Argon2id hash with identical memory/time cost.
 *
 * @param {string} password Plaintext password from login attempt
 * @returns {Promise<boolean>} Always false
 */
export async function executeDummyPasswordComparison(password) {
  await verifyPassword(DUMMY_ARGON2_HASH, password);
  return false;
}
