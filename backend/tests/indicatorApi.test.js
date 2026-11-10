import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';
import redisClient from '../src/config/redis.js';
import { MLServiceClient } from '../src/services/mlClient.service.js';
import cacheService from '../src/services/cache.service.js';

describe('Milestone 5 — Phase 5B: Technical Indicators & Feature Engineering API Integration Suite', () => {
  let nseExchange = null;
  let bseExchange = null;
  let seededStockNse = null;
  let seededStockBse = null;
  let duplicateBseStock = null;

  before(async () => {
    assert.ok(process.env.NODE_ENV === 'test');

    nseExchange = await prisma.exchange.findUnique({ where: { code: 'NSE' } });
    bseExchange = await prisma.exchange.findUnique({ where: { code: 'BSE' } });
    assert.ok(nseExchange, 'Test database must have NSE exchange');
    assert.ok(bseExchange, 'Test database must have BSE exchange');

    seededStockNse = await prisma.stock.findFirst({
      where: { symbol: 'RELIANCE', exchange: { code: 'NSE' }, isActive: true },
      include: { exchange: true },
    });
    assert.ok(seededStockNse, 'Test database must have seeded NSE RELIANCE');

    seededStockBse = await prisma.stock.findFirst({
      where: { symbol: '500325', exchange: { code: 'BSE' }, isActive: true },
      include: { exchange: true },
    });
    assert.ok(seededStockBse, 'Test database must have seeded BSE 500325');

    // Create temporary duplicate stock on BSE to test ambiguity
    duplicateBseStock = await prisma.stock.create({
      data: {
        exchangeId: bseExchange.id,
        symbol: 'RELIANCE',
        companyName: 'Reliance Industries Limited (BSE Duplicate)',
        instrumentToken: 'BSE_EQ|INE002A01018_INDICATOR_TEST',
        exchangeToken: '500325_IND_TEST',
        segment: 'BSE_EQ',
        instrumentType: 'EQUITY',
        series: 'EQ',
        lotSize: 1,
        isActive: true,
      },
      include: { exchange: true },
    });
  });

  after(async () => {
    try {
      if (duplicateBseStock) {
        await prisma.stock.delete({ where: { id: duplicateBseStock.id } });
      }
      await cacheService.invalidateStockPricesCache();
    } finally {
      const isStandaloneRun = process.argv.some(
        (arg) => arg.includes('indicatorApi.test.js') && !arg.includes('*')
      );
      if (isStandaloneRun) {
        try {
          if (redisClient && redisClient.status === 'ready') {
            await redisClient.quit();
          }
          await prisma.$disconnect();
        } catch {}
      }
    }
  });

  // --------------------------------------------------------------------------
  // 1. Endpoint Input Validation & Ambiguity Handling
  // --------------------------------------------------------------------------
  describe('1. Endpoint Input Validation & Ambiguity Handling', () => {
    test('GET /api/stocks/:id/indicators returns hasData: false when no candles exist', async () => {
      const res = await request(app).get(`/api/stocks/${seededStockNse.id}/indicators`);
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.hasData, false);
      assert.equal(res.body.data.totalCandles, 0);
      assert.equal(res.body.data.indicators, null);
      assert.ok(res.body.data.message.includes('No historical 1D candles available'));
    });

    test('GET /api/stocks/:id/features returns hasData: false when no candles exist', async () => {
      const res = await request(app).get(`/api/stocks/${seededStockNse.id}/features`);
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.hasData, false);
      assert.equal(res.body.data.totalRows, 0);
      assert.equal(res.body.data.features.length, 0);
    });

    test('rejects invalid interval with 400 INVALID_INTERVAL', async () => {
      const res = await request(app).get(`/api/stocks/${seededStockNse.id}/indicators?interval=invalidInterval`);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_INTERVAL');
    });

    test('rejects non-existent stock identifier with 404 STOCK_NOT_FOUND', async () => {
      const res = await request(app).get('/api/stocks/NON_EXISTENT_TICKER/indicators');
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'STOCK_NOT_FOUND');
    });

    test('rejects ambiguous symbol with 409 AMBIGUOUS_STOCK_IDENTIFIER', async () => {
      // RELIANCE exists on both NSE and BSE
      const res = await request(app).get('/api/stocks/RELIANCE/indicators');
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'AMBIGUOUS_STOCK_IDENTIFIER');
      assert.ok(res.body.error.details?.matches?.length >= 2);
    });

    test('resolves ambiguous symbol with explicit exchange parameter', async () => {
      const res = await request(app).get('/api/stocks/RELIANCE/indicators?exchange=NSE');
      assert.equal(res.status, 200);
      assert.equal(res.body.meta.stock.exchange, 'NSE');
      assert.equal(res.body.data.hasData, false);
    });
  });

  // --------------------------------------------------------------------------
  // 2. MLServiceClient Unit Tests & Error Resilience
  // --------------------------------------------------------------------------
  describe('2. MLServiceClient Unit Tests & Error Resilience', () => {
    test('formatCandlesForML formats Prisma Decimal and BigInt accurately to floats', () => {
      const client = new MLServiceClient();
      const rawCandles = [
        {
          timestamp: new Date('2025-01-01T09:15:00.000Z'),
          open: '2500.5000',
          high: '2550.0000',
          low: '2490.2500',
          close: '2530.7500',
          volume: 1500000n,
        },
      ];

      const formatted = client.formatCandlesForML(rawCandles);
      assert.equal(formatted.length, 1);
      assert.equal(formatted[0].timestamp, '2025-01-01T09:15:00.000Z');
      assert.equal(formatted[0].open, 2500.5);
      assert.equal(formatted[0].high, 2550.0);
      assert.equal(formatted[0].low, 2490.25);
      assert.equal(formatted[0].close, 2530.75);
      assert.equal(formatted[0].volume, 1500000);
    });

    test('rejects empty candles with 400 EMPTY_CANDLES', async () => {
      const client = new MLServiceClient();
      await assert.rejects(
        () => client.computeIndicators('RELIANCE', []),
        (err) => {
          assert.equal(err.code, 'EMPTY_CANDLES');
          assert.equal(err.statusCode, 400);
          return true;
        }
      );
    });

    test('classifies connection refusal as 503 ML_SERVICE_UNAVAILABLE', async () => {
      const mockHttp = {
        post: async () => {
          const err = new Error('connect ECONNREFUSED 127.0.0.1:8000');
          err.code = 'ECONNREFUSED';
          throw err;
        },
      };

      const client = new MLServiceClient({ httpClient: mockHttp });
      await assert.rejects(
        () => client.computeIndicators('RELIANCE', [{ timestamp: '2025-01-01', open: 1, high: 2, low: 1, close: 2, volume: 100 }]),
        (err) => {
          assert.equal(err.code, 'ML_SERVICE_UNAVAILABLE');
          assert.equal(err.statusCode, 503);
          return true;
        }
      );
    });

    test('classifies HTTP error response as ML_CALCULATION_ERROR with detail message', async () => {
      const mockHttp = {
        post: async () => {
          const err = new Error('Unprocessable Content');
          err.response = {
            status: 422,
            data: { detail: 'High price is less than Low price' },
          };
          throw err;
        },
      };

      const client = new MLServiceClient({ httpClient: mockHttp });
      await assert.rejects(
        () => client.computeIndicators('RELIANCE', [{ timestamp: '2025-01-01', open: 1, high: 2, low: 1, close: 2, volume: 100 }]),
        (err) => {
          assert.equal(err.code, 'ML_CALCULATION_ERROR');
          assert.equal(err.statusCode, 422);
          assert.ok(err.message.includes('High price is less than Low price'));
          return true;
        }
      );
    });

    test('successfully returns data when ML service succeeds', async () => {
      const mockResult = {
        symbol: 'RELIANCE',
        total_candles: 30,
        warmup_status: 'PARTIAL_WARMUP',
        indicators: {
          timestamps: ['2025-01-01'],
          close: [2500.0],
          sma: { sma_20: [2480.0] },
          ema: { ema_12: [2490.0] },
          rsi: [55.0],
          macd: { macd_line: [10.0], signal_line: [8.0], histogram: [2.0] },
          bollinger_bands: { upper: [2550.0], middle: [2480.0], lower: [2410.0], percent_b: [0.64], bandwidth: [0.056] },
          atr: [45.0],
          daily_returns_pct: [0.5],
          rolling_volatility_pct: [18.2],
          volume_sma: [1200000.0],
          relative_volume: [1.25],
        },
        latest: { close: 2500.0, rsi: 55.0 },
        metadata: { max_period_needed: 200 },
      };

      const mockHttp = {
        post: async () => ({ status: 200, data: mockResult }),
      };

      const client = new MLServiceClient({ httpClient: mockHttp });
      const data = await client.computeIndicators('RELIANCE', [{ timestamp: '2025-01-01', open: 1, high: 2, low: 1, close: 2, volume: 100 }]);

      assert.equal(data.symbol, 'RELIANCE');
      assert.equal(data.indicators.rsi[0], 55.0);
      assert.equal(data.warmup_status, 'PARTIAL_WARMUP');
    });
  });
});
