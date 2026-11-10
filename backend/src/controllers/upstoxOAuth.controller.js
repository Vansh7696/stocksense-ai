import defaultUpstoxOAuthService from '../services/oauth/upstoxOAuth.service.js';
import defaultOAuthStateService from '../services/oauth/oauthState.service.js';
import defaultTokenService from '../services/token.service.js';
import { config as defaultConfig } from '../config/index.js';
import { redactString } from '../utils/crypto.js';
import { AppError } from '../middleware/errorHandler.js';

export class UpstoxOAuthController {
  /**
   * @param {Object} [options]
   * @param {Object} [options.oauthService] Injected Upstox OAuth service
   * @param {Object} [options.stateService] Injected OAuth state service
   * @param {Object} [options.tokenService] Injected Token service
   * @param {Object} [options.config] Injected configuration
   */
  constructor(options = {}) {
    this.oauthService = options.oauthService || defaultUpstoxOAuthService;
    this.stateService = options.stateService || defaultOAuthStateService;
    this.tokenService = options.tokenService || defaultTokenService;
    this.config = options.config || defaultConfig;
  }

  /**
   * Applies strict HTTP caching and privacy headers to prevent credential and state leakage.
   *
   * @param {import('express').Response} res
   * @private
   */
  _applySecurityHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Referrer-Policy', 'no-referrer');
  }

  /**
   * GET /api/auth/upstox/start (and /login alias)
   * Initiates Upstox OAuth 2.0 flow: generates secure state and redirects user to Upstox authorization dialog.
   */
  start = async (req, res, next) => {
    try {
      this._applySecurityHeaders(res);
      const clientIp = req.ip || req.connection?.remoteAddress || null;
      const { authUrl, state, expiresAt } = await this.oauthService.buildAuthorizationUrl({
        ip: clientIp,
        userAgent: req.headers['user-agent'] ? req.headers['user-agent'].slice(0, 100) : null,
      });

      // If client requests JSON (e.g. API clients or SPAs managing redirect manually)
      if (req.headers.accept?.includes('application/json') || req.query.json === 'true') {
        return res.json({
          success: true,
          authUrl,
          expiresAt: expiresAt.toISOString(),
        });
      }

      // Default browser behavior: redirect to Upstox authorization dialog
      return res.redirect(authUrl);
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/auth/upstox/callback
   * Handles the authorization-code callback from Upstox.
   * Enforces atomic single-use state consumption, exchanges code for token, and encrypts token.
   */
  callback = async (req, res, next) => {
    try {
      this._applySecurityHeaders(res);

      // 1. Handle user cancellation or provider rejection
      if (req.query.error) {
        const errorDesc = req.query.error_description || req.query.error;
        const sanitized = redactString(String(errorDesc));

        if (req.headers.accept?.includes('application/json') || req.query.format === 'json') {
          return res.status(400).json({
            success: false,
            error: {
              code: 'OAUTH_PROVIDER_DENIED',
              message: `Upstox authorization was cancelled or denied: ${sanitized}`,
            },
          });
        }

        const frontendUrl = this.config.corsOrigin || 'http://localhost:5173';
        return res.redirect(`${frontendUrl}/settings?auth=error&reason=${encodeURIComponent(sanitized)}`);
      }

      // 2. Validate presence of code and state query parameters
      const { code, state } = req.query;
      if (!code || typeof code !== 'string' || !state || typeof state !== 'string') {
        throw new AppError(
          'Missing required authorization code or state parameter in Upstox callback.',
          400,
          'MISSING_OAUTH_PARAMETERS'
        );
      }

      // 3. Atomically consume the OAuth state (single-use verification against Redis)
      const stateResult = await this.stateService.consumeState(state);
      if (!stateResult.valid) {
        throw new AppError(
          'Invalid, expired, or already consumed OAuth state. Please initiate login again.',
          400,
          'INVALID_OAUTH_STATE'
        );
      }

      // 4. Exchange code for access token (single-use guarantee, no automatic retries)
      const exchangeResult = await this.oauthService.exchangeCodeForToken(code);

      // 5. Send response
      if (req.headers.accept?.includes('application/json') || req.query.format === 'json') {
        return res.json({
          success: true,
          message: 'Upstox account authenticated successfully.',
          data: {
            active: true,
            expiresAt: exchangeResult.expiresAt,
            userId: exchangeResult.userId,
            userName: exchangeResult.userName,
          },
        });
      }

      // Browser redirect to frontend settings page (strictly no codes or tokens in URL)
      const frontendUrl = this.config.corsOrigin || 'http://localhost:5173';
      return res.redirect(`${frontendUrl}/settings?auth=success`);
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/auth/upstox/status
   * Returns current token configuration and validity status without exposing raw tokens or secrets.
   */
  status = async (req, res, next) => {
    try {
      this._applySecurityHeaders(res);
      const tokenStatus = await this.tokenService.getTokenStatus();

      // Return clean, safe metadata
      return res.json({
        success: true,
        data: {
          configured: tokenStatus.configured,
          active: tokenStatus.active,
          status: tokenStatus.code,
          expiresAt: tokenStatus.expiresAt || null,
          reauthorizationRequired: !tokenStatus.active,
          source: tokenStatus.source,
          reason: tokenStatus.reason,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/auth/upstox/disconnect
   * Clears the stored encrypted token from PostgreSQL and Redis.
   * Note: This removes local credentials; Upstox tokens expire automatically at 03:30 AM IST.
   */
  disconnect = async (req, res, next) => {
    try {
      this._applySecurityHeaders(res);
      await this.tokenService.clearToken();

      return res.json({
        success: true,
        message: 'Upstox session disconnected. Local credentials and tokens cleared.',
        data: {
          configured: false,
          active: false,
          status: 'REAUTHORIZATION_REQUIRED',
          reauthorizationRequired: true,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}

export default new UpstoxOAuthController();
