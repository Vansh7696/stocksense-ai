/**
 * StockSense AI — ML Service Client
 * Node.js HTTP client interface to the Python FastAPI Machine Learning microservice.
 * Handles technical indicator computation and ML feature extraction RPCs.
 */

import axios from 'axios';
import { config } from '../config/index.js';
import { AppError } from '../middleware/errorHandler.js';
import metricsRegistry from './metrics.service.js';

export class MLServiceClient {
  /**
   * @param {Object} [options]
   * @param {string} [options.baseUrl] Base URL of the ML microservice
   * @param {Object} [options.httpClient] Injected axios instance or mock
   * @param {number} [options.timeout=5000] Request timeout in milliseconds
   */
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || config.mlService.url || 'http://localhost:8000';
    this.httpClient = options.httpClient || axios;
    this.timeout = options.timeout || 5000;
  }

  /**
   * Formats database candle records into the schema required by the ML service.
   *
   * @param {Array<Object>} candles
   * @returns {Array<Object>}
   */
  formatCandlesForML(candles) {
    if (!Array.isArray(candles)) return [];
    return candles.map((c) => ({
      timestamp: c.timestamp instanceof Date ? c.timestamp.toISOString() : String(c.timestamp),
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume.toString()),
    }));
  }

  /**
   * Invokes Python FastAPI endpoint POST /api/indicators/compute
   *
   * @param {string} symbol - Equity ticker
   * @param {Array<Object>} candles - Raw or formatted candles
   * @param {Object} [indicatorConfig] - Optional parameter overrides
   * @returns {Promise<Object>}
   */
  async computeIndicators(symbol, candles, indicatorConfig = {}, options = {}) {
    if (!candles || candles.length === 0) {
      throw new AppError('Candles array cannot be empty for indicator calculation.', 400, 'EMPTY_CANDLES');
    }

    const formatted = this.formatCandlesForML(candles);
    const url = `${this.baseUrl}/api/indicators/compute`;
    const startTime = process.hrtime.bigint();

    try {
      const response = await this.httpClient.post(
        url,
        {
          symbol: symbol || 'UNKNOWN',
          candles: formatted,
          config: indicatorConfig,
        },
        {
          timeout: this.timeout,
          headers: {
            'Content-Type': 'application/json',
            ...(options.correlationId && { 'X-Correlation-ID': options.correlationId }),
          },
        }
      );

      const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;
      metricsRegistry.recordMlCall('/api/indicators/compute', 'success', durationSeconds);
      return response.data;
    } catch (err) {
      const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;
      metricsRegistry.recordMlCall('/api/indicators/compute', 'error', durationSeconds);
      if (err.response) {
        const detail = err.response.data?.detail || err.message;
        throw new AppError(`ML service calculation error: ${detail}`, err.response.status || 500, 'ML_CALCULATION_ERROR');
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        throw new AppError(
          `Machine learning microservice is unavailable at ${this.baseUrl}.`,
          503,
          'ML_SERVICE_UNAVAILABLE'
        );
      }
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        throw new AppError(
          `Machine learning microservice timed out after ${this.timeout}ms.`,
          504,
          'ML_SERVICE_TIMEOUT'
        );
      }
      throw new AppError(`Failed to communicate with ML service: ${err.message}`, 502, 'ML_SERVICE_COMMUNICATION_ERROR');
    }
  }

  /**
   * Invokes Python FastAPI endpoint POST /api/features/engineer
   *
   * @param {string} symbol
   * @param {Array<Object>} candles
   * @param {boolean} [dropNa=false]
   * @param {Object} [indicatorConfig]
   * @returns {Promise<Object>}
   */
  async engineerFeatures(symbol, candles, dropNa = false, indicatorConfig = {}) {
    if (!candles || candles.length === 0) {
      throw new AppError('Candles array cannot be empty for feature extraction.', 400, 'EMPTY_CANDLES');
    }

    const formatted = this.formatCandlesForML(candles);
    const url = `${this.baseUrl}/api/features/engineer`;

    try {
      const response = await this.httpClient.post(
        url,
        {
          symbol: symbol || 'UNKNOWN',
          candles: formatted,
          drop_na: dropNa,
          config: indicatorConfig,
        },
        {
          timeout: this.timeout,
          headers: { 'Content-Type': 'application/json' },
        }
      );

      return response.data;
    } catch (err) {
      if (err.response) {
        const detail = err.response.data?.detail || err.message;
        throw new AppError(`ML feature extraction error: ${detail}`, err.response.status || 500, 'ML_FEATURE_ERROR');
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        throw new AppError(
          `Machine learning microservice is unavailable at ${this.baseUrl}.`,
          503,
          'ML_SERVICE_UNAVAILABLE'
        );
      }
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        throw new AppError(
          `Machine learning microservice timed out after ${this.timeout}ms.`,
          504,
          'ML_SERVICE_TIMEOUT'
        );
      }
      throw new AppError(`Failed to communicate with ML service: ${err.message}`, 502, 'ML_SERVICE_COMMUNICATION_ERROR');
    }
  }

  /**
   * Invokes Python FastAPI endpoint POST /api/predict
   *
   * @param {string} symbol - Equity ticker
   * @param {Object} [options]
   * @param {number} [options.horizon=1] - Forecast horizon (1, 3, or 5)
   * @param {Array<Object>} [options.candles] - Raw or formatted candles (>= 200 required)
   * @param {Object} [options.features] - Precomputed 23-feature dictionary
   * @param {string} [options.modelOverrideId] - Optional model_id override
   * @returns {Promise<Object>}
   */
  async predict(symbol, options = {}) {
    const horizon = options.horizon || 1;
    if (![1, 3, 5].includes(horizon)) {
      throw new AppError('Horizon must be 1, 3, or 5 trading days.', 400, 'INVALID_HORIZON');
    }

    const payload = {
      symbol: symbol || 'UNKNOWN',
      horizon,
    };

    if (options.candles && options.candles.length > 0) {
      payload.candles = this.formatCandlesForML(options.candles);
    } else if (options.features && Object.keys(options.features).length > 0) {
      payload.features = options.features;
    } else {
      throw new AppError('Either candles (>= 200) or precomputed features must be provided for inference.', 400, 'MISSING_INFERENCE_INPUT');
    }

    if (options.modelOverrideId) {
      payload.model_override_id = options.modelOverrideId;
    }

    const url = `${this.baseUrl}/api/predict`;
    const startTime = process.hrtime.bigint();

    try {
      const response = await this.httpClient.post(url, payload, {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json',
          ...(options.correlationId && { 'X-Correlation-ID': options.correlationId }),
        },
      });
      const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;
      metricsRegistry.recordMlCall('/api/predict', 'success', durationSeconds);
      return response.data;
    } catch (err) {
      const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;
      metricsRegistry.recordMlCall('/api/predict', 'error', durationSeconds);
      if (err.response) {
        const detail = err.response.data?.detail || err.message;
        throw new AppError(`ML prediction error: ${typeof detail === 'object' ? JSON.stringify(detail) : detail}`, err.response.status || 500, 'ML_PREDICTION_ERROR');
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        throw new AppError(
          `Machine learning microservice is unavailable at ${this.baseUrl}.`,
          503,
          'ML_SERVICE_UNAVAILABLE'
        );
      }
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        throw new AppError(
          `Machine learning microservice timed out after ${this.timeout}ms.`,
          504,
          'ML_SERVICE_TIMEOUT'
        );
      }
      throw new AppError(`Failed to communicate with ML service: ${err.message}`, 502, 'ML_SERVICE_COMMUNICATION_ERROR');
    }
  }

  /**
   * Invokes Python FastAPI endpoint POST /api/predict/multi-horizon
   *
   * @param {string} symbol - Equity ticker
   * @param {Object} [options]
   * @param {Array<Object>} [options.candles] - Raw or formatted candles (>= 200 required)
   * @param {Object} [options.features] - Precomputed 23-feature dictionary
   * @returns {Promise<Object>}
   */
  async predictMultiHorizon(symbol, options = {}) {
    const payload = {
      symbol: symbol || 'UNKNOWN',
    };

    if (options.candles && options.candles.length > 0) {
      payload.candles = this.formatCandlesForML(options.candles);
    } else if (options.features && Object.keys(options.features).length > 0) {
      payload.features = options.features;
    } else {
      throw new AppError('Either candles (>= 200) or precomputed features must be provided for multi-horizon inference.', 400, 'MISSING_INFERENCE_INPUT');
    }

    const url = `${this.baseUrl}/api/predict/multi-horizon`;
    const startTime = process.hrtime.bigint();

    try {
      const response = await this.httpClient.post(url, payload, {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json',
          ...(options.correlationId && { 'X-Correlation-ID': options.correlationId }),
        },
      });
      const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;
      metricsRegistry.recordMlCall('/api/predict/multi-horizon', 'success', durationSeconds);
      return response.data;
    } catch (err) {
      const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;
      metricsRegistry.recordMlCall('/api/predict/multi-horizon', 'error', durationSeconds);
      if (err.response) {
        const detail = err.response.data?.detail || err.message;
        throw new AppError(`ML multi-horizon prediction error: ${typeof detail === 'object' ? JSON.stringify(detail) : detail}`, err.response.status || 500, 'ML_PREDICTION_ERROR');
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        throw new AppError(
          `Machine learning microservice is unavailable at ${this.baseUrl}.`,
          503,
          'ML_SERVICE_UNAVAILABLE'
        );
      }
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        throw new AppError(
          `Machine learning microservice timed out after ${this.timeout}ms.`,
          504,
          'ML_SERVICE_TIMEOUT'
        );
      }
      throw new AppError(`Failed to communicate with ML service: ${err.message}`, 502, 'ML_SERVICE_COMMUNICATION_ERROR');
    }
  }

  /**
   * Invokes Python FastAPI endpoint GET /api/models/active
   *
   * @returns {Promise<Object>}
   */
  async getActiveModels() {
    const url = `${this.baseUrl}/api/models/active`;

    try {
      const response = await this.httpClient.get(url, {
        timeout: this.timeout,
      });
      return response.data;
    } catch (err) {
      if (err.response) {
        const detail = err.response.data?.detail || err.message;
        throw new AppError(`ML model registry error: ${typeof detail === 'object' ? JSON.stringify(detail) : detail}`, err.response.status || 500, 'ML_REGISTRY_ERROR');
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        throw new AppError(
          `Machine learning microservice is unavailable at ${this.baseUrl}.`,
          503,
          'ML_SERVICE_UNAVAILABLE'
        );
      }
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        throw new AppError(
          `Machine learning microservice timed out after ${this.timeout}ms.`,
          504,
          'ML_SERVICE_TIMEOUT'
        );
      }
      throw new AppError(`Failed to communicate with ML service: ${err.message}`, 502, 'ML_SERVICE_COMMUNICATION_ERROR');
    }
  }

  /**
   * Invokes Python FastAPI endpoint GET /api/sentiment/summary/{symbol}
   *
   * @param {string} symbol - Equity ticker
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  async getSentimentSummary(symbol, options = {}) {
    const encoded = encodeURIComponent(symbol.toUpperCase());
    const url = `${this.baseUrl}/api/sentiment/summary/${encoded}`;
    const headers = {};
    if (options.correlationId) {
      headers['X-Correlation-ID'] = options.correlationId;
    }

    try {
      const response = await this.httpClient.get(url, {
        headers,
        timeout: options.timeout || this.timeout,
      });
      return response.data;
    } catch (err) {
      if (err.response) {
        const detail = err.response.data?.detail || err.message;
        throw new AppError(`ML sentiment service error: ${typeof detail === 'object' ? JSON.stringify(detail) : detail}`, err.response.status || 500, 'ML_SENTIMENT_ERROR');
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        throw new AppError(`ML sentiment service is unavailable at ${this.baseUrl}.`, 503, 'ML_SERVICE_UNAVAILABLE');
      }
      throw new AppError(`Failed to communicate with ML sentiment service: ${err.message}`, 502, 'ML_SERVICE_COMMUNICATION_ERROR');
    }
  }

  /**
   * Invokes Python FastAPI endpoint POST /api/sentiment/fuse
   *
   * @param {Object} payload
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  async fusePredictionWithSentiment(payload, options = {}) {
    const url = `${this.baseUrl}/api/sentiment/fuse`;
    const headers = {};
    if (options.correlationId) {
      headers['X-Correlation-ID'] = options.correlationId;
    }

    try {
      const response = await this.httpClient.post(url, payload, {
        headers,
        timeout: options.timeout || this.timeout,
      });
      return response.data;
    } catch (err) {
      if (err.response) {
        const detail = err.response.data?.detail || err.message;
        throw new AppError(`ML fusion error: ${typeof detail === 'object' ? JSON.stringify(detail) : detail}`, err.response.status || 500, 'ML_FUSION_ERROR');
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        throw new AppError(`ML service is unavailable at ${this.baseUrl}.`, 503, 'ML_SERVICE_UNAVAILABLE');
      }
      throw new AppError(`Failed to communicate with ML fusion service: ${err.message}`, 502, 'ML_SERVICE_COMMUNICATION_ERROR');
    }
  }

  /**
   * Invokes Python FastAPI endpoint POST /api/patterns/analyze
   *
   * @param {Array<Object>} candles - Historical OHLCV candle records
   * @param {string} [symbol] - Instrument ticker
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  async analyzeTechnicalPatterns(candles, symbol = 'UNKNOWN', options = {}) {
    const formattedCandles = this.formatCandlesForML(candles);
    const url = `${this.baseUrl}/api/patterns/analyze`;
    const headers = {};
    if (options.correlationId) {
      headers['X-Correlation-ID'] = options.correlationId;
    }

    try {
      const response = await this.httpClient.post(
        url,
        {
          candles: formattedCandles,
          symbol,
        },
        {
          headers,
          timeout: options.timeout || this.timeout,
        }
      );
      return response.data;
    } catch (err) {
      if (err.response) {
        const detail = err.response.data?.detail || err.message;
        throw new AppError(
          `ML technical pattern analysis error: ${typeof detail === 'object' ? JSON.stringify(detail) : detail}`,
          err.response.status || 500,
          'ML_PATTERN_ERROR'
        );
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        throw new AppError(`ML pattern service is unavailable at ${this.baseUrl}.`, 503, 'ML_SERVICE_UNAVAILABLE');
      }
      throw new AppError(`Failed to communicate with ML pattern service: ${err.message}`, 502, 'ML_SERVICE_COMMUNICATION_ERROR');
    }
  }
}

export default new MLServiceClient();
