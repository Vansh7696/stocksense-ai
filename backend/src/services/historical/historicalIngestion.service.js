import crypto from 'node:crypto';
import defaultPersistence from './historicalPersistence.js';
import { marketDataProvider } from '../../providers/index.js';
import marketDataValidatorService from '../marketDataValidator.service.js';
import defaultCacheService from '../cache.service.js';
import tokenService from '../token.service.js';
import defaultPrisma from '../../config/prisma.js';
import defaultRedisClient, { isRedisReady } from '../../config/redis.js';
import { AppError } from '../../middleware/errorHandler.js';
import {
  getExpectedTradingDays,
  analyzeCandleGaps,
  toKolkataDateString,
} from '../../utils/tradingCalendar.js';

export const HISTORICAL_INGESTION_LOCK_KEY = 'stocksense:lock:historical_ingestion';
export const HISTORICAL_INGESTION_LOCK_TTL_SECONDS = 900; // 15 minutes
export const DEFAULT_HISTORICAL_YEARS = 3; // Target 3-5 years of daily history

export const INITIAL_NSE_EQUITIES = [
  'RELIANCE',
  'TCS',
  'INFY',
  'HDFCBANK',
  'ICICIBANK',
];

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Returns a YYYY-MM-DD date string formatted in the Asia/Kolkata timezone (UTC+05:30).
 *
 * @param {Date} [date=new Date()]
 * @returns {string} YYYY-MM-DD in Asia/Kolkata
 */
export function getKolkataDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export class HistoricalIngestionService {
  /**
   * @param {Object} [options]
   * @param {Object} [options.provider] Market data provider (defaults to UpstoxProvider)
   * @param {Object} [options.validator] Market data validator service
   * @param {Object} [options.persistence] Historical candle persistence layer
   * @param {Object} [options.cacheService] Cache service
   * @param {Object} [options.tokenManager] Token manager
   * @param {Object} [options.prisma] Prisma client
   * @param {Object} [options.redisClient] Redis client
   * @param {number} [options.lockTtlSeconds] Custom lock TTL
   */
  constructor(options = {}) {
    this.provider = options.provider || marketDataProvider;
    this.validator = options.validator || marketDataValidatorService;
    this.persistence = options.persistence || defaultPersistence;
    this.cacheService = options.cacheService || defaultCacheService;
    this.tokenManager = options.tokenManager || tokenService;
    this.prisma = options.prisma || defaultPrisma;
    this.redisClient = options.redisClient !== undefined ? options.redisClient : defaultRedisClient;
    this.lockTtlSeconds = options.lockTtlSeconds || HISTORICAL_INGESTION_LOCK_TTL_SECONDS;
    this._currentLockToken = null;
    this._heartbeatInterval = null;
    this._lockLost = false;
    this._lockLostError = null;
  }

  /**
   * Acquires a distributed lock with a cryptographically unique ownership token
   * using atomic SET NX EX to prevent overlapping ingestion runs.
   *
   * Fail-Closed Policy:
   * Redis is mandatory. If Redis is down or unavailable, ingestion fails immediately
   * with HTTP 503 (INGESTION_LOCK_UNAVAILABLE) before querying broker APIs or database.
   *
   * @param {number} [ttlSeconds]
   * @returns {Promise<boolean>}
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
        'Distributed historical ingestion lock is unavailable. Redis is mandatory for historical ingestion.',
        503,
        'INGESTION_LOCK_UNAVAILABLE'
      );
    }

    try {
      const acquired = await this.redisClient.set(
        HISTORICAL_INGESTION_LOCK_KEY,
        token,
        'EX',
        ttl,
        'NX'
      );
      if (acquired === 'OK') {
        this._currentLockToken = token;
        this._lockLost = false;
        this._lockLostError = null;
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
   * Safely renews the distributed lock TTL using atomic Lua script.
   * Only extends the lock if the key still exists and is currently owned
   * by this worker's unique token. Prevents renewing or touching another worker's lock.
   *
   * @param {number} [ttlSeconds]
   * @returns {Promise<boolean>} True if successfully renewed, false if expired or owned by another worker
   */
  async _renewLock(ttlSeconds) {
    const ttl = ttlSeconds || this.lockTtlSeconds;
    const token = this._currentLockToken;

    if (!token || !this.redisClient) {
      return false;
    }

    try {
      const luaScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("expire", KEYS[1], ARGV[2])
else
    return 0
end`;
      const res = await this.redisClient.eval(
        luaScript,
        1,
        HISTORICAL_INGESTION_LOCK_KEY,
        token,
        ttl
      );
      if (res === 1) {
        return true;
      }
      this._lockLost = true;
      this._lockLostError = new AppError(
        'Distributed lock renewal failed. Ingestion lock was lost or acquired by another process.',
        500,
        'INGESTION_LOCK_LOST'
      );
      this._stopHeartbeat();
      return false;
    } catch (err) {
      this._lockLost = true;
      this._lockLostError = new AppError(
        `Distributed lock renewal failed due to Redis error: ${err.message}`,
        503,
        'INGESTION_LOCK_LOST'
      );
      this._stopHeartbeat();
      return false;
    }
  }

  /**
   * Starts a background heartbeat interval to safely renew the distributed lock
   * during long-running ingestion jobs before the TTL window expires.
   *
   * @param {number} [ttlSeconds]
   */
  _startHeartbeat(ttlSeconds) {
    this._stopHeartbeat();
    const ttl = ttlSeconds || this.lockTtlSeconds;
    // Renew every 1/3 of the TTL window (minimum 1 second)
    const intervalMs = Math.max(1000, Math.floor(ttl / 3) * 1000);

    this._heartbeatInterval = setInterval(async () => {
      try {
        const renewed = await this._renewLock(ttl);
        if (!renewed) {
          this._stopHeartbeat();
        }
      } catch {
        this._stopHeartbeat();
      }
    }, intervalMs);

    if (this._heartbeatInterval.unref) {
      this._heartbeatInterval.unref();
    }
  }

  /**
   * Stops the background lock heartbeat.
   */
  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  /**
   * Asserts that this worker still holds the distributed ingestion lock.
   * Fails closed immediately by throwing INGESTION_LOCK_LOST if the lock
   * was lost, expired, or acquired by another process.
   *
   * @throws {AppError} INGESTION_LOCK_LOST (500 or 503)
   */
  async _assertLockHeld() {
    if (this._lockLost) {
      throw (
        this._lockLostError ||
        new AppError(
          'Distributed ingestion lock has been lost. Aborting processing.',
          500,
          'INGESTION_LOCK_LOST'
        )
      );
    }

    if (!this._currentLockToken) {
      throw new AppError(
        'No active distributed ingestion lock is held by this worker.',
        500,
        'INGESTION_LOCK_LOST'
      );
    }

    if (this.redisClient) {
      try {
        const currentOwner = await this.redisClient.get(HISTORICAL_INGESTION_LOCK_KEY);
        if (currentOwner !== this._currentLockToken) {
          this._lockLost = true;
          this._stopHeartbeat();
          this._lockLostError = new AppError(
            'Distributed lock ownership check failed. Lock was lost or acquired by another process.',
            500,
            'INGESTION_LOCK_LOST'
          );
          throw this._lockLostError;
        }
      } catch (err) {
        if (err.code === 'INGESTION_LOCK_LOST') throw err;
        this._lockLost = true;
        this._stopHeartbeat();
        this._lockLostError = new AppError(
          `Distributed lock check failed due to Redis error: ${err.message}`,
          503,
          'INGESTION_LOCK_LOST'
        );
        throw this._lockLostError;
      }
    }
  }

  /**
   * Releases the distributed lock using atomic Lua compare-and-delete.
   *
   * @param {string} [tokenToRelease]
   * @returns {Promise<boolean>}
   */
  async _releaseLock(tokenToRelease) {
    this._stopHeartbeat();
    const token = tokenToRelease || this._currentLockToken;
    this._currentLockToken = null;
    this._lockLost = false;
    this._lockLostError = null;

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
end`;
        const res = await this.redisClient.eval(luaScript, 1, HISTORICAL_INGESTION_LOCK_KEY, token);
        return res === 1;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Normalizes and validates symbol list input.
   *
   * @param {string|Array<string>} [symbolsInput]
   * @param {boolean} [allSymbols=false]
   * @returns {Array<string>} Array of uppercase symbol strings
   */
  _normalizeSymbols(symbolsInput, allSymbols = false) {
    if (allSymbols || !symbolsInput) {
      return [...INITIAL_NSE_EQUITIES];
    }

    let list = [];
    if (Array.isArray(symbolsInput)) {
      list = symbolsInput;
    } else if (typeof symbolsInput === 'string') {
      list = symbolsInput.split(',').map((s) => s.trim());
    }

    const cleaned = list.map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0);
    if (cleaned.length === 0) {
      return [...INITIAL_NSE_EQUITIES];
    }

    return Array.from(new Set(cleaned));
  }

  /**
   * Validates date parameters (YYYY-MM-DD) and chronological ordering in Asia/Kolkata timezone.
   * Rejects future trading dates.
   *
   * @param {string} [from]
   * @param {string} [to]
   * @param {number} [years=DEFAULT_HISTORICAL_YEARS]
   * @returns {{ fromDate: string, toDate: string }}
   */
  _validateDateRange(from, to, years = DEFAULT_HISTORICAL_YEARS) {
    const todayKolkata = getKolkataDateString(new Date());
    const toDate = to || todayKolkata;
    const defaultYears = typeof years === 'number' && years > 0 ? years : DEFAULT_HISTORICAL_YEARS;
    const defaultFrom = getKolkataDateString(new Date(Date.now() - defaultYears * 365 * 24 * 60 * 60 * 1000));
    const fromDate = from || defaultFrom;

    if (!DATE_REGEX.test(fromDate)) {
      throw new AppError(
        `Invalid "from" date format: "${fromDate}". Expected YYYY-MM-DD.`,
        400,
        'INVALID_DATE_FROM'
      );
    }
    if (!DATE_REGEX.test(toDate)) {
      throw new AppError(
        `Invalid "to" date format: "${toDate}". Expected YYYY-MM-DD.`,
        400,
        'INVALID_DATE_TO'
      );
    }

    const start = new Date(fromDate);
    const end = new Date(toDate);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new AppError('Unable to parse date values for historical ingestion.', 400, 'INVALID_DATE');
    }

    if (start > end) {
      throw new AppError(
        `"from" date (${fromDate}) cannot be after "to" date (${toDate}).`,
        400,
        'INVALID_DATE_RANGE'
      );
    }

    if (toDate > todayKolkata) {
      throw new AppError(
        `"to" date (${toDate}) cannot be in the future. Current date in Asia/Kolkata is ${todayKolkata}.`,
        400,
        'INVALID_DATE_FUTURE'
      );
    }

    return { fromDate, toDate };
  }

  /**
   * Main entry point for historical candle ingestion.
   *
   * @param {Object} [options]
   * @param {string|Array<string>} [options.symbols] Symbol(s) to ingest
   * @param {string|Array<string>} [options.symbol] Single symbol alias
   * @param {boolean} [options.all=false] Ingest all initial NSE equities
   * @param {string} [options.from] Start date (YYYY-MM-DD)
   * @param {string} [options.to] End date (YYYY-MM-DD)
   * @param {string} [options.interval='1D'] Bar interval
   * @param {number} [options.years=DEFAULT_HISTORICAL_YEARS] Number of historical years (defaults to 3)
   * @param {boolean} [options.incremental=false] When true, only ingests missing days since latest stored candle
   * @param {boolean} [options.dryRun=false] When true, simulates persistence
   * @param {Function} [options.onProgress] Optional progress callback
   * @returns {Promise<Object>} Comprehensive ingestion summary
   */
  async ingest(options = {}) {
    const startTime = Date.now();
    const {
      symbols: rawSymbols,
      symbol: singleSymbol,
      all = false,
      from,
      to,
      years,
      interval = '1D',
      incremental = false,
      dryRun = false,
      onProgress,
    } = options;

    const symbols = this._normalizeSymbols(rawSymbols || singleSymbol, all);
    const { fromDate, toDate } = this._validateDateRange(from, to, years);

    // 1. Acquire distributed lock (fail-closed)
    const lockAcquired = await this._acquireLock();
    if (!lockAcquired) {
      throw new AppError(
        'Historical market data ingestion is already running. Concurrent jobs are blocked.',
        409,
        'INGESTION_ALREADY_IN_PROGRESS'
      );
    }
    this._startHeartbeat();

    try {
      const perStockResults = [];
      let totalFetched = 0;
      let totalInserted = 0;
      let totalUpdated = 0;
      let totalRejected = 0;
      let totalDuplicates = 0;
      let hasFailures = false;

      // 2. Iterate through each target stock
      for (let sIdx = 0; sIdx < symbols.length; sIdx++) {
        await this._assertLockHeld();
        const symbol = symbols[sIdx];
        const stockStartTime = Date.now();

        // 2a. Resolve stock record from database
        const stock = await this.prisma.stock.findFirst({
          where: {
            symbol,
            exchange: { code: 'NSE' },
            isActive: true,
          },
          include: { exchange: true },
        });

        if (!stock) {
          perStockResults.push({
            symbol,
            status: 'FAILED',
            error: `Stock not found on NSE in database: "${symbol}"`,
            code: 'STOCK_NOT_FOUND',
            fetched: 0,
            inserted: 0,
            updated: 0,
            rejected: 0,
            duplicatesWithinBatch: 0,
            expectedTradingDaysCount: 0,
            missingTradingDaysCount: 0,
            missingTradingDays: [],
            unexpectedGaps: [],
            coveragePercentage: 0,
            failedChunksCount: 0,
            failedChunks: [],
          });
          hasFailures = true;
          continue;
        }

        // 2b. Resolve exact Upstox instrument key
        let instrumentKey = stock.instrumentToken;
        if (!instrumentKey) {
          instrumentKey = this.provider.resolveInstrumentKey(stock, 'NSE');
        }

        if (!instrumentKey) {
          perStockResults.push({
            symbol,
            instrumentKey: null,
            status: 'FAILED',
            error: `Unable to resolve verified Upstox instrument key for stock "${symbol}"`,
            code: 'UNRESOLVED_INSTRUMENT_KEY',
            fetched: 0,
            inserted: 0,
            updated: 0,
            rejected: 0,
            duplicatesWithinBatch: 0,
            expectedTradingDaysCount: 0,
            missingTradingDaysCount: 0,
            missingTradingDays: [],
            unexpectedGaps: [],
            coveragePercentage: 0,
            failedChunksCount: 0,
            failedChunks: [],
          });
          hasFailures = true;
          continue;
        }

        // 2c. Handle incremental mode: detect latest stored candle date
        let stockFromDate = fromDate;
        const stockToDate = toDate;

        if (incremental) {
          const latestCandle = await this.prisma.historicalPrice.findFirst({
            where: {
              stockId: stock.id,
              interval,
            },
            orderBy: { timestamp: 'desc' },
            select: { timestamp: true },
          });

          if (latestCandle) {
            const latestDateStr = toKolkataDateString(latestCandle.timestamp);
            if (latestDateStr >= stockToDate) {
              // Already fresh up to today
              perStockResults.push({
                symbol,
                instrumentKey,
                status: 'SUCCESS',
                alreadyUpToDate: true,
                message: `Already up-to-date through ${latestDateStr}`,
                requestedRange: { from: stockFromDate, to: stockToDate },
                fetched: 0,
                valid: 0,
                rejected: 0,
                inserted: 0,
                updated: 0,
                duplicatesWithinBatch: 0,
                expectedTradingDaysCount: 0,
                missingTradingDaysCount: 0,
                missingTradingDays: [],
                unexpectedGaps: [],
                coveragePercentage: 100.0,
                dataFreshness: latestDateStr,
                failedChunksCount: 0,
                failedChunks: [],
                source: 'UPSTOX_V3',
                durationMs: Date.now() - stockStartTime,
              });
              continue;
            }
            // Start from the latest existing date to refresh close and fetch subsequent days
            stockFromDate = latestDateStr;
          }
        }

        // 2d. Fetch and validate historical candles via Upstox Provider
        let fetchResult = null;
        let stockError = null;

        try {
          fetchResult = await this.provider.getHistoricalCandles(
            instrumentKey,
            interval,
            stockFromDate,
            stockToDate,
            {
              continueOnError: true,
              beforeChunk: async () => {
                await this._assertLockHeld();
              },
              onChunk: async () => {
                await this._assertLockHeld();
              },
            }
          );
        } catch (fetchErr) {
          if (fetchErr.code === 'INGESTION_LOCK_LOST') {
            throw fetchErr;
          }
          stockError = fetchErr;
        }

        if (stockError || !fetchResult) {
          const errMsg = stockError?.message || 'Failed to retrieve historical candles from provider';
          perStockResults.push({
            symbol,
            instrumentKey,
            status: 'FAILED',
            error: errMsg,
            code: stockError?.code || 'PROVIDER_FETCH_ERROR',
            fetched: 0,
            inserted: 0,
            updated: 0,
            rejected: 0,
            duplicatesWithinBatch: 0,
            expectedTradingDaysCount: 0,
            missingTradingDaysCount: 0,
            missingTradingDays: [],
            unexpectedGaps: [],
            coveragePercentage: 0,
            failedChunksCount: 0,
            failedChunks: [],
          });
          hasFailures = true;

          // Log failed attempt in DataSourceLog
          await this.prisma.dataSourceLog.create({
            data: {
              provider: 'UPSTOX',
              operation: 'SYNC_OHLCV',
              status: 'FAILED',
              recordsProcessed: 0,
              errorMessage: `[${symbol}] ${errMsg}`,
              executionTimeMs: Date.now() - stockStartTime,
            },
          });
          continue;
        }

        const validCandles = fetchResult.data || [];
        const rejectedCandles = fetchResult.rejected || [];
        const failedChunks = fetchResult.failedChunks || [];

        totalFetched += validCandles.length + rejectedCandles.length;
        totalRejected += rejectedCandles.length;

        // 2e. Persist valid candles to PostgreSQL
        let persistResult = { inserted: 0, updated: 0, skipped: 0, errors: [] };
        if (validCandles.length > 0) {
          await this._assertLockHeld();
          persistResult = await this.persistence.persistBatch(
            stock.id,
            interval,
            validCandles,
            {
              dryRun,
              beforeBatch: async () => {
                await this._assertLockHeld();
              },
              onProgress: (current, total) => {
                if (onProgress) {
                  onProgress({
                    symbol,
                    stockIndex: sIdx + 1,
                    totalStocks: symbols.length,
                    currentRecords: current,
                    totalRecords: total,
                  });
                }
              },
            }
          );
        }

        totalInserted += persistResult.inserted;
        totalUpdated += persistResult.updated;
        totalDuplicates += persistResult.skipped;

        // 2f. Invalidate affected stock prices cache in Redis
        if (!dryRun && (persistResult.inserted > 0 || persistResult.updated > 0)) {
          await this._assertLockHeld();
          await this.cacheService.invalidateStockPricesCache(stock.id);
        }

        const stockDurationMs = Date.now() - stockStartTime;
        const usefulCandlesCount = persistResult.inserted + persistResult.updated;

        let stockStatus;
        if (usefulCandlesCount > 0 && (failedChunks.length > 0 || persistResult.errors.length > 0)) {
          stockStatus = 'PARTIAL';
          hasFailures = true;
        } else if (usefulCandlesCount === 0 && (failedChunks.length > 0 || persistResult.errors.length > 0)) {
          stockStatus = 'FAILED';
          hasFailures = true;
        } else {
          stockStatus = 'SUCCESS';
        }

        // 2g. Trading Calendar & Gap Analysis (Excluding Weekends & Indian Exchange Holidays)
        const expectedTradingDays = getExpectedTradingDays(stockFromDate, stockToDate);
        const gapAnalysis = analyzeCandleGaps(
          expectedTradingDays,
          validCandles.map((c) => c.timestamp)
        );

        const latestCandleDate = validCandles.length > 0
          ? toKolkataDateString(validCandles[validCandles.length - 1].timestamp)
          : null;

        perStockResults.push({
          symbol,
          instrumentKey,
          status: stockStatus,
          requestedRange: { from: stockFromDate, to: stockToDate },
          fetched: validCandles.length + rejectedCandles.length,
          valid: validCandles.length,
          rejected: rejectedCandles.length,
          inserted: persistResult.inserted,
          updated: persistResult.updated,
          duplicatesWithinBatch: persistResult.skipped,
          expectedTradingDaysCount: gapAnalysis.expectedTradingDaysCount,
          missingTradingDaysCount: gapAnalysis.missingTradingDaysCount,
          missingTradingDays: gapAnalysis.missingTradingDays.slice(0, 10),
          unexpectedGaps: gapAnalysis.unexpectedGaps,
          coveragePercentage: gapAnalysis.coveragePercentage,
          dataFreshness: latestCandleDate,
          failedChunksCount: failedChunks.length,
          failedChunks,
          source: 'UPSTOX_V3',
          durationMs: stockDurationMs,
        });

        // 2h. Log individual stock execution in DataSourceLog
        await this.prisma.dataSourceLog.create({
          data: {
            provider: 'UPSTOX',
            operation: 'SYNC_OHLCV',
            status: stockStatus,
            recordsProcessed: usefulCandlesCount,
            errorMessage: JSON.stringify({
              symbol,
              range: { from: stockFromDate, to: stockToDate },
              fetched: validCandles.length + rejectedCandles.length,
              inserted: persistResult.inserted,
              updated: persistResult.updated,
              duplicates: persistResult.skipped,
              rejected: rejectedCandles.length,
              expectedDays: gapAnalysis.expectedTradingDaysCount,
              missingDays: gapAnalysis.missingTradingDaysCount,
              coveragePct: gapAnalysis.coveragePercentage,
              failedChunks: failedChunks.map((fc) => ({ chunk: fc.chunk, error: fc.error, code: fc.code })),
              batchErrors: persistResult.errors,
            }),
            executionTimeMs: stockDurationMs,
          },
        });
      }

      const totalDurationMs = Date.now() - startTime;
      const totalUsefulRecords = totalInserted + totalUpdated;
      const anyStockSucceeded = perStockResults.some((r) => r.status === 'SUCCESS');
      const anyStockPartial = perStockResults.some((r) => r.status === 'PARTIAL');

      let overallStatus;
      if (!hasFailures) {
        overallStatus = 'SUCCESS';
      } else if (totalUsefulRecords > 0 || anyStockSucceeded || anyStockPartial) {
        overallStatus = 'PARTIAL';
      } else {
        overallStatus = 'FAILED';
      }

      const totalExpectedDays = perStockResults.reduce((acc, r) => acc + (r.expectedTradingDaysCount || 0), 0);
      const totalMissingDays = perStockResults.reduce((acc, r) => acc + (r.missingTradingDaysCount || 0), 0);
      const overallCoverage = totalExpectedDays > 0
        ? Number((((totalExpectedDays - totalMissingDays) / totalExpectedDays) * 100).toFixed(2))
        : 100.0;

      const summaryPayload = {
        status: overallStatus,
        mode: dryRun ? 'DRY_RUN' : 'LIVE',
        interval,
        dateRange: { from: fromDate, to: toDate },
        totalStocks: symbols.length,
        stocksProcessed: perStockResults.length,
        totalFetched,
        totalInserted,
        totalUpdated,
        totalRejected,
        totalDuplicates,
        totalExpectedTradingDays: totalExpectedDays,
        totalMissingTradingDays: totalMissingDays,
        overallCoveragePercentage: overallCoverage,
        durationMs: totalDurationMs,
        timestamp: new Date().toISOString(),
        details: perStockResults,
      };

      // 3. Persist latest ingestion summary in SystemConfig
      if (!dryRun) {
        try {
          await this.prisma.systemConfig.upsert({
            where: { key: 'UPSTOX_HISTORICAL_INGESTION_SUMMARY' },
            update: { value: JSON.stringify(summaryPayload) },
            create: { key: 'UPSTOX_HISTORICAL_INGESTION_SUMMARY', value: JSON.stringify(summaryPayload) },
          });
        } catch {
          // Non-critical configuration write error
        }
      }

      return summaryPayload;
    } catch (err) {
      if (err.code === 'INGESTION_LOCK_LOST') {
        try {
          await this.prisma.dataSourceLog.create({
            data: {
              provider: 'UPSTOX',
              operation: 'SYNC_OHLCV',
              status: 'FAILED',
              recordsProcessed: 0,
              errorMessage: `[FATAL_LOCK_LOST] ${err.message}`,
              executionTimeMs: Date.now() - startTime,
            },
          });
        } catch {
          // Ignore secondary logging failure
        }
      }
      throw err;
    } finally {
      // 4. Always stop heartbeat and release distributed lock in finally block
      this._stopHeartbeat();
      await this._releaseLock();
    }
  }

  /**
   * Retrieves the latest historical ingestion summary from SystemConfig.
   *
   * @returns {Promise<Object|null>}
   */
  async getLatestStatus() {
    const configRow = await this.prisma.systemConfig.findUnique({
      where: { key: 'UPSTOX_HISTORICAL_INGESTION_SUMMARY' },
    });

    if (!configRow) return null;

    try {
      return JSON.parse(configRow.value);
    } catch {
      return null;
    }
  }
}

export default new HistoricalIngestionService();
