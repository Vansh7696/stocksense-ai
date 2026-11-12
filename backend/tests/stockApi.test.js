import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';
import redisClient from '../src/config/redis.js';
import cacheService, { CacheService } from '../src/services/cache.service.js';

describe('Milestone 3, Step 6: Express REST APIs & Redis Caching Test Suite', () => {
  let seededStock = null;
  let bseStock = null;
  let duplicateBseStock = null;
  let testIndexStock = null;
  let testCandle = null;
  let bseExchange = null;
  let nseExchange = null;

  before(async () => {
    // 1. Fetch reference seeded stocks and exchanges from test database
    nseExchange = await prisma.exchange.findUnique({ where: { code: 'NSE' } });
    bseExchange = await prisma.exchange.findUnique({ where: { code: 'BSE' } });
    assert.ok(nseExchange, 'Test database must have NSE exchange');
    assert.ok(bseExchange, 'Test database must have BSE exchange');

    seededStock = await prisma.stock.findFirst({
      where: { symbol: 'RELIANCE', segment: 'NSE_EQ' },
      include: { exchange: true },
    });
    assert.ok(seededStock, 'Test database must have seeded RELIANCE stock');

    bseStock = await prisma.stock.findFirst({
      where: { symbol: '500325', segment: 'BSE_EQ' },
      include: { exchange: true },
    });
    assert.ok(bseStock, 'Test database must have seeded BSE stock');

    // 2. Create a duplicate stock in BSE with identical symbol 'RELIANCE' to test disambiguation
    duplicateBseStock = await prisma.stock.create({
      data: {
        exchangeId: bseExchange.id,
        symbol: 'RELIANCE',
        companyName: 'Reliance Industries Limited (BSE)',
        instrumentToken: 'BSE_EQ|INE002A01018_DUP_TEST',
        exchangeToken: '500325_DUP',
        segment: 'BSE_EQ',
        instrumentType: 'EQUITY',
        series: 'EQ',
        lotSize: 1,
        isActive: true,
      },
      include: { exchange: true },
    });

    // 3. Create a test index stock in test DB (cleaned up in after())
    testIndexStock = await prisma.stock.create({
      data: {
        exchangeId: nseExchange.id,
        symbol: 'NIFTY 50',
        companyName: 'Nifty 50 Index',
        instrumentToken: 'NSE_INDEX|Nifty 50',
        exchangeToken: '10001',
        segment: 'NSE_INDEX',
        instrumentType: 'INDEX',
        series: 'INDEX',
        lotSize: 50,
        isActive: true,
      },
    });

    // 4. Create a test historical candle for RELIANCE (cleaned up in after())
    testCandle = await prisma.historicalPrice.create({
      data: {
        stockId: seededStock.id,
        timestamp: new Date('2026-03-31T09:15:00.000Z'),
        open: '2980.5000',
        high: '3015.2500',
        low: '2975.0000',
        close: '3005.7500',
        volume: BigInt('15420980'),
        interval: '1D',
        dataSource: 'UPSTOX',
      },
    });

    // 5. Create an ingestion summary config in test DB
    await prisma.systemConfig.upsert({
      where: { key: 'UPSTOX_INSTRUMENT_INGESTION_SUMMARY' },
      update: {
        value: JSON.stringify({
          status: 'COMPLETED',
          totalDownloaded: 130884,
          validInScope: 23104,
          insertedRecords: 10,
          updatedRecords: 0,
          timestamp: '2026-03-31T06:00:00.000Z',
        }),
      },
      create: {
        key: 'UPSTOX_INSTRUMENT_INGESTION_SUMMARY',
        value: JSON.stringify({
          status: 'COMPLETED',
          totalDownloaded: 130884,
          validInScope: 23104,
          insertedRecords: 10,
          updatedRecords: 0,
          timestamp: '2026-03-31T06:00:00.000Z',
        }),
      },
    });
  });

  after(async () => {
    // Clean up created test fixtures to preserve clean test database
    if (testCandle) {
      await prisma.historicalPrice.deleteMany({ where: { stockId: seededStock.id } });
    }
    if (testIndexStock) {
      await prisma.stock.delete({ where: { id: testIndexStock.id } });
    }
    if (duplicateBseStock) {
      await prisma.stock.delete({ where: { id: duplicateBseStock.id } });
    }
    await prisma.systemConfig.deleteMany({
      where: { key: 'UPSTOX_INSTRUMENT_INGESTION_SUMMARY' },
    });

    // Invalidate any leftover cache keys
    await cacheService.invalidateStockCatalogueCache();
  });

  beforeEach(async () => {
    // Flush cache before each test to ensure deterministic starting state
    await cacheService.invalidateStockCatalogueCache();
  });

  // -------------------------------------------------------------
  // 1. GET /api/stocks (Catalogue, Filtering, Pagination, Sorting)
  // -------------------------------------------------------------
  describe('GET /api/stocks', () => {
    test('returns paginated stocks with standard envelope and pagination metadata', async () => {
      const res = await request(app).get('/api/stocks?page=1&limit=5');
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(Array.isArray(res.body.data.stocks));
      assert.ok(res.body.data.stocks.length <= 5);
      assert.equal(res.body.data.pagination.page, 1);
      assert.equal(res.body.data.pagination.limit, 5);
      assert.ok(res.body.data.pagination.totalRecords >= 7);
      assert.ok(typeof res.body.data.pagination.totalPages === 'number');
      assert.equal(typeof res.body.meta.cached, 'boolean');
      assert.ok(res.body.meta.timestamp);
    });

    test('filters stocks by exchange code (e.g. NSE vs BSE)', async () => {
      const resNse = await request(app).get('/api/stocks?exchange=NSE');
      assert.equal(resNse.status, 200);
      for (const stock of resNse.body.data.stocks) {
        assert.equal(stock.exchange.code, 'NSE');
      }

      const resBse = await request(app).get('/api/stocks?exchange=BSE');
      assert.equal(resBse.status, 200);
      for (const stock of resBse.body.data.stocks) {
        assert.equal(stock.exchange.code, 'BSE');
      }
    });

    test('filters stocks by instrumentType (e.g. EQUITY vs INDEX)', async () => {
      const resEquity = await request(app).get('/api/stocks?instrumentType=EQUITY');
      assert.equal(resEquity.status, 200);
      for (const stock of resEquity.body.data.stocks) {
        assert.equal(stock.instrumentType, 'EQUITY');
      }

      const resIndex = await request(app).get('/api/stocks?instrumentType=INDEX');
      assert.equal(resIndex.status, 200);
      assert.ok(resIndex.body.data.stocks.length >= 1);
      for (const stock of resIndex.body.data.stocks) {
        assert.equal(stock.instrumentType, 'INDEX');
      }
    });

    test('filters stocks by segment (e.g. NSE_EQ)', async () => {
      const res = await request(app).get('/api/stocks?segment=NSE_EQ');
      assert.equal(res.status, 200);
      for (const stock of res.body.data.stocks) {
        assert.equal(stock.segment, 'NSE_EQ');
      }
    });

    test('filters stocks by active status', async () => {
      const res = await request(app).get('/api/stocks?isActive=true');
      assert.equal(res.status, 200);
      for (const stock of res.body.data.stocks) {
        assert.equal(stock.isActive, true);
      }
    });

    test('searches stocks by symbol or company name using search param', async () => {
      const res = await request(app).get('/api/stocks?search=Reliance');
      assert.equal(res.status, 200);
      assert.ok(res.body.data.stocks.length >= 1);
      const hasReliance = res.body.data.stocks.some(
        (s) => s.symbol.includes('RELIANCE') || s.companyName.includes('Reliance')
      );
      assert.ok(hasReliance);
    });

    test('sorts stocks deterministically by symbol desc with secondary tie-breaker', async () => {
      const res = await request(app).get('/api/stocks?sortBy=symbol&sortOrder=desc');
      assert.equal(res.status, 200);
      const symbols = res.body.data.stocks.map((s) => s.symbol);
      const sorted = [...symbols].sort((a, b) => b.localeCompare(a));
      assert.deepEqual(symbols, sorted);
    });

    test('rejects invalid page number with 400 INVALID_PAGINATION_PAGE', async () => {
      const res = await request(app).get('/api/stocks?page=0');
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'INVALID_PAGINATION_PAGE');
    });

    test('rejects invalid limit with 400 INVALID_PAGINATION_LIMIT', async () => {
      const res = await request(app).get('/api/stocks?limit=200');
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'INVALID_PAGINATION_LIMIT');
    });

    test('rejects invalid sortBy field with 400 INVALID_SORT_BY', async () => {
      const res = await request(app).get('/api/stocks?sortBy=unsupportedColumn');
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'INVALID_SORT_BY');
    });

    test('rejects invalid sortOrder with 400 INVALID_SORT_ORDER', async () => {
      const res = await request(app).get('/api/stocks?sortOrder=sideways');
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'INVALID_SORT_ORDER');
    });

    test('rejects invalid exchange filter with 400 INVALID_EXCHANGE', async () => {
      const res = await request(app).get('/api/stocks?exchange=NASDAQ');
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'INVALID_EXCHANGE');
    });

    test('rejects invalid instrumentType filter with 400 INVALID_INSTRUMENT_TYPE', async () => {
      const res = await request(app).get('/api/stocks?instrumentType=CRYPTO');
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'INVALID_INSTRUMENT_TYPE');
    });

    test('rejects invalid isActive filter with 400 INVALID_FILTER_IS_ACTIVE', async () => {
      const res = await request(app).get('/api/stocks?isActive=maybe');
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'INVALID_FILTER_IS_ACTIVE');
    });
  });

  // -------------------------------------------------------------
  // 2. GET /api/stocks/search (Typeahead Search)
  // -------------------------------------------------------------
  describe('GET /api/stocks/search', () => {
    test('returns matching stocks by symbol or company name prefix', async () => {
      const res = await request(app).get('/api/stocks/search?q=rel');
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.query, 'rel');
      assert.ok(res.body.data.totalMatches >= 1);
      assert.ok(Array.isArray(res.body.data.results));
      const hasMatch = res.body.data.results.some(
        (s) => s.symbol.includes('RELIANCE') || s.companyName.toLowerCase().includes('reliance')
      );
      assert.ok(hasMatch);
    });

    test('respects limit parameter on typeahead search', async () => {
      const res = await request(app).get('/api/stocks/search?q=e&limit=2');
      assert.equal(res.status, 200);
      assert.ok(res.body.data.results.length <= 2);
    });

    test('rejects empty query parameter with 400 MISSING_SEARCH_QUERY', async () => {
      const res = await request(app).get('/api/stocks/search?q=');
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'MISSING_SEARCH_QUERY');
    });

    test('rejects query exceeding 50 characters with 400 INVALID_SEARCH_QUERY', async () => {
      const longQuery = 'A'.repeat(51);
      const res = await request(app).get(`/api/stocks/search?q=${longQuery}`);
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'INVALID_SEARCH_QUERY');
    });

    test('returns empty results list for non-matching query', async () => {
      const res = await request(app).get('/api/stocks/search?q=NONEXISTENT_SYMBOL_XYZ');
      assert.equal(res.status, 200);
      assert.equal(res.body.data.totalMatches, 0);
      assert.equal(res.body.data.results.length, 0);
    });
  });

  // -------------------------------------------------------------
  // 3. Duplicate Symbol Disambiguation & Cross-Exchange Resolution
  // -------------------------------------------------------------
  describe('Duplicate Symbol Disambiguation & Identifier Resolution', () => {
    test('UUID lookup returns the exact record regardless of identical symbols', async () => {
      const res = await request(app).get(`/api/stocks/${seededStock.id}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.id, seededStock.id);
      assert.equal(res.body.data.symbol, 'RELIANCE');
      assert.equal(res.body.data.exchange.code, 'NSE');
    });

    test('Upstox instrument key lookup returns the exact record regardless of identical symbols', async () => {
      const res = await request(app).get(`/api/stocks/${encodeURIComponent(duplicateBseStock.instrumentToken)}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.id, duplicateBseStock.id);
      assert.equal(res.body.data.instrumentToken, duplicateBseStock.instrumentToken);
      assert.equal(res.body.data.exchange.code, 'BSE');
    });

    test('symbol lookup for ambiguous symbol returns 409 AMBIGUOUS_STOCK_IDENTIFIER with safe matching candidates', async () => {
      // Both NSE and BSE have 'RELIANCE' in test DB
      const res = await request(app).get('/api/stocks/RELIANCE');
      assert.equal(res.status, 409);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'AMBIGUOUS_STOCK_IDENTIFIER');
      assert.ok(res.body.error.message.includes('Ambiguous stock symbol "RELIANCE"'));

      // Verify safe matching candidate identifiers are returned in details
      const matches = res.body.error.details?.matches;
      assert.ok(Array.isArray(matches));
      assert.equal(matches.length, 2);
      const exchanges = matches.map((m) => m.exchange);
      assert.ok(exchanges.includes('NSE'));
      assert.ok(exchanges.includes('BSE'));

      // Ensure no raw database internals or secrets are in matches
      for (const m of matches) {
        assert.ok(m.id);
        assert.ok(m.symbol);
        assert.ok(m.instrumentToken);
        assert.equal(m.passwordHash, undefined);
      }
    });

    test('symbol lookup disambiguates when exchange=NSE query parameter is provided', async () => {
      const res = await request(app).get('/api/stocks/RELIANCE?exchange=NSE');
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.id, seededStock.id);
      assert.equal(res.body.data.exchange.code, 'NSE');
    });

    test('symbol lookup disambiguates when exchange=BSE query parameter is provided', async () => {
      const res = await request(app).get('/api/stocks/RELIANCE?exchange=BSE');
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.id, duplicateBseStock.id);
      assert.equal(res.body.data.exchange.code, 'BSE');
    });

    test('rejects invalid exchange parameter during symbol lookup with 400 INVALID_EXCHANGE', async () => {
      const res = await request(app).get('/api/stocks/RELIANCE?exchange=INVALID');
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'INVALID_EXCHANGE');
    });

    test('unique symbol without duplicates (e.g. TCS) resolves directly with 200 OK', async () => {
      const res = await request(app).get('/api/stocks/TCS');
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.symbol, 'TCS');
    });

    test('returns 404 STOCK_NOT_FOUND when identifier does not exist', async () => {
      const res = await request(app).get('/api/stocks/UNKNOWN_SYMBOL_9999');
      assert.equal(res.status, 404);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'STOCK_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------
  // 4. GET /api/stocks/:id/prices (Historical Candle Prices)
  // -------------------------------------------------------------
  describe('GET /api/stocks/:id/prices', () => {
    test('returns historical candles with decimal strings and BigInt volume string', async () => {
      const res = await request(app).get(`/api/stocks/${seededStock.id}/prices?interval=1D`);
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.stock.id, seededStock.id);
      assert.equal(res.body.data.stock.symbol, seededStock.symbol);
      assert.equal(res.body.data.interval, '1D');
      assert.ok(Array.isArray(res.body.data.candles));
      assert.ok(res.body.data.candles.length >= 1);

      const candle = res.body.data.candles[0];
      assert.equal(candle.open, '2980.5');
      assert.equal(candle.high, '3015.25');
      assert.equal(candle.low, '2975');
      assert.equal(candle.close, '3005.75');
      // Verify BigInt volume is serialized accurately as a string without precision loss
      assert.equal(candle.volume, '15420980');
      assert.equal(typeof candle.volume, 'string');
      assert.equal(candle.interval, '1D');
      assert.equal(candle.dataSource, 'UPSTOX');
    });

    test('ambiguous symbol without exchange returns 409 AMBIGUOUS_STOCK_IDENTIFIER for prices', async () => {
      const res = await request(app).get('/api/stocks/RELIANCE/prices?interval=1D');
      assert.equal(res.status, 409);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'AMBIGUOUS_STOCK_IDENTIFIER');
    });

    test('ambiguous symbol with exchange=NSE resolves and returns candles', async () => {
      const res = await request(app).get('/api/stocks/RELIANCE/prices?interval=1D&exchange=NSE');
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.stock.exchange, 'NSE');
      assert.ok(res.body.data.candles.length >= 1);
    });

    test('returns empty candles list with 200 OK for stock with no candles and identifies verified alternate listing', async () => {
      const res = await request(app).get(`/api/stocks/${bseStock.id}/prices?interval=1D`);
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.deepEqual(res.body.data.candles, []);
      assert.equal(res.body.data.pagination.totalRecords, 0);
      assert.ok(res.body.data.alternateListing, 'Must identify verified alternate listing when available');
      assert.equal(res.body.data.alternateListing.exchange, 'NSE');
      assert.equal(res.body.data.alternateListing.symbol, seededStock.symbol);
      assert.ok(res.body.data.alternateListing.candlesCount >= 1);
    });

    test('rejects non-existent stock with 404 STOCK_NOT_FOUND', async () => {
      const res = await request(app).get('/api/stocks/NON_EXISTENT_STOCK/prices');
      assert.equal(res.status, 404);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'STOCK_NOT_FOUND');
    });

    test('rejects unsupported interval with 400 INVALID_INTERVAL', async () => {
      const res = await request(app).get(`/api/stocks/${seededStock.id}/prices?interval=2hr`);
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'INVALID_INTERVAL');
    });

    test('filters candles by date range from and to', async () => {
      const res = await request(app).get(
        `/api/stocks/${seededStock.id}/prices?interval=1D&from=2026-03-01&to=2026-04-01`
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.data.candles.length, 1);

      // Outside date range
      const resEmpty = await request(app).get(
        `/api/stocks/${seededStock.id}/prices?interval=1D&from=2025-01-01&to=2025-01-31`
      );
      assert.equal(resEmpty.status, 200);
      assert.equal(resEmpty.body.data.candles.length, 0);
    });

    test('rejects invalid date formats with 400 INVALID_DATE_FROM', async () => {
      const res = await request(app).get(`/api/stocks/${seededStock.id}/prices?from=invalid-date`);
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'INVALID_DATE_FROM');
    });

    test('rejects from date after to date with 400 INVALID_DATE_RANGE', async () => {
      const res = await request(app).get(
        `/api/stocks/${seededStock.id}/prices?from=2026-04-01&to=2026-03-01`
      );
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'INVALID_DATE_RANGE');
    });
  });

  // -------------------------------------------------------------
  // 5. GET /api/market/overview (Market Overview Aggregate)
  // -------------------------------------------------------------
  describe('GET /api/market/overview', () => {
    test('returns accurate market counts, exchange breakdown, and Upstox provider status', async () => {
      const res = await request(app).get('/api/market/overview');
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);

      // Summary verification
      const summary = res.body.data.summary;
      assert.ok(typeof summary.totalActiveInstruments === 'number');
      assert.ok(summary.totalActiveInstruments >= 8); // 7 base + 1 test index + 1 dup bse
      assert.ok(summary.exchanges.NSE >= 6);
      assert.ok(summary.exchanges.BSE >= 3);
      assert.ok(summary.instrumentTypes.EQUITY >= 8);
      assert.ok(summary.instrumentTypes.INDEX >= 1);

      // Provider verification
      const provider = res.body.data.provider;
      assert.equal(provider.name, 'UPSTOX');
      assert.ok(['ACTIVE', 'REAUTHORIZATION_REQUIRED'].includes(provider.status));
      assert.equal(typeof provider.configured, 'boolean');
      assert.equal(typeof provider.active, 'boolean');

      // Last Ingestion verification
      const ingestion = res.body.data.lastIngestion;
      assert.ok(ingestion);
      assert.equal(ingestion.status, 'COMPLETED');
      assert.equal(ingestion.totalDownloaded, 130884);

      // Metadata envelope
      assert.equal(typeof res.body.meta.cached, 'boolean');
      assert.ok(res.body.meta.timestamp);
    });

    test('never synthesizes or fabricates live price fields in overview', async () => {
      const res = await request(app).get('/api/market/overview');
      assert.equal(res.status, 200);
      assert.equal(res.body.data.ltp, undefined);
      assert.equal(res.body.data.fakePrice, undefined);
      assert.equal(res.body.data.currentPrice, undefined);
    });
  });

  // -------------------------------------------------------------
  // 6. GET /api/market/indices (Database Indices)
  // -------------------------------------------------------------
  describe('GET /api/market/indices', () => {
    test('returns verified indices stored in database without live price fabrication', async () => {
      const res = await request(app).get('/api/market/indices');
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.data.totalIndices >= 1);
      assert.ok(Array.isArray(res.body.data.indices));

      const nifty = res.body.data.indices.find((i) => i.symbol === 'NIFTY 50');
      assert.ok(nifty, 'Database must contain test index NIFTY 50');
      assert.equal(nifty.instrumentType, 'INDEX');
      assert.equal(nifty.segment, 'NSE_INDEX');
      assert.equal(nifty.exchange.code, 'NSE');

      // Crucial: No fabricated live prices
      assert.equal(nifty.ltp, undefined);
      assert.equal(nifty.lastPrice, undefined);
      assert.equal(nifty.changePercent, undefined);
    });
  });

  // -------------------------------------------------------------
  // 7. Redis Caching & Invalidation Integration
  // -------------------------------------------------------------
  describe('Redis Caching Integration', () => {
    test('first request produces cache miss (meta.cached: false), second produces cache hit (meta.cached: true)', async () => {
      const url = '/api/stocks?page=1&limit=3';

      // First request (Cold cache)
      const res1 = await request(app).get(url);
      assert.equal(res1.status, 200);
      assert.equal(res1.body.meta.cached, false);

      // Second request (Warm cache)
      const res2 = await request(app).get(url);
      assert.equal(res2.status, 200);
      assert.equal(res2.body.meta.cached, true);
      assert.deepEqual(res1.body.data, res2.body.data);
    });

    test('cache for stock detail caches on first hit and invalidates cleanly', async () => {
      const url = `/api/stocks/${seededStock.id}`;

      // 1. Initial fetch -> cache miss
      const res1 = await request(app).get(url);
      assert.equal(res1.status, 200);
      assert.equal(res1.body.meta.cached, false);

      // 2. Immediate fetch -> cache hit
      const res2 = await request(app).get(url);
      assert.equal(res2.status, 200);
      assert.equal(res2.body.meta.cached, true);

      // 3. Invalidate stock catalogue cache
      await cacheService.invalidateStockCatalogueCache();

      // 4. Fetch after invalidation -> cache miss again
      const res3 = await request(app).get(url);
      assert.equal(res3.status, 200);
      assert.equal(res3.body.meta.cached, false);
    });

    test('failed queries (404 not found, 409 ambiguous) are NOT cached in Redis', async () => {
      // 1. 404 query
      const res404 = await request(app).get('/api/stocks/NON_EXISTENT_STK_999');
      assert.equal(res404.status, 404);

      const cached404 = await cacheService.get(cacheService.buildKey('stocks:detail', 'NON_EXISTENT_STK_999'));
      assert.equal(cached404, null, '404 responses must not be cached');

      // 2. 409 ambiguous query
      const res409 = await request(app).get('/api/stocks/RELIANCE');
      assert.equal(res409.status, 409);

      const cached409 = await cacheService.get(cacheService.buildKey('stocks:detail', 'RELIANCE'));
      assert.equal(cached409, null, '409 ambiguous responses must not be cached');
    });

    test('different filter parameters produce distinct cache keys and payloads', async () => {
      const resNse = await request(app).get('/api/stocks?exchange=NSE&limit=5');
      assert.equal(resNse.status, 200);

      const resBse = await request(app).get('/api/stocks?exchange=BSE&limit=5');
      assert.equal(resBse.status, 200);

      const nseKey = cacheService.buildDeterministicKey('stocks:list', { exchange: 'NSE', limit: 5 });
      const bseKey = cacheService.buildDeterministicKey('stocks:list', { exchange: 'BSE', limit: 5 });

      assert.notEqual(nseKey, bseKey);
      assert.notDeepEqual(resNse.body.data.stocks, resBse.body.data.stocks);
    });

    test('equivalent query parameter ordering produces identical cache keys (deterministic normalization)', async () => {
      const url1 = '/api/stocks?page=1&limit=5&exchange=NSE';
      const url2 = '/api/stocks?exchange=NSE&limit=5&page=1';

      const res1 = await request(app).get(url1);
      assert.equal(res1.status, 200);
      assert.equal(res1.body.meta.cached, false);

      // The second request with shuffled query param ordering should hit the exact same cache
      const res2 = await request(app).get(url2);
      assert.equal(res2.status, 200);
      assert.equal(res2.body.meta.cached, true);
      assert.deepEqual(res1.body.data, res2.body.data);
    });

    test('fails open gracefully when Redis client is offline (returns live DB data without crashing)', async () => {
      // Mock an isolated CacheService with offline Redis
      const offlineRedis = {
        status: 'close',
        get: async () => {
          throw new Error('Redis connection refused: ECONNREFUSED');
        },
        set: async () => {
          throw new Error('Redis connection refused: ECONNREFUSED');
        },
        scan: async () => ['0', []],
      };

      const offlineCacheService = new CacheService({ redisClient: offlineRedis });
      assert.equal(offlineCacheService.isAvailable(), false);

      const val = await offlineCacheService.get('any-key');
      assert.equal(val, null);

      const setRes = await offlineCacheService.set('any-key', { foo: 'bar' }, 60);
      assert.equal(setRes, false);

      // Verify getOrSet falls through to database factory seamlessly
      const factoryResult = await offlineCacheService.getOrSet('test-key', 60, async () => {
        return { source: 'live_database' };
      });
      assert.equal(factoryResult.cached, false);
      assert.equal(factoryResult.data.source, 'live_database');
    });

    test('deterministic query string builder normalizes param order preventing cache duplication', () => {
      const key1 = cacheService.buildDeterministicKey('stocks:list', {
        page: 1,
        limit: 10,
        exchange: 'NSE',
      });
      const key2 = cacheService.buildDeterministicKey('stocks:list', {
        exchange: 'NSE',
        limit: 10,
        page: 1,
      });

      assert.equal(key1, key2);
      assert.equal(key1, 'stocksense:cache:stocks:list:exchange=NSE&limit=10&page=1');
    });
  });
});
