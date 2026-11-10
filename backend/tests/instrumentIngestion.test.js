import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';
import redisClient, { isRedisReady } from '../src/config/redis.js';
import { config } from '../src/config/index.js';
import { InstrumentDownloader } from '../src/services/instruments/instrumentDownloader.js';
import { InstrumentParser } from '../src/services/instruments/instrumentParser.js';
import {
  InstrumentValidator,
  classifyInstrumentType,
  isValidISIN,
} from '../src/services/instruments/instrumentValidator.js';
import { InstrumentPersistence } from '../src/services/instruments/instrumentPersistence.js';
import instrumentIngestionService, {
  InstrumentIngestionService,
  INGESTION_LOCK_KEY,
} from '../src/services/instruments/instrumentIngestion.service.js';

/**
 * Creates a gzipped Buffer from a JavaScript object or string.
 */
function createMockGzip(data) {
  const content = typeof data === 'string' ? data : JSON.stringify(data);
  return zlib.gzipSync(Buffer.from(content, 'utf-8'));
}

describe('Milestone 3 — Step 5: Instrument Master Ingestion (instrumentIngestion.test.js)', () => {
  const sampleInstruments = [
    {
      segment: 'NSE_EQ',
      name: 'INFOSYS LIMITED',
      exchange: 'NSE',
      isin: 'INE009A01021',
      instrument_type: 'EQ',
      instrument_key: 'NSE_EQ|INE009A01021',
      lot_size: 1,
      freeze_quantity: 100000.0,
      exchange_token: '1594',
      tick_size: 5.0,
      trading_symbol: 'INFY',
      qty_multiplier: 1.0,
    },
    {
      segment: 'NSE_INDEX',
      name: 'Nifty 50',
      exchange: 'NSE',
      instrument_type: 'INDEX',
      instrument_key: 'NSE_INDEX|Nifty 50',
      exchange_token: '26000',
      trading_symbol: 'NIFTY 50',
    },
    {
      segment: 'BSE_EQ',
      name: 'TATA CONSULTANCY SERVICES LTD.',
      exchange: 'BSE',
      isin: 'INE467B01029',
      instrument_type: 'A',
      instrument_key: 'BSE_EQ|INE467B01029',
      lot_size: 1,
      freeze_quantity: 100000.0,
      exchange_token: '532540',
      tick_size: 5.0,
      trading_symbol: 'TCS',
    },
    {
      segment: 'BSE_INDEX',
      name: 'BSE SENSEX',
      exchange: 'BSE',
      instrument_type: 'INDEX',
      instrument_key: 'BSE_INDEX|SENSEX',
      exchange_token: '1',
      trading_symbol: 'SENSEX',
    },
    {
      segment: 'NSE_FO',
      name: 'RELIANCE INDUSTRIES LTD',
      exchange: 'NSE',
      expiry: 1798568999000,
      instrument_type: 'FUT',
      instrument_key: 'NSE_FO|99991',
      lot_size: 250,
      exchange_token: '99991',
      tick_size: 0.05,
      trading_symbol: 'RELIANCE FUT 26 NOV 26',
    },
    {
      segment: 'NSE_FO',
      name: 'RELIANCE INDUSTRIES LTD',
      exchange: 'NSE',
      expiry: 1798568999000,
      instrument_type: 'CE',
      instrument_key: 'NSE_FO|99992',
      lot_size: 250,
      exchange_token: '99992',
      tick_size: 0.05,
      trading_symbol: 'RELIANCE 3000 CE 26 NOV 26',
      strike_price: 3000.0,
    },
    {
      segment: 'MCX_FO',
      name: 'GOLD',
      exchange: 'MCX', // Non-NSE/BSE exchange
      instrument_type: 'FUT',
      instrument_key: 'MCX_FO|12345',
      trading_symbol: 'GOLDM',
    },
  ];

  let adminJwt;

  before(async () => {
    adminJwt = jwt.sign(
      { userId: 'admin_ingest_tester', role: 'ADMIN' },
      config.jwt.secret,
      { expiresIn: '1h' }
    );
    await prisma.$queryRaw`SELECT 1`;
  });

  beforeEach(async () => {
    if (isRedisReady() && redisClient) {
      await redisClient.del(INGESTION_LOCK_KEY);
    }
  });

  after(async () => {
    if (isRedisReady() && redisClient) {
      await redisClient.del(INGESTION_LOCK_KEY);
    }
  });

  describe('1. Instrument Downloader (instrumentDownloader.js)', () => {
    it('should successfully download compressed bytes using HTTP client', async () => {
      const mockGzip = createMockGzip(sampleInstruments);
      const mockHttpClient = {
        get: async () => ({
          status: 200,
          data: mockGzip,
        }),
      };

      const downloader = new InstrumentDownloader({
        httpClient: mockHttpClient,
        maxRetries: 1,
      });

      const buffer = await downloader.download();
      assert.ok(Buffer.isBuffer(buffer));
      assert.equal(buffer.length, mockGzip.length);
    });

    it('should retry on transient network errors and succeed on subsequent attempt', async () => {
      const mockGzip = createMockGzip(sampleInstruments);
      let callCount = 0;

      const mockHttpClient = {
        get: async () => {
          callCount++;
          if (callCount === 1) {
            const err = new Error('ECONNRESET connection reset by peer');
            err.code = 'ECONNRESET';
            throw err;
          }
          return { status: 200, data: mockGzip };
        },
      };

      const downloader = new InstrumentDownloader({
        httpClient: mockHttpClient,
        maxRetries: 2,
      });

      const buffer = await downloader.download();
      assert.equal(callCount, 2, 'Should succeed on attempt 2 after 1 retry');
      assert.ok(Buffer.isBuffer(buffer));
    });

    it('should fail with DOWNLOAD_FAILED when all retries are exhausted', async () => {
      const mockHttpClient = {
        get: async () => {
          throw new Error('ETIMEDOUT gateway connection timed out');
        },
      };

      const downloader = new InstrumentDownloader({
        httpClient: mockHttpClient,
        maxRetries: 2,
      });

      await assert.rejects(
        () => downloader.download(),
        (err) => err.code === 'DOWNLOAD_FAILED' && err.statusCode === 502
      );
    });

    it('should throw immediately without retrying on HTTP 404 or 403', async () => {
      let callCount = 0;
      const mockHttpClient = {
        get: async () => {
          callCount++;
          const err = new Error('Not Found');
          err.response = { status: 404 };
          throw err;
        },
      };

      const downloader = new InstrumentDownloader({
        httpClient: mockHttpClient,
        maxRetries: 3,
      });

      await assert.rejects(
        () => downloader.download(),
        (err) => err.code === 'DOWNLOAD_FAILED' && err.statusCode === 404
      );

      assert.equal(callCount, 1, '404 must not trigger retries');
    });

    it('should throw EMPTY_FILE if downloaded content is empty', async () => {
      const mockHttpClient = {
        get: async () => ({ status: 200, data: Buffer.alloc(0) }),
      };

      const downloader = new InstrumentDownloader({
        httpClient: mockHttpClient,
        maxRetries: 0,
      });

      await assert.rejects(
        () => downloader.download(),
        (err) => err.code === 'EMPTY_FILE' && err.statusCode === 502
      );
    });
  });

  describe('2. Instrument Parser & Decompression (instrumentParser.js)', () => {
    it('should successfully decompress and parse valid gzipped JSON array', async () => {
      const parser = new InstrumentParser();
      const gzipped = createMockGzip(sampleInstruments);

      const parsed = await parser.parse(gzipped);
      assert.ok(Array.isArray(parsed));
      assert.equal(parsed.length, sampleInstruments.length);
      assert.equal(parsed[0].trading_symbol, 'INFY');
    });

    it('should throw CORRUPT_ARCHIVE on corrupted or invalid gzip data', async () => {
      const parser = new InstrumentParser();
      const corruptedBytes = Buffer.from('this is completely invalid non-gzip binary data');

      await assert.rejects(
        () => parser.parse(corruptedBytes),
        (err) => err.code === 'CORRUPT_ARCHIVE' && err.statusCode === 422
      );
    });

    it('should throw EMPTY_DATA on empty input buffer', async () => {
      const parser = new InstrumentParser();

      await assert.rejects(
        () => parser.parse(Buffer.alloc(0)),
        (err) => err.code === 'EMPTY_DATA' && err.statusCode === 422
      );
    });

    it('should throw INVALID_JSON if decompressed payload is malformed JSON', async () => {
      const parser = new InstrumentParser();
      const badJsonGzip = zlib.gzipSync(Buffer.from('{ "broken": json without closing', 'utf-8'));

      await assert.rejects(
        () => parser.parse(badJsonGzip),
        (err) => err.code === 'INVALID_JSON' && err.statusCode === 422
      );
    });

    it('should throw INVALID_FORMAT if decompressed JSON is not a top-level array', async () => {
      const parser = new InstrumentParser();
      const objectGzip = createMockGzip({ status: 'ok', instruments: [] });

      await assert.rejects(
        () => parser.parse(objectGzip),
        (err) => err.code === 'INVALID_FORMAT' && err.statusCode === 422
      );
    });
  });

  describe('3. Instrument Validator & Normalizer (instrumentValidator.js)', () => {
    it('should correctly classify instrument types across segments', () => {
      assert.equal(classifyInstrumentType('NSE_EQ', 'EQ'), 'EQUITY');
      assert.equal(classifyInstrumentType('BSE_EQ', 'A'), 'EQUITY');
      assert.equal(classifyInstrumentType('NSE_INDEX', 'INDEX'), 'INDEX');
      assert.equal(classifyInstrumentType('BSE_INDEX', 'INDEX'), 'INDEX');
      assert.equal(classifyInstrumentType('NSE_FO', 'FUT'), 'FUTURES');
      assert.equal(classifyInstrumentType('NSE_FO', 'CE'), 'OPTIONS');
      assert.equal(classifyInstrumentType('NSE_FO', 'PE'), 'OPTIONS');
      assert.equal(classifyInstrumentType('NSE_EQ', 'SG'), 'BOND');
      assert.equal(classifyInstrumentType('NSE_COM', 'COM'), 'OTHER');
    });

    it('should validate Indian ISINs strictly and reject malformed/foreign codes', () => {
      assert.equal(isValidISIN('INE002A01018'), true);
      assert.equal(isValidISIN('INF769K01QB4'), true);
      assert.equal(isValidISIN('IN002A01018'), false); // Too short (11 chars)
      assert.equal(isValidISIN('INE002A0101899'), false); // Too long (14 chars)
      assert.equal(isValidISIN('NSE_EQ|INE002A01018'), false); // Instrument key is NOT an ISIN
      assert.equal(isValidISIN(''), false);
      assert.equal(isValidISIN(null), false);
    });

    it('should validate and normalize a valid NSE equity record', () => {
      const validator = new InstrumentValidator();
      const raw = {
        segment: 'NSE_EQ',
        name: 'RELIANCE INDUSTRIES LTD',
        exchange: 'NSE',
        isin: 'INE002A01018',
        instrument_type: 'EQ',
        instrument_key: 'NSE_EQ|INE002A01018',
        lot_size: 1,
        exchange_token: '2885',
        tick_size: 10.0,
        trading_symbol: 'RELIANCE',
      };

      const res = validator.validate(raw);
      assert.equal(res.valid, true);
      assert.equal(res.normalized.exchange, 'NSE');
      assert.equal(res.normalized.symbol, 'RELIANCE');
      assert.equal(res.normalized.isin, 'INE002A01018');
      assert.equal(res.normalized.instrumentToken, 'NSE_EQ|INE002A01018');
      assert.equal(res.normalized.instrumentType, 'EQUITY');
      assert.equal(res.normalized.lotSize, 1);
      assert.equal(res.normalized.tickSize, '10.0000');
      assert.equal(res.normalized.exchangeToken, '2885');
    });

    it('should validate and normalize a valid BSE index record without an ISIN', () => {
      const validator = new InstrumentValidator();
      const raw = {
        segment: 'BSE_INDEX',
        name: 'BSE SENSEX',
        exchange: 'BSE',
        instrument_type: 'INDEX',
        instrument_key: 'BSE_INDEX|SENSEX',
        exchange_token: '1',
        trading_symbol: 'SENSEX',
      };

      const res = validator.validate(raw);
      assert.equal(res.valid, true);
      assert.equal(res.normalized.exchange, 'BSE');
      assert.equal(res.normalized.symbol, 'SENSEX');
      assert.equal(res.normalized.isin, null, 'Indices must have null ISIN');
      assert.equal(res.normalized.instrumentToken, 'BSE_INDEX|SENSEX');
      assert.equal(res.normalized.instrumentType, 'INDEX');
    });

    it('should reject non-NSE/BSE instruments (e.g. MCX)', () => {
      const validator = new InstrumentValidator();
      const rawMCX = {
        exchange: 'MCX',
        segment: 'MCX_FO',
        instrument_key: 'MCX_FO|123',
        trading_symbol: 'GOLD',
      };

      const res = validator.validate(rawMCX);
      assert.equal(res.valid, false);
      assert.equal(res.reason, 'UNSUPPORTED_EXCHANGE_MCX');
    });

    it('should reject malformed records missing trading symbol or instrument key', () => {
      const validator = new InstrumentValidator();

      const missingKey = { exchange: 'NSE', segment: 'NSE_EQ', trading_symbol: 'TEST' };
      assert.equal(validator.validate(missingKey).valid, false);

      const missingSymbol = { exchange: 'NSE', segment: 'NSE_EQ', instrument_key: 'NSE_EQ|123' };
      assert.equal(validator.validate(missingSymbol).valid, false);
    });

    it('should filter segments when allowedSegments whitelist is configured', () => {
      const equityOnlyValidator = new InstrumentValidator({
        allowedSegments: new Set(['NSE_EQ', 'BSE_EQ']),
      });

      const derivative = {
        exchange: 'NSE',
        segment: 'NSE_FO',
        instrument_key: 'NSE_FO|111',
        trading_symbol: 'NIFTY_FUT',
      };
      const res = equityOnlyValidator.validate(derivative);
      assert.equal(res.valid, false);
      assert.equal(res.scope, 'OUT_OF_SCOPE');
      assert.equal(res.reason, 'SEGMENT_FILTERED_NSE_FO');
    });

    it('should separate validInScope, validOutOfScope, and invalidRecords in validateBatch', () => {
      const validator = new InstrumentValidator({
        allowedSegments: new Set(['NSE_EQ', 'BSE_EQ', 'NSE_INDEX', 'BSE_INDEX']),
      });

      const mixedRecords = [
        ...sampleInstruments, // 4 equities/indices, 2 NSE_FO derivatives, 1 MCX_FO
        {
          // Genuinely invalid record 1: missing instrument_key
          exchange: 'NSE',
          segment: 'NSE_EQ',
          trading_symbol: 'MISSING_KEY_STOCK',
        },
        {
          // Genuinely invalid record 2: missing trading symbol
          exchange: 'NSE',
          segment: 'NSE_EQ',
          instrument_key: 'NSE_EQ|NO_SYMBOL',
        },
      ];

      const res = validator.validateBatch(mixedRecords);
      assert.equal(res.validInScope, 4, '4 equities/indices should be validInScope');
      assert.equal(res.validOutOfScope, 3, '2 derivatives + 1 MCX should be validOutOfScope (NOT invalid)');
      assert.equal(res.invalidRecords, 2, '2 malformed records should be invalidRecords');
      assert.equal(res.validInScope + res.validOutOfScope + res.invalidRecords, mixedRecords.length);
    });
  });

  describe('4. Instrument Database Persistence (instrumentPersistence.js)', () => {
    it('should resolve and cache exchange IDs for NSE and BSE', async () => {
      const persistence = new InstrumentPersistence();
      const map = await persistence.getExchangeIdMap();

      assert.ok(map.has('NSE'));
      assert.ok(map.has('BSE'));
      assert.equal(typeof map.get('NSE'), 'string');
      assert.equal(typeof map.get('BSE'), 'string');
    });

    it('should persist a batch of normalized instruments safely into PostgreSQL', async () => {
      const persistence = new InstrumentPersistence({ batchSize: 10 });
      const testNormalized = [
        {
          exchange: 'NSE',
          segment: 'NSE_EQ',
          symbol: 'PERSIST_TEST_NSE',
          companyName: 'Persistence Test Equity NSE Ltd',
          isin: 'INE999A01001',
          instrumentToken: 'NSE_EQ|INE999A01001',
          exchangeToken: '99001',
          instrumentType: 'EQUITY',
          series: 'EQ',
          lotSize: 1,
          tickSize: '0.0500',
          expiryDate: null,
          isActive: true,
        },
        {
          exchange: 'BSE',
          segment: 'BSE_INDEX',
          symbol: 'PERSIST_TEST_BSE_INDEX',
          companyName: 'Persistence Test BSE Index',
          isin: null,
          instrumentToken: 'BSE_INDEX|PERSIST_TEST',
          exchangeToken: '99002',
          instrumentType: 'INDEX',
          series: 'INDEX',
          lotSize: 1,
          tickSize: null,
          expiryDate: null,
          isActive: true,
        },
      ];

      try {
        const res = await persistence.persistBatch(testNormalized);
        assert.equal(res.inserted, 2);
        assert.equal(res.errors.length, 0);

        // Verify in database
        const stock1 = await prisma.stock.findUnique({
          where: { instrumentToken: 'NSE_EQ|INE999A01001' },
        });
        assert.ok(stock1);
        assert.equal(stock1.symbol, 'PERSIST_TEST_NSE');
        assert.equal(stock1.isin, 'INE999A01001');
        assert.equal(stock1.lotSize, 1);

        const stock2 = await prisma.stock.findUnique({
          where: { instrumentToken: 'BSE_INDEX|PERSIST_TEST' },
        });
        assert.ok(stock2);
        assert.equal(stock2.instrumentType, 'INDEX');
      } finally {
        await prisma.stock.deleteMany({
          where: {
            instrumentToken: {
              in: ['NSE_EQ|INE999A01001', 'BSE_INDEX|PERSIST_TEST'],
            },
          },
        });
      }
    });

    it('should be idempotent: repeated ingestion updates existing records without creating duplicates', async () => {
      const persistence = new InstrumentPersistence({ batchSize: 10 });
      const record = {
        exchange: 'NSE',
        segment: 'NSE_EQ',
        symbol: 'IDEMPOTENT_TEST',
        companyName: 'Idempotency Test Ltd - Initial',
        isin: 'INE999B01002',
        instrumentToken: 'NSE_EQ|INE999B01002',
        exchangeToken: '88001',
        instrumentType: 'EQUITY',
        series: 'EQ',
        lotSize: 1,
        tickSize: '0.0500',
        expiryDate: null,
        isActive: true,
      };

      try {
        // Run 1: Insert
        const res1 = await persistence.persistBatch([record]);
        assert.equal(res1.inserted, 1);
        assert.equal(res1.updated, 0);

        // Run 2: Same instrument with updated name and lot size
        const updatedRecord = {
          ...record,
          companyName: 'Idempotency Test Ltd - Updated Name',
          lotSize: 25,
        };
        const res2 = await persistence.persistBatch([updatedRecord]);
        assert.equal(res2.inserted, 0, 'Must NOT insert duplicate record');
        assert.equal(res2.updated, 1, 'Must update existing record');

        // Confirm database has exactly 1 row with updated values
        const inDb = await prisma.stock.findMany({
          where: { instrumentToken: 'NSE_EQ|INE999B01002' },
        });
        assert.equal(inDb.length, 1);
        assert.equal(inDb[0].companyName, 'Idempotency Test Ltd - Updated Name');
        assert.equal(inDb[0].lotSize, 25);
      } finally {
        await prisma.stock.deleteMany({
          where: { instrumentToken: 'NSE_EQ|INE999B01002' },
        });
      }
    });

    it('should support dryRun simulation without modifying database', async () => {
      const persistence = new InstrumentPersistence();
      const dryRecord = {
        exchange: 'NSE',
        segment: 'NSE_EQ',
        symbol: 'DRY_RUN_STOCK',
        companyName: 'Dry Run Ltd',
        instrumentToken: 'NSE_EQ|INE999C01003',
        instrumentType: 'EQUITY',
      };

      const res = await persistence.persistBatch([dryRecord], { dryRun: true });
      assert.equal(res.inserted, 1);
      assert.equal(res.errors.length, 0);

      // Verify row was NOT written to database
      const inDb = await prisma.stock.findUnique({
        where: { instrumentToken: 'NSE_EQ|INE999C01003' },
      });
      assert.equal(inDb, null, 'Dry run must not create records in database');
    });

    it('should handle partial batch failure: rolls back only failed batch while committed batches remain in DB', async () => {
      let callCount = 0;
      const wrappedPrisma = {
        exchange: prisma.exchange,
        stock: prisma.stock,
        $transaction: async (ops) => {
          callCount++;
          if (callCount === 2) {
            throw new Error('Simulated database deadlock / constraint failure on batch 2');
          }
          return prisma.$transaction(ops);
        },
      };

      const testPersistence = new InstrumentPersistence({
        prisma: wrappedPrisma,
        batchSize: 1,
      });

      const record1 = {
        exchange: 'NSE',
        segment: 'NSE_EQ',
        symbol: 'BATCH_FAIL_1',
        companyName: 'Batch Fail Test 1 Ltd',
        isin: 'INE999D01004',
        instrumentToken: 'NSE_EQ|INE999D01004',
        instrumentType: 'EQUITY',
        lotSize: 1,
      };

      const record2 = {
        exchange: 'NSE',
        segment: 'NSE_EQ',
        symbol: 'BATCH_FAIL_2',
        companyName: 'Batch Fail Test 2 Ltd',
        isin: 'INE999D01005',
        instrumentToken: 'NSE_EQ|INE999D01005',
        instrumentType: 'EQUITY',
        lotSize: 1,
      };

      try {
        const result = await testPersistence.persistBatch([record1, record2]);

        assert.equal(result.inserted, 1, 'Only successfully committed batch 1 should be counted as inserted');
        assert.equal(result.errors.length, 1, 'Batch 2 failure should be recorded in errors');
        assert.equal(result.errors[0].chunkIndex, 1);

        const inDb1 = await prisma.stock.findUnique({
          where: { instrumentToken: 'NSE_EQ|INE999D01004' },
        });
        assert.ok(inDb1, 'Committed batch 1 must remain in DB');

        const inDb2 = await prisma.stock.findUnique({
          where: { instrumentToken: 'NSE_EQ|INE999D01005' },
        });
        assert.equal(inDb2, null, 'Failed batch 2 must be rolled back');
      } finally {
        await prisma.stock.deleteMany({
          where: {
            instrumentToken: {
              in: ['NSE_EQ|INE999D01004', 'NSE_EQ|INE999D01005'],
            },
          },
        });
      }
    });
  });

  describe('5. Orchestrator Service (InstrumentIngestionService)', () => {
    it('should execute end-to-end ingestion pipeline with fixture data and record audit logs (isolated persistence)', async () => {
      const mockGzip = createMockGzip(sampleInstruments);
      const mockDownloader = {
        download: async () => mockGzip,
      };

      const mockPersistence = {
        persistBatch: async (records) => ({
          inserted: records.length,
          updated: 0,
          skipped: 0,
          insertedRecords: records.length,
          updatedRecords: 0,
          skippedRecords: 0,
          errors: [],
        }),
      };

      const service = new InstrumentIngestionService({
        downloader: mockDownloader,
        persistence: mockPersistence,
      });

      const summary = await service.ingest({
        allSegments: false, // Equities & indices only
      });

      assert.equal(summary.status, 'SUCCESS');
      assert.equal(summary.totalDownloaded, sampleInstruments.length);
      // Sample has 4 equity/index records in NSE & BSE (INFY, Nifty 50, TCS, SENSEX)
      assert.equal(summary.validInScope, 4);
      assert.equal(summary.validOutOfScope, 3, 'Derivatives and MCX records must be counted as validOutOfScope');
      assert.equal(summary.invalidRecords, 0, 'No malformed records in clean sampleInstruments');
      assert.equal(summary.nseRecords, 2);
      assert.equal(summary.bseRecords, 2);
      assert.ok(summary.durationMs >= 0);

      // Verify audit log created in DataSourceLog
      const log = await prisma.dataSourceLog.findFirst({
        where: { operation: 'INSTRUMENT_INGESTION' },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(log);
      assert.equal(log.status, 'SUCCESS');
      assert.equal(log.recordsProcessed, 4);

      // Verify summary saved in SystemConfig
      const latestStatus = await service.getLatestStatus();
      assert.ok(latestStatus);
      assert.equal(latestStatus.status, 'SUCCESS');
      assert.equal(latestStatus.totalDownloaded, sampleInstruments.length);
      assert.equal(latestStatus.validInScope, 4);
      assert.equal(latestStatus.validOutOfScope, 3);
      assert.equal(latestStatus.invalidRecords, 0);
    });

    it('should prove limit option behavior: filters in-scope first, then persists exactly N records', async () => {
      const mockGzip = createMockGzip(sampleInstruments);
      const mockDownloader = {
        download: async () => mockGzip,
      };

      const service = new InstrumentIngestionService({
        downloader: mockDownloader,
      });

      // Sample has 4 valid in-scope records. Passing limit = 2 should persist only 2.
      const summary = await service.ingest({
        dryRun: true,
        limit: 2,
      });

      assert.equal(summary.validInScope, 4, 'Full valid in-scope count must reflect all in-scope records');
      assert.equal(summary.validOutOfScope, 3);
      assert.equal(summary.inserted + summary.updated, 2, 'Exactly 2 records should be processed for persistence');
    });

    it('Lock Test 1: should reject concurrent ingestion attempts with 409 conflict', async () => {
      const mockGzip = createMockGzip(sampleInstruments);
      let finishDelay;
      const delayedDownloader = {
        download: async () => {
          await new Promise((resolve) => {
            finishDelay = resolve;
          });
          return mockGzip;
        },
      };

      const mockPersistence = {
        persistBatch: async (records) => ({
          inserted: records.length,
          updated: 0,
          skipped: 0,
          insertedRecords: records.length,
          updatedRecords: 0,
          skippedRecords: 0,
          errors: [],
        }),
      };

      const service = new InstrumentIngestionService({
        downloader: delayedDownloader,
        persistence: mockPersistence,
      });

      // Start first job (holds lock)
      const firstJobPromise = service.ingest();

      // Second concurrent job attempt while first is in progress MUST be rejected
      await assert.rejects(
        () => service.ingest(),
        (err) => err.code === 'INGESTION_ALREADY_IN_PROGRESS' && err.statusCode === 409
      );

      // Finish first job
      if (finishDelay) finishDelay();
      await firstJobPromise;
    });

    it('Lock Test 2: should allow subsequent ingestion after lock TTL expires', async () => {
      const service = new InstrumentIngestionService();

      // Acquire lock with 1-second TTL
      const acquired1 = await service._acquireLock(1);
      assert.equal(acquired1, true, 'First lock acquisition must succeed');

      // Immediate second attempt while lock is active must fail
      const service2 = new InstrumentIngestionService();
      const acquired2 = await service2._acquireLock(1);
      assert.equal(acquired2, false, 'Second lock attempt before TTL must fail');

      // Wait 1.1s for Redis TTL expiration
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Attempt after expiration must succeed
      const acquired3 = await service2._acquireLock(5);
      assert.equal(acquired3, true, 'Subsequent lock acquisition after TTL expiration must succeed');

      // Cleanup
      await service2._releaseLock();
    });

    it('Lock Test 3: older process attempting to release newer lock must fail safe (Lua token check)', async () => {
      if (!isRedisReady() || !redisClient) {
        return; // Redis specific test
      }

      const serviceA = new InstrumentIngestionService();
      const acquiredA = await serviceA._acquireLock(60);
      assert.equal(acquiredA, true);
      const tokenA = serviceA._currentLockToken;
      assert.ok(tokenA, 'Process A must have a unique lock token');

      // Simulate Process A timing out and Process B taking ownership of the lock key
      const tokenB = 'simulated-newer-process-token-uuid';
      await redisClient.set(INGESTION_LOCK_KEY, tokenB, 'EX', 60);

      // Process A attempts to release using token A
      const releaseResult = await serviceA._releaseLock(tokenA);
      assert.equal(releaseResult, false, 'Lua script must reject release when lock token does not match');

      // Verify Process B lock is PRESERVED in Redis!
      const currentInRedis = await redisClient.get(INGESTION_LOCK_KEY);
      assert.equal(currentInRedis, tokenB, 'Newer process lock must NOT be deleted by older process');

      // Cleanup
      await redisClient.del(INGESTION_LOCK_KEY);
    });

    it('Lock Test 4: fails closed with HTTP 503 INGESTION_LOCK_UNAVAILABLE when Redis is unavailable, preventing download and DB write', async () => {
      let downloadAttempted = false;
      let writeAttempted = false;

      const failingDownloader = {
        download: async () => {
          downloadAttempted = true;
          return Buffer.from('mock');
        },
      };

      const failingPersistence = {
        persistBatch: async () => {
          writeAttempted = true;
          return { inserted: 0, updated: 0, skipped: 0, errors: [] };
        },
      };

      const failingRedis = {
        set: async () => {
          throw new Error('Redis connection ECONNREFUSED simulation');
        },
        del: async () => {},
        eval: async () => 0,
      };

      const failClosedService = new InstrumentIngestionService({
        downloader: failingDownloader,
        persistence: failingPersistence,
        redisClient: failingRedis,
      });

      // Must fail closed with HTTP 503 (INGESTION_LOCK_UNAVAILABLE)
      await assert.rejects(
        () => failClosedService.ingest(),
        (err) => err.statusCode === 503 && err.code === 'INGESTION_LOCK_UNAVAILABLE'
      );

      // Verify no download occurred
      assert.equal(downloadAttempted, false, 'Downloader must NOT be invoked when lock acquisition fails');

      // Verify no database write occurred
      assert.equal(writeAttempted, false, 'Database persistence must NOT be invoked when lock acquisition fails');
    });

    it('Lock Test 4b: fails closed when redisClient is null or disconnected without silent in-memory fallback', async () => {
      const disconnectedRedis = {
        status: 'disconnected',
        set: async () => 'OK',
      };

      const serviceNullRedis = new InstrumentIngestionService({
        redisClient: null,
      });

      const serviceDisconnectedRedis = new InstrumentIngestionService({
        redisClient: disconnectedRedis,
      });

      await assert.rejects(
        () => serviceNullRedis.ingest(),
        (err) => err.statusCode === 503 && err.code === 'INGESTION_LOCK_UNAVAILABLE'
      );

      await assert.rejects(
        () => serviceDisconnectedRedis.ingest(),
        (err) => err.statusCode === 503 && err.code === 'INGESTION_LOCK_UNAVAILABLE'
      );
    });

    it('Lock Test 5: ensures lock is released in finally block when ingestion throws an error', async () => {
      const failingDownloader = {
        download: async () => {
          throw new Error('Simulated network failure during download step');
        },
      };

      const service = new InstrumentIngestionService({
        downloader: failingDownloader,
      });

      await assert.rejects(() => service.ingest());

      // Confirm lock was released in finally: another service can acquire immediately
      const nextService = new InstrumentIngestionService();
      const acquired = await nextService._acquireLock();
      assert.equal(acquired, true, 'Lock must be released in finally block following an ingestion failure');
      await nextService._releaseLock();
    });

    it('should mark run as PARTIAL when some batches succeed and some fail', async () => {
      const mockGzip = createMockGzip(sampleInstruments);
      const mockDownloader = {
        download: async () => mockGzip,
      };

      const partialPersistence = {
        persistBatch: async () => ({
          inserted: 2,
          updated: 0,
          skipped: 0,
          insertedRecords: 2,
          updatedRecords: 0,
          skippedRecords: 0,
          errors: [{ chunkIndex: 1, error: 'Simulated chunk write failure' }],
        }),
      };

      const service = new InstrumentIngestionService({
        downloader: mockDownloader,
        persistence: partialPersistence,
      });

      const summary = await service.ingest();
      assert.equal(summary.status, 'PARTIAL', 'Run must be marked PARTIAL when some batches succeed and some fail');
      assert.equal(summary.insertedRecords, 2);
      assert.equal(summary.errors.length, 1);
    });

    it('should preserve existing stock catalog when an ingestion run fails during download', async () => {
      // Confirm seeded stocks exist
      const beforeCount = await prisma.stock.count();
      assert.ok(beforeCount >= 5);

      const failingDownloader = {
        download: async () => {
          throw new Error('Simulated upstream network breakdown');
        },
      };

      const service = new InstrumentIngestionService({
        downloader: failingDownloader,
      });

      await assert.rejects(() => service.ingest());

      // Ensure existing stocks were NEVER deleted or modified by failed run
      const afterCount = await prisma.stock.count();
      assert.equal(afterCount, beforeCount, 'Catalogue must be preserved on download failure');

      // Verify failed log was recorded
      const failedLog = await prisma.dataSourceLog.findFirst({
        where: { operation: 'INSTRUMENT_INGESTION' },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(failedLog);
      assert.equal(failedLog.status, 'FAILED');
      assert.ok(failedLog.errorMessage.includes('Simulated upstream network breakdown'));
    });
  });

  describe('6. Admin API Endpoints (/api/admin/instruments) Disabled Pending RBAC', () => {
    it('POST /api/admin/instruments/ingest should be explicitly disabled returning HTTP 503 (ADMIN_API_DISABLED)', async () => {
      const res = await request(app).post('/api/admin/instruments/ingest');
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'ADMIN_API_DISABLED');
      assert.ok(res.body.error.message.includes('npm run ingest:instruments'));
    });

    it('POST /api/admin/instruments/ingest should remain disabled even with a valid JWT token', async () => {
      const res = await request(app)
        .post('/api/admin/instruments/ingest')
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({ dryRun: true });

      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'ADMIN_API_DISABLED');
    });

    it('GET /api/admin/instruments/status should be explicitly disabled returning HTTP 503 (ADMIN_API_DISABLED)', async () => {
      const res = await request(app).get('/api/admin/instruments/status');
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'ADMIN_API_DISABLED');
    });

    it('should set strict anti-caching headers on administrative routes', async () => {
      const res = await request(app).get('/api/admin/instruments/status');

      assert.equal(res.headers['cache-control'], 'no-store, no-cache, must-revalidate, private');
      assert.equal(res.headers['pragma'], 'no-cache');
      assert.equal(res.headers['expires'], '0');
    });
  });
});
