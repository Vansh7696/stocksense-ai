import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MLServiceClient } from '../src/services/mlClient.service.js';
import { AppError } from '../src/middleware/errorHandler.js';

describe('Phase 5C.5 — MLServiceClient Directional Inference Suite', () => {
  const dummyCandles = Array.from({ length: 200 }, (_, i) => ({
    timestamp: new Date(Date.UTC(2025, 0, 1 + i, 9, 15, 0)),
    open: 2500 + i * 0.5,
    high: 2510 + i * 0.5,
    low: 2490 + i * 0.5,
    close: 2505 + i * 0.5,
    volume: 100000 + i * 10,
  }));

  const dummyFeatures = {
    price_to_sma20: 0.01,
    price_to_sma50: 0.02,
    price_to_sma200: 0.05,
    price_to_ema12: 0.01,
    price_to_ema26: 0.02,
    price_to_ema50: 0.03,
    rsi_14: 55.0,
    rsi_normalized: 0.55,
    rsi_slope_5: 0.1,
    macd_hist: 0.5,
    macd_hist_normalized: 0.002,
    bb_percent_b: 0.6,
    bb_zscore: 0.5,
    bb_bandwidth: 0.04,
    atr_pct: 0.015,
    return_1d: 0.005,
    return_5d: 0.02,
    return_21d: 0.06,
    volatility_20d: 0.18,
    relative_volume_20: 1.1,
    trend_alignment: 1.0,
    ma_spread_50_200: 0.03,
    ma_spread_20_50: 0.01,
  };

  it('should successfully call predict with features', async () => {
    const mockHttpClient = {
      post: async (url, payload) => {
        assert.match(url, /\/api\/predict$/);
        assert.equal(payload.symbol, 'RELIANCE');
        assert.equal(payload.horizon, 1);
        assert.deepEqual(payload.features, dummyFeatures);
        return {
          data: {
            symbol: 'RELIANCE',
            horizon: 1,
            predicted_class: 0,
            predicted_label: 'NEUTRAL',
            probabilities: { DOWN: 0.3, NEUTRAL: 0.5, UP: 0.2 },
            confidence: 0.5,
            model_id: 'xgboost_h1_v1.0.0',
            execution_time_ms: 5.2,
          },
        };
      },
    };

    const client = new MLServiceClient({ httpClient: mockHttpClient });
    const res = await client.predict('RELIANCE', { horizon: 1, features: dummyFeatures });

    assert.equal(res.symbol, 'RELIANCE');
    assert.equal(res.predicted_label, 'NEUTRAL');
    assert.equal(res.confidence, 0.5);
    assert.equal(res.model_id, 'xgboost_h1_v1.0.0');
  });

  it('should successfully call predict with raw candles', async () => {
    const mockHttpClient = {
      post: async (url, payload) => {
        assert.match(url, /\/api\/predict$/);
        assert.equal(payload.symbol, 'TCS');
        assert.equal(payload.horizon, 3);
        assert.equal(payload.candles.length, 200);
        return {
          data: {
            symbol: 'TCS',
            horizon: 3,
            predicted_class: 1,
            predicted_label: 'UP',
            probabilities: { DOWN: 0.2, NEUTRAL: 0.3, UP: 0.5 },
            confidence: 0.5,
            model_id: 'xgboost_h3_v1.0.0',
            execution_time_ms: 12.4,
          },
        };
      },
    };

    const client = new MLServiceClient({ httpClient: mockHttpClient });
    const res = await client.predict('TCS', { horizon: 3, candles: dummyCandles });

    assert.equal(res.symbol, 'TCS');
    assert.equal(res.horizon, 3);
    assert.equal(res.predicted_label, 'UP');
  });

  it('should reject invalid horizon in predict', async () => {
    const client = new MLServiceClient();
    await assert.rejects(
      () => client.predict('RELIANCE', { horizon: 4, features: dummyFeatures }),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INVALID_HORIZON');
        assert.equal(err.statusCode, 400);
        return true;
      }
    );
  });

  it('should reject call without candles or features', async () => {
    const client = new MLServiceClient();
    await assert.rejects(
      () => client.predict('RELIANCE', { horizon: 1 }),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'MISSING_INFERENCE_INPUT');
        return true;
      }
    );
  });

  it('should successfully invoke predictMultiHorizon', async () => {
    const mockHttpClient = {
      post: async (url, payload) => {
        assert.match(url, /\/api\/predict\/multi-horizon$/);
        assert.equal(payload.symbol, 'INFY');
        assert.deepEqual(payload.features, dummyFeatures);
        return {
          data: {
            symbol: 'INFY',
            predictions: {
              1: { horizon: 1, predicted_label: 'NEUTRAL', confidence: 0.45 },
              3: { horizon: 3, predicted_label: 'NEUTRAL', confidence: 0.48 },
              5: { horizon: 5, predicted_label: 'DOWN', confidence: 0.52 },
            },
            total_execution_time_ms: 18.2,
          },
        };
      },
    };

    const client = new MLServiceClient({ httpClient: mockHttpClient });
    const res = await client.predictMultiHorizon('INFY', { features: dummyFeatures });

    assert.equal(res.symbol, 'INFY');
    assert.equal(res.predictions[1].predicted_label, 'NEUTRAL');
    assert.equal(res.predictions[5].predicted_label, 'DOWN');
  });

  it('should successfully invoke getActiveModels', async () => {
    const mockHttpClient = {
      get: async (url) => {
        assert.match(url, /\/api\/models\/active$/);
        return {
          data: {
            manifest_version: '1.0',
            active_champions: {
              1: { horizon: 1, model_id: 'xgboost_h1_v1.0.0' },
              3: { horizon: 3, model_id: 'xgboost_h3_v1.0.0' },
              5: { horizon: 5, model_id: 'random_forest_h5_v1.0.0' },
            },
          },
        };
      },
    };

    const client = new MLServiceClient({ httpClient: mockHttpClient });
    const res = await client.getActiveModels();

    assert.equal(res.manifest_version, '1.0');
    assert.equal(res.active_champions[1].model_id, 'xgboost_h1_v1.0.0');
    assert.equal(res.active_champions[5].model_id, 'random_forest_h5_v1.0.0');
  });

  it('should handle service unavailable error (ECONNREFUSED)', async () => {
    const mockHttpClient = {
      post: async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:8000');
        err.code = 'ECONNREFUSED';
        throw err;
      },
    };

    const client = new MLServiceClient({ httpClient: mockHttpClient });
    await assert.rejects(
      () => client.predict('RELIANCE', { horizon: 1, features: dummyFeatures }),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'ML_SERVICE_UNAVAILABLE');
        assert.equal(err.statusCode, 503);
        return true;
      }
    );
  });
});
