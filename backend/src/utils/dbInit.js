/**
 * StockSense AI — Database Initialization & Startup Resilience Module
 *
 * Implements:
 * 1. Exponential backoff connection retry logic to survive PostgreSQL boot latency.
 * 2. Automated pending migration deployment verification.
 * 3. Idempotent baseline seed verification (NSE/BSE verified metadata).
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prisma from '../config/prisma.js';
import logger from './logger.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Probes the PostgreSQL database with exponential backoff and jitter.
 *
 * @param {object} client - Prisma client instance
 * @param {object} options
 * @param {number} options.maxRetries - Maximum retry attempts (default: 10)
 * @param {number} options.initialDelayMs - Initial delay in ms (default: 1000)
 * @param {number} options.factor - Exponential multiplication factor (default: 1.5)
 * @param {number} options.maxDelayMs - Maximum delay cap in ms (default: 10000)
 * @param {boolean} options.throwOnFailure - Whether to throw on exhaustion (default: true)
 * @returns {Promise<boolean>} True if connected, false if failed and throwOnFailure is false
 */
export async function waitForDatabase(client = prisma, options = {}) {
  const maxRetries = options.maxRetries ?? parseInt(process.env.DB_MAX_RETRIES || '10', 10);
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const factor = options.factor ?? 1.5;
  const maxDelayMs = options.maxDelayMs ?? 10000;
  const throwOnFailure = options.throwOnFailure ?? (process.env.NODE_ENV === 'production');

  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    try {
      await client.$queryRaw`SELECT 1`;
      logger.info('Database connection verified successfully', {
        attempt,
        status: 'CONNECTED',
      });
      return true;
    } catch (err) {
      const isLastAttempt = attempt >= maxRetries;
      const rawDelay = initialDelayMs * Math.pow(factor, attempt - 1);
      // Add ±15% jitter to prevent thundering herd in multi-instance containers
      const jitter = (Math.random() * 0.3 - 0.15) * rawDelay;
      const delay = Math.min(maxDelayMs, Math.max(100, Math.round(rawDelay + jitter)));

      if (isLastAttempt) {
        logger.error('Database connection retries exhausted', {
          attempt,
          maxRetries,
          error: err.message,
        });
        if (throwOnFailure) {
          throw new Error(`Database connection failed after ${maxRetries} attempts: ${err.message}`);
        }
        return false;
      }

      logger.warn(`Database connection attempt ${attempt}/${maxRetries} failed. Retrying in ${delay}ms...`, {
        attempt,
        maxRetries,
        delayMs: delay,
        error: err.message,
      });

      await sleep(delay);
    }
  }

  return false;
}

/**
 * Deploys pending Prisma migrations safely via `prisma migrate deploy`.
 * Skips in test environment to preserve isolated test database state.
 *
 * @returns {Promise<{ applied: boolean, message?: string }>}
 */
export async function applyPendingMigrations() {
  if (process.env.NODE_ENV === 'test') {
    return { applied: false, message: 'Skipped in test environment' };
  }

  try {
    const cwd = path.resolve(__dirname, '../../');
    logger.info('Checking for pending Prisma migrations...');
    const { stdout, stderr } = await execAsync('npx prisma migrate deploy', { cwd, timeout: 60000 });

    logger.info('Prisma migration deployment finished', {
      stdout: stdout.trim(),
      stderr: stderr.trim() || undefined,
    });
    return { applied: true, message: stdout.trim() };
  } catch (err) {
    logger.error('Prisma migration deployment failed', {
      error: err.message,
      stdout: err.stdout?.toString(),
      stderr: err.stderr?.toString(),
    });
    throw err;
  }
}

/**
 * Ensures baseline exchange and verified equity metadata is seeded.
 * Idempotent: Only seeds if exchanges table is empty.
 *
 * @param {object} client - Prisma client instance
 * @returns {Promise<{ seeded: boolean, details?: object }>}
 */
export async function ensureDatabaseSeeded(client = prisma) {
  if (process.env.NODE_ENV === 'test') {
    return { seeded: false, details: { reason: 'Skipped in test environment' } };
  }

  try {
    const exchangeCount = await client.exchange.count();
    const stockCount = await client.stock.count();

    if (exchangeCount > 0 && stockCount > 0) {
      logger.info('Database baseline already populated. Skipping seed.', {
        exchangeCount,
        stockCount,
      });
      return { seeded: false, details: { exchangeCount, stockCount } };
    }

    logger.info('Database metadata unpopulated. Executing baseline seeder...');
    const { seed } = await import('../../prisma/seed.js');
    const result = await seed(client);

    logger.info('Baseline seeding complete', result);
    return { seeded: true, details: result };
  } catch (err) {
    logger.error('Baseline seed verification failed', { error: err.message });
    throw err;
  }
}

/**
 * Orchestrates full database initialization sequence for backend startup.
 *
 * @param {object} options
 * @returns {Promise<{ initialized: boolean, connected: boolean }>}
 */
export async function initializeDatabase(options = {}) {
  logger.info('Commencing database initialization and readiness verification...');

  const isConnected = await waitForDatabase(prisma, options);
  if (!isConnected) {
    return { initialized: false, connected: false };
  }

  if (process.env.NODE_ENV !== 'test') {
    if (process.env.AUTO_MIGRATE === 'true') {
      await applyPendingMigrations();
    }
    if (process.env.AUTO_SEED === 'true') {
      await ensureDatabaseSeeded(prisma);
    }
  }

  logger.info('Database initialization sequence completed successfully.');
  return { initialized: true, connected: true };
}
