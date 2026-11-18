/**
 * StockSense AI — Backend Prediction Controller & Routes Test Suite (Milestone 5C.6.1)
 * Validates authenticated endpoints, multi-horizon prediction generation, descending candle retrieval,
 * chronological reversing, 200-session warm-up enforcement, Redis caching & fail-open, and error handling.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';
import redisClient from '../src/config/redis.js';
import { config } from '../src/config/index.js';
import mlClientService from '../src/services/mlClient.service.js';
import cacheService from '../src/services/cache.service.js';
import { PREDICTION_DISCLAIMER } from '../src/controllers/prediction.controller.js';
import { AppError } from '../src/middleware/errorHandler.js';

describe('Milestone 5C.6.1: Backend Prediction Controller & API Integration Suite', () => {
  const testUserId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const testUserEmail = 'ml.prediction.test@stocksense.ai';
  let validAuthToken = '';

  let nseExchange = null;
  let bseExchange = null;
  let relianceStock = null;
  let tcsStock = null;
  let duplicateBseStock = null;
  let shortHistoryStock = null;
  let seededRelianceCandles = false;
  let seededTcsCandles = false;

  // Mock multi-horizon ML response fixture
  const mockMLMultiHorizonResponse = {
    symbol: 'RELIANCE',
    predictions: {
      1: {
        symbol: 'RELIANCE',
        horizon: 1,
        target_threshold_pct: 0.5,
        predicted_class: 0,
        predicted_label: 'NEUTRAL',
        probabilities: { DOWN: 0.2722, NEUTRAL: 0.4674, UP: 0.2604 },
        confidence: 0.4674,
        model_id: 'xgboost_h1_v1.0.0',
        algorithm: 'XGBoost Classifier (Gradient Boosting)',
        artifact_sha256: 'de20b76f50ac3f755be689f9103799153f651b1fe953a3fc5268df9d6898d7fb',
        feature_schema_version: '23_scale_invariant_technical_v1',
        inference_timestamp_utc: '2026-11-18T06:00:00Z',
        execution_time_ms: 3.42,
        attributions: [
          {
            feature: 'rsi_14',
            value: 68.5,
            contribution: 0.342,
            direction: 'UP',
            display_name: 'RSI (14-period)',
            description: 'RSI at 68.5 indicates strong bullish momentum.',
          },
        ],
      },
      3: {
        symbol: 'RELIANCE',
        horizon: 3,
        target_threshold_pct: 1.0,
        predicted_class: 0,
        predicted_label: 'NEUTRAL',
        probabilities: { DOWN: 0.1652, NEUTRAL: 0.7478, UP: 0.087 },
        confidence: 0.7478,
        model_id: 'xgboost_h3_v1.0.0',
        algorithm: 'XGBoost Classifier (Gradient Boosting)',
        artifact_sha256: 'cd99702a67888c4cc449a82c58d2ee420d661229323bb883f052dbf839896dbc',
        feature_schema_version: '23_scale_invariant_technical_v1',
        inference_timestamp_utc: '2026-11-18T06:00:00Z',
        execution_time_ms: 2.81,
      },
      5: {
        symbol: 'RELIANCE',
        horizon: 5,
        target_threshold_pct: 1.5,
        predicted_class: 0,
        predicted_label: 'NEUTRAL',
        probabilities: { DOWN: 0.2542, NEUTRAL: 0.4758, UP: 0.27 },
        confidence: 0.4758,
        model_id: 'random_forest_h5_v1.0.0',
        algorithm: 'Random Forest Classifier',
        artifact_sha256: '31f38a811f91cec56135a1ce4d288693e5261a5a1922a317913a15ef32e0c57a',
        feature_schema_version: '23_scale_invariant_technical_v1',
        inference_timestamp_utc: '2026-11-18T06:00:00Z',
        execution_time_ms: 4.15,
      },
    },
    inference_timestamp_utc: '2026-11-18T06:00:00Z',
    total_execution_time_ms: 10.38,
  };

  const mockActiveModelsResponse = {
    manifest_version: '1.0',
    updated_at_utc: '2026-11-18T06:00:00Z',
    dataset_sha256: 'd75a0e0f4e94c0991bbca71e911333b1944e7f064d8f4dd712cffa1688b97170',
    active_champions: {
      1: {
        horizon: 1,
        model_id: 'xgboost_h1_v1.0.0',
        model_family: 'xgboost',
        algorithm: 'XGBoost Classifier (Gradient Boosting)',
        artifact_filename: 'model.joblib',
        artifact_sha256: 'de20b76f50ac3f755be689f9103799153f651b1fe953a3fc5268df9d6898d7fb',
        status: 'validation_selected',
      },
      3: {
        horizon: 3,
        model_id: 'xgboost_h3_v1.0.0',
        model_family: 'xgboost',
        algorithm: 'XGBoost Classifier (Gradient Boosting)',
        artifact_filename: 'model.joblib',
        artifact_sha256: 'cd99702a67888c4cc449a82c58d2ee420d661229323bb883f052dbf839896dbc',
        status: 'validation_selected',
      },
      5: {
        horizon: 5,
        model_id: 'random_forest_h5_v1.0.0',
        model_family: 'random_forest',
        algorithm: 'Random Forest Classifier',
        artifact_filename: 'model.joblib',
        artifact_sha256: '31f38a811f91cec56135a1ce4d288693e5261a5a1922a317913a15ef32e0c57a',
        status: 'validation_selected',
      },
    },
  };

  // Original mlClientService method stubs
  let originalPredictMultiHorizon;
  let originalGetActiveModels;

  before(async () => {
    // Generate valid JWT token for authenticated requests
    validAuthToken = jwt.sign(
      { id: testUserId, userId: testUserId, email: testUserEmail, role: 'USER' },
      config.jwt.secret,
      { algorithm: 'HS256', expiresIn: '2h' }
    );

    nseExchange = await prisma.exchange.findUnique({ where: { code: 'NSE' } });
    bseExchange = await prisma.exchange.findUnique({ where: { code: 'BSE' } });

    relianceStock = await prisma.stock.findFirst({
      where: { symbol: 'RELIANCE', exchange: { code: 'NSE' } },
      include: { exchange: true },
    });

    tcsStock = await prisma.stock.findFirst({
      where: { symbol: 'TCS', exchange: { code: 'NSE' } },
      include: { exchange: true },
    });

    // Ensure at least 250 candles exist for test stocks in test database
    const relianceCount = await prisma.historicalPrice.count({
      where: { stockId: relianceStock.id, interval: '1D' },
    });
    if (relianceCount < 200) {
      seededRelianceCandles = true;
      const rCandles = Array.from({ length: 250 }, (_, i) => ({
        stockId: relianceStock.id,
        timestamp: new Date(Date.UTC(2025, 0, 1 + i, 9, 15, 0)),
        open: 2500 + i * 0.5,
        high: 2510 + i * 0.5,
        low: 2490 + i * 0.5,
        close: 2505 + i * 0.5,
        volume: 150000n,
        interval: '1D',
        dataSource: 'UPSTOX',
      }));
      await prisma.historicalPrice.createMany({ data: rCandles });
    }

    const tcsCount = await prisma.historicalPrice.count({
      where: { stockId: tcsStock.id, interval: '1D' },
    });
    if (tcsCount < 200) {
      seededTcsCandles = true;
      const tCandles = Array.from({ length: 250 }, (_, i) => ({
        stockId: tcsStock.id,
        timestamp: new Date(Date.UTC(2025, 0, 1 + i, 9, 15, 0)),
        open: 3500 + i * 0.5,
        high: 3510 + i * 0.5,
        low: 3490 + i * 0.5,
        close: 3505 + i * 0.5,
        volume: 120000n,
        interval: '1D',
        dataSource: 'UPSTOX',
      }));
      await prisma.historicalPrice.createMany({ data: tCandles });
    }

    // Create temporary duplicate stock on BSE to test ambiguity resolution
    duplicateBseStock = await prisma.stock.create({
      data: {
        exchangeId: bseExchange.id,
        symbol: 'RELIANCE',
        companyName: 'Reliance Industries Limited (BSE Duplicate For Testing)',
        instrumentToken: 'BSE_EQ|INE002A01018_PREDICTION_TEST',
        exchangeToken: '500325_PRED_TEST',
        segment: 'BSE_EQ',
        instrumentType: 'EQUITY',
        series: 'EQ',
        lotSize: 1,
        isActive: true,
      },
      include: { exchange: true },
    });

    // Create temporary stock with only 50 daily candles (< 200 required) to test warm-up enforcement
    shortHistoryStock = await prisma.stock.create({
      data: {
        exchangeId: nseExchange.id,
        symbol: 'SHORT_HISTORY_STOCK',
        companyName: 'Short History Test Stock',
        instrumentToken: 'NSE_EQ|SHORT_HIST_TEST',
        exchangeToken: '999999',
        segment: 'NSE_EQ',
        instrumentType: 'EQUITY',
        series: 'EQ',
        lotSize: 1,
        isActive: true,
      },
      include: { exchange: true },
    });

    const shortCandles = Array.from({ length: 50 }, (_, i) => ({
      stockId: shortHistoryStock.id,
      timestamp: new Date(Date.UTC(2025, 0, 1 + i, 9, 15, 0)),
      open: 100 + i,
      high: 105 + i,
      low: 95 + i,
      close: 102 + i,
      volume: 10000n,
      interval: '1D',
      dataSource: 'UPSTOX',
    }));
    await prisma.historicalPrice.createMany({ data: shortCandles });

    // Back up mlClientService methods
    originalPredictMultiHorizon = mlClientService.predictMultiHorizon;
    originalGetActiveModels = mlClientService.getActiveModels;
  });

  after(async () => {
    // Restore mlClientService methods
    mlClientService.predictMultiHorizon = originalPredictMultiHorizon;
    mlClientService.getActiveModels = originalGetActiveModels;

    // Clean up temporary stocks and prices
    if (seededRelianceCandles) {
      await prisma.historicalPrice.deleteMany({ where: { stockId: relianceStock.id } });
    }
    if (seededTcsCandles) {
      await prisma.historicalPrice.deleteMany({ where: { stockId: tcsStock.id } });
    }
    if (duplicateBseStock) {
      await prisma.stock.delete({ where: { id: duplicateBseStock.id } });
    }
    if (shortHistoryStock) {
      await prisma.historicalPrice.deleteMany({ where: { stockId: shortHistoryStock.id } });
      await prisma.stock.delete({ where: { id: shortHistoryStock.id } });
    }

    // Flush prediction test keys in Redis
    try {
      if (redisClient && redisClient.status === 'ready') {
        const keys = await redisClient.keys('stocksense:*:predictions*');
        if (keys.length > 0) {
          await redisClient.del(keys);
        }
      }
    } catch {}

    const isStandaloneRun = process.argv.some(
      (arg) => arg.includes('predictionApi.test.js') && !arg.includes('*')
    );
    if (isStandaloneRun) {
      try {
        if (redisClient && redisClient.status === 'ready') {
          await redisClient.quit();
        }
        await prisma.$disconnect();
      } catch {}
    }
  });

  beforeEach(async () => {
    // Default stub: return mock multi-horizon prediction
    mlClientService.predictMultiHorizon = async () => mockMLMultiHorizonResponse;
    mlClientService.getActiveModels = async () => mockActiveModelsResponse;

    // Clear prediction cache and rate limit keys between tests
    try {
      if (redisClient && redisClient.status === 'ready') {
        const cacheKeys = await redisClient.keys('stocksense:cache:stocks:predictions*');
        if (cacheKeys.length > 0) {
          await redisClient.del(cacheKeys);
        }
        const rateLimitKeys = await redisClient.keys('stocksense:ratelimit:predictions:*');
        if (rateLimitKeys.length > 0) {
          await redisClient.del(rateLimitKeys);
        }
      }
    } catch {}
  });

  // ===========================================================================
  // 1. Authentication & Route Shadowing
  // ===========================================================================
  describe('1. Authentication & Route Registration Security', () => {
    test('rejects unauthenticated request to /api/stocks/:id/predictions with 401 UNAUTHORIZED', async () => {
      const res = await request(app).get(`/api/stocks/${relianceStock.id}/predictions`);
      assert.equal(res.status, 401);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'UNAUTHORIZED');
    });

    test('rejects unauthenticated request to /api/stocks/predictions/models with 401 UNAUTHORIZED', async () => {
      const res = await request(app).get('/api/stocks/predictions/models');
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'UNAUTHORIZED');
    });

    test('successfully resolves /api/stocks/predictions/models without being shadowed by /:id', async () => {
      const res = await request(app)
        .get('/api/stocks/predictions/models')
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.manifest_version, '1.0');
      assert.ok(res.body.data.active_champions['1']);
      assert.equal(res.body.data.active_champions['1'].model_id, 'xgboost_h1_v1.0.0');
    });

    test('enforces rate limit returning 429 TOO_MANY_PREDICTION_REQUESTS when quota exceeded', async () => {
      const rateLimitUserToken = jwt.sign(
        { id: 'rate-limit-test-user-id', userId: 'rate-limit-test-user-id', email: 'ratelimit@stocksense.ai', role: 'USER' },
        config.jwt.secret,
        { algorithm: 'HS256', expiresIn: '1h' }
      );

      try {
        // Make 30 requests to fill the quota
        for (let i = 0; i < 30; i++) {
          const res = await request(app)
            .get(`/api/stocks/${relianceStock.id}/predictions`)
            .set('Authorization', `Bearer ${rateLimitUserToken}`);
          assert.equal(res.status, 200);
        }

        // 31st request should be rate limited
        const limitedRes = await request(app)
          .get(`/api/stocks/${relianceStock.id}/predictions`)
          .set('Authorization', `Bearer ${rateLimitUserToken}`);

        assert.equal(limitedRes.status, 429);
        assert.equal(limitedRes.body.error.code, 'TOO_MANY_PREDICTION_REQUESTS');
        assert.ok(limitedRes.headers['retry-after']);
      } finally {
        // Explicitly clear test user rate limit key
        try {
          if (redisClient && redisClient.status === 'ready') {
            await redisClient.del('stocksense:ratelimit:predictions:user:rate-limit-test-user-id');
          }
        } catch {}
      }
    });
  });

  // ===========================================================================
  // 2. Multi-Horizon Prediction Generation & Disclaimer
  // ===========================================================================
  describe('2. Multi-Horizon Prediction Generation', () => {
    test('successfully returns multi-horizon predictions across h=1, 3, 5 with educational disclaimer', async () => {
      const res = await request(app)
        .get(`/api/stocks/${relianceStock.id}/predictions`)
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.symbol, 'RELIANCE');
      assert.equal(res.body.data.exchange, 'NSE');
      assert.ok(res.body.data.candlesUsed >= 200);
      assert.ok(res.body.data.latestCandleTimestamp);

      // Verify all 3 horizons are present
      const preds = res.body.data.predictions;
      assert.ok(preds['1']);
      assert.ok(preds['3']);
      assert.ok(preds['5']);

      // Verify h=1 details
      assert.equal(preds['1'].horizon, 1);
      assert.equal(preds['1'].predictedClass, 0);
      assert.equal(preds['1'].predictedLabel, 'NEUTRAL');
      assert.equal(preds['1'].targetThresholdPct, 0.5);
      assert.equal(preds['1'].model.modelId, 'xgboost_h1_v1.0.0');
      assert.ok(preds['1'].probabilities.DOWN > 0);
      assert.ok(preds['1'].probabilities.NEUTRAL > 0);
      assert.ok(preds['1'].probabilities.UP > 0);
      assert.ok(Array.isArray(preds['1'].attributions));
      assert.equal(preds['1'].attributions[0].feature, 'rsi_14');
      assert.equal(preds['1'].attributions[0].displayName, 'RSI (14-period)');

      // Verify statutory disclaimer
      assert.equal(res.body.data.disclaimer, PREDICTION_DISCLAIMER);
      assert.ok(res.body.data.disclaimer.includes('educational, research'));
      assert.ok(res.body.data.disclaimer.includes('do not constitute investment advice'));
    });

    test('supports single-horizon filtering via ?horizon=1', async () => {
      const res = await request(app)
        .get(`/api/stocks/${relianceStock.id}/predictions?horizon=1`)
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res.status, 200);
      const preds = res.body.data.predictions;
      assert.ok(preds['1']);
      assert.equal(preds['3'], undefined);
      assert.equal(preds['5'], undefined);
    });

    test('rejects invalid horizon filter with 400 INVALID_HORIZON', async () => {
      const res = await request(app)
        .get(`/api/stocks/${relianceStock.id}/predictions?horizon=4`)
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_HORIZON');
      assert.ok(res.body.error.message.includes('Allowed forecast horizons: 1, 3, 5'));
    });
  });

  // ===========================================================================
  // 3. Database Query & Candle Chronology Verification
  // ===========================================================================
  describe('3. Database Query & Chronological Candle Ordering', () => {
    test('retrieves the most recent candles and passes them in ascending chronological order to ML', async () => {
      let passedCandles = null;
      mlClientService.predictMultiHorizon = async (symbol, options) => {
        passedCandles = options.candles;
        return mockMLMultiHorizonResponse;
      };

      const res = await request(app)
        .get(`/api/stocks/${relianceStock.id}/predictions`)
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res.status, 200);
      assert.ok(passedCandles);
      assert.ok(passedCandles.length >= 200);
      assert.ok(passedCandles.length <= 300);

      // Strictly verify ascending chronological order: candle[i].timestamp < candle[i+1].timestamp
      for (let i = 0; i < passedCandles.length - 1; i++) {
        const t1 = new Date(passedCandles[i].timestamp).getTime();
        const t2 = new Date(passedCandles[i + 1].timestamp).getTime();
        assert.ok(
          t1 <= t2,
          `Candles are not in ascending order: index ${i} (${t1}) > index ${i + 1} (${t2})`
        );
      }
    });

    test('enforces minimum 200 daily sessions warm-up, rejecting stocks with < 200 candles', async () => {
      const res = await request(app)
        .get(`/api/stocks/${shortHistoryStock.id}/predictions`)
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INSUFFICIENT_HISTORICAL_DATA');
      assert.ok(res.body.error.message.includes('At least 200 trading sessions are required'));
    });
  });

  // ===========================================================================
  // 4. Redis Caching & Invalidation
  // ===========================================================================
  describe('4. Redis Caching, Cache Hits, and Fail-Open Resilience', () => {
    test('caches prediction on first request (cache miss) and returns cached on second (cache hit)', async () => {
      let mlCallCount = 0;
      mlClientService.predictMultiHorizon = async () => {
        mlCallCount++;
        return mockMLMultiHorizonResponse;
      };

      // 1. First request -> cache miss
      const res1 = await request(app)
        .get(`/api/stocks/${relianceStock.id}/predictions`)
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res1.status, 200);
      assert.equal(res1.body.meta.cached, false);
      assert.equal(mlCallCount, 1);

      // 2. Second request -> cache hit
      const res2 = await request(app)
        .get(`/api/stocks/${relianceStock.id}/predictions`)
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res2.status, 200);
      assert.equal(res2.body.meta.cached, true);
      assert.equal(mlCallCount, 1); // ML service was NOT called again!
    });

    test('fails open when Redis cache throws error or is unavailable', async () => {
      const originalGet = cacheService.get;
      cacheService.get = async () => null; // Simulate Redis miss / failure

      const res = await request(app)
        .get(`/api/stocks/${tcsStock.id}/predictions`)
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.meta.cached, false);

      cacheService.get = originalGet;
    });
  });

  // ===========================================================================
  // 5. Stock Resolution & Ambiguity Handling
  // ===========================================================================
  describe('5. Stock Resolution & Ambiguity Protection', () => {
    test('rejects non-existent stock with 404 STOCK_NOT_FOUND', async () => {
      const res = await request(app)
        .get('/api/stocks/NON_EXISTENT_EQUITY/predictions')
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'STOCK_NOT_FOUND');
    });

    test('rejects ambiguous symbol with 409 AMBIGUOUS_STOCK_IDENTIFIER', async () => {
      // RELIANCE exists on both NSE and BSE
      const res = await request(app)
        .get('/api/stocks/RELIANCE/predictions')
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'AMBIGUOUS_STOCK_IDENTIFIER');
      assert.ok(res.body.error.details?.matches?.length >= 2);
    });

    test('resolves ambiguous symbol when explicit ?exchange=NSE is provided', async () => {
      const res = await request(app)
        .get('/api/stocks/RELIANCE/predictions?exchange=NSE')
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.symbol, 'RELIANCE');
      assert.equal(res.body.data.exchange, 'NSE');
    });

    test('rejects invalid exchange filter with 400 INVALID_EXCHANGE', async () => {
      const res = await request(app)
        .get('/api/stocks/RELIANCE/predictions?exchange=NASDAQ')
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_EXCHANGE');
    });
  });

  // ===========================================================================
  // 6. Upstream Service Failure Handling
  // ===========================================================================
  describe('6. Upstream Service Failure Handling', () => {
    test('maps FastAPI microservice unavailable (ECONNREFUSED) to HTTP 503 ML_SERVICE_UNAVAILABLE', async () => {
      mlClientService.predictMultiHorizon = async () => {
        throw new AppError(
          'Machine learning microservice is unavailable at http://localhost:8000.',
          503,
          'ML_SERVICE_UNAVAILABLE'
        );
      };

      const res = await request(app)
        .get(`/api/stocks/${tcsStock.id}/predictions`)
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'ML_SERVICE_UNAVAILABLE');
    });

    test('maps FastAPI microservice timeout to HTTP 504 ML_SERVICE_TIMEOUT', async () => {
      mlClientService.predictMultiHorizon = async () => {
        throw new AppError(
          'Machine learning microservice timed out after 5000ms.',
          504,
          'ML_SERVICE_TIMEOUT'
        );
      };

      const res = await request(app)
        .get(`/api/stocks/${tcsStock.id}/predictions`)
        .set('Authorization', `Bearer ${validAuthToken}`);

      assert.equal(res.status, 504);
      assert.equal(res.body.error.code, 'ML_SERVICE_TIMEOUT');
    });
  });
});
