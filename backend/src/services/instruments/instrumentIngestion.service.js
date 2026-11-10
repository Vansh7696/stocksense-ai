import crypto from 'node:crypto';
import defaultDownloader from './instrumentDownloader.js';
import defaultParser from './instrumentParser.js';
import defaultValidator, { InstrumentValidator } from './instrumentValidator.js';
import defaultPersistence from './instrumentPersistence.js';
import defaultCacheService from '../cache.service.js';
import defaultPrisma from '../../config/prisma.js';
import defaultRedisClient, { isRedisReady } from '../../config/redis.js';
import { AppError } from '../../middleware/errorHandler.js';

export const INGESTION_LOCK_KEY = 'stocksense:lock:instrument_ingestion';
export const INGESTION_LOCK_TTL_SECONDS = 900; // 15 minutes
export const DEFAULT_EQUITY_SEGMENTS = new Set([
  'NSE_EQ',
  'BSE_EQ',
  'NSE_INDEX',
  'BSE_INDEX',
]);

export class InstrumentIngestionService {
  /**
   * @param {Object} [options]
   * @param {Object} [options.downloader] Injected downloader
   * @param {Object} [options.parser] Injected parser
   * @param {Object} [options.validator] Injected validator
   * @param {Object} [options.persistence] Injected persistence
   * @param {Object} [options.prisma] Injected Prisma Client
   * @param {Object} [options.redisClient] Injected Redis Client
   * @param {number} [options.lockTtlSeconds] Optional custom lock TTL
   */
  constructor(options = {}) {
    this.downloader = options.downloader || defaultDownloader;
    this.parser = options.parser || defaultParser;
    this.validator = options.validator || defaultValidator;
    this.persistence = options.persistence || defaultPersistence;
    this.cacheService = options.cacheService || defaultCacheService;
    this.prisma = options.prisma || defaultPrisma;
    this.redisClient = options.redisClient !== undefined ? options.redisClient : defaultRedisClient;
    this.lockTtlSeconds = options.lockTtlSeconds || INGESTION_LOCK_TTL_SECONDS;
    this._currentLockToken = null;
  }

  /**
   * Acquires a distributed lock with a cryptographically unique ownership token
   * using atomic SET NX EX to prevent overlapping ingestion runs.
   *
   * Fail-Closed Security Policy:
   * Redis is mandatory. If Redis is unavailable or fails, ingestion fails immediately
   * with HTTP 503 (INGESTION_LOCK_UNAVAILABLE) before downloading or writing any records.
   * No silent in-memory fallback is permitted.
   *
   * @param {number} [ttlSeconds] Optional custom TTL
   * @returns {Promise<boolean>} True if lock acquired, false if already locked by another job
   */
  async _acquireLock(ttlSeconds) {
    const ttl = ttlSeconds || this.lockTtlSeconds;
    const token = crypto.randomUUID();

    if (this.redisClient && !isRedisReady() && (this.redisClient.status === 'connecting' || this.redisClient.status === 'wait')) {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 800);
        this.redisClient.once('connect', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    const isReady = Boolean(
      this.redisClient &&
      (this.redisClient === defaultRedisClient
        ? isRedisReady()
        : (this.redisClient.status === undefined || this.redisClient.status === 'ready'))
    );

    if (!isReady) {
      throw new AppError(
        'Distributed ingestion lock is unavailable. Redis is mandatory for instrument ingestion.',
        503,
        'INGESTION_LOCK_UNAVAILABLE'
      );
    }

    try {
      const acquired = await this.redisClient.set(
        INGESTION_LOCK_KEY,
        token,
        'EX',
        ttl,
        'NX'
      );
      if (acquired === 'OK') {
        this._currentLockToken = token;
        return true;
      }
      return false;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        `Failed to acquire distributed lock: ${err.message}`,
        503,
        'INGESTION_LOCK_UNAVAILABLE'
      );
    }
  }

  /**
   * Releases the distributed lock using an atomic Lua script that compares the
   * ownership token before deletion. This guarantees an older process will never
   * accidentally release a lock acquired by a newer process after TTL expiry.
   *
   * @param {string} [tokenToRelease] Specific token to release (defaults to instance token)
   * @returns {Promise<boolean>} True if lock was owned and deleted, false otherwise
   */
  async _releaseLock(tokenToRelease) {
    const token = tokenToRelease || this._currentLockToken;
    this._currentLockToken = null;

    if (!token) {
      return false;
    }

    if (this.redisClient) {
      try {
        const luaScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
`;
        const result = await this.redisClient.eval(luaScript, 1, INGESTION_LOCK_KEY, token);
        return result === 1;
      } catch {
        // Cleanly handle release failures without unhandled rejections
        return false;
      }
    }
    return false;
  }

  /**
   * Executes the complete instrument master ingestion pipeline.
   *
   * @param {Object} [options]
   * @param {string} [options.url] Optional custom download URL
   * @param {Buffer} [options.fileBuffer] Optional pre-downloaded compressed buffer (e.g. for testing)
   * @param {boolean} [options.allSegments=false] Ingest all segments (including derivatives) vs equities & indices only
   * @param {boolean} [options.dryRun=false] When true, simulates persistence without modifying database
   * @param {number} [options.limit] Optional maximum number of records to ingest
   * @param {number} [options.lockTtlSeconds] Optional custom lock TTL
   * @param {Function} [options.onProgress] Optional progress reporting callback
   * @returns {Promise<Object>} Ingestion summary report
   */
  async ingest(options = {}) {
    const startTime = Date.now();
    const hasLock = await this._acquireLock(options.lockTtlSeconds);

    if (!hasLock) {
      throw new AppError(
        'Instrument master ingestion is currently in progress. Overlapping jobs are prohibited.',
        409,
        'INGESTION_ALREADY_IN_PROGRESS'
      );
    }

    const lockToken = this._currentLockToken;
    let status = 'FAILED';
    let errorMessage = null;
    let totalDownloaded = 0;
    let validRecords = [];
    let validInScope = 0;
    let validOutOfScope = 0;
    let invalidRecords = 0;
    let nseCount = 0;
    let bseCount = 0;
    let recordsToPersist = [];
    let persistenceResult = {
      inserted: 0,
      updated: 0,
      skipped: 0,
      insertedRecords: 0,
      updatedRecords: 0,
      skippedRecords: 0,
      errors: [],
    };

    try {
      // 1. Download (or use injected buffer)
      let compressedBytes = options.fileBuffer;
      if (!compressedBytes) {
        compressedBytes = await this.downloader.download(options.url);
      }

      // 2. Decompress and Parse
      const rawRecords = await this.parser.parse(compressedBytes);
      totalDownloaded = rawRecords.length;

      // 3. Validate & Normalize
      const validator = options.allSegments
        ? new InstrumentValidator({ allowedSegments: null })
        : new InstrumentValidator({ allowedSegments: DEFAULT_EQUITY_SEGMENTS });

      const validationRes = validator.validateBatch(rawRecords);
      validRecords = validationRes.validRecords;
      validInScope = validationRes.validInScope;
      validOutOfScope = validationRes.validOutOfScope;
      invalidRecords = validationRes.invalidRecords;

      for (const rec of validRecords) {
        if (rec.exchange === 'NSE') nseCount++;
        else if (rec.exchange === 'BSE') bseCount++;
      }

      // Apply limit if specified (takes first N valid in-scope records)
      recordsToPersist = validRecords;
      if (options.limit && typeof options.limit === 'number' && options.limit > 0) {
        recordsToPersist = validRecords.slice(0, options.limit);
      }

      // 4. Database Persistence
      persistenceResult = await this.persistence.persistBatch(recordsToPersist, {
        dryRun: options.dryRun || false,
        onProgress: options.onProgress,
      });

      if (persistenceResult.errors.length === 0) {
        status = 'SUCCESS';
      } else if (persistenceResult.inserted > 0 || persistenceResult.updated > 0) {
        status = 'PARTIAL';
      } else {
        status = 'FAILED';
      }

      // Invalidate stock catalogue and market overview caches when records are mutated
      if (!options.dryRun && (status === 'SUCCESS' || status === 'PARTIAL')) {
        try {
          await this.cacheService.invalidateStockCatalogueCache();
        } catch {
          // Cache invalidation failure must not fail primary ingestion
        }
      }
    } catch (err) {
      status = 'FAILED';
      errorMessage = err.message;
      throw err;
    } finally {
      const durationMs = Date.now() - startTime;
      await this._releaseLock(lockToken);

      const insertedCount = persistenceResult.insertedRecords ?? persistenceResult.inserted;
      const updatedCount = persistenceResult.updatedRecords ?? persistenceResult.updated;
      const skippedCount = persistenceResult.skippedRecords ?? persistenceResult.skipped;

      // Record audit log in DataSourceLog
      try {
        await this.prisma.dataSourceLog.create({
          data: {
            provider: 'UPSTOX',
            operation: 'INSTRUMENT_INGESTION',
            status,
            recordsProcessed: recordsToPersist.length,
            errorMessage,
            executionTimeMs: durationMs,
          },
        });

        // Store latest ingestion summary in SystemConfig
        const summaryPayload = JSON.stringify({
          lastIngestedAt: new Date().toISOString(),
          status,
          totalDownloaded,
          validInScope,
          validOutOfScope,
          invalidRecords,
          nseRecords: nseCount,
          bseRecords: bseCount,
          insertedRecords: insertedCount,
          updatedRecords: updatedCount,
          skippedRecords: skippedCount,
          durationMs,
        });

        await this.prisma.systemConfig.upsert({
          where: { key: 'UPSTOX_INSTRUMENT_INGESTION_SUMMARY' },
          update: { value: summaryPayload },
          create: {
            key: 'UPSTOX_INSTRUMENT_INGESTION_SUMMARY',
            value: summaryPayload,
          },
        });
      } catch {
        // Logging failure must not mask primary ingestion outcome
      }
    }

    const durationMs = Date.now() - startTime;
    const insertedCount = persistenceResult.insertedRecords ?? persistenceResult.inserted;
    const updatedCount = persistenceResult.updatedRecords ?? persistenceResult.updated;
    const skippedCount = persistenceResult.skippedRecords ?? persistenceResult.skipped;

    return {
      status,
      totalDownloaded,
      validInScope,
      validOutOfScope,
      invalidRecords,
      insertedRecords: insertedCount,
      updatedRecords: updatedCount,
      skippedRecords: skippedCount,
      // Backward compatibility aliases:
      validRecords: validInScope,
      inserted: insertedCount,
      updated: updatedCount,
      skipped: skippedCount,
      nseRecords: nseCount,
      bseRecords: bseCount,
      durationMs,
      errors: persistenceResult.errors,
    };
  }

  /**
   * Retrieves the latest ingestion summary status from the database.
   *
   * @returns {Promise<Object|null>}
   */
  async getLatestStatus() {
    const configRow = await this.prisma.systemConfig.findUnique({
      where: { key: 'UPSTOX_INSTRUMENT_INGESTION_SUMMARY' },
    });

    if (!configRow) return null;

    try {
      return JSON.parse(configRow.value);
    } catch {
      return null;
    }
  }
}

export default new InstrumentIngestionService();
