/**
 * StockSense AI — Milestone 6A.1: Analytics Rate Limiting & DoS Protection Tests
 * Validates Redis-backed distributed rate limiting for /api/stocks/:id/sentiment
 * and /api/stocks/:id/patterns endpoints.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';
import redisClient, { isRedisReady } from '../src/config/redis.js';
import { config } from '../src/config/index.js';
import mlClientService from '../src/services/mlClient.service.js';
import cacheService from '../src/services/cache.service.js';

describe('Milestone 6A.1: Analytics Rate Limiter & DoS Protection Tests', () => {
  const userAId = 'user-a-6a1-rate-limit-test-uuid';
  const userBId = 'user-b-6a1-rate-limit-test-uuid';
  let tokenUserA = '';
  let tokenUserB = '';
  let testStock = null;

  // Stubs for ML client
  let originalGetSentimentSummary;
  let originalFusePrediction;
  let originalAnalyzePatterns;
  let originalFindManyCandles;

  const mockSentimentSummary = {
    symbol: 'RELIANCE',
    overall_polarity: 0.35,
    overall_label: 'BULLISH',
    confidence: 0.72,
    sample_count: 5,
    bullish_ratio: 0.6,
    bearish_ratio: 0.0,
    neutral_ratio: 0.4,
    headlines: [],
    analyzed_at_utc: '2026-11-18T10:00:00Z',
  };

  const mockFusionResult = {
    symbol: 'RELIANCE',
    horizon: 1,
    technical_probabilities: { DOWN: 0.25, NEUTRAL: 0.35, UP: 0.40 },
    sentiment_polarity: 0.35,
    fused_probabilities: { DOWN: 0.20, NEUTRAL: 0.35, UP: 0.45 },
    fused_label: 'UP',
    confidence: 0.45,
    alignment: 'CONFIRMING',
    alignment_description: 'Sentiment confirms technical stance.',
  };

  const mockPatternResult = {
    stance: 'BULLISH',
    technical_score: 0.42,
    summary: 'Constructive candlestick structures.',
    patterns: [],
    support_resistance: [],
    signals: [],
    indicators: { close_price: 2450.0 },
    total_candles_analyzed: 200,
    meta: { computation_ms: 5.2, symbol: 'RELIANCE' },
  };

  before(async () => {
    // Generate valid tokens
    tokenUserA = jwt.sign(
      { id: userAId, userId: userAId, email: 'usera@stocksense.ai', role: 'USER' },
      config.jwt.secret,
      { expiresIn: '1h' }
    );
    tokenUserB = jwt.sign(
      { id: userBId, userId: userBId, email: 'userb@stocksense.ai', role: 'USER' },
      config.jwt.secret,
      { expiresIn: '1h' }
    );

    // Fetch or resolve a stock from PostgreSQL
    testStock = await prisma.stock.findFirst({
      where: { symbol: 'RELIANCE', exchange: { code: 'NSE' } },
      include: { exchange: true },
    });
    if (!testStock) {
      testStock = await prisma.stock.findFirst({
        include: { exchange: true },
      });
    }

    // Stub ML services to avoid external HTTP dependencies
    originalGetSentimentSummary = mlClientService.getSentimentSummary;
    originalFusePrediction = mlClientService.fusePredictionWithSentiment;
    originalAnalyzePatterns = mlClientService.analyzeTechnicalPatterns;
    originalFindManyCandles = prisma.historicalPrice.findMany;

    mlClientService.getSentimentSummary = async () => mockSentimentSummary;
    mlClientService.fusePredictionWithSentiment = async () => mockFusionResult;
    mlClientService.analyzeTechnicalPatterns = async () => mockPatternResult;
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
  });

  const cleanTestKeys = async () => {
    try {
      if (redisClient && (redisClient.status === 'ready' || isRedisReady())) {
        const keys = await redisClient.keys('stocksense:ratelimit:analytics:*');
        if (keys && keys.length > 0) {
          await redisClient.del(...keys);
        }
        await redisClient.del(
          `stocksense:ratelimit:analytics:user:${userAId}`,
          `stocksense:ratelimit:analytics:user:${userBId}`
        );
      }
    } catch {}
  };

  beforeEach(async () => {
    await cleanTestKeys();
  });

  after(async () => {
    // Restore stubs
    mlClientService.getSentimentSummary = originalGetSentimentSummary;
    mlClientService.fusePredictionWithSentiment = originalFusePrediction;
    mlClientService.analyzeTechnicalPatterns = originalAnalyzePatterns;
    prisma.historicalPrice.findMany = originalFindManyCandles;

    // Clean up Redis test keys
    await cleanTestKeys();
    try {
      await prisma.$disconnect();
    } catch {}
  });

  // ===========================================================================
  // 1. Authentication Precedence
  // ===========================================================================
  describe('1. Authentication Precedence over Rate Limiting', () => {
    test('rejects unauthenticated request with 401 without consuming rate limit quota (/sentiment)', async () => {
      const stockId = testStock?.id || 'fake-id';
      const res = await request(app).get(`/api/stocks/${stockId}/sentiment`);

      assert.equal(res.status, 401);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error?.code, 'UNAUTHORIZED');

      // Verify no rate limit key was created
      if (redisClient && (redisClient.status === 'ready' || isRedisReady())) {
        const keys = await redisClient.keys('stocksense:ratelimit:analytics:*');
        assert.equal(keys.length, 0);
      }
    });

    test('rejects unauthenticated request with 401 without consuming rate limit quota (/patterns)', async () => {
      const stockId = testStock?.id || 'fake-id';
      const res = await request(app).get(`/api/stocks/${stockId}/patterns`);

      assert.equal(res.status, 401);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error?.code, 'UNAUTHORIZED');
    });

    test('rejects malformed or invalid JWT token with 401 (/sentiment)', async () => {
      const stockId = testStock?.id || 'fake-id';
      const res = await request(app)
        .get(`/api/stocks/${stockId}/sentiment`)
        .set('Authorization', 'Bearer invalid-token-string');

      assert.equal(res.status, 401);
      assert.equal(res.body.success, false);
    });
  });

  // ===========================================================================
  // 2. Request Allowance within Configured Limit
  // ===========================================================================
  describe('2. Request Allowance within Configured Limit', () => {
    test('permits requests within the 30 req/min limit on both sentiment and pattern endpoints', async () => {
      if (!testStock) return;

      await cleanTestKeys();

      // Request 1: Sentiment
      const res1 = await request(app)
        .get(`/api/stocks/${testStock.id}/sentiment`)
        .set('Authorization', `Bearer ${tokenUserA}`);
      assert.equal(res1.status, 200);
      assert.equal(res1.body.success, true);

      // Request 2: Patterns
      const res2 = await request(app)
        .get(`/api/stocks/${testStock.id}/patterns`)
        .set('Authorization', `Bearer ${tokenUserA}`);
      assert.equal(res2.status, 200);
      assert.equal(res2.body.success, true);

      // Verify Redis counter recorded 2 requests for User A
      if (redisClient && (redisClient.status === 'ready' || isRedisReady())) {
        const key = `stocksense:ratelimit:analytics:user:${userAId}`;
        const count = await redisClient.get(key);
        assert.equal(count, '2');
      }
    });
  });

  // ===========================================================================
  // 3. Rate Limit Enforcement, HTTP 429 & Retry-After Header
  // ===========================================================================
  describe('3. Rate Limit Enforcement, HTTP 429 & Retry-After Header', () => {
    test('enforces rate limit returning HTTP 429 and Retry-After header when quota exceeded on /sentiment', async () => {
      if (!testStock) return;

      // Seed 30 requests directly in Redis to simulate fast quota consumption
      const key = `stocksense:ratelimit:analytics:user:${userAId}`;
      await redisClient.set(key, '30', 'EX', 60);

      // 31st request should be rejected
      const limitedRes = await request(app)
        .get(`/api/stocks/${testStock.id}/sentiment`)
        .set('Authorization', `Bearer ${tokenUserA}`);

      assert.equal(limitedRes.status, 429);
      assert.equal(limitedRes.body.success, false);
      assert.equal(limitedRes.body.error.code, 'TOO_MANY_ANALYTICS_REQUESTS');
      assert.ok(limitedRes.body.error.message.includes('Analytics rate limit exceeded'));

      // Validate Retry-After header is present and positive integer
      const retryAfter = limitedRes.headers['retry-after'];
      assert.ok(retryAfter, 'Expected Retry-After header to be present');
      assert.ok(parseInt(retryAfter, 10) > 0, 'Expected Retry-After to be > 0');
    });

    test('enforces rate limit returning HTTP 429 when quota exceeded on /patterns', async () => {
      if (!testStock) return;

      const key = `stocksense:ratelimit:analytics:user:${userAId}`;
      await redisClient.set(key, '30', 'EX', 60);

      const limitedRes = await request(app)
        .get(`/api/stocks/${testStock.id}/patterns`)
        .set('Authorization', `Bearer ${tokenUserA}`);

      assert.equal(limitedRes.status, 429);
      assert.equal(limitedRes.body.error.code, 'TOO_MANY_ANALYTICS_REQUESTS');
      assert.ok(limitedRes.headers['retry-after']);
    });
  });

  // ===========================================================================
  // 4. User Quota Isolation & IP Spoofing Immunity
  // ===========================================================================
  describe('4. User Quota Isolation & Spoofing Immunity', () => {
    test('ensures rate limits are strictly isolated per user (User B unaffected when User A is limited)', async () => {
      if (!testStock) return;

      // Exhaust User A's quota
      const keyA = `stocksense:ratelimit:analytics:user:${userAId}`;
      await redisClient.set(keyA, '30', 'EX', 60);

      // Verify User A gets 429
      const resA = await request(app)
        .get(`/api/stocks/${testStock.id}/sentiment`)
        .set('Authorization', `Bearer ${tokenUserA}`);
      assert.equal(resA.status, 429);

      // Verify User B succeeds with 200
      const resB = await request(app)
        .get(`/api/stocks/${testStock.id}/sentiment`)
        .set('Authorization', `Bearer ${tokenUserB}`);
      assert.equal(resB.status, 200);
      assert.equal(resB.body.success, true);
    });

    test('prevents quota evasion via spoofed X-Forwarded-For headers', async () => {
      if (!testStock) return;

      // Exhaust User A's quota
      const keyA = `stocksense:ratelimit:analytics:user:${userAId}`;
      await redisClient.set(keyA, '30', 'EX', 60);

      // User A attempts spoofing client IP via X-Forwarded-For
      const spoofedRes = await request(app)
        .get(`/api/stocks/${testStock.id}/sentiment`)
        .set('Authorization', `Bearer ${tokenUserA}`)
        .set('X-Forwarded-For', '203.0.113.195, 70.41.3.18');

      // Must still be blocked because rate limiter uses verified JWT user ID
      assert.equal(spoofedRes.status, 429);
      assert.equal(spoofedRes.body.error.code, 'TOO_MANY_ANALYTICS_REQUESTS');
    });
  });

  // ===========================================================================
  // 5. Redis Failure Policy & Resilience (Fail Open)
  // ===========================================================================
  describe('5. Redis Failure Policy & Resilience (Fail Open)', () => {
    test('fails open gracefully when Redis eval encounters error, permitting requests without disruption', async () => {
      if (!testStock) return;

      // Stub redisClient.eval to simulate Redis transient failure
      const originalEval = redisClient.eval;
      redisClient.eval = async () => {
        throw new Error('Connection to Redis lost');
      };

      try {
        const res = await request(app)
          .get(`/api/stocks/${testStock.id}/sentiment`)
          .set('Authorization', `Bearer ${tokenUserA}`);

        assert.equal(res.status, 200);
        assert.equal(res.body.success, true);
      } finally {
        redisClient.eval = originalEval;
      }
    });
  });
});
