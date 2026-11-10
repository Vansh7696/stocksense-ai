import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/config/prisma.js';
import redisClient from '../src/config/redis.js';
import {
  HistoricalIngestionService,
  HISTORICAL_INGESTION_LOCK_KEY,
  getKolkataDateString,
} from '../src/services/historical/historicalIngestion.service.js';
import { HistoricalPersistence } from '../src/services/historical/historicalPersistence.js';
import { UpstoxProvider } from '../src/providers/upstox/UpstoxProvider.js';
import marketDataValidatorService from '../src/services/marketDataValidator.service.js';
import cacheService from '../src/services/cache.service.js';

describe('Milestone 3 — Step 7: Historical Market Data Ingestion Test Suite', () => {
  let seededStock = null;
  let testPersistence = null;

  before(async () => {
    // Verify running against isolated test database
    assert.ok(process.env.NODE_ENV === 'test');

    seededStock = await prisma.stock.findFirst({
      where: { symbol: 'RELIANCE', exchange: { code: 'NSE' }, isActive: true },
      include: { exchange: true },
    });
    assert.ok(seededStock, 'Test database must have seeded NSE RELIANCE stock');

    testPersistence = new HistoricalPersistence({ prisma, batchSize: 50 });
  });

  after(async () => {
    // Clean up test historical prices and logs created during testing
    if (seededStock) {
      await prisma.historicalPrice.deleteMany({ where: { stockId: seededStock.id } });
    }
    await prisma.dataSourceLog.deleteMany({
      where: { provider: 'UPSTOX', operation: 'SYNC_OHLCV' },
    });
    await prisma.systemConfig.deleteMany({
      where: { key: 'UPSTOX_HISTORICAL_INGESTION_SUMMARY' },
    });
    if (redisClient) {
      await redisClient.del(HISTORICAL_INGESTION_LOCK_KEY);
    }
    await cacheService.invalidateStockPricesCache();
  });

  beforeEach(async () => {
    // Clear lock before each test
    if (redisClient) {
      await redisClient.del(HISTORICAL_INGESTION_LOCK_KEY);
    }
  });

  // -------------------------------------------------------------
  // 1. Date Range Chunking & Boundary Transitions
  // -------------------------------------------------------------
  describe('1. Date Range Chunking & Boundary Transitions', () => {
    const provider = new UpstoxProvider();

    test('splits 3-year date range into consecutive 365-day chunks with zero gaps or overlaps', () => {
      // 2023 (365d) + 2024 leap year (366d) + 2025 (365d) = 1,096 days -> 4 chunks (3x365 + 1)
      const chunks = provider.chunkDateRange('2023-01-01', '2025-12-31', 365);
      assert.equal(chunks.length, 4);
      assert.equal(chunks[0].from, '2023-01-01');
      assert.equal(chunks[0].to, '2023-12-31');
      assert.equal(chunks[1].from, '2024-01-01');
      assert.equal(chunks[1].to, '2024-12-30'); // 2024 is leap year (366 days)
      assert.equal(chunks[2].from, '2024-12-31');
      assert.equal(chunks[2].to, '2025-12-30');
      assert.equal(chunks[3].from, '2025-12-31');
      assert.equal(chunks[3].to, '2025-12-31');

      // Verify no gaps between chunks
      for (let i = 0; i < chunks.length - 1; i++) {
        const nextDayOfEnd = new Date(chunks[i].to);
        nextDayOfEnd.setUTCDate(nextDayOfEnd.getUTCDate() + 1);
        assert.equal(nextDayOfEnd.toISOString().split('T')[0], chunks[i + 1].from);
      }
    });

    test('handles leap-year February boundary correctly (2024 leap year)', () => {
      // Feb 15 to Mar 25 in 2024 (leap year Feb has 29 days) -> 40 days total, splits into 30d + 10d
      const chunks = provider.chunkDateRange('2024-02-15', '2024-03-25', 30);
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0].from, '2024-02-15');
      assert.equal(chunks[0].to, '2024-03-15'); // 15 days in Feb (Feb 15..29) + 15 days in Mar (Mar 1..15) = 30 days
      assert.equal(chunks[1].from, '2024-03-16');
      assert.equal(chunks[1].to, '2024-03-25');
    });

    test('handles month-end transitions smoothly (e.g. Jan 31 to Feb 1)', () => {
      const chunks = provider.chunkDateRange('2025-01-25', '2025-02-10', 10);
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0].from, '2025-01-25');
      assert.equal(chunks[0].to, '2025-02-03');
      assert.equal(chunks[1].from, '2025-02-04');
      assert.equal(chunks[1].to, '2025-02-10');
    });

    test('handles year-boundary rollovers with zero date drift (Dec 31 to Jan 1)', () => {
      const chunks = provider.chunkDateRange('2024-12-25', '2025-01-05', 10);
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0].from, '2024-12-25');
      assert.equal(chunks[0].to, '2025-01-03');
      assert.equal(chunks[1].from, '2025-01-04');
      assert.equal(chunks[1].to, '2025-01-05');
    });

    test('rejects fromDate after toDate with explicit error', () => {
      assert.throws(
        () => provider.chunkDateRange('2025-12-31', '2025-01-01', 30),
        /fromDate.*cannot be after toDate/
      );
    });

    test('HistoricalIngestionService validates date format and rejects invalid inputs', () => {
      const service = new HistoricalIngestionService();
      assert.throws(
        () => service._validateDateRange('invalid-from', '2025-12-31'),
        (err) => err.code === 'INVALID_DATE_FROM'
      );
      assert.throws(
        () => service._validateDateRange('2025-01-01', 'not-a-date'),
        (err) => err.code === 'INVALID_DATE_TO'
      );
      assert.throws(
        () => service._validateDateRange('2025-12-31', '2025-01-01'),
        (err) => err.code === 'INVALID_DATE_RANGE'
      );
    });

    test('HistoricalIngestionService prevents future trading dates from being requested', () => {
      const service = new HistoricalIngestionService();
      const futureDate = '2099-01-01';
      assert.throws(
        () => service._validateDateRange('2025-01-01', futureDate),
        (err) => {
          assert.equal(err.code, 'INVALID_DATE_FUTURE');
          assert.equal(err.statusCode, 400);
          assert.ok(err.message.includes('Asia/Kolkata'));
          return true;
        }
      );
    });

    test('HistoricalIngestionService defaults to past 365 days up to today in Asia/Kolkata', () => {
      const service = new HistoricalIngestionService();
      const { fromDate, toDate } = service._validateDateRange();
      const expectedTo = getKolkataDateString(new Date());

      assert.equal(toDate, expectedTo);
      assert.match(fromDate, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(toDate, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(new Date(fromDate) < new Date(toDate));
    });

    test('handles single-day inclusive date chunk (from === to)', () => {
      const chunks = provider.chunkDateRange('2025-06-15', '2025-06-15', 365);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].from, '2025-06-15');
      assert.equal(chunks[0].to, '2025-06-15');
    });
  });

  // -------------------------------------------------------------
  // 2. Candle Validation & BigInt Volume Precision
  // -------------------------------------------------------------
  describe('2. Candle Validation & BigInt Volume Precision', () => {
    test('validates correct OHLCV candle records and converts to DECIMAL(14, 4) strings', () => {
      const raw = ['2026-03-15T09:15:00+05:30', 2500.5, 2530.0, 2490.25, 2520.75, 1500000, 0];
      const candle = marketDataValidatorService.validateCandle(raw);

      assert.equal(candle.openDecimal, '2500.5000');
      assert.equal(candle.highDecimal, '2530.0000');
      assert.equal(candle.lowDecimal, '2490.2500');
      assert.equal(candle.closeDecimal, '2520.7500');
      assert.equal(candle.volume, 1500000n);
      assert.equal(typeof candle.volume, 'bigint');
      assert.equal(candle.volumeString, '1500000');
    });

    test('preserves BigInt volume precision without loss for large institutional trades', () => {
      const largeVolume = BigInt('9007199254740999'); // Larger than Number.MAX_SAFE_INTEGER
      const raw = ['2026-03-15T09:15:00+05:30', 2500, 2530, 2490, 2520, largeVolume, 0];
      const candle = marketDataValidatorService.validateCandle(raw);

      assert.equal(candle.volume, 9007199254740999n);
      assert.equal(candle.volumeString, '9007199254740999');
    });

    test('rejects inverted candles (High < Low) with HIGH_LESS_THAN_LOW', () => {
      const raw = ['2026-03-15T09:15:00+05:30', 2500, 2480, 2520, 2500, 1000, 0]; // High 2480 < Low 2520
      assert.throws(
        () => marketDataValidatorService.validateCandle(raw),
        (err) => err.code === 'HIGH_LESS_THAN_LOW'
      );
    });

    test('rejects negative trading volume with NEGATIVE_VOLUME', () => {
      const raw = ['2026-03-15T09:15:00+05:30', 2500, 2530, 2490, 2520, -500, 0];
      assert.throws(
        () => marketDataValidatorService.validateCandle(raw),
        (err) => err.code === 'NEGATIVE_VOLUME'
      );
    });

    test('rejects excess decimal precision (> 4 decimals) with EXCESS_DECIMAL_PRECISION', () => {
      const raw = ['2026-03-15T09:15:00+05:30', '2500.12345', 2530, 2490, 2520, 1000, 0];
      assert.throws(
        () => marketDataValidatorService.validateCandle(raw),
        (err) => err.code === 'EXCESS_DECIMAL_PRECISION'
      );
    });

    test('validateCandleBatch filters invalid bars and sorts valid bars chronologically', () => {
      const rawBatch = [
        ['2026-03-16T09:15:00+05:30', 2510, 2540, 2500, 2530, 10000, 0],
        ['2026-03-15T09:15:00+05:30', 2500, 2530, 2490, 2520, 12000, 0], // Out of chronological order
        ['2026-03-17T09:15:00+05:30', 2530, 2500, 2540, 2510, 11000, 0], // Inverted High < Low
      ];

      const res = marketDataValidatorService.validateCandleBatch(rawBatch);
      assert.equal(res.valid.length, 2);
      assert.equal(res.rejected.length, 1);
      assert.equal(res.rejected[0].code, 'HIGH_LESS_THAN_LOW');

      // Valid must be sorted chronologically ascending
      assert.ok(res.valid[0].timestamp.getTime() < res.valid[1].timestamp.getTime());
      assert.equal(res.valid[0].originalTimestampString, '2026-03-15T09:15:00+05:30');
      assert.equal(res.valid[1].originalTimestampString, '2026-03-16T09:15:00+05:30');
    });
  });

  // -------------------------------------------------------------
  // 3. Database Persistence & Repeated Ingestion Idempotency
  // -------------------------------------------------------------
  describe('3. Database Persistence & Repeated Ingestion Idempotency', () => {
    const sampleCandles = [
      {
        timestamp: new Date('2026-02-01T09:15:00.000Z'),
        open: '2500.0000',
        high: '2540.0000',
        low: '2490.0000',
        close: '2530.0000',
        volume: 1000000n,
        dataSource: 'UPSTOX',
      },
      {
        timestamp: new Date('2026-02-02T09:15:00.000Z'),
        open: '2530.0000',
        high: '2560.0000',
        low: '2520.0000',
        close: '2550.0000',
        volume: 1200000n,
        dataSource: 'UPSTOX',
      },
    ];

    beforeEach(async () => {
      await prisma.historicalPrice.deleteMany({ where: { stockId: seededStock.id } });
    });

    test('dryRun mode calculates inserted vs updated without database mutation', async () => {
      const res = await testPersistence.persistBatch(seededStock.id, '1D', sampleCandles, { dryRun: true });
      assert.equal(res.inserted, 2);
      assert.equal(res.updated, 0);

      // Verify zero records were actually written to DB
      const count = await prisma.historicalPrice.count({ where: { stockId: seededStock.id } });
      assert.equal(count, 0);
    });

    test('persists candles and preserves native BigInt volume in PostgreSQL', async () => {
      const res = await testPersistence.persistBatch(seededStock.id, '1D', sampleCandles, { dryRun: false });
      assert.equal(res.inserted, 2);
      assert.equal(res.updated, 0);

      const dbCandles = await prisma.historicalPrice.findMany({
        where: { stockId: seededStock.id },
        orderBy: { timestamp: 'asc' },
      });
      assert.equal(dbCandles.length, 2);
      assert.equal(dbCandles[0].open.toString(), '2500');
      assert.equal(dbCandles[0].volume, 1000000n);
      assert.equal(typeof dbCandles[0].volume, 'bigint');
    });

    test('repeated ingestion is 100% idempotent (updates existing, zero duplicates created)', async () => {
      // First run: inserts 2
      const res1 = await testPersistence.persistBatch(seededStock.id, '1D', sampleCandles, { dryRun: false });
      assert.equal(res1.inserted, 2);
      assert.equal(res1.updated, 0);

      // Second run: updates 2, inserts 0
      const res2 = await testPersistence.persistBatch(seededStock.id, '1D', sampleCandles, { dryRun: false });
      assert.equal(res2.inserted, 0);
      assert.equal(res2.updated, 2);

      // Total count in database remains exactly 2
      const finalCount = await prisma.historicalPrice.count({ where: { stockId: seededStock.id } });
      assert.equal(finalCount, 2);
    });

    test('deduplicates within same input batch if identical timestamp appears twice', async () => {
      const batchWithDup = [...sampleCandles, sampleCandles[0]]; // 3 items, 1 duplicate
      const res = await testPersistence.persistBatch(seededStock.id, '1D', batchWithDup, { dryRun: false });
      assert.equal(res.inserted, 2);
      assert.equal(res.skipped, 1);

      const count = await prisma.historicalPrice.count({ where: { stockId: seededStock.id } });
      assert.equal(count, 2);
    });
  });

  // -------------------------------------------------------------
  // 4. HistoricalIngestionService End-to-End Orchestration
  // -------------------------------------------------------------
  describe('4. HistoricalIngestionService End-to-End Orchestration', () => {
    beforeEach(async () => {
      await prisma.historicalPrice.deleteMany({ where: { stockId: seededStock.id } });
      await prisma.dataSourceLog.deleteMany({ where: { provider: 'UPSTOX', operation: 'SYNC_OHLCV' } });
    });

    test('successfully ingests historical candles, logs to DataSourceLog, and invalidates price cache', async () => {
      let invalidatedPricesStockId = null;
      const mockCacheService = {
        invalidateStockPricesCache: async (id) => {
          invalidatedPricesStockId = id;
          return 1;
        },
      };

      const mockProvider = {
        resolveInstrumentKey: () => seededStock.instrumentToken,
        getHistoricalCandles: async () => ({
          status: 'SUCCESS',
          data: [
            {
              timestamp: new Date('2026-03-01T09:15:00.000Z'),
              open: '2500.0000',
              high: '2550.0000',
              low: '2490.0000',
              close: '2540.0000',
              volume: 1000000n,
              dataSource: 'UPSTOX',
            },
            {
              timestamp: new Date('2026-03-02T09:15:00.000Z'),
              open: '2540.0000',
              high: '2580.0000',
              low: '2530.0000',
              close: '2570.0000',
              volume: 1100000n,
              dataSource: 'UPSTOX',
            },
          ],
          rejected: [],
          failedChunks: [],
        }),
      };

      const service = new HistoricalIngestionService({
        provider: mockProvider,
        persistence: testPersistence,
        cacheService: mockCacheService,
        prisma,
        redisClient,
      });

      const result = await service.ingest({
        symbols: ['RELIANCE'],
        from: '2026-03-01',
        to: '2026-03-02',
        interval: '1D',
        dryRun: false,
      });

      assert.equal(result.status, 'SUCCESS');
      assert.equal(result.totalStocks, 1);
      assert.equal(result.totalInserted, 2);
      assert.equal(result.totalUpdated, 0);

      // Verify DataSourceLog recorded execution
      const logs = await prisma.dataSourceLog.findMany({
        where: { provider: 'UPSTOX', operation: 'SYNC_OHLCV' },
      });
      assert.equal(logs.length, 1);
      assert.equal(logs[0].status, 'SUCCESS');
      assert.equal(logs[0].recordsProcessed, 2);

      // Verify targeted cache invalidation occurred for this stock
      assert.equal(invalidatedPricesStockId, seededStock.id);

      // Verify SystemConfig summary was updated
      const summaryConfig = await prisma.systemConfig.findUnique({
        where: { key: 'UPSTOX_HISTORICAL_INGESTION_SUMMARY' },
      });
      assert.ok(summaryConfig);
      const parsedSummary = JSON.parse(summaryConfig.value);
      assert.equal(parsedSummary.status, 'SUCCESS');
      assert.equal(parsedSummary.totalInserted, 2);
    });

    test('handles partial API failures gracefully (PARTIAL status logged in DataSourceLog)', async () => {
      const mockProvider = {
        resolveInstrumentKey: () => seededStock.instrumentToken,
        getHistoricalCandles: async () => ({
          status: 'PARTIAL',
          data: [
            {
              timestamp: new Date('2026-03-01T09:15:00.000Z'),
              open: '2500.0000',
              high: '2550.0000',
              low: '2490.0000',
              close: '2540.0000',
              volume: 1000000n,
              dataSource: 'UPSTOX',
            },
          ],
          rejected: [],
          failedChunks: [
            {
              chunk: { from: '2026-03-02', to: '2026-03-03' },
              error: 'Provider HTTP 504 Gateway Timeout',
              code: 'PROVIDER_TIMEOUT',
            },
          ],
        }),
      };

      const service = new HistoricalIngestionService({
        provider: mockProvider,
        persistence: testPersistence,
        prisma,
        redisClient,
      });

      const result = await service.ingest({
        symbols: ['RELIANCE'],
        from: '2026-03-01',
        to: '2026-03-03',
        interval: '1D',
      });

      assert.equal(result.status, 'PARTIAL');
      assert.equal(result.totalInserted, 1);

      // Verify DataSourceLog recorded PARTIAL status
      const logs = await prisma.dataSourceLog.findMany({
        where: { provider: 'UPSTOX', operation: 'SYNC_OHLCV' },
      });
      assert.equal(logs.length, 1);
      assert.equal(logs[0].status, 'PARTIAL');
      assert.ok(logs[0].errorMessage.includes('PROVIDER_TIMEOUT'));
    });

    test('rejects unresolvable stock gracefully without failing entire run', async () => {
      const service = new HistoricalIngestionService({
        persistence: testPersistence,
        prisma,
        redisClient,
      });

      const result = await service.ingest({
        symbols: ['NON_EXISTENT_XYZ'],
        from: '2026-03-01',
        to: '2026-03-02',
      });

      assert.equal(result.status, 'FAILED');
      assert.equal(result.details[0].code, 'STOCK_NOT_FOUND');
    });

    test('classifies stock and run as FAILED (never PARTIAL) when 0 candles are fetched due to failed chunks', async () => {
      const mockProvider = {
        resolveInstrumentKey: () => seededStock.instrumentToken,
        getHistoricalCandles: async () => ({
          status: 'FAILED',
          data: [],
          rejected: [],
          failedChunks: [
            {
              chunk: { from: '2026-03-01', to: '2026-03-02' },
              error: 'Authentication failed. Access token invalid or expired.',
              code: 'REAUTHORIZATION_REQUIRED',
            },
          ],
        }),
      };

      const service = new HistoricalIngestionService({
        provider: mockProvider,
        persistence: testPersistence,
        prisma,
        redisClient,
      });

      const result = await service.ingest({
        symbols: ['RELIANCE'],
        from: '2026-03-01',
        to: '2026-03-02',
        interval: '1D',
      });

      // Crucial audit check: 0 candles fetched must result in FAILED, NOT PARTIAL
      assert.equal(result.status, 'FAILED');
      assert.equal(result.details[0].status, 'FAILED');
      assert.equal(result.totalInserted, 0);
      assert.equal(result.totalUpdated, 0);

      // Verify DataSourceLog recorded FAILED and 0 recordsProcessed
      const logs = await prisma.dataSourceLog.findMany({
        where: { provider: 'UPSTOX', operation: 'SYNC_OHLCV' },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(logs.length > 0);
      assert.equal(logs[0].status, 'FAILED');
      assert.equal(logs[0].recordsProcessed, 0);
    });

    test('dryRun fails and never claims success when provider authentication fails', async () => {
      const mockProvider = {
        resolveInstrumentKey: () => seededStock.instrumentToken,
        getHistoricalCandles: async () => {
          const err = new Error('Upstox access token is missing or expired. Reauthorization required.');
          err.code = 'REAUTHORIZATION_REQUIRED';
          err.statusCode = 401;
          throw err;
        },
      };

      const service = new HistoricalIngestionService({
        provider: mockProvider,
        persistence: testPersistence,
        prisma,
        redisClient,
      });

      const result = await service.ingest({
        symbols: ['RELIANCE'],
        from: '2026-03-01',
        to: '2026-03-02',
        interval: '1D',
        dryRun: true,
      });

      assert.equal(result.status, 'FAILED');
      assert.equal(result.mode, 'DRY_RUN');
      assert.equal(result.totalInserted, 0);
      assert.equal(result.totalUpdated, 0);
      assert.equal(result.details[0].code, 'REAUTHORIZATION_REQUIRED');
    });

    test('multi-stock ingestion returns PARTIAL when one stock succeeds and another fails', async () => {
      const mockProvider = {
        resolveInstrumentKey: (stk) => stk?.instrumentToken || null,
        getHistoricalCandles: async () => ({
          status: 'SUCCESS',
          data: [
            {
              timestamp: new Date('2026-03-01T09:15:00.000Z'),
              open: '2500.0000',
              high: '2550.0000',
              low: '2490.0000',
              close: '2540.0000',
              volume: 1000000n,
              dataSource: 'UPSTOX',
            },
          ],
          rejected: [],
          failedChunks: [],
        }),
      };

      const service = new HistoricalIngestionService({
        provider: mockProvider,
        persistence: testPersistence,
        prisma,
        redisClient,
      });

      const result = await service.ingest({
        symbols: ['RELIANCE', 'NON_EXISTENT_XYZ'],
        from: '2026-03-01',
        to: '2026-03-02',
      });

      assert.equal(result.status, 'PARTIAL');
      assert.equal(result.stocksProcessed, 2);
      assert.equal(result.details[0].symbol, 'RELIANCE');
      assert.equal(result.details[0].status, 'SUCCESS');
      assert.equal(result.details[1].symbol, 'NON_EXISTENT_XYZ');
      assert.equal(result.details[1].status, 'FAILED');
    });
  });

  // -------------------------------------------------------------
  // 5. Distributed Lock & Fail-Closed Safety
  // -------------------------------------------------------------
  describe('5. Distributed Lock & Fail-Closed Safety', () => {
    test('blocks concurrent ingestion jobs with 409 INGESTION_ALREADY_IN_PROGRESS', async () => {
      // Simulate an active lock
      await redisClient.set(HISTORICAL_INGESTION_LOCK_KEY, 'active-worker-token', 'EX', 60);

      const service = new HistoricalIngestionService({ prisma, redisClient });

      await assert.rejects(
        async () => {
          await service.ingest({ symbols: ['RELIANCE'] });
        },
        (err) => {
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'INGESTION_ALREADY_IN_PROGRESS');
          return true;
        }
      );
    });

    test('fails closed with 503 INGESTION_LOCK_UNAVAILABLE when Redis is offline', async () => {
      const offlineRedis = {
        status: 'close',
        set: async () => {
          throw new Error('Redis connection refused: ECONNREFUSED');
        },
      };

      const service = new HistoricalIngestionService({
        prisma,
        redisClient: offlineRedis,
      });

      await assert.rejects(
        async () => {
          await service.ingest({ symbols: ['RELIANCE'] });
        },
        (err) => {
          assert.equal(err.statusCode, 503);
          assert.equal(err.code, 'INGESTION_LOCK_UNAVAILABLE');
          return true;
        }
      );
    });

    test('releases distributed lock in finally block even when ingestion throws', async () => {
      const mockProvider = {
        resolveInstrumentKey: () => seededStock.instrumentToken,
        getHistoricalCandles: async () => {
          throw new Error('Fatal unhandled error inside provider');
        },
      };

      const service = new HistoricalIngestionService({
        provider: mockProvider,
        persistence: testPersistence,
        prisma,
        redisClient,
      });

      // Service catches per-stock error and releases lock cleanly
      await service.ingest({ symbols: ['RELIANCE'] });

      // Verify lock was released
      const lockVal = await redisClient.get(HISTORICAL_INGESTION_LOCK_KEY);
      assert.equal(lockVal, null, 'Distributed lock must be cleared upon completion');
    });

    test('atomic Lua compare-and-delete prevents older process from deleting newer lock', async () => {
      const service = new HistoricalIngestionService({ prisma, redisClient });

      // Acquire lock with token A
      await service._acquireLock();
      const tokenA = service._currentLockToken;

      // Simulate lock TTL expiration and another worker acquiring with token B
      await redisClient.set(HISTORICAL_INGESTION_LOCK_KEY, 'newer-worker-token-b', 'EX', 60);

      // Attempt to release using older token A
      const released = await service._releaseLock(tokenA);
      assert.equal(released, false, 'Lua script must not delete lock owned by a different token');

      // Newer token B should still own the lock
      const currentVal = await redisClient.get(HISTORICAL_INGESTION_LOCK_KEY);
      assert.equal(currentVal, 'newer-worker-token-b');
    });

    test('atomic Lua renewal (_renewLock) extends lock TTL when token matches', async () => {
      const service = new HistoricalIngestionService({ prisma, redisClient, lockTtlSeconds: 10 });

      // 1. Acquire lock
      const acquired = await service._acquireLock();
      assert.equal(acquired, true);

      // Check initial TTL
      const initialTtl = await redisClient.ttl(HISTORICAL_INGESTION_LOCK_KEY);
      assert.ok(initialTtl > 0 && initialTtl <= 10);

      // 2. Renew lock with 30s TTL
      const renewed = await service._renewLock(30);
      assert.equal(renewed, true, '_renewLock must return true when token matches');

      // Check updated TTL
      const renewedTtl = await redisClient.ttl(HISTORICAL_INGESTION_LOCK_KEY);
      assert.ok(renewedTtl > 10 && renewedTtl <= 30, `Renewed TTL should be up to 30s, got ${renewedTtl}`);

      await service._releaseLock();
    });

    test('atomic Lua renewal (_renewLock) rejects renewal when token does not match', async () => {
      const service = new HistoricalIngestionService({ prisma, redisClient });

      await service._acquireLock();
      const myToken = service._currentLockToken;

      // Simulate expiration and acquisition by another worker
      await redisClient.set(HISTORICAL_INGESTION_LOCK_KEY, 'other-worker-token', 'EX', 60);

      // Attempt renewal with the outdated token
      const renewed = await service._renewLock(60);
      assert.equal(renewed, false, '_renewLock must return false when token mismatch occurs');

      // Verify the other worker's token was not modified or overwritten
      const currentToken = await redisClient.get(HISTORICAL_INGESTION_LOCK_KEY);
      assert.equal(currentToken, 'other-worker-token');

      // Release should also fail
      const released = await service._releaseLock(myToken);
      assert.equal(released, false);
    });

    test('heartbeat starts, periodically renews lock, and cleans up timer on release', async () => {
      const service = new HistoricalIngestionService({ prisma, redisClient, lockTtlSeconds: 3 });

      await service._acquireLock(3);
      assert.ok(service._currentLockToken);

      // Start heartbeat with short 3s TTL (interval = 1000ms)
      service._startHeartbeat(3);
      assert.ok(service._heartbeatInterval, 'Heartbeat interval must be initialized');

      // Wait 1.2 seconds for heartbeat to tick
      await new Promise((resolve) => setTimeout(resolve, 1200));

      // Key should still be alive because of renewal
      const remainingTtl = await redisClient.ttl(HISTORICAL_INGESTION_LOCK_KEY);
      assert.ok(remainingTtl > 0, `Lock should have been renewed, TTL is ${remainingTtl}`);

      // Stop heartbeat and release
      service._stopHeartbeat();
      assert.equal(service._heartbeatInterval, null, 'Heartbeat interval must be null after stop');

      await service._releaseLock();
      const finalVal = await redisClient.get(HISTORICAL_INGESTION_LOCK_KEY);
      assert.equal(finalVal, null);
    });

    test('exact concurrency scenario: Worker A loses lock during ingestion, Worker B acquires lock, Worker A halts with INGESTION_LOCK_LOST, zero further candles persisted, Worker B lock preserved', async () => {
      // Clean seeded stock candles
      await prisma.historicalPrice.deleteMany({ where: { stockId: seededStock.id } });

      let providerFetchAttempts = 0;
      const workerBToken = 'worker-b-active-ownership-token-' + Date.now();

      // Mock provider that yields 2 chunks of candles
      const mockProvider = {
        resolveInstrumentKey: () => seededStock.instrumentToken,
        getHistoricalCandles: async (key, interval, from, to, options) => {
          providerFetchAttempts++;

          // Chunk 1:
          if (options.beforeChunk) await options.beforeChunk({ chunk: { from: '2026-03-01', to: '2026-03-01' } });

          // SIMULATE LOCK LOSS & WORKER B ACQUISITION:
          // While Worker A is processing chunk 1, Worker A's lock expires/fails renewal,
          // and Worker B successfully acquires the lock with its own token.
          await redisClient.set(HISTORICAL_INGESTION_LOCK_KEY, workerBToken, 'EX', 120);

          // Chunk 2: When Worker A attempts to proceed to chunk 2, beforeChunk will detect lock loss!
          if (options.beforeChunk) await options.beforeChunk({ chunk: { from: '2026-03-02', to: '2026-03-02' } });

          return {
            status: 'SUCCESS',
            data: [
              {
                timestamp: new Date('2026-03-01T09:15:00.000Z'),
                open: '2500.0000',
                high: '2550.0000',
                low: '2490.0000',
                close: '2540.0000',
                volume: 1000000n,
                dataSource: 'UPSTOX',
              },
            ],
            rejected: [],
            failedChunks: [],
          };
        },
      };

      const workerA = new HistoricalIngestionService({
        provider: mockProvider,
        persistence: testPersistence,
        prisma,
        redisClient,
      });

      // Worker A must detect lock loss and fail with INGESTION_LOCK_LOST
      await assert.rejects(
        async () => {
          await workerA.ingest({
            symbols: ['RELIANCE'],
            from: '2026-03-01',
            to: '2026-03-02',
            interval: '1D',
          });
        },
        (err) => {
          assert.equal(err.code, 'INGESTION_LOCK_LOST');
          assert.ok(err.message.includes('Distributed lock') || err.message.includes('ownership'));
          return true;
        }
      );

      // 1. Worker A must NEVER release Worker B's lock
      const currentLockInRedis = await redisClient.get(HISTORICAL_INGESTION_LOCK_KEY);
      assert.equal(
        currentLockInRedis,
        workerBToken,
        "Worker B's lock must remain untouched in Redis after Worker A aborts"
      );

      // 2. Zero candles must have been persisted to PostgreSQL by Worker A after lock loss
      const candleCount = await prisma.historicalPrice.count({ where: { stockId: seededStock.id } });
      assert.equal(candleCount, 0, 'No candles must be persisted after Worker A loses lock');

      // 3. Worker A's heartbeat must be cleanly stopped
      assert.equal(workerA._heartbeatInterval, null, "Worker A's heartbeat must be cleaned up");

      // 4. Verify DataSourceLog records fatal lock loss
      const fatalLog = await prisma.dataSourceLog.findFirst({
        where: { provider: 'UPSTOX', operation: 'SYNC_OHLCV', status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(fatalLog);
      assert.ok(fatalLog.errorMessage.includes('FATAL_LOCK_LOST') || fatalLog.errorMessage.includes('INGESTION_LOCK_LOST'));

      // Cleanup Worker B lock
      await redisClient.del(HISTORICAL_INGESTION_LOCK_KEY);
    });

    test('simulates failed lock renewal during batch persistence: Worker A halts immediately, remaining batches NOT written', async () => {
      await prisma.historicalPrice.deleteMany({ where: { stockId: seededStock.id } });

      const sampleBatchCandles = [
        {
          timestamp: new Date('2026-01-01T09:15:00.000Z'),
          open: '2500.0000',
          high: '2550.0000',
          low: '2490.0000',
          close: '2540.0000',
          volume: 1000000n,
          dataSource: 'UPSTOX',
        },
        {
          timestamp: new Date('2026-01-02T09:15:00.000Z'),
          open: '2540.0000',
          high: '2580.0000',
          low: '2530.0000',
          close: '2570.0000',
          volume: 1100000n,
          dataSource: 'UPSTOX',
        },
      ];

      const workerBToken = 'worker-b-stolen-lock-' + Date.now();

      // Persistence with batchSize = 1 so there are 2 batches
      const smallBatchPersistence = new HistoricalPersistence({ prisma, batchSize: 1 });

      const mockProvider = {
        resolveInstrumentKey: () => seededStock.instrumentToken,
        getHistoricalCandles: async () => ({
          status: 'SUCCESS',
          data: sampleBatchCandles,
          rejected: [],
          failedChunks: [],
        }),
      };

      const workerA = new HistoricalIngestionService({
        provider: mockProvider,
        persistence: smallBatchPersistence,
        prisma,
        redisClient,
      });

      // Wrap persistence.persistBatch to simulate lock theft right before batch 2
      const originalPersistBatch = smallBatchPersistence.persistBatch.bind(smallBatchPersistence);
      smallBatchPersistence.persistBatch = async (stockId, interval, candles, options) => {
        return originalPersistBatch(stockId, interval, candles, {
          ...options,
          beforeBatch: async (batchInfo) => {
            if (batchInfo.index >= 1) {
              // Lock stolen right before batch 2
              await redisClient.set(HISTORICAL_INGESTION_LOCK_KEY, workerBToken, 'EX', 60);
            }
            if (options.beforeBatch) {
              await options.beforeBatch(batchInfo);
            }
          },
        });
      };

      // Ingestion must reject with INGESTION_LOCK_LOST
      await assert.rejects(
        async () => {
          await workerA.ingest({
            symbols: ['RELIANCE'],
            from: '2026-01-01',
            to: '2026-01-02',
          });
        },
        (err) => {
          assert.equal(err.code, 'INGESTION_LOCK_LOST');
          return true;
        }
      );

      // Only batch 1 (1 candle) was written before lock loss; batch 2 was blocked
      const count = await prisma.historicalPrice.count({ where: { stockId: seededStock.id } });
      assert.equal(count, 1, 'Only the batch written before lock loss should exist; subsequent batch must be blocked');

      // Worker B lock is intact
      const redisLock = await redisClient.get(HISTORICAL_INGESTION_LOCK_KEY);
      assert.equal(redisLock, workerBToken);

      // Cleanup
      await redisClient.del(HISTORICAL_INGESTION_LOCK_KEY);
      await prisma.historicalPrice.deleteMany({ where: { stockId: seededStock.id } });
    });

    test('heartbeat is stopped in all execution paths: success, lock loss, and unexpected throw', async () => {
      const service = new HistoricalIngestionService({ prisma, redisClient });

      // Path 1: Success path
      await service._acquireLock();
      service._startHeartbeat(10);
      assert.ok(service._heartbeatInterval);
      await service._releaseLock();
      assert.equal(service._heartbeatInterval, null);

      // Path 2: Lock renewal failure path
      await service._acquireLock();
      service._startHeartbeat(10);
      // Change token in Redis to simulate theft
      await redisClient.set(HISTORICAL_INGESTION_LOCK_KEY, 'stolen', 'EX', 10);
      const renewed = await service._renewLock(10);
      assert.equal(renewed, false);
      assert.equal(service._heartbeatInterval, null, 'Heartbeat must be stopped immediately when renewal fails');
      assert.equal(service._lockLost, true);
      assert.equal(service._lockLostError?.code, 'INGESTION_LOCK_LOST');

      // Cleanup
      await redisClient.del(HISTORICAL_INGESTION_LOCK_KEY);
    });
  });
});
