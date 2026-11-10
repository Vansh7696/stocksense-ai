import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  UpstoxProvider,
  UpstoxClient,
  UPSTOX_ENDPOINTS,
  UPSTOX_UNITS,
  INTERVAL_TO_V3_MAP,
  encodeInstrumentKey,
  resolveInstrumentKey,
  VERIFIED_SEED_INSTRUMENTS,
  safeJsonStringify,
  serializeMarketData,
} from '../src/providers/index.js';
import { AppError } from '../src/middleware/errorHandler.js';

describe('Milestone 3 — Step 3: Upstox API V3 Provider Adapter & Client (upstoxProvider.test.js)', () => {
  const sampleToken = 'mock_upstox_token_sample_v3_12345';
  const sampleKey = 'NSE_EQ|INE002A01018'; // Reliance Industries

  describe('1. V3 Constants, Units & Interval Mapping', () => {
    it('should use official plural unit names for all V3 endpoints', () => {
      assert.equal(UPSTOX_UNITS.MINUTES, 'minutes');
      assert.equal(UPSTOX_UNITS.HOURS, 'hours');
      assert.equal(UPSTOX_UNITS.DAYS, 'days');
      assert.equal(UPSTOX_UNITS.WEEKS, 'weeks');
      assert.equal(UPSTOX_UNITS.MONTHS, 'months');
    });

    it('should map intervals to official V3 plural units and retrieval limits', () => {
      // 1m, 5m, 15m -> minutes (30 days chunk)
      assert.deepEqual(INTERVAL_TO_V3_MAP['1m'], { unit: 'minutes', interval: '1', maxSpanDays: 30 });
      assert.deepEqual(INTERVAL_TO_V3_MAP['5m'], { unit: 'minutes', interval: '5', maxSpanDays: 30 });
      assert.deepEqual(INTERVAL_TO_V3_MAP['15m'], { unit: 'minutes', interval: '15', maxSpanDays: 30 });

      // 30m -> minutes (90 days chunk)
      assert.deepEqual(INTERVAL_TO_V3_MAP['30m'], { unit: 'minutes', interval: '30', maxSpanDays: 90 });

      // 1h -> hours (90 days chunk)
      assert.deepEqual(INTERVAL_TO_V3_MAP['1h'], { unit: 'hours', interval: '1', maxSpanDays: 90 });

      // 1D -> days (365 days chunk)
      assert.deepEqual(INTERVAL_TO_V3_MAP['1D'], { unit: 'days', interval: '1', maxSpanDays: 365 });

      // 1W -> weeks (730 days chunk)
      assert.deepEqual(INTERVAL_TO_V3_MAP['1W'], { unit: 'weeks', interval: '1', maxSpanDays: 730 });

      // 1M -> months (1825 days chunk)
      assert.deepEqual(INTERVAL_TO_V3_MAP['1M'], { unit: 'months', interval: '1', maxSpanDays: 1825 });
    });

    it('should URL-encode instrument keys replacing pipe with %7C', () => {
      assert.equal(encodeInstrumentKey('NSE_EQ|INE002A01018'), 'NSE_EQ%7CINE002A01018');
      assert.equal(encodeInstrumentKey('BSE_EQ|INE467B01029'), 'BSE_EQ%7CINE467B01029');
    });

    it('should reject invalid or empty instrument keys for encoding', () => {
      assert.throws(() => encodeInstrumentKey(''), /invalid instrument key/i);
      assert.throws(() => encodeInstrumentKey(null), /invalid instrument key/i);
    });
  });

  describe('2. Instrument Key Resolution & Seed Mapping', () => {
    it('should resolve verified seed bluechips accurately', () => {
      assert.equal(resolveInstrumentKey('RELIANCE', 'NSE'), VERIFIED_SEED_INSTRUMENTS['NSE:RELIANCE']);
      assert.equal(resolveInstrumentKey('TCS', 'NSE'), VERIFIED_SEED_INSTRUMENTS['NSE:TCS']);
      assert.equal(resolveInstrumentKey('INFY', 'NSE'), VERIFIED_SEED_INSTRUMENTS['NSE:INFY']);
      assert.equal(resolveInstrumentKey('HDFCBANK', 'NSE'), VERIFIED_SEED_INSTRUMENTS['NSE:HDFCBANK']);
      assert.equal(resolveInstrumentKey('ICICIBANK', 'NSE'), VERIFIED_SEED_INSTRUMENTS['NSE:ICICIBANK']);
      assert.equal(resolveInstrumentKey('500325', 'BSE'), VERIFIED_SEED_INSTRUMENTS['BSE:500325']);
    });

    it('should resolve from stock entity object with existing verified instrumentToken', () => {
      const stockWithToken = { symbol: 'RELIANCE', instrumentToken: 'NSE_EQ|INE002A01018' };
      assert.equal(resolveInstrumentKey(stockWithToken), 'NSE_EQ|INE002A01018');
    });

    it('should resolve from verified metadata by symbol or ISIN', () => {
      assert.equal(resolveInstrumentKey({ symbol: 'INFY', exchange: { code: 'NSE' } }), 'NSE_EQ|INE009A01021');
      assert.equal(resolveInstrumentKey({ isin: 'INE040A01034', exchange: { code: 'NSE' } }), 'NSE_EQ|INE040A01034');
    });

    it('should return null for unverified stocks and NEVER assume an unverified ISIN format', () => {
      // Unverified ISIN without official metadata
      const unverifiedStock = { symbol: 'UNVERIFIED', isin: 'INE999X01010', exchange: { code: 'NSE' } };
      assert.equal(resolveInstrumentKey(unverifiedStock), null);
      assert.equal(resolveInstrumentKey('UNKNOWN_FAKE_STOCK', 'NSE'), null);
      assert.equal(resolveInstrumentKey({ symbol: 'FAKE' }), null);
      assert.equal(resolveInstrumentKey(null), null);
    });

    it('should validate string instrument keys and reject invalid formats', () => {
      assert.equal(resolveInstrumentKey('NSE_EQ|INE002A01018'), 'NSE_EQ|INE002A01018');
      assert.equal(resolveInstrumentKey('INVALID_NO_PIPE'), null);
      assert.equal(resolveInstrumentKey('INVALID_SEGMENT|12345'), null);
    });
  });

  describe('3. Date Range Chunking Strategy', () => {
    const provider = new UpstoxProvider();

    it('should split 90-day minute request into 30-day chunks (maxSpanDays: 30)', () => {
      const chunks = provider.chunkDateRange('2026-08-01', '2026-10-30', 30);
      assert.ok(chunks.length >= 3);
      assert.equal(chunks[0].from, '2026-08-01');
      assert.equal(chunks[chunks.length - 1].to, '2026-10-30');
    });

    it('should return 1 chunk when date span is smaller than maxSpanDays', () => {
      const chunks = provider.chunkDateRange('2026-11-01', '2026-11-15', 30);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].from, '2026-11-01');
      assert.equal(chunks[0].to, '2026-11-15');
    });

    it('should handle month-end transitions smoothly with zero date gaps', () => {
      const chunks = provider.chunkDateRange('2026-01-15', '2026-02-15', 30);
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0].from, '2026-01-15');
      assert.equal(chunks[0].to, '2026-02-13');
      assert.equal(chunks[1].from, '2026-02-14');
      assert.equal(chunks[1].to, '2026-02-15');
    });

    it('should handle quarter-end transitions across 90-day chunks', () => {
      // Jan 1 to Jun 30 is 181 calendar days -> exactly 3 chunks (90d + 90d + 1d)
      const chunks = provider.chunkDateRange('2026-01-01', '2026-06-30', 90);
      assert.equal(chunks.length, 3);
      assert.equal(chunks[0].from, '2026-01-01');
      assert.equal(chunks[0].to, '2026-03-31'); // 90 days: Jan(31) + Feb(28) + Mar(31)
      assert.equal(chunks[1].from, '2026-04-01');
      assert.equal(chunks[1].to, '2026-06-29'); // 90 days: Apr(30) + May(31) + Jun(29)
      assert.equal(chunks[2].from, '2026-06-30');
      assert.equal(chunks[2].to, '2026-06-30'); // Remaining 1 day
    });

    it('should handle leap-year February boundaries correctly (2024 leap year)', () => {
      const chunks = provider.chunkDateRange('2024-02-20', '2024-03-05', 10);
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0].from, '2024-02-20');
      assert.equal(chunks[0].to, '2024-02-29'); // Leap day
      assert.equal(chunks[1].from, '2024-03-01');
      assert.equal(chunks[1].to, '2024-03-05');
    });

    it('should handle year-boundary rollovers with zero date drift', () => {
      const chunks = provider.chunkDateRange('2025-12-15', '2026-01-15', 30);
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0].from, '2025-12-15');
      assert.equal(chunks[0].to, '2026-01-13');
      assert.equal(chunks[1].from, '2026-01-14');
      assert.equal(chunks[1].to, '2026-01-15');
    });

    it('should throw when fromDate is after toDate', () => {
      assert.throws(
        () => provider.chunkDateRange('2026-11-15', '2026-11-01', 30),
        /fromDate .* cannot be after toDate/
      );
    });
  });

  describe('4. UpstoxClient Authentication, Rate Limiting & Error Handling', () => {
    it('should reject with REAUTHORIZATION_REQUIRED (401) when token is missing or expired', async () => {
      const mockTokenManager = {
        getAccessToken: async () => null, // Expired / missing token
      };

      const client = new UpstoxClient({ tokenProvider: mockTokenManager });

      await assert.rejects(
        () => client.get('https://api.upstox.com/v3/historical-candle/test'),
        (err) => err.code === 'REAUTHORIZATION_REQUIRED' && err.statusCode === 401
      );
    });

    it('should acquire rate limit permit before every outbound request', async () => {
      let permitAcquiredType = null;
      const mockRateLimiter = async (type) => {
        permitAcquiredType = type;
        return true;
      };

      const mockHttpClient = {
        get: async (url, config) => {
          assert.equal(config.headers.Authorization, `Bearer ${sampleToken}`);
          assert.equal(config.headers.Accept, 'application/json');
          return { data: { status: 'success', data: { candles: [] } } };
        },
      };

      const client = new UpstoxClient({
        tokenProvider: { getAccessToken: async () => sampleToken },
        rateLimiterFn: mockRateLimiter,
        httpClient: mockHttpClient,
      });

      await client.get('https://api.upstox.com/v3/historical-candle/test', { permitType: 'historical' });
      assert.equal(permitAcquiredType, 'historical', 'Must call rate limiter with historical permit');

      await client.get('https://api.upstox.com/v2/market-quote/quotes', { permitType: 'quote' });
      assert.equal(permitAcquiredType, 'quote', 'Must call rate limiter with quote permit');
    });

    it('should retry on HTTP 429 and eventually throw PROVIDER_RATE_LIMITED upon exhaustion', async () => {
      let callCount = 0;
      const mockHttpClient = {
        get: async () => {
          callCount++;
          const err = new Error('Too Many Requests');
          err.response = { status: 429, headers: {} };
          throw err;
        },
      };

      const client = new UpstoxClient({
        tokenProvider: { getAccessToken: async () => sampleToken },
        rateLimiterFn: async () => true,
        httpClient: mockHttpClient,
      });

      await assert.rejects(
        () => client.get('https://api.upstox.com/v3/historical-candle/test'),
        (err) => err.code === 'PROVIDER_RATE_LIMITED' && err.statusCode === 429
      );

      assert.equal(callCount, 3, 'Must attempt exactly 3 retries before failing');
    });

    it('should NEVER retry non-429 client errors (e.g. 400 Bad Request)', async () => {
      let callCount = 0;
      const mockHttpClient = {
        get: async () => {
          callCount++;
          const err = new Error('Bad Request');
          err.response = { status: 400, data: { status: 'error', errors: [{ message: 'Bad request' }] } };
          throw err;
        },
      };

      const client = new UpstoxClient({
        tokenProvider: { getAccessToken: async () => sampleToken },
        rateLimiterFn: async () => true,
        httpClient: mockHttpClient,
      });

      await assert.rejects(
        () => client.get('https://api.upstox.com/v3/historical-candle/test'),
        (err) => err.statusCode === 400 || err.code === 'PROVIDER_ERROR'
      );

      assert.equal(callCount, 1, 'Non-429 errors must abort immediately without retrying');
    });

    it('should map network timeouts (ECONNABORTED) to PROVIDER_TIMEOUT (504)', async () => {
      const mockHttpClient = {
        get: async () => {
          const err = new Error('timeout of 10000ms exceeded');
          err.code = 'ECONNABORTED';
          throw err;
        },
      };

      const client = new UpstoxClient({
        tokenProvider: { getAccessToken: async () => sampleToken },
        rateLimiterFn: async () => true,
        httpClient: mockHttpClient,
      });

      await assert.rejects(
        () => client.get('https://api.upstox.com/v3/historical-candle/test'),
        (err) => err.code === 'PROVIDER_TIMEOUT' && err.statusCode === 504
      );
    });

    it('should handle malformed non-JSON provider responses gracefully', async () => {
      const mockHttpClient = {
        get: async () => ({ data: '<html><body>502 Bad Gateway</body></html>' }),
      };

      const client = new UpstoxClient({
        tokenProvider: { getAccessToken: async () => sampleToken },
        rateLimiterFn: async () => true,
        httpClient: mockHttpClient,
      });

      await assert.rejects(
        () => client.get('https://api.upstox.com/v3/historical-candle/test'),
        (err) => err.code === 'PROVIDER_RESPONSE_MALFORMED' && err.statusCode === 502
      );
    });
  });

  describe('5. UpstoxProvider End-to-End Operational Methods', () => {
    it('should fetch and validate historical candles via V3 URL construction', async () => {
      const requestedUrls = [];
      const mockClient = {
        get: async (url, opts) => {
          requestedUrls.push(url);
          assert.equal(opts.permitType, 'historical');
          return {
            status: 'success',
            data: {
              candles: [
                ['2026-11-05T09:15:00+05:30', 2500, 2520, 2490, 2510, 100000, 0],
                ['2026-11-06T09:15:00+05:30', 2510, 2530, 2505, 2525, 120000, 0],
              ],
            },
          };
        },
      };

      const provider = new UpstoxProvider({ client: mockClient });
      const result = await provider.getHistoricalCandles(sampleKey, '1D', '2026-11-01', '2026-11-06');

      assert.equal(result.status, 'SUCCESS');
      assert.equal(result.data.length, 2);
      assert.equal(result.summary.validCount, 2);
      assert.equal(result.data[0].open, 2500);
      assert.equal(result.data[1].close, 2525);

      // Verify V3 URL structure
      assert.ok(requestedUrls[0].includes('https://api.upstox.com/v3/historical-candle/NSE_EQ%7CINE002A01018/days/1/'));
    });

    it('should fetch and validate intraday candles via V3 intraday URL construction', async () => {
      let requestedUrl = null;
      const mockClient = {
        get: async (url, opts) => {
          requestedUrl = url;
          assert.equal(opts.permitType, 'historical');
          return {
            status: 'success',
            data: {
              candles: [
                ['2026-11-06T10:00:00+05:30', 2515, 2520, 2512, 2518, 5000, 0],
              ],
            },
          };
        },
      };

      const provider = new UpstoxProvider({ client: mockClient });
      const result = await provider.getIntradayCandles(sampleKey, '5m');

      assert.equal(result.status, 'SUCCESS');
      assert.equal(result.data.length, 1);
      assert.equal(
        requestedUrl,
        'https://api.upstox.com/v3/historical-candle/intraday/NSE_EQ%7CINE002A01018/minutes/5'
      );
    });

    it('should fetch and normalize market quote via V2 URL construction', async () => {
      let requestedUrl = null;
      const mockClient = {
        get: async (url, opts) => {
          requestedUrl = url;
          assert.equal(opts.permitType, 'quote');
          return {
            status: 'success',
            data: {
              'NSE_EQ:RELIANCE': {
                symbol: 'RELIANCE',
                last_price: 2515.1,
                volume: 1234567,
                net_change: 14.6,
                percentage_change: 0.58,
                ohlc: { open: 2500.5, high: 2520.0, low: 2495.25, close: 2515.1 },
                timestamp: '2026-11-06T15:30:00.000+05:30',
              },
            },
          };
        },
      };

      const provider = new UpstoxProvider({ client: mockClient });
      const quote = await provider.getQuote(sampleKey);

      assert.equal(quote.symbol, 'RELIANCE');
      assert.equal(quote.lastPrice, 2515.1);
      assert.equal(quote.open, 2500.5);
      assert.equal(quote.high, 2520.0);
      assert.equal(quote.volume, BigInt(1234567));
      assert.equal(quote.volumeString, '1234567');
      assert.equal(quote.lastPriceDecimal, '2515.1000');
      assert.equal(
        requestedUrl,
        'https://api.upstox.com/v2/market-quote/quotes?instrument_key=NSE_EQ%7CINE002A01018'
      );

      // Verify JSON serialization safety with explicit safe serializer and market data serializer
      assert.doesNotThrow(() => safeJsonStringify(quote));
      const serialized = JSON.parse(safeJsonStringify(quote));
      assert.equal(serialized.volume, '1234567');
      const marketDataSerialized = serializeMarketData(quote);
      assert.equal(typeof marketDataSerialized.volume, 'string');
      assert.equal(marketDataSerialized.volume, '1234567');
      // Verify raw JSON.stringify throws TypeError because BigInt.prototype is NOT polluted
      assert.throws(() => JSON.stringify(quote), TypeError);
    });

    it('should fetch and normalize LTP via official V3 LTP endpoint and map all V3 fields', async () => {
      let requestedUrl = null;
      const mockClient = {
        get: async (url, opts) => {
          requestedUrl = url;
          assert.equal(opts.permitType, 'quote');
          return {
            status: 'success',
            data: {
              'NSE_EQ:RELIANCE': {
                instrument_token: sampleKey,
                last_price: 2515.1,
                ltq: 50,
                volume: 1234567,
                cp: 2500.5,
              },
            },
          };
        },
      };

      const provider = new UpstoxProvider({ client: mockClient });
      const ltp = await provider.getLtp(sampleKey);

      assert.equal(ltp.lastPrice, 2515.1);
      assert.equal(ltp.lastPriceDecimal, '2515.1000');
      assert.equal(ltp.instrumentKey, sampleKey);
      assert.equal(ltp.instrumentToken, sampleKey);
      assert.equal(ltp.ltq, 50n);
      assert.equal(ltp.ltqString, '50');
      assert.equal(ltp.volume, 1234567n);
      assert.equal(ltp.volumeString, '1234567');
      assert.equal(ltp.closePrice, 2500.5);
      assert.equal(ltp.closePriceDecimal, '2500.5000');
      assert.equal(ltp.cp, 2500.5);
      assert.equal(ltp.source, 'UPSTOX_V3');

      // Verify V3 URL and that deprecated V2 is NOT used
      assert.equal(
        requestedUrl,
        'https://api.upstox.com/v3/market-quote/ltp?instrument_key=NSE_EQ%7CINE002A01018'
      );
      assert.ok(!requestedUrl.includes('/v2/market-quote/ltp'), 'Deprecated V2 LTP endpoint must NOT be used');

      // Verify JSON serialization safety with explicit safe serializer and market data serializer
      assert.doesNotThrow(() => safeJsonStringify(ltp));
      const serialized = JSON.parse(safeJsonStringify(ltp));
      assert.equal(serialized.volume, '1234567');
      assert.equal(serialized.ltq, '50');
      const marketDataSerialized = serializeMarketData(ltp);
      assert.equal(typeof marketDataSerialized.volume, 'string');
      assert.equal(marketDataSerialized.volume, '1234567');
      assert.equal(typeof marketDataSerialized.ltq, 'string');
      assert.equal(marketDataSerialized.ltq, '50');
      // Verify raw JSON.stringify throws TypeError because BigInt.prototype is NOT polluted
      assert.throws(() => JSON.stringify(ltp), TypeError);
    });

    it('should detect and deduplicate duplicate timestamps across multiple fetched chunks', async () => {
      let chunkCallCount = 0;
      const mockClient = {
        get: async () => {
          chunkCallCount++;
          if (chunkCallCount === 1) {
            return {
              status: 'success',
              data: {
                candles: [
                  ['2026-09-01T09:15:00+05:30', 2500, 2520, 2490, 2510, 100000, 0],
                  ['2026-09-30T09:15:00+05:30', 2510, 2530, 2505, 2525, 120000, 0],
                ],
              },
            };
          }
          // Chunk 2 returns an overlapping boundary candle with identical timestamp
          return {
            status: 'success',
            data: {
              candles: [
                ['2026-09-30T09:15:00+05:30', 2510, 2530, 2505, 2525, 120000, 0], // Overlapping duplicate
                ['2026-10-01T09:15:00+05:30', 2525, 2540, 2515, 2535, 110000, 0],
              ],
            },
          };
        },
      };

      const provider = new UpstoxProvider({ client: mockClient });
      // 60-day range with 30-day chunk size ('15m' interval) creates exactly 2 chunks
      const result = await provider.getHistoricalCandles(sampleKey, '15m', '2026-09-01', '2026-10-30');

      assert.equal(result.data.length, 3, 'Deduplicated valid candles count must be 3');
      assert.equal(result.summary.duplicatesCount, 1, 'Must detect exactly 1 duplicate across chunks');
      assert.equal(result.rejected[0].code, 'DUPLICATE_TIMESTAMP');
    });

    it('should report operational health accurately reflecting token state', async () => {
      const mockTokenManager = {
        getTokenStatus: async () => ({
          configured: true,
          active: true,
          code: 'ACTIVE',
        }),
      };

      const provider = new UpstoxProvider({ tokenManager: mockTokenManager });
      const health = await provider.getHealth();

      assert.equal(health.provider, 'UPSTOX');
      assert.equal(health.status, 'CONNECTED');
      assert.equal(health.limits.historicalReqPerSec, 5);
      assert.equal(health.limits.quoteReqPerSec, 8);
    });
  });
});
