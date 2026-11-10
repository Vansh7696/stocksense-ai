import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/config/prisma.js';
import redisClient from '../src/config/redis.js';
import {
  HistoricalIngestionService,
  HISTORICAL_INGESTION_LOCK_KEY,
  INITIAL_NSE_EQUITIES,
  DEFAULT_HISTORICAL_YEARS,
} from '../src/services/historical/historicalIngestion.service.js';
import { HistoricalPersistence } from '../src/services/historical/historicalPersistence.js';
import { UpstoxProvider } from '../src/providers/upstox/UpstoxProvider.js';
import marketDataValidatorService from '../src/services/marketDataValidator.service.js';
import cacheService from '../src/services/cache.service.js';
import {
  isWeekend,
  getExchangeHoliday,
  isTradingDay,
  getExpectedTradingDays,
  analyzeCandleGaps,
  toKolkataDateString,
  INDIAN_EXCHANGE_HOLIDAYS,
} from '../src/utils/tradingCalendar.js';

describe('Milestone 5 — Phase 5A: Historical Market Data Foundation & Trading Calendar Suite', () => {
  let seededStock = null;
  let testPersistence = null;

  before(async () => {
    assert.ok(process.env.NODE_ENV === 'test', 'Test must run with NODE_ENV=test');

    seededStock = await prisma.stock.findFirst({
      where: { symbol: 'RELIANCE', exchange: { code: 'NSE' }, isActive: true },
      include: { exchange: true },
    });
    assert.ok(seededStock, 'Test database must have seeded NSE RELIANCE stock');

    testPersistence = new HistoricalPersistence({ prisma, batchSize: 50 });
  });

  after(async () => {
    try {
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
    } finally {
      // Disconnect connections when running standalone so Node exits naturally
      const isStandaloneRun = process.argv.some(
        (arg) => arg.includes('historicalFoundation.test.js') && !arg.includes('*')
      );
      if (isStandaloneRun) {
        try {
          if (redisClient && redisClient.status === 'ready') {
            await redisClient.quit();
          }
          await prisma.$disconnect();
        } catch {
          // Ignore teardown disconnect errors
        }
      }
    }
  });

  beforeEach(async () => {
    if (redisClient) {
      await redisClient.del(HISTORICAL_INGESTION_LOCK_KEY);
    }
  });

  // --------------------------------------------------------------------------
  // 1. Trading Calendar Engine & Holiday Schedules (2021–2026)
  // --------------------------------------------------------------------------
  describe('1. Trading Calendar Engine & Holiday Schedules', () => {
    test('contains verified Indian exchange holidays across 2021 through 2026', () => {
      // Key annual national holidays
      assert.equal(INDIAN_EXCHANGE_HOLIDAYS['2021-01-26'], 'Republic Day');
      assert.equal(INDIAN_EXCHANGE_HOLIDAYS['2022-08-15'], 'Independence Day');
      assert.equal(INDIAN_EXCHANGE_HOLIDAYS['2023-10-02'], 'Mahatma Gandhi Jayanti');
      assert.equal(INDIAN_EXCHANGE_HOLIDAYS['2024-01-22'], 'Special Holiday (Ayodhya Pran Pratishtha)');
      assert.equal(INDIAN_EXCHANGE_HOLIDAYS['2024-11-20'], 'Maharashtra Assembly Elections');
      assert.equal(INDIAN_EXCHANGE_HOLIDAYS['2025-08-15'], 'Independence Day');
      assert.equal(INDIAN_EXCHANGE_HOLIDAYS['2026-01-26'], 'Republic Day');
    });

    test('correctly identifies weekend days in Asia/Kolkata timezone', () => {
      // 2026-03-07 is Saturday, 2026-03-08 is Sunday, 2026-03-09 is Monday
      assert.equal(isWeekend('2026-03-07'), true);
      assert.equal(isWeekend('2026-03-08'), true);
      assert.equal(isWeekend('2026-03-09'), false);
    });

    test('correctly flags exchange holidays and non-holiday weekdays', () => {
      // 2026-01-26 is Republic Day (Monday holiday)
      assert.equal(getExchangeHoliday('2026-01-26'), 'Republic Day');
      assert.equal(isTradingDay('2026-01-26'), false);

      // 2026-01-27 is a regular Tuesday trading day
      assert.equal(getExchangeHoliday('2026-01-27'), null);
      assert.equal(isWeekend('2026-01-27'), false);
      assert.equal(isTradingDay('2026-01-27'), true);
    });

    test('computes chronological expected trading days excluding weekends and holidays', () => {
      // From Jan 23, 2026 (Fri) to Jan 27, 2026 (Tue)
      // Jan 23: Fri (Trading Day)
      // Jan 24: Sat (Weekend)
      // Jan 25: Sun (Weekend)
      // Jan 26: Mon (Republic Day Holiday)
      // Jan 27: Tue (Trading Day)
      const tradingDays = getExpectedTradingDays('2026-01-23', '2026-01-27');
      assert.deepEqual(tradingDays, ['2026-01-23', '2026-01-27']);
    });

    test('analyzeCandleGaps accurately measures coverage, missing days, and unexpected gaps', () => {
      const expectedDays = [
        '2026-02-02', // Mon
        '2026-02-03', // Tue
        '2026-02-04', // Wed - missing
        '2026-02-05', // Thu - missing (2-day gap with Feb 4)
        '2026-02-06', // Fri
      ];

      const candles = [
        { timestamp: new Date('2026-02-02T09:15:00+05:30') },
        { timestamp: new Date('2026-02-03T09:15:00+05:30') },
        { timestamp: new Date('2026-02-06T09:15:00+05:30') },
      ];

      const analysis = analyzeCandleGaps(expectedDays, candles.map((c) => c.timestamp));
      assert.equal(analysis.expectedTradingDaysCount, 5);
      assert.equal(analysis.actualCandlesCount, 3);
      assert.equal(analysis.uniqueTradingDaysCount, 3);
      assert.equal(analysis.missingTradingDaysCount, 2);
      assert.deepEqual(analysis.missingTradingDays, ['2026-02-04', '2026-02-05']);
      assert.equal(analysis.unexpectedGaps.length, 1);
      assert.equal(analysis.unexpectedGaps[0].from, '2026-02-04');
      assert.equal(analysis.unexpectedGaps[0].to, '2026-02-05');
      assert.equal(analysis.unexpectedGaps[0].daysCount, 2);
      assert.equal(analysis.coveragePercentage, 60.0);
    });

    test('does not report weekends or official exchange holidays as missing trading days', () => {
      // 2026-01-24 (Sat), 2026-01-25 (Sun), 2026-01-26 (Republic Day)
      const expected = getExpectedTradingDays('2026-01-23', '2026-01-27');
      // Candles present only for Jan 23 and Jan 27 (the only 2 trading days)
      const candles = [
        new Date('2026-01-23T09:15:00+05:30'),
        new Date('2026-01-27T09:15:00+05:30'),
      ];
      const analysis = analyzeCandleGaps(expected, candles);
      assert.equal(analysis.missingTradingDaysCount, 0);
      assert.equal(analysis.unexpectedGaps.length, 0);
      assert.equal(analysis.coveragePercentage, 100.0);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Upstox V3 Provider Date Chunking & Boundary Transitions
  // --------------------------------------------------------------------------
  describe('2. Provider Date Chunking & Range Management', () => {
    const provider = new UpstoxProvider();

    test('chunks 3-year date range into 365-day segments with strict continuity', () => {
      const chunks = provider.chunkDateRange('2023-01-01', '2025-12-31', 365);
      assert.equal(chunks.length, 4);
      assert.equal(chunks[0].from, '2023-01-01');
      assert.equal(chunks[0].to, '2023-12-31');
      assert.equal(chunks[1].from, '2024-01-01');
      assert.equal(chunks[1].to, '2024-12-30'); // Leap year 366 days
      assert.equal(chunks[2].from, '2024-12-31');
      assert.equal(chunks[2].to, '2025-12-30');
      assert.equal(chunks[3].from, '2025-12-31');
      assert.equal(chunks[3].to, '2025-12-31');
    });

    test('chunks 5-year date range into 365-day segments without losing any day', () => {
      const chunks = provider.chunkDateRange('2021-01-01', '2025-12-31', 365);
      // 5 calendar years with 1 leap year (2024) = 1826 days -> 5 * 365 + 1 day = 6 chunks
      assert.equal(chunks.length, 6);
      assert.equal(chunks[0].from, '2021-01-01');
      assert.equal(chunks[chunks.length - 1].to, '2025-12-31');

      for (let i = 0; i < chunks.length - 1; i++) {
        const nextDay = new Date(chunks[i].to);
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        assert.equal(nextDay.toISOString().split('T')[0], chunks[i + 1].from);
      }
    });

    test('handles leap-year February boundary correctly in 2024', () => {
      const chunks = provider.chunkDateRange('2024-02-20', '2024-03-05', 10);
      assert.equal(chunks.length, 2);
      // 2024-02-20 through 2024-02-29 has 10 days in leap year
      assert.equal(chunks[0].from, '2024-02-20');
      assert.equal(chunks[0].to, '2024-02-29');
      assert.equal(chunks[1].from, '2024-03-01');
      assert.equal(chunks[1].to, '2024-03-05');
    });

    test('rejects reversed date range where fromDate is after toDate', () => {
      assert.throws(
        () => provider.chunkDateRange('2025-12-31', '2025-01-01', 365),
        /fromDate.*cannot be after toDate/
      );
    });
  });

  // --------------------------------------------------------------------------
  // 3. Pre-Ingestion OHLCV Validation & Decimal Precision
  // --------------------------------------------------------------------------
  describe('3. Pre-Ingestion OHLCV Validation & Decimal Precision', () => {
    test('converts numeric prices into exact DECIMAL(14, 4) strings', () => {
      const raw = ['2026-03-02T09:15:00+05:30', 2850.5, 2890.0, 2840.25, 2875.75, 1250000, 0];
      const candle = marketDataValidatorService.validateCandle(raw);

      assert.equal(candle.openDecimal, '2850.5000');
      assert.equal(candle.highDecimal, '2890.0000');
      assert.equal(candle.lowDecimal, '2840.2500');
      assert.equal(candle.closeDecimal, '2875.7500');
      assert.equal(candle.volume, 1250000n);
      assert.equal(candle.volumeString, '1250000');
    });

    test('preserves BigInt volume without IEEE 754 precision loss', () => {
      const institutionalVolume = 9876543210123456n;
      const raw = ['2026-03-02T09:15:00+05:30', 1000, 1050, 990, 1020, institutionalVolume, 0];
      const candle = marketDataValidatorService.validateCandle(raw);

      assert.equal(candle.volume, 9876543210123456n);
      assert.equal(candle.volumeString, '9876543210123456');
    });

    test('rejects inverted candles where High < Low with HIGH_LESS_THAN_LOW', () => {
      const inverted = ['2026-03-02T09:15:00+05:30', 2500, 2450, 2550, 2500, 1000, 0];
      assert.throws(
        () => marketDataValidatorService.validateCandle(inverted),
        (err) => err.code === 'HIGH_LESS_THAN_LOW'
      );
    });

    test('rejects negative trading volume with NEGATIVE_VOLUME', () => {
      const negativeVol = ['2026-03-02T09:15:00+05:30', 2500, 2550, 2450, 2500, -100, 0];
      assert.throws(
        () => marketDataValidatorService.validateCandle(negativeVol),
        (err) => err.code === 'NEGATIVE_VOLUME'
      );
    });

    test('filters out invalid candles and sorts valid candles chronologically', () => {
      const batch = [
        ['2026-03-04T09:15:00+05:30', 100, 110, 95, 105, 5000, 0],
        ['2026-03-02T09:15:00+05:30', 90, 100, 85, 95, 4000, 0], // earlier date
        ['2026-03-03T09:15:00+05:30', 95, 90, 105, 95, 3000, 0], // inverted High < Low
      ];
      const validated = marketDataValidatorService.validateCandleBatch(batch);
      assert.equal(validated.valid.length, 2);
      assert.equal(validated.rejected.length, 1);
      assert.equal(validated.rejected[0].code, 'HIGH_LESS_THAN_LOW');
      assert.ok(validated.valid[0].timestamp.getTime() < validated.valid[1].timestamp.getTime());
    });
  });

  // --------------------------------------------------------------------------
  // 4. Persistence Idempotency & Batching
  // --------------------------------------------------------------------------
  describe('4. Persistence Idempotency & Batching', () => {
    test('persists a batch of candles and successfully handles duplicate timestamps', async () => {
      const candles = [
        {
          timestamp: new Date('2026-01-05T09:15:00.000Z'),
          open: '2500.0000',
          high: '2550.0000',
          low: '2480.0000',
          close: '2530.0000',
          volume: 1000000n,
          dataSource: 'UPSTOX',
        },
        {
          timestamp: new Date('2026-01-06T09:15:00.000Z'),
          open: '2530.0000',
          high: '2570.0000',
          low: '2510.0000',
          close: '2560.0000',
          volume: 1100000n,
          dataSource: 'UPSTOX',
        },
      ];

      // First insertion: 2 inserted
      const res1 = await testPersistence.persistBatch(seededStock.id, '1D', candles);
      assert.equal(res1.inserted, 2);
      assert.equal(res1.updated, 0);

      // Duplicate insertion of the exact same records: 2 updated/skipped, 0 errors
      const res2 = await testPersistence.persistBatch(seededStock.id, '1D', candles);
      assert.equal(res2.inserted, 0);
      assert.equal(res2.updated, 2);
      assert.equal(res2.errors.length, 0);

      // Verify records in DB
      const dbRows = await prisma.historicalPrice.findMany({
        where: { stockId: seededStock.id, interval: '1D' },
      });
      assert.equal(dbRows.length, 2);
    });

    test('deduplicates within-batch duplicate timestamps safely', async () => {
      const duplicateCandles = [
        {
          timestamp: new Date('2026-01-07T09:15:00.000Z'),
          open: '2560.0000',
          high: '2600.0000',
          low: '2550.0000',
          close: '2590.0000',
          volume: 1200000n,
          dataSource: 'UPSTOX',
        },
        {
          timestamp: new Date('2026-01-07T09:15:00.000Z'), // Duplicate timestamp within same batch
          open: '2560.0000',
          high: '2610.0000',
          low: '2550.0000',
          close: '2595.0000',
          volume: 1250000n,
          dataSource: 'UPSTOX',
        },
      ];

      // Within-batch duplicate: first is inserted, duplicate is skipped
      const res = await testPersistence.persistBatch(seededStock.id, '1D', duplicateCandles);
      assert.equal(res.inserted, 1);
      assert.equal(res.updated, 0);
      assert.equal(res.skipped, 1);
      assert.equal(res.errors.length, 0);

      // Subsequent batch with the same timestamp updates the existing PostgreSQL record
      const updateCandle = [
        {
          timestamp: new Date('2026-01-07T09:15:00.000Z'),
          open: '2560.0000',
          high: '2620.0000', // Adjusted high
          low: '2550.0000',
          close: '2600.0000', // Adjusted close
          volume: 1300000n,
          dataSource: 'UPSTOX',
        },
      ];

      const resUpdate = await testPersistence.persistBatch(seededStock.id, '1D', updateCandle);
      assert.equal(resUpdate.inserted, 0);
      assert.equal(resUpdate.updated, 1);
      assert.equal(resUpdate.skipped, 0);
      assert.equal(resUpdate.errors.length, 0);

      // Verify DB record has the updated values
      const updatedRow = await prisma.historicalPrice.findFirst({
        where: {
          stockId: seededStock.id,
          timestamp: new Date('2026-01-07T09:15:00.000Z'),
          interval: '1D',
        },
      });
      assert.ok(updatedRow);
      assert.equal(Number(updatedRow.high), 2620.0);
      assert.equal(Number(updatedRow.close), 2600.0);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Incremental Ingestion Logic
  // --------------------------------------------------------------------------
  describe('5. Incremental Ingestion Logic', () => {
    test('skips provider fetch when stored data is already up-to-date', async () => {
      // Ensure DB has a candle for 2026-02-10
      await prisma.historicalPrice.upsert({
        where: {
          stockId_timestamp_interval: {
            stockId: seededStock.id,
            timestamp: new Date('2026-02-10T09:15:00.000Z'),
            interval: '1D',
          },
        },
        create: {
          stockId: seededStock.id,
          timestamp: new Date('2026-02-10T09:15:00.000Z'),
          interval: '1D',
          open: '2500.0000',
          high: '2550.0000',
          low: '2490.0000',
          close: '2540.0000',
          volume: 1000000n,
          dataSource: 'UPSTOX',
        },
        update: {},
      });

      let providerCalled = false;
      const mockProvider = {
        resolveInstrumentKey: () => seededStock.instrumentToken,
        getHistoricalCandles: async () => {
          providerCalled = true;
          return { status: 'SUCCESS', data: [], rejected: [], failedChunks: [] };
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
        from: '2026-01-01',
        to: '2026-02-10',
        incremental: true,
      });

      assert.equal(result.status, 'SUCCESS');
      assert.equal(result.details[0].alreadyUpToDate, true);
      assert.equal(providerCalled, false, 'Provider must NOT be called when data is already up-to-date');
    });

    test('adjusts start date to latest stored candle when stale', async () => {
      let requestedFrom = null;
      const mockProvider = {
        resolveInstrumentKey: () => seededStock.instrumentToken,
        getHistoricalCandles: async (key, interval, from) => {
          requestedFrom = from;
          return {
            status: 'SUCCESS',
            data: [
              {
                timestamp: new Date('2026-02-11T09:15:00.000Z'),
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
          };
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
        from: '2026-01-01',
        to: '2026-02-15',
        incremental: true,
      });

      assert.equal(result.status, 'SUCCESS');
      // Must have requested from 2026-02-10 (the latest candle in DB)
      assert.equal(requestedFrom, '2026-02-10');
      assert.equal(result.totalInserted, 1);
    });
  });

  // --------------------------------------------------------------------------
  // 6. Partial Failures & Failed Chunk Isolation
  // --------------------------------------------------------------------------
  describe('6. Partial Failures & Failed Chunk Isolation', () => {
    test('records PARTIAL status and retains valid candles when a chunk fails', async () => {
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
      });

      assert.equal(result.status, 'PARTIAL');
      assert.equal(result.totalInserted, 1);
      assert.equal(result.details[0].failedChunksCount, 1);

      // Verify DataSourceLog recorded the partial failure
      const logs = await prisma.dataSourceLog.findMany({
        where: { provider: 'UPSTOX', operation: 'SYNC_OHLCV' },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(logs.length > 0);
      assert.equal(logs[0].status, 'PARTIAL');
      assert.ok(logs[0].errorMessage.includes('PROVIDER_TIMEOUT'));
    });
  });

  // --------------------------------------------------------------------------
  // 7. Redis Distributed Lock & Fail-Closed Safety
  // --------------------------------------------------------------------------
  describe('7. Redis Distributed Lock & Fail-Closed Safety', () => {
    test('acquires distributed lock with unique UUID and rejects concurrent executions', async () => {
      const service1 = new HistoricalIngestionService({ prisma, redisClient });
      const service2 = new HistoricalIngestionService({ prisma, redisClient });

      const acquired1 = await service1._acquireLock(60);
      assert.equal(acquired1, true);

      // Concurrent acquisition attempt must fail
      const acquired2 = await service2._acquireLock(60);
      assert.equal(acquired2, false);

      // Release lock
      const released = await service1._releaseLock();
      assert.equal(released, true);

      // Now service2 can acquire
      const acquired2After = await service2._acquireLock(60);
      assert.equal(acquired2After, true);
      await service2._releaseLock();
    });

    test('service.ingest rejects concurrent job with 409 INGESTION_ALREADY_IN_PROGRESS', async () => {
      const service1 = new HistoricalIngestionService({ prisma, redisClient });
      const service2 = new HistoricalIngestionService({ prisma, redisClient });

      await service1._acquireLock(60);

      await assert.rejects(
        () => service2.ingest({ symbols: ['RELIANCE'], from: '2026-01-01', to: '2026-01-05' }),
        (err) => {
          assert.equal(err.code, 'INGESTION_ALREADY_IN_PROGRESS');
          assert.equal(err.statusCode, 409);
          return true;
        }
      );

      await service1._releaseLock();
    });
  });

  // --------------------------------------------------------------------------
  // 8. Dry-Run Mode & Simulation
  // --------------------------------------------------------------------------
  describe('8. Dry-Run Mode & Simulation', () => {
    test('dryRun: true calculates inserted/updated counts without writing to database', async () => {
      // Clear any existing prices for this test window
      await prisma.historicalPrice.deleteMany({
        where: {
          stockId: seededStock.id,
          timestamp: {
            gte: new Date('2026-04-01T00:00:00.000Z'),
            lte: new Date('2026-04-05T00:00:00.000Z'),
          },
        },
      });

      const mockProvider = {
        resolveInstrumentKey: () => seededStock.instrumentToken,
        getHistoricalCandles: async () => ({
          status: 'SUCCESS',
          data: [
            {
              timestamp: new Date('2026-04-01T09:15:00.000Z'),
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
        symbols: ['RELIANCE'],
        from: '2026-04-01',
        to: '2026-04-05',
        dryRun: true,
      });

      assert.equal(result.status, 'SUCCESS');
      assert.equal(result.mode, 'DRY_RUN');
      assert.equal(result.totalInserted, 1);

      // Verify zero records were written to PostgreSQL
      const dbCount = await prisma.historicalPrice.count({
        where: {
          stockId: seededStock.id,
          timestamp: new Date('2026-04-01T09:15:00.000Z'),
        },
      });
      assert.equal(dbCount, 0, 'Dry run must not persist records to database');
    });
  });

  // --------------------------------------------------------------------------
  // 9. Cache Invalidation on Successful Ingestion
  // --------------------------------------------------------------------------
  describe('9. Cache Invalidation on Successful Ingestion', () => {
    test('invalidates stock prices cache in Redis after persistence', async () => {
      let cacheInvalidated = false;
      const customCache = {
        invalidateStockPricesCache: async (stockId) => {
          assert.equal(stockId, seededStock.id);
          cacheInvalidated = true;
        },
      };

      const mockProvider = {
        resolveInstrumentKey: () => seededStock.instrumentToken,
        getHistoricalCandles: async () => ({
          status: 'SUCCESS',
          data: [
            {
              timestamp: new Date('2026-04-10T09:15:00.000Z'),
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
        cacheService: customCache,
        prisma,
        redisClient,
      });

      await service.ingest({
        symbols: ['RELIANCE'],
        from: '2026-04-10',
        to: '2026-04-10',
        dryRun: false,
      });

      assert.equal(cacheInvalidated, true, 'Cache must be invalidated for the updated stock');
    });
  });
});
