import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';
import redisClient from '../src/config/redis.js';
import { config } from '../src/config/index.js';
import mlClientService from '../src/services/mlClient.service.js';
import cacheService from '../src/services/cache.service.js';

describe('Phase 5C.10: Backend Technical Pattern Recognition API Integration Tests', () => {
  const testUserId = 'a12bc34d-56ef-7890-abcd-ef1234567890';
  let validAuthToken = '';
  let relianceStock = null;

  const mockPatternResponse = {
    stance: 'BULLISH',
    technical_score: 0.385,
    summary: 'Technical setup leans bullish with constructive candlestick action.',
    patterns: [
      {
        name: 'Hammer',
        code: 'HAMMER',
        pattern_type: 'BULLISH',
        bar_index: 199,
        timestamp: '2026-07-13T10:00:00Z',
        price: 2450.5,
        confidence: 0.84,
        description: 'Bullish reversal rejection of lower prices.',
      },
      {
        name: 'Bullish Engulfing',
        code: 'BULLISH_ENGULFING',
        pattern_type: 'BULLISH',
        bar_index: 185,
        timestamp: '2026-06-25T10:00:00Z',
        price: 2410.0,
        confidence: 0.88,
        description: 'Green candle completely engulfs prior red candle.',
      },
    ],
    support_resistance: [
      {
        level_type: 'SUPPORT',
        price: 2400.0,
        touch_count: 3,
        strength: 0.85,
        distance_pct: -2.06,
        range_min: 2395.0,
        range_max: 2405.0,
      },
      {
        level_type: 'RESISTANCE',
        price: 2520.0,
        touch_count: 2,
        strength: 0.70,
        distance_pct: 2.84,
        range_min: 2515.0,
        range_max: 2525.0,
      },
    ],
    signals: [
      {
        signal_type: 'DONCHIAN_HIGH_BREAKOUT',
        label: 'Donchian 20-Day High Breakout',
        bias: 'BULLISH',
        severity: 'STRONG',
        indicator: 'Donchian Channel',
        timestamp: '2026-07-13T10:00:00Z',
        description: 'Close price cleared 20-day high channel with volume confirmation.',
      },
    ],
    indicators: {
      rsi: 61.5,
      macd_line: 12.4,
      macd_signal: 9.8,
      macd_histogram: 2.6,
      sma_20: 2420.0,
      sma_50: 2380.0,
      sma_200: 2290.0,
      donchian_high_20: 2445.0,
      donchian_low_20: 2360.0,
      atr_14: 28.5,
      rvol_20: 1.65,
      close_price: 2450.5,
    },
    total_candles_analyzed: 200,
    meta: {
      computation_ms: 12.4,
      symbol: 'RELIANCE',
    },
  };

  before(async () => {
    validAuthToken = jwt.sign(
      { id: testUserId, sub: testUserId, email: 'patterns.tester@stocksense.ai', role: 'USER' },
      config.jwt.secret,
      { expiresIn: '1h' }
    );

    try {
      relianceStock = await prisma.stock.findFirst({
        where: { symbol: 'RELIANCE', exchange: { code: 'NSE' } },
        include: { exchange: true },
      });
      if (!relianceStock) {
        relianceStock = await prisma.stock.findFirst({
          include: { exchange: true },
        });
      }
    } catch (err) {
      console.warn('PostgreSQL unavailable for pattern test setup');
    }
  });

  test('1. GET /api/stocks/:id/patterns rejects unauthenticated request with 401', async () => {
    const stockId = relianceStock?.id || 'fake-id';
    const res = await request(app).get(`/api/stocks/${stockId}/patterns`);
    assert.equal(res.status, 401);
  });

  test('2. GET /api/stocks/:id/patterns rejects invalid interval with 400', async () => {
    const stockId = relianceStock?.id || 'fake-id';
    const res = await request(app)
      .get(`/api/stocks/${stockId}/patterns?interval=INVALID`)
      .set('Authorization', `Bearer ${validAuthToken}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error?.code, 'INVALID_INTERVAL');
  });

  test('3. GET /api/stocks/:id/patterns returns technical pattern and S/R response', async (t) => {
    if (!relianceStock) {
      t.skip('Database record for stock not found');
      return;
    }

    const originalAnalyze = mlClientService.analyzeTechnicalPatterns;
    const originalFindMany = prisma.historicalPrice.findMany;

    mlClientService.analyzeTechnicalPatterns = async () => mockPatternResponse;
    prisma.historicalPrice.findMany = async () => [
      {
        timestamp: new Date('2026-07-13T10:00:00Z'),
        open: 2400.0,
        high: 2460.0,
        low: 2390.0,
        close: 2450.0,
        volume: 100000,
      },
    ];

    try {
      // Clear cache key first
      const cacheKey = cacheService.buildKey('stocks:patterns', `${relianceStock.id}:1D`);
      await cacheService.del(cacheKey);

      const res = await request(app)
        .get(`/api/stocks/${relianceStock.id}/patterns?interval=1D`)
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.data);
      assert.equal(res.body.data.stance, 'BULLISH');
      assert.equal(res.body.data.patterns.length, 2);
      assert.equal(res.body.data.support_resistance.length, 2);
      assert.equal(res.body.data.signals.length, 1);
      assert.equal(res.body.meta.cached, false);

      // Verify cached response on second call
      const res2 = await request(app)
        .get(`/api/stocks/${relianceStock.id}/patterns?interval=1D`)
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res2.status, 200);
      assert.equal(res2.body.meta.cached, true);
    } finally {
      mlClientService.analyzeTechnicalPatterns = originalAnalyze;
      prisma.historicalPrice.findMany = originalFindMany;
    }
  });

  after(async () => {
    try {
      if (redisClient && redisClient.isOpen) {
        await redisClient.quit();
      }
      await prisma.$disconnect();
    } catch (err) {
      // Cleanup silently
    }
  });
});
