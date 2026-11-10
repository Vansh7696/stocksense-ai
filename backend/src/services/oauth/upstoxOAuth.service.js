import axios from 'axios';
import { config as defaultConfig } from '../../config/index.js';
import defaultOAuthStateService from './oauthState.service.js';
import defaultTokenService from '../token.service.js';
import { redactSecrets } from '../../utils/crypto.js';
import { AppError } from '../../middleware/errorHandler.js';

export const UPSTOX_AUTH_DIALOG_URL = 'https://api.upstox.com/v2/login/authorization/dialog';
export const UPSTOX_TOKEN_URL = 'https://api.upstox.com/v2/login/authorization/token';

export class UpstoxOAuthService {
  /**
   * @param {Object} [options]
   * @param {Object} [options.config] Injected configuration
   * @param {Object} [options.oauthStateService] Injected OAuth state service
   * @param {Object} [options.tokenService] Injected Token service
   * @param {Object} [options.httpClient] Injected Axios/HTTP client
   */
  constructor(options = {}) {
    this.config = options.config || defaultConfig;
    this.oauthStateService = options.oauthStateService || defaultOAuthStateService;
    this.tokenService = options.tokenService || defaultTokenService;
    this.httpClient = options.httpClient || axios;
  }

  /**
   * Validate that Upstox OAuth credentials are configured.
   * Throws safe AppError if credentials are missing.
   *
   * @param {boolean} [requireSecret=true] Whether client_secret is required
   * @private
   */
  _validateOAuthConfig(requireSecret = true) {
    const env = this.config?.env !== undefined ? this.config.env : (process.env.NODE_ENV || 'development');
    const isTest = env === 'test';
    const apiKey = this.config?.upstox?.apiKey;
    const redirectUri = this.config?.upstox?.redirectUri;
    const apiSecret = this.config?.upstox?.apiSecret;

    // Production security guard: Never silently use mock credentials outside automated test suites
    if (!isTest) {
      if (apiKey === 'test_upstox_api_key' || apiSecret === 'test_upstox_api_secret') {
        throw new AppError(
          'Mock OAuth credentials are strictly prohibited outside automated test suites. Real UPSTOX_API_KEY and UPSTOX_API_SECRET required.',
          500,
          'OAUTH_CONFIG_ERROR'
        );
      }
    }

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new AppError(
        'Upstox API key (UPSTOX_API_KEY) is not configured in backend environment.',
        500,
        'OAUTH_CONFIG_ERROR'
      );
    }

    if (!redirectUri || typeof redirectUri !== 'string' || redirectUri.trim().length === 0) {
      throw new AppError(
        'Upstox redirect URI (UPSTOX_REDIRECT_URI) is not configured in backend environment.',
        500,
        'OAUTH_CONFIG_ERROR'
      );
    }

    if (requireSecret && (!apiSecret || typeof apiSecret !== 'string' || apiSecret.trim().length === 0)) {
      throw new AppError(
        'Upstox API secret (UPSTOX_API_SECRET) is not configured in backend environment.',
        500,
        'OAUTH_CONFIG_ERROR'
      );
    }
  }

  /**
   * Generates a cryptographically secure OAuth state and builds the official Upstox authorization URL.
   * Does NOT accept arbitrary frontend redirect destinations — strictly uses the server-configured UPSTOX_REDIRECT_URI.
   *
   * @param {Object} [metadata={}] Optional context stored with state
   * @returns {Promise<{ authUrl: string, state: string, expiresAt: Date }>}
   */
  async buildAuthorizationUrl(metadata = {}) {
    this._validateOAuthConfig(false);

    const { apiKey, redirectUri } = this.config.upstox;
    const { state, expiresAt } = await this.oauthStateService.createState(metadata);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: apiKey.trim(),
      redirect_uri: redirectUri.trim(),
      state: state,
    });

    const authUrl = `${UPSTOX_AUTH_DIALOG_URL}?${params.toString()}`;

    return {
      authUrl,
      state,
      expiresAt,
    };
  }

  /**
   * Exchanges a single-use authorization code for an Upstox access token.
   *
   * Strictly enforces security policies:
   * 1. NO AUTOMATIC RETRIES: Upstox authorization codes are strictly single-use. If exchange fails,
   *    retrying with the same code will fail and could trigger security throttles.
   * 2. Request body (containing client_secret and code) and raw access tokens are NEVER logged.
   * 3. Network timeouts or ambiguous failures require a fresh user authorization flow.
   * 4. Tokens are encrypted using AES-256-GCM before database or Redis persistence.
   * 5. Unnecessary personal profile information is discarded.
   *
   * @param {string} code - The single-use authorization code
   * @returns {Promise<{ success: boolean, expiresAt: string, userId?: string, userName?: string }>}
   */
  async exchangeCodeForToken(code) {
    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      throw new AppError(
        'Invalid or missing authorization code from Upstox callback.',
        400,
        'INVALID_AUTHORIZATION_CODE'
      );
    }

    this._validateOAuthConfig(true);

    const { apiKey, apiSecret, redirectUri } = this.config.upstox;

    // Body formatted strictly as application/x-www-form-urlencoded
    const formParams = new URLSearchParams({
      code: code.trim(),
      client_id: apiKey.trim(),
      client_secret: apiSecret.trim(),
      redirect_uri: redirectUri.trim(),
      grant_type: 'authorization_code',
    });

    let response;
    try {
      response = await this.httpClient.post(
        UPSTOX_TOKEN_URL,
        formParams.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          timeout: 8000, // 8-second request timeout
          // Strictly disable automatic redirects
          maxRedirects: 0,
        }
      );
    } catch (err) {
      // Single-use guarantee: Do NOT retry on any error (network timeout, 400, 401, 500)
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        throw new AppError(
          'Upstox token exchange request timed out. The authorization code cannot be reused. Please initiate a fresh login.',
          504,
          'OAUTH_TIMEOUT'
        );
      }

      const status = err.response?.status || 502;
      const responseData = err.response?.data;

      // Extract provider error message safely without exposing secrets
      let providerError = 'Upstox authorization code exchange failed.';
      if (responseData) {
        if (Array.isArray(responseData.errors) && responseData.errors[0]?.message) {
          providerError = `${responseData.errors[0].errorCode || ''}: ${responseData.errors[0].message}`.trim();
        } else if (responseData.error_description) {
          providerError = responseData.error_description;
        } else if (responseData.message) {
          providerError = responseData.message;
        }
      }

      const sanitizedError = redactSecrets(providerError);

      throw new AppError(
        `Upstox token exchange failed: ${sanitizedError}. Please initiate a fresh authorization flow.`,
        status >= 400 && status < 500 ? 400 : 502,
        'OAUTH_EXCHANGE_FAILED'
      );
    }

    const tokenData = response.data;
    if (!tokenData || !tokenData.access_token || typeof tokenData.access_token !== 'string') {
      throw new AppError(
        'Upstox response did not contain a valid access_token.',
        502,
        'INVALID_TOKEN_RESPONSE'
      );
    }

    // Persist token securely via TokenService (AES-256-GCM encryption)
    let saveResult;
    try {
      saveResult = await this.tokenService.saveAccessToken(tokenData.access_token);
    } catch (err) {
      throw new AppError(
        `Failed to securely store authenticated token: ${err.message}. Please re-authenticate.`,
        500,
        'TOKEN_STORAGE_ERROR'
      );
    }

    // Return only safe minimal information (discard sensitive personal info like email, products, etc.)
    return {
      success: true,
      expiresAt: saveResult.expiresAt,
      userId: tokenData.user_id ? String(tokenData.user_id) : undefined,
      userName: tokenData.user_name || undefined,
    };
  }
}

export default new UpstoxOAuthService();
