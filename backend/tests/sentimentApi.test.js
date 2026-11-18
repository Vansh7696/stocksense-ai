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

describe('Phase 5C.9: Backend Market Sentiment API Integration Tests', () => {
  const testUserId = 'a12bc34d-56ef-7890-abcd-ef1234567890';
  let validAuthToken = '';
  let relianceStock = null;

  const mockSentimentSummary = {
    symbol: 'RELIANCE',
    overall_polarity: 0.425,
    overall_label: 'BULLISH',
    confidence: 0.7125,
    sample_count: 3,
    bullish_ratio: 0.6667,
    bearish_ratio: 0.0,
    neutral_ratio: 0.3333,
    headlines: [
      {
        id: 'news-0',
        title: 'Reliance Retail revenue jumps 22% in robust festive season',
        source: 'Economic Times',
        published_at: '2026-11-18T05:00:00Z',
        polarity: 0.65,
        label: 'BULLISH',
        confidence: 0.825,
        key_drivers: ['revenue', 'jump', 'robust'],
      },
      {
        id: 'news-1',
        title: 'Jio 5G subscribers cross key milestone',
        source: 'Mint',
        published_at: '2026-11-17T11:00:00Z',
        polarity: 0.45,
        label: 'BULLISH',
        confidence: 0.725,
        key_drivers: ['growth'],
      },
    ],
    analyzed_at_utc: '2026-11-18T08:00:00Z',
  };

  const mockFusionResult = {
    symbol: 'RELIANCE',
    horizon: 1,
    technical_probabilities: { DOWN: 0.20, NEUTRAL: 0.35, UP: 0.45 },
    sentiment_polarity: 0.425,
    fused_probabilities: { DOWN: 0.16, NEUTRAL: 0.32, UP: 0.52 },
    fused_label: 'UP',
    confidence: 0.52,
    alignment: 'CONFIRMING',
    alignment_description: 'Qualitative news sentiment confirms bullish forecast.',
  };

  before(async () => {
    // Generate valid JWT token
    validAuthToken = jwt.sign(
      { sub: testUserId, email: 'sentiment.tester@stocksense.ai', role: 'USER' },
      config.jwt.secret,
      { expiresIn: '1h' }
    );

    // Fetch existing test stock from database
    try {
      relianceStock = await prisma.stock.findFirst({
        where: { symbol: 'RELIANCE' },
        include: { exchange: true },
      });
    } catch (err) {
      console.warn('PostgreSQL unavailable for sentiment test setup');
    }
  });

  test('1. GET /api/stocks/:id/sentiment rejects unauthenticated request with 401', async () => {
    const stockId = relianceStock?.id || 'fake-id';
    const res = await request(app).get(`/api/stocks/${stockId}/sentiment`);
    assert.equal(res.status, 401);
  });

  test('2. GET /api/stocks/:id/sentiment returns structured sentiment and fusion data', async (t) => {
    if (!relianceStock) {
      t.skip('Database record for RELIANCE not found');
      return;
    }

    // Mock ML client responses
    const originalGetSummary = mlClientService.getSentimentSummary;
    const originalFuse = mlClientService.fusePredictionWithSentiment;

    mlClientService.getSentimentSummary = async () => mockSentimentSummary;
    mlClientService.fusePredictionWithSentiment = async () => mockFusionResult;

    try {
      // Clear any prior cache
      const cacheKey = cacheService.buildKey(
        'stocks:sentiment',
        `${relianceStock.id}:${relianceStock.exchange.code}:h1`
      );
      await cacheService.del(cacheKey);

      const res = await request(app)
        .get(`/api/stocks/${relianceStock.id}/sentiment?horizon=1`)
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.symbol, 'RELIANCE');
      assert.equal(res.body.data.overallLabel, 'BULLISH');
      assert.equal(res.body.data.overallPolarity, 0.425);
      assert.equal(res.body.data.sampleCount, 3);
      assert.equal(res.body.data.ratios.bullish, 0.6667);
      assert.equal(res.body.data.headlines.length, 2);
      assert.equal(res.body.data.fusion.alignment, 'CONFIRMING');
      assert.equal(res.body.meta.cached, false);

      // Verify second call hits Redis cache
      const resCached = await request(app)
        .get(`/api/stocks/${relianceStock.id}/sentiment?horizon=1`)
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(resCached.status, 200);
      assert.equal(resCached.body.meta.cached, true);
    } finally {
      mlClientService.getSentimentSummary = originalGetSummary;
      mlClientService.fusePredictionWithSentiment = originalFuse;
    }
  });

  test('3. GET /api/stocks/:id/sentiment handles ML service failure gracefully', async (t) => {
    if (!relianceStock) {
      t.skip('Database record for RELIANCE not found');
      return;
    }

    const originalGetSummary = mlClientService.getSentimentSummary;
    mlClientService.getSentimentSummary = async () => {
      const { AppError } = await import('../src/middleware/errorHandler.js');
      throw new AppError('Machine learning microservice is unavailable', 503, 'ML_SERVICE_UNAVAILABLE');
    };

    try {
      // Clear cache
      const cacheKey = cacheService.buildKey(
        'stocks:sentiment',
        `${relianceStock.id}:${relianceStock.exchange.code}:h3`
      );
      await cacheService.del(cacheKey);

      const res = await request(app)
        .get(`/api/stocks/${relianceStock.id}/sentiment?horizon=3`)
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'ML_SERVICE_UNAVAILABLE');
    } finally {
      mlClientService.getSentimentSummary = originalGetSummary;
    }
  });
});
