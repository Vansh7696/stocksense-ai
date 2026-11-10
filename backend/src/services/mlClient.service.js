/**
 * StockSense AI — ML Service Client
 * Node.js HTTP client interface to the Python FastAPI Machine Learning microservice.
 * Handles technical indicator computation and ML feature extraction RPCs.
 */

import axios from 'axios';
import { config } from '../config/index.js';
import { AppError } from '../middleware/errorHandler.js';

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
  async computeIndicators(symbol, candles, indicatorConfig = {}) {
    if (!candles || candles.length === 0) {
      throw new AppError('Candles array cannot be empty for indicator calculation.', 400, 'EMPTY_CANDLES');
    }

    const formatted = this.formatCandlesForML(candles);
    const url = `${this.baseUrl}/api/indicators/compute`;

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
          headers: { 'Content-Type': 'application/json' },
        }
      );

      return response.data;
    } catch (err) {
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
}

export default new MLServiceClient();
