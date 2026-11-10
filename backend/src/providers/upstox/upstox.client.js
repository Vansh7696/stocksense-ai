import axios from 'axios';
import tokenService from '../../services/token.service.js';
import { acquireProviderPermit, executeWithRetry } from '../../utils/rateLimiter.js';
import { redactSecrets } from '../../utils/crypto.js';
import { AppError } from '../../middleware/errorHandler.js';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
} from './upstox.constants.js';

export class UpstoxClient {
  constructor({
    timeoutMs = DEFAULT_TIMEOUT_MS,
    tokenProvider = null,
    rateLimiterFn = null,
    httpClient = null,
  } = {}) {
    this.timeoutMs = timeoutMs;
    this.tokenProvider = tokenProvider || tokenService;
    this.acquirePermit = rateLimiterFn || acquireProviderPermit;
    this.http = httpClient || axios;
  }

  /**
   * Obtain authorized headers using TokenService.
   * Throws REAUTHORIZATION_REQUIRED if token is expired, missing, or unconfigured.
   *
   * @returns {Promise<{ Accept: string, Authorization: string }>}
   */
  async getAuthHeaders() {
    const token = await this.tokenProvider.getAccessToken();

    if (!token) {
      throw new AppError(
        'Upstox access token is missing or expired at 03:30 AM IST. Re-authorization required.',
        401,
        'REAUTHORIZATION_REQUIRED',
        { provider: 'UPSTOX' }
      );
    }

    return {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    };
  }

  /**
   * Execute an authenticated GET request with rate-limiting, retries, and error mapping.
   *
   * @param {string} url - Full target URL
   * @param {Object} [options]
   * @param {'historical' | 'quote'} [options.permitType='historical']
   * @param {Object} [options.params]
   * @param {number} [options.timeout]
   * @returns {Promise<any>}
   */
  async get(url, { permitType = 'historical', params = {}, timeout = this.timeoutMs } = {}) {
    // 1. Fetch active auth headers (verifies token is present and valid before consuming rate quota)
    const headers = await this.getAuthHeaders();

    // 2. Acquire permit from atomic distributed rate limiter before outbound call
    await this.acquirePermit(permitType);

    // 3. Execute with full-jitter exponential backoff on HTTP 429
    return executeWithRetry(
      async () => {
        try {
          const response = await this.http.get(url, {
            headers,
            params,
            timeout,
          });

          // Validate provider response envelope
          if (!response || typeof response.data !== 'object') {
            throw new AppError(
              'Malformed response received from Upstox API: Expected JSON object envelope',
              502,
              'PROVIDER_RESPONSE_MALFORMED'
            );
          }

          if (response.data.status === 'error') {
            const errorObj = response.data.errors?.[0] || {};
            throw new AppError(
              errorObj.message || 'Upstox API returned error status',
              502,
              errorObj.errorCode || 'UPSTOX_API_ERROR',
              { errors: response.data.errors }
            );
          }

          return response.data;
        } catch (error) {
          // If already an AppError, rethrow directly
          if (error instanceof AppError) {
            throw error;
          }

          const status = error.response?.status;
          const responseData = error.response?.data;

          // Standardize Upstox error codes
          if (status === 401 || status === 403) {
            throw new AppError(
              'Upstox authorization failed or token expired. Re-authorization required.',
              401,
              'REAUTHORIZATION_REQUIRED',
              redactSecrets({ status, responseData })
            );
          }

          if (status === 429) {
            // Propagate for executeWithRetry to handle backoff
            const err = new Error('Upstox provider rate limit exceeded (HTTP 429)');
            err.status = 429;
            err.response = error.response;
            throw err;
          }

          if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
            throw new AppError(
              `Upstox API request timed out after ${timeout}ms`,
              504,
              'PROVIDER_TIMEOUT',
              { url, timeout }
            );
          }

          if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
            throw new AppError(
              `Network error connecting to Upstox API (${error.code})`,
              503,
              'PROVIDER_NETWORK_ERROR',
              { code: error.code }
            );
          }

          throw new AppError(
            `Upstox API request failed: ${error.message}`,
            status || 502,
            'PROVIDER_ERROR',
            redactSecrets({ status, responseData, message: error.message })
          );
        }
      },
      {
        maxAttempts: MAX_RETRY_ATTEMPTS,
        baseDelayMs: RETRY_BASE_DELAY_MS,
        maxDelayMs: RETRY_MAX_DELAY_MS,
      }
    );
  }
}

export default new UpstoxClient();
