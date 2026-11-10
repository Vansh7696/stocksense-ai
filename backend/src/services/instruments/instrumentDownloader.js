import axios from 'axios';
import { config } from '../../config/index.js';
import { AppError } from '../../middleware/errorHandler.js';

export const DEFAULT_INSTRUMENTS_URL =
  'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz';

/**
 * Calculates exponential backoff with full jitter.
 * delay = random(0, min(baseDelay * 2^attempt, maxDelay))
 *
 * @param {number} attempt - Current attempt (1-based)
 * @param {number} [baseDelay=1000]
 * @param {number} [maxDelay=10000]
 * @returns {number} Delay in milliseconds
 */
export function calculateJitterDelay(attempt, baseDelay = 1000, maxDelay = 10000) {
  const exponential = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
  return Math.floor(Math.random() * exponential);
}

export class InstrumentDownloader {
  /**
   * @param {Object} [options]
   * @param {string} [options.url] Custom instrument master download URL
   * @param {Object} [options.httpClient] Injected HTTP client (e.g. axios)
   * @param {number} [options.maxRetries=3] Number of retry attempts on network error
   * @param {number} [options.timeout=60000] Timeout in milliseconds
   */
  constructor(options = {}) {
    this.url = options.url || config?.upstox?.instrumentsUrl || DEFAULT_INSTRUMENTS_URL;
    this.httpClient = options.httpClient || axios;
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : 3;
    this.timeout = options.timeout || 60000;
  }

  /**
   * Downloads the compressed (.json.gz) instrument master file.
   * Employs exponential backoff with full jitter on transient network failures.
   *
   * @param {string} [overrideUrl] Optional URL override
   * @returns {Promise<Buffer>} Compressed file bytes as Buffer
   */
  async download(overrideUrl) {
    const targetUrl = overrideUrl || this.url;
    let attempt = 0;
    let lastError = null;

    while (attempt <= this.maxRetries) {
      attempt++;
      try {
        const response = await this.httpClient.get(targetUrl, {
          responseType: 'arraybuffer',
          timeout: this.timeout,
          headers: {
            'Accept-Encoding': 'gzip',
            'User-Agent': 'StockSense-AI/1.0.0',
          },
        });

        if (!response.data || response.data.length === 0) {
          throw new AppError(
            'Downloaded instrument master file is empty (0 bytes).',
            502,
            'EMPTY_FILE'
          );
        }

        return Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
      } catch (err) {
        lastError = err;

        if (err.code === 'EMPTY_FILE') {
          throw err;
        }

        // Never retry if server responded with 404 Not Found or 403 Forbidden
        if (err.response && (err.response.status === 404 || err.response.status === 403)) {
          throw new AppError(
            `Failed to download instrument master from ${targetUrl}: HTTP ${err.response.status}`,
            err.response.status,
            'DOWNLOAD_FAILED'
          );
        }

        if (attempt <= this.maxRetries) {
          const delay = calculateJitterDelay(attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new AppError(
      `Instrument master download failed after ${this.maxRetries} retries: ${lastError?.message}`,
      502,
      'DOWNLOAD_FAILED',
      { originalError: lastError?.message }
    );
  }
}

export default new InstrumentDownloader();
