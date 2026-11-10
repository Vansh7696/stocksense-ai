import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import marketDataValidatorService, {
  toDecimalSafeString,
  MarketDataValidationError,
  serializeMarketData,
  safeJsonStringify,
  bigIntJsonReplacer,
} from '../src/services/marketDataValidator.service.js';

describe('Milestone 3 — Step 3: Market Data Quality Validation Service (marketDataValidator.service.js)', () => {
  const fixedNow = '2026-11-06T15:30:00.000Z';

  describe('1. Individual Candle Validation & Field Integrity', () => {
    it('should validate and normalize a valid candle bar from Upstox V3 array', () => {
      // Upstox array format: [timestamp, open, high, low, close, volume, open_interest]
      const rawArray = ['2026-11-06T10:00:00+05:30', 2500.5, 2520.0, 2495.25, 2515.1, 125000, 45000];

      const candle = marketDataValidatorService.validateCandle(rawArray, { customNow: fixedNow });

      assert.equal(candle.open, 2500.5);
      assert.equal(candle.high, 2520.0);
      assert.equal(candle.low, 2495.25);
      assert.equal(candle.close, 2515.1);
      assert.equal(candle.volume, BigInt(125000));
      assert.equal(candle.openInterest, BigInt(45000));
      assert.equal(candle.openDecimal, '2500.5000');
      assert.equal(candle.highDecimal, '2520.0000');
      assert.equal(candle.lowDecimal, '2495.2500');
      assert.equal(candle.closeDecimal, '2515.1000');
      assert.equal(candle.originalTimestampString, '2026-11-06T10:00:00+05:30');
      assert.ok(candle.timestamp instanceof Date);
    });

    it('should validate and normalize a valid candle bar from object format', () => {
      const rawObj = {
        timestamp: '2026-11-06T09:15:00.000Z',
        open: 100.0,
        high: 105.5,
        low: 99.25,
        close: 104.0,
        volume: 5000,
      };

      const candle = marketDataValidatorService.validateCandle(rawObj, { customNow: fixedNow });

      assert.equal(candle.open, 100.0);
      assert.equal(candle.high, 105.5);
      assert.equal(candle.low, 99.25);
      assert.equal(candle.close, 104.0);
      assert.equal(candle.volume, BigInt(5000));
    });

    it('should PRESERVE exact exchange timestamp string and never hardcode 09:15', () => {
      const dailyTimestamp = '2026-11-06T00:00:00+05:30';
      const candle = marketDataValidatorService.validateCandle(
        [dailyTimestamp, 200, 210, 195, 205, 1000, 0],
        { customNow: fixedNow }
      );

      assert.equal(candle.originalTimestampString, dailyTimestamp);
      assert.ok(!candle.originalTimestampString.includes('09:15'));
    });

    it('should reject future timestamps beyond allowable clock drift buffer', () => {
      // 10 minutes in the future relative to fixedNow
      const futureTime = new Date(new Date(fixedNow).getTime() + 10 * 60 * 1000).toISOString();

      assert.throws(
        () =>
          marketDataValidatorService.validateCandle(
            [futureTime, 100, 110, 95, 105, 1000, 0],
            { customNow: fixedNow, clockSkewBufferMs: 300000 }
          ),
        (err) => err instanceof MarketDataValidationError && err.code === 'FUTURE_TIMESTAMP'
      );
    });

    it('should accept timestamps within allowable 5-minute clock drift buffer', () => {
      // 2 minutes in the future relative to fixedNow
      const slightDriftTime = new Date(new Date(fixedNow).getTime() + 2 * 60 * 1000).toISOString();

      const candle = marketDataValidatorService.validateCandle(
        [slightDriftTime, 100, 110, 95, 105, 1000, 0],
        { customNow: fixedNow, clockSkewBufferMs: 300000 }
      );
      assert.ok(candle);
    });

    it('should reject missing or invalid timestamps', () => {
      assert.throws(
        () => marketDataValidatorService.validateCandle(['not-a-real-date', 100, 110, 95, 105, 1000]),
        (err) => err.code === 'INVALID_TIMESTAMP'
      );

      assert.throws(
        () => marketDataValidatorService.validateCandle([null, 100, 110, 95, 105, 1000]),
        (err) => err.code === 'MISSING_TIMESTAMP'
      );
    });

    it('should reject missing required OHLC price fields', () => {
      assert.throws(
        () => marketDataValidatorService.validateCandle({ timestamp: fixedNow, open: 100, high: 110, low: 95 }),
        (err) => err.code === 'MISSING_CLOSE'
      );

      assert.throws(
        () => marketDataValidatorService.validateCandle({ timestamp: fixedNow, open: 100, high: 110, close: 105 }),
        (err) => err.code === 'MISSING_LOW'
      );
    });
  });

  describe('2. Strict OHLC Relational Integrity & Price Rules', () => {
    const validTs = '2026-11-06T09:15:00.000Z';

    it('should reject inverted bar where High < Low', () => {
      assert.throws(
        () => marketDataValidatorService.validateCandle([validTs, 100, 90, 110, 105, 1000], { customNow: fixedNow }),
        (err) => err.code === 'HIGH_LESS_THAN_LOW'
      );
    });

    it('should reject candle where High < Open or High < Close', () => {
      // High < Open
      assert.throws(
        () => marketDataValidatorService.validateCandle([validTs, 110, 105, 95, 100, 1000], { customNow: fixedNow }),
        (err) => err.code === 'INVERTED_HIGH'
      );

      // High < Close
      assert.throws(
        () => marketDataValidatorService.validateCandle([validTs, 100, 105, 95, 110, 1000], { customNow: fixedNow }),
        (err) => err.code === 'INVERTED_HIGH'
      );
    });

    it('should reject candle where Low > Open or Low > Close', () => {
      // Low > Open
      assert.throws(
        () => marketDataValidatorService.validateCandle([validTs, 90, 110, 95, 105, 1000], { customNow: fixedNow }),
        (err) => err.code === 'INVERTED_LOW'
      );

      // Low > Close
      assert.throws(
        () => marketDataValidatorService.validateCandle([validTs, 100, 110, 95, 90, 1000], { customNow: fixedNow }),
        (err) => err.code === 'INVERTED_LOW'
      );
    });

    it('should reject non-positive prices (zero or negative)', () => {
      assert.throws(
        () => marketDataValidatorService.validateCandle([validTs, 0, 100, 0, 50, 1000], { customNow: fixedNow }),
        (err) => err.code === 'NON_POSITIVE_PRICE'
      );

      assert.throws(
        () => marketDataValidatorService.validateCandle([validTs, -10, 100, -20, 50, 1000], { customNow: fixedNow }),
        (err) => err.code === 'NON_POSITIVE_PRICE'
      );
    });

    it('should reject non-numeric price values (NaN, Infinity, string garbage)', () => {
      assert.throws(
        () => marketDataValidatorService.validateCandle([validTs, 'abc', 100, 90, 95, 1000], { customNow: fixedNow }),
        (err) => err.code === 'NON_NUMERIC_PRICE'
      );

      assert.throws(
        () => marketDataValidatorService.validateCandle([validTs, 100, Infinity, 90, 95, 1000], { customNow: fixedNow }),
        (err) => err.code === 'NON_NUMERIC_PRICE'
      );
    });

    it('should reject negative volume across number, string, and BigInt inputs', () => {
      assert.throws(
        () => marketDataValidatorService.validateCandle([validTs, 100, 110, 90, 105, -50], { customNow: fixedNow }),
        (err) => err.code === 'NEGATIVE_VOLUME'
      );
      assert.throws(
        () => marketDataValidatorService.validateCandle([validTs, 100, 110, 90, 105, '-1000'], { customNow: fixedNow }),
        (err) => err.code === 'NEGATIVE_VOLUME'
      );
      assert.throws(
        () => marketDataValidatorService.validateCandle([validTs, 100, 110, 90, 105, -500n], { customNow: fixedNow }),
        (err) => err.code === 'NEGATIVE_VOLUME'
      );
    });

    it('should handle large volumes with BigInt without precision loss', () => {
      // 9007199254740993n exceeds Number.MAX_SAFE_INTEGER (9007199254740991)
      const bigVolumeStr = '9007199254740993';
      const candle = marketDataValidatorService.validateCandle(
        [validTs, 100, 110, 90, 105, bigVolumeStr],
        { customNow: fixedNow }
      );
      assert.equal(candle.volume, 9007199254740993n);
      assert.equal(candle.volume.toString(), bigVolumeStr);
    });

    it('should reject unsafe floating-point numbers exceeding MAX_SAFE_INTEGER to prevent silent precision loss', () => {
      // 9007199254740995 as a JS Number exceeds MAX_SAFE_INTEGER
      const unsafeNum = Number.MAX_SAFE_INTEGER + 10;
      assert.throws(
        () => marketDataValidatorService.validateCandle([validTs, 100, 110, 90, 105, unsafeNum], { customNow: fixedNow }),
        (err) => err.code === 'VOLUME_PRECISION_LOSS'
      );
    });

    it('should preserve PostgreSQL DECIMAL(14, 4) compatibility and reject floating-point precision loss', () => {
      const res = toDecimalSafeString(2500.1, 4);
      assert.equal(res, '2500.1000');

      const resExact = toDecimalSafeString('0.3', 4);
      assert.equal(resExact, '0.3000');

      // 0.1 + 0.2 in JS float evaluates to 0.30000000000000004 (17 decimal places)
      // Must reject rather than claiming to recover precision via silent rounding
      assert.throws(
        () => toDecimalSafeString(0.1 + 0.2, 4),
        (err) => err.code === 'EXCESS_DECIMAL_PRECISION'
      );
    });
  });

  describe('3. Batch Validation, Deduplication & Chronological Sorting', () => {
    it('should separate valid candles from rejected candles without silently repairing data', () => {
      const rawBatch = [
        ['2026-11-06T09:15:00.000Z', 100, 105, 95, 102, 1000], // Valid 1
        ['2026-11-06T09:20:00.000Z', 102, 90, 105, 98, 1000],  // Corrupt: High < Low
        ['2026-11-06T09:25:00.000Z', 100, 108, 98, 106, 2000], // Valid 2
        ['2026-11-06T09:30:00.000Z', -50, 100, -60, 80, 1000], // Corrupt: Negative price
      ];

      const result = marketDataValidatorService.validateCandleBatch(rawBatch, { customNow: fixedNow });

      assert.equal(result.valid.length, 2, 'Must retain exactly 2 valid bars');
      assert.equal(result.rejected.length, 2, 'Must flag exactly 2 rejected bars');
      assert.equal(result.summary.validCount, 2);
      assert.equal(result.summary.rejectedCount, 2);
      assert.equal(result.rejected[0].code, 'HIGH_LESS_THAN_LOW');
      assert.equal(result.rejected[1].code, 'NON_POSITIVE_PRICE');
    });

    it('should detect duplicate timestamps within a batch and reject subsequent duplicates', () => {
      const rawBatch = [
        ['2026-11-06T09:15:00.000Z', 100, 105, 95, 102, 1000],
        ['2026-11-06T09:15:00.000Z', 101, 106, 96, 103, 1500], // Duplicate!
        ['2026-11-06T09:20:00.000Z', 102, 107, 97, 104, 2000],
      ];

      const result = marketDataValidatorService.validateCandleBatch(rawBatch, { customNow: fixedNow });

      assert.equal(result.valid.length, 2, 'Only first occurrence of timestamp should be kept');
      assert.equal(result.summary.duplicatesCount, 1);
      assert.equal(result.rejected[0].code, 'DUPLICATE_TIMESTAMP');
    });

    it('should detect out-of-order candles and sort the valid output chronologically ascending', () => {
      const rawBatch = [
        ['2026-11-06T09:25:00.000Z', 104, 108, 102, 106, 1000], // Bar 3
        ['2026-11-06T09:15:00.000Z', 100, 105, 95, 102, 1000],  // Bar 1
        ['2026-11-06T09:20:00.000Z', 102, 107, 98, 104, 1000],  // Bar 2
      ];

      const result = marketDataValidatorService.validateCandleBatch(rawBatch, { customNow: fixedNow });

      assert.equal(result.summary.outOfOrderCount, 1, 'Should record that raw sequence had out-of-order bars');
      assert.equal(result.valid.length, 3);
      assert.equal(result.valid[0].originalTimestampString, '2026-11-06T09:15:00.000Z');
      assert.equal(result.valid[1].originalTimestampString, '2026-11-06T09:20:00.000Z');
      assert.equal(result.valid[2].originalTimestampString, '2026-11-06T09:25:00.000Z');
    });

    it('should safely handle malformed non-array provider responses', () => {
      const result = marketDataValidatorService.validateCandleBatch(null);
      assert.equal(result.valid.length, 0);
      assert.equal(result.rejected.length, 1);
      assert.equal(result.rejected[0].code, 'MALFORMED_PROVIDER_RESPONSE');
    });
  });

  describe('4. Decimal Precision & BigInt Serialization Integrity', () => {
    const validTs = '2026-11-06T09:15:00.000Z';

    it('should reject prices with more than 4 decimal places with EXCESS_DECIMAL_PRECISION (no silent rounding)', () => {
      // 5 decimal places: 2500.12345
      assert.throws(
        () => marketDataValidatorService.validateCandle([validTs, '2500.12345', 2510, 2490, 2505, 1000], { customNow: fixedNow }),
        (err) => err.code === 'EXCESS_DECIMAL_PRECISION'
      );

      assert.throws(
        () => marketDataValidatorService.validateCandle([validTs, 2500.12345, 2510, 2490, 2505, 1000], { customNow: fixedNow }),
        (err) => err.code === 'EXCESS_DECIMAL_PRECISION'
      );
    });

    it('should reject prices exceeding 10 integer digits with PRICE_OVERFLOW for DECIMAL(14, 4)', () => {
      // 11 integer digits: 12345678901.50
      assert.throws(
        () => marketDataValidatorService.validateCandle([validTs, '12345678901.50', '12345678902', '12345678900', '12345678901', 1000], { customNow: fixedNow }),
        (err) => err.code === 'PRICE_OVERFLOW'
      );
    });

    it('should format prices with <= 4 decimal places to exact padded string representations', () => {
      assert.equal(toDecimalSafeString('2500.5', 4), '2500.5000');
      assert.equal(toDecimalSafeString('2500.12', 4), '2500.1200');
      assert.equal(toDecimalSafeString('2500.1234', 4), '2500.1234');
      assert.equal(toDecimalSafeString('2500.120000', 4), '2500.1200'); // Trailing zeroes normalized
    });

    it('should confirm BigInt.prototype is completely unmodified (no toJSON method exists)', () => {
      assert.strictEqual(
        BigInt.prototype.toJSON,
        undefined,
        'BigInt.prototype.toJSON must be undefined across the entire runtime'
      );
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(BigInt.prototype, 'toJSON'),
        false,
        'BigInt.prototype must not have own property toJSON'
      );

      // Native JSON.stringify must throw TypeError without a replacer
      assert.throws(
        () => JSON.stringify({ v: 100n }),
        (err) => err instanceof TypeError && err.message.includes('BigInt'),
        'Native JSON.stringify without replacer must throw TypeError for BigInt'
      );
    });

    it('should serialize BigInt values as decimal strings with safeJsonStringify and bigIntJsonReplacer', () => {
      const res = safeJsonStringify({ volume: 15000000000000n });
      assert.equal(res, '{"volume":"15000000000000"}');

      const withReplacer = JSON.stringify({ volume: 15000000000000n }, bigIntJsonReplacer);
      assert.equal(withReplacer, '{"volume":"15000000000000"}');
    });

    it('should retain exact precision for large integer values without converting to Number', () => {
      // 9007199254740993 is Number.MAX_SAFE_INTEGER + 2. In IEEE 754 float, it rounds to 9007199254740992.
      const largeInt = 9007199254740993n;

      const serializedJson = safeJsonStringify({ volume: largeInt });
      assert.equal(serializedJson, '{"volume":"9007199254740993"}');

      const marketDataSerialized = serializeMarketData({ volume: largeInt });
      assert.equal(typeof marketDataSerialized.volume, 'string');
      assert.equal(marketDataSerialized.volume, '9007199254740993');

      // Verify that precision was NOT corrupted by conversion to JS Number
      assert.notEqual(
        marketDataSerialized.volume,
        Number(largeInt).toString(),
        'Must retain exact BigInt precision, not corrupted Number conversion'
      );
    });

    it('should provide native BigInt on validated candles for Prisma database operations', () => {
      const candle = marketDataValidatorService.validateCandle(
        [validTs, 2500.5, 2520.0, 2495.0, 2510.0, 15000000000000n],
        { customNow: fixedNow }
      );

      // Prisma requires native BigInt for database writes
      assert.equal(typeof candle.volume, 'bigint');
      assert.equal(candle.volume, 15000000000000n);
      assert.equal(typeof candle.openInterest, 'bigint');
      assert.equal(candle.openInterest, 0n);

      // Also provides string representations for serialization
      assert.equal(candle.volumeString, '15000000000000');
      assert.equal(candle.openInterestString, '0');
    });

    it('should recursively serialize nested market data payloads via serializeMarketData() without touching prototypes', () => {
      const payload = {
        symbol: 'RELIANCE',
        volume: 9007199254740993n,
        nested: {
          ltq: 50n,
          candles: [{ vol: 1000n }],
        },
      };

      const serialized = serializeMarketData(payload);
      assert.equal(typeof serialized.volume, 'string');
      assert.equal(serialized.volume, '9007199254740993');
      assert.equal(typeof serialized.nested.ltq, 'string');
      assert.equal(serialized.nested.ltq, '50');
      assert.equal(typeof serialized.nested.candles[0].vol, 'string');
      assert.equal(serialized.nested.candles[0].vol, '1000');
    });

    it('should serialize BigInt in Express API responses using the configured Express json replacer', async () => {
      const replacer = app.get('json replacer');
      assert.strictEqual(typeof replacer, 'function', 'Express must have json replacer configured');
      assert.strictEqual(replacer, bigIntJsonReplacer);

      const expressModule = (await import('express')).default;
      const testApp = expressModule();
      testApp.set('json replacer', replacer);
      testApp.get('/test-replacer', (req, res) => {
        res.json({
          success: true,
          data: {
            volume: 9007199254740993n,
            list: [100n, 200n],
          },
        });
      });

      const res = await request(testApp).get('/test-replacer');
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(typeof res.body.data.volume, 'string');
      assert.equal(res.body.data.volume, '9007199254740993');
      assert.deepEqual(res.body.data.list, ['100', '200']);
    });
  });
});
