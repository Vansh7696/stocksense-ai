import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';
import redisClient, { isRedisReady } from '../src/config/redis.js';
import { config } from '../src/config/index.js';
import tokenService from '../src/services/token.service.js';
import oauthStateService, {
  OAuthStateService,
  ATOMIC_CONSUME_STATE_LUA,
} from '../src/services/oauth/oauthState.service.js';
import upstoxOAuthService, {
  UpstoxOAuthService,
  UPSTOX_AUTH_DIALOG_URL,
  UPSTOX_TOKEN_URL,
} from '../src/services/oauth/upstoxOAuth.service.js';
import {
  DistributedOAuthRateLimiter,
  getSafeClientIp,
} from '../src/routes/upstoxOAuth.routes.js';
import { redactString } from '../src/utils/crypto.js';

describe('Milestone 3 — Step 4: Upstox OAuth 2.0 Authentication & Token Lifecycle (upstoxOAuth.test.js)', () => {
  const mockApiKey = 'test_upstox_api_key_12345';
  const mockApiSecret = 'test_upstox_api_secret_67890';
  const mockRedirectUri = 'http://localhost:5001/api/auth/upstox/callback';
  const sampleAccessToken = 'mock_access_token_secure_oauth_upstox_token_v3';

  const testConfig = {
    ...config,
    upstox: {
      ...config.upstox,
      apiKey: mockApiKey,
      apiSecret: mockApiSecret,
      redirectUri: mockRedirectUri,
      accessToken: '', // Ensure static env override does not interfere
    },
  };

  before(async () => {
    config.upstox.apiKey = mockApiKey;
    config.upstox.apiSecret = mockApiSecret;
    config.upstox.redirectUri = mockRedirectUri;
    config.upstox.accessToken = '';
    await prisma.$queryRaw`SELECT 1`;
  });

  beforeEach(async () => {
    await tokenService.clearToken();
    if (isRedisReady() && redisClient) {
      await redisClient.del('stocksense:ratelimit:oauth:start:127.0.0.1');
      await redisClient.del('stocksense:ratelimit:oauth:start:::ffff:127.0.0.1');
      await redisClient.del('stocksense:ratelimit:oauth:start:::1');
    }
  });

  after(async () => {
    await tokenService.clearToken();
  });

  describe('1. OAuth State Service (CSRF Protection & Atomic Single-Use)', () => {
    it('should generate a 64-character hexadecimal cryptographically secure random state', async () => {
      const { state, expiresAt } = await oauthStateService.createState();

      assert.equal(typeof state, 'string');
      assert.equal(state.length, 64, 'State must be exactly 64 hex characters (32 bytes entropy)');
      assert.match(state, /^[0-9a-f]{64}$/, 'State must consist of lowercase hexadecimal characters');
      assert.ok(expiresAt instanceof Date);
      assert.ok(expiresAt.getTime() > Date.now(), 'State expiresAt must be in the future');
    });

    it('should store the SHA-256 hash of the state in Redis with 300-second TTL', async () => {
      const { state } = await oauthStateService.createState({ testContext: 'unit-test' });
      const stateHash = oauthStateService.hashState(state);

      if (isRedisReady() && redisClient) {
        const stored = await redisClient.get(`stocksense:oauth:state:${stateHash}`);
        assert.ok(stored, 'State hash must be stored in Redis');

        const ttl = await redisClient.ttl(`stocksense:oauth:state:${stateHash}`);
        assert.ok(ttl > 0 && ttl <= 300, `TTL must be between 1 and 300 seconds (was ${ttl})`);

        const parsed = JSON.parse(stored);
        assert.equal(parsed.testContext, 'unit-test');
      }
    });

    it('should atomically consume state on first call and reject replay on second call', async () => {
      const { state } = await oauthStateService.createState();

      // First consumption: MUST succeed
      const firstResult = await oauthStateService.consumeState(state);
      assert.equal(firstResult.valid, true, 'First consumption of state must be valid');
      assert.ok(firstResult.metadata, 'Must return associated metadata');

      // Second consumption (REPLAY ATTACK): MUST fail because state was atomically deleted
      const secondResult = await oauthStateService.consumeState(state);
      assert.equal(secondResult.valid, false, 'Second consumption of same state must be rejected');
      assert.equal(secondResult.reason, 'STATE_EXPIRED_OR_ALREADY_USED');
    });

    it('should reject malformed, non-hex, or mismatched states', async () => {
      const tooShort = await oauthStateService.consumeState('abc123');
      assert.equal(tooShort.valid, false);
      assert.equal(tooShort.reason, 'MALFORMED_STATE_FORMAT');

      const nonHex = await oauthStateService.consumeState('z'.repeat(64));
      assert.equal(nonHex.valid, false);
      assert.equal(nonHex.reason, 'MALFORMED_STATE_FORMAT');

      const nonExistent = await oauthStateService.consumeState('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
      assert.equal(nonExistent.valid, false);
      assert.equal(nonExistent.reason, 'STATE_EXPIRED_OR_ALREADY_USED');
    });

    it('should operate correctly with in-memory fallback when configured', async () => {
      const memService = new OAuthStateService({ allowMemoryFallback: true, redisClient: null });
      const { state } = await memService.createState({ mock: true });

      const res1 = await memService.consumeState(state);
      assert.equal(res1.valid, true);

      // Replay must fail in memory too
      const res2 = await memService.consumeState(state);
      assert.equal(res2.valid, false);
    });

    it('should fail closed with HTTP 503 (REDIS_OFFLINE) during state creation if Redis is offline', async () => {
      const offlineService = new OAuthStateService({ redisClient: null, allowMemoryFallback: false });
      await assert.rejects(
        () => offlineService.createState(),
        (err) => err.code === 'REDIS_OFFLINE' && err.statusCode === 503
      );
    });

    it('should fail closed with HTTP 503 (REDIS_OFFLINE) during state consumption if Redis is offline', async () => {
      const offlineService = new OAuthStateService({ redisClient: null, allowMemoryFallback: false });
      await assert.rejects(
        () => offlineService.consumeState('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
        (err) => err.code === 'REDIS_OFFLINE' && err.statusCode === 503
      );
    });
  });

  describe('2. Upstox OAuth Service (Authorization URL & Token Exchange)', () => {
    it('should build the official Upstox authorization URL containing client_id, redirect_uri, and state', async () => {
      const service = new UpstoxOAuthService({ config: testConfig });
      const { authUrl, state } = await service.buildAuthorizationUrl();

      assert.ok(authUrl.startsWith(UPSTOX_AUTH_DIALOG_URL));
      const parsedUrl = new URL(authUrl);

      assert.equal(parsedUrl.searchParams.get('response_type'), 'code');
      assert.equal(parsedUrl.searchParams.get('client_id'), mockApiKey);
      assert.equal(parsedUrl.searchParams.get('redirect_uri'), mockRedirectUri);
      assert.equal(parsedUrl.searchParams.get('state'), state);

      // NEVER leak client secret in authorization URL
      assert.ok(!authUrl.includes(mockApiSecret), 'Authorization URL must NEVER contain client secret');
    });

    it('should throw OAUTH_CONFIG_ERROR when API key or redirect URI is missing', async () => {
      const brokenConfig = {
        upstox: { apiKey: '', redirectUri: '' },
      };
      const service = new UpstoxOAuthService({ config: brokenConfig });

      await assert.rejects(
        () => service.buildAuthorizationUrl(),
        (err) => err.code === 'OAUTH_CONFIG_ERROR'
      );
    });

    it('should reject mock OAuth credentials outside automated test environment', async () => {
      const nonTestService = new UpstoxOAuthService({
        config: {
          env: 'production',
          upstox: {
            apiKey: 'test_upstox_api_key',
            apiSecret: 'test_upstox_api_secret',
            redirectUri: 'http://localhost:5001/api/auth/upstox/callback',
          },
        },
      });
      await assert.rejects(
        () => nonTestService.buildAuthorizationUrl(),
        (err) => err.code === 'OAUTH_CONFIG_ERROR' && err.message.includes('Mock OAuth credentials are strictly prohibited')
      );
    });

    it('should format token exchange request body as application/x-www-form-urlencoded with exact parameters', async () => {
      let capturedUrl = null;
      let capturedBody = null;
      let capturedHeaders = null;
      let callCount = 0;

      const mockHttpClient = {
        post: async (url, body, options) => {
          callCount++;
          capturedUrl = url;
          capturedBody = body;
          capturedHeaders = options.headers;
          return {
            status: 200,
            data: {
              access_token: sampleAccessToken,
              user_id: 'USER123',
              user_name: 'Test Trader',
            },
          };
        },
      };

      const service = new UpstoxOAuthService({
        config: testConfig,
        httpClient: mockHttpClient,
      });

      const sampleCode = 'single_use_auth_code_xyz123';
      const result = await service.exchangeCodeForToken(sampleCode);

      assert.equal(result.success, true);
      assert.ok(result.expiresAt);
      assert.equal(result.userId, 'USER123');
      assert.equal(result.userName, 'Test Trader');

      // Verify request details
      assert.equal(capturedUrl, UPSTOX_TOKEN_URL);
      assert.equal(capturedHeaders['Content-Type'], 'application/x-www-form-urlencoded');
      assert.equal(capturedHeaders['Accept'], 'application/json');

      const parsedParams = new URLSearchParams(capturedBody);
      assert.equal(parsedParams.get('code'), sampleCode);
      assert.equal(parsedParams.get('client_id'), mockApiKey);
      assert.equal(parsedParams.get('client_secret'), mockApiSecret);
      assert.equal(parsedParams.get('redirect_uri'), mockRedirectUri);
      assert.equal(parsedParams.get('grant_type'), 'authorization_code');

      // Verify called exactly once
      assert.equal(callCount, 1);
    });

    it('should strictly NOT retry on token exchange failure (single-use authorization code guarantee)', async () => {
      let callCount = 0;
      const mockHttpClient = {
        post: async () => {
          callCount++;
          const err = new Error('Invalid code');
          err.response = {
            status: 400,
            data: {
              status: 'error',
              errors: [{ errorCode: 'UDAPI100057', message: 'Invalid code' }],
            },
          };
          throw err;
        },
      };

      const service = new UpstoxOAuthService({
        config: testConfig,
        httpClient: mockHttpClient,
      });

      await assert.rejects(
        () => service.exchangeCodeForToken('expired_or_invalid_code'),
        (err) => {
          assert.equal(err.code, 'OAUTH_EXCHANGE_FAILED');
          assert.equal(err.statusCode, 400);
          assert.ok(err.message.includes('UDAPI100057: Invalid code'));
          return true;
        }
      );

      // MUST NOT retry: call count must be strictly 1
      assert.equal(callCount, 1, 'Token exchange MUST NOT retry single-use authorization code');
    });

    it('should map network timeout (ECONNABORTED) to OAUTH_TIMEOUT (504) without retrying', async () => {
      let callCount = 0;
      const mockHttpClient = {
        post: async () => {
          callCount++;
          const err = new Error('timeout of 8000ms exceeded');
          err.code = 'ECONNABORTED';
          throw err;
        },
      };

      const service = new UpstoxOAuthService({
        config: testConfig,
        httpClient: mockHttpClient,
      });

      await assert.rejects(
        () => service.exchangeCodeForToken('sample_code'),
        (err) => {
          assert.equal(err.code, 'OAUTH_TIMEOUT');
          assert.equal(err.statusCode, 504);
          assert.ok(err.message.includes('authorization code cannot be reused'));
          return true;
        }
      );

      assert.equal(callCount, 1, 'Timeout must NOT trigger retries');
    });

    it('should encrypt and persist token in PostgreSQL system_configs upon successful exchange', async () => {
      const mockHttpClient = {
        post: async () => ({
          status: 200,
          data: {
            access_token: sampleAccessToken,
            user_id: 'USER999',
          },
        }),
      };

      const service = new UpstoxOAuthService({
        config: testConfig,
        httpClient: mockHttpClient,
      });

      await service.exchangeCodeForToken('valid_code_persist_test');

      // Verify token can now be decrypted by TokenService
      const decrypted = await tokenService.getAccessToken();
      assert.equal(decrypted, sampleAccessToken);

      // Verify database contains ONLY ciphertext, never plaintext
      const record = await prisma.systemConfig.findUnique({
        where: { key: 'UPSTOX_AUTH_TOKEN_ENCRYPTED' },
      });
      assert.ok(record);
      assert.ok(!record.value.includes(sampleAccessToken), 'Database must NOT store plaintext token');
    });

    it('should fail safely with TOKEN_STORAGE_ERROR if database storage fails after exchange', async () => {
      const mockTokenService = {
        saveAccessToken: async () => {
          throw new Error('Database connection lost');
        },
      };

      const mockHttpClient = {
        post: async () => ({
          status: 200,
          data: { access_token: sampleAccessToken },
        }),
      };

      const service = new UpstoxOAuthService({
        config: testConfig,
        httpClient: mockHttpClient,
        tokenService: mockTokenService,
      });

      await assert.rejects(
        () => service.exchangeCodeForToken('code_storage_fail_test'),
        (err) => {
          assert.equal(err.code, 'TOKEN_STORAGE_ERROR');
          assert.equal(err.statusCode, 500);
          return true;
        }
      );
    });
  });

  describe('3. Express OAuth Controller & Endpoints (/api/auth/upstox)', () => {
    it('GET /api/auth/upstox/start should redirect browser to official Upstox authorization dialog', async () => {
      const res = await request(app).get('/api/auth/upstox/start');

      assert.equal(res.status, 302, 'Should respond with HTTP 302 Found redirect');
      const location = res.headers.location;
      assert.ok(location.startsWith(UPSTOX_AUTH_DIALOG_URL));
      assert.ok(location.includes('response_type=code'));
      assert.ok(location.includes('state='));
    });

    it('GET /api/auth/upstox/login alias should redirect browser identically to /start', async () => {
      const res = await request(app).get('/api/auth/upstox/login');

      assert.equal(res.status, 302);
      assert.ok(res.headers.location.startsWith(UPSTOX_AUTH_DIALOG_URL));
    });

    it('GET /api/auth/upstox/start with Accept: application/json should return JSON with authUrl', async () => {
      const res = await request(app)
        .get('/api/auth/upstox/start')
        .set('Accept', 'application/json');

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.authUrl.startsWith(UPSTOX_AUTH_DIALOG_URL));
      assert.ok(res.body.expiresAt);
    });

    it('GET /api/auth/upstox/callback should reject missing code or state parameters with 400', async () => {
      const resMissingBoth = await request(app)
        .get('/api/auth/upstox/callback')
        .set('Accept', 'application/json');

      assert.equal(resMissingBoth.status, 400);
      assert.equal(resMissingBoth.body.error.code, 'MISSING_OAUTH_PARAMETERS');

      const resMissingState = await request(app)
        .get('/api/auth/upstox/callback?code=some_code')
        .set('Accept', 'application/json');

      assert.equal(resMissingState.status, 400);
      assert.equal(resMissingState.body.error.code, 'MISSING_OAUTH_PARAMETERS');
    });

    it('GET /api/auth/upstox/callback should reject invalid or forged state parameter with 400', async () => {
      const forgedState = 'a'.repeat(64);
      const res = await request(app)
        .get(`/api/auth/upstox/callback?code=some_code&state=${forgedState}`)
        .set('Accept', 'application/json');

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_OAUTH_STATE');
      assert.ok(res.body.error.message.includes('Invalid, expired, or already consumed OAuth state'));
    });

    it('GET /api/auth/upstox/callback should handle provider cancellation/error query params safely', async () => {
      const res = await request(app)
        .get('/api/auth/upstox/callback?error=access_denied&error_description=User%20denied%20access')
        .set('Accept', 'application/json');

      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'OAUTH_PROVIDER_DENIED');
      assert.ok(res.body.error.message.includes('User denied access'));
    });

    it('GET /api/auth/upstox/callback end-to-end: state consumption + code exchange', async () => {
      // 1. Generate real state via service
      const { state } = await oauthStateService.createState();

      // 2. Mock httpClient in upstoxOAuthService singleton for the exchange step
      const originalHttpClient = upstoxOAuthService.httpClient;
      upstoxOAuthService.httpClient = {
        post: async () => ({
          status: 200,
          data: {
            access_token: 'live_test_access_token_v3_success',
            user_id: 'USER_MOCK_1',
            user_name: 'Simulated User',
          },
        }),
      };

      try {
        const res = await request(app)
          .get(`/api/auth/upstox/callback?code=valid_test_code&state=${state}`)
          .set('Accept', 'application/json');

        assert.equal(res.status, 200);
        assert.equal(res.body.success, true);
        assert.equal(res.body.data.active, true);
        assert.equal(res.body.data.userId, 'USER_MOCK_1');

        // Confirm token is now active and decrypted in TokenService
        const activeToken = await tokenService.getAccessToken();
        assert.equal(activeToken, 'live_test_access_token_v3_success');

        // 3. Replay with same state MUST fail with INVALID_OAUTH_STATE
        const replayRes = await request(app)
          .get(`/api/auth/upstox/callback?code=valid_test_code&state=${state}`)
          .set('Accept', 'application/json');

        assert.equal(replayRes.status, 400);
        assert.equal(replayRes.body.error.code, 'INVALID_OAUTH_STATE');
      } finally {
        upstoxOAuthService.httpClient = originalHttpClient;
      }
    });

    it('GET /api/auth/upstox/status should return safe status without exposing secrets or tokens', async () => {
      // Status before login
      const resUnauth = await request(app).get('/api/auth/upstox/status');
      assert.equal(resUnauth.status, 200);
      assert.equal(resUnauth.body.data.configured, false);
      assert.equal(resUnauth.body.data.active, false);
      assert.equal(resUnauth.body.data.reauthorizationRequired, true);

      // Save a valid token
      await tokenService.saveAccessToken(sampleAccessToken);

      const resAuth = await request(app).get('/api/auth/upstox/status');
      assert.equal(resAuth.status, 200);
      assert.equal(resAuth.body.data.configured, true);
      assert.equal(resAuth.body.data.active, true);
      assert.equal(resAuth.body.data.status, 'ACTIVE');
      assert.equal(resAuth.body.data.reauthorizationRequired, false);

      // Strictly verify no secret information is returned
      assert.equal(resAuth.body.data.token, undefined);
      assert.equal(resAuth.body.data.accessToken, undefined);
      assert.equal(resAuth.body.data.ciphertext, undefined);
      assert.equal(resAuth.body.data.iv, undefined);
      assert.equal(resAuth.body.data.authTag, undefined);

      const bodyStr = JSON.stringify(resAuth.body);
      assert.ok(!bodyStr.includes(sampleAccessToken), 'Status response must NEVER return raw token');
      assert.ok(!bodyStr.includes('"ciphertext":'), 'Status response must not expose ciphertext');
      assert.ok(!bodyStr.includes('"iv":'), 'Status response must not expose iv');
      assert.ok(!bodyStr.includes('"authTag":'), 'Status response must not expose authTag');
    });

    it('POST /api/auth/upstox/disconnect should reject unauthenticated requests with HTTP 401 (UNAUTHORIZED) and NOT disconnect', async () => {
      await tokenService.saveAccessToken(sampleAccessToken);
      assert.ok(await tokenService.getAccessToken());

      // Attempt disconnect without Authorization header
      const res = await request(app).post('/api/auth/upstox/disconnect');
      assert.equal(res.status, 401);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'UNAUTHORIZED');
      assert.ok(res.body.error.message.includes('Authentication required'));

      // Verify token in database and Redis is STILL active and NOT cleared
      const storedToken = await tokenService.getAccessToken();
      assert.equal(storedToken, sampleAccessToken, 'Token must NOT be cleared by unauthorized request');
    });

    it('POST /api/auth/upstox/disconnect should reject requests with invalid/forged Bearer token with HTTP 401 (INVALID_TOKEN) and NOT disconnect', async () => {
      await tokenService.saveAccessToken(sampleAccessToken);

      // Attempt disconnect with forged/garbage token
      const res = await request(app)
        .post('/api/auth/upstox/disconnect')
        .set('Authorization', 'Bearer forged_tampered_token_xyz_123');

      assert.equal(res.status, 401);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'INVALID_TOKEN');

      // Verify token is still untouched
      const storedToken = await tokenService.getAccessToken();
      assert.equal(storedToken, sampleAccessToken);
    });

    it('POST /api/auth/upstox/disconnect should succeed for authorized requests with valid JWT, clear credentials, and NEVER return sensitive data', async () => {
      await tokenService.saveAccessToken(sampleAccessToken);
      assert.ok(await tokenService.getAccessToken());

      // Generate authentic JWT signed with backend jwt.secret
      const validJwt = jwt.sign(
        { userId: 'admin_test_user_id', role: 'ADMIN', email: 'admin@stocksense.ai' },
        config.jwt.secret,
        { expiresIn: '1h' }
      );

      const res = await request(app)
        .post('/api/auth/upstox/disconnect')
        .set('Authorization', `Bearer ${validJwt}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.active, false);
      assert.equal(res.body.data.reauthorizationRequired, true);
      assert.equal(res.body.data.status, 'REAUTHORIZATION_REQUIRED');

      // Verify token is deleted from memory and database
      const afterToken = await tokenService.getAccessToken();
      assert.equal(afterToken, null);

      const dbRecord = await prisma.systemConfig.findUnique({
        where: { key: 'UPSTOX_AUTH_TOKEN_ENCRYPTED' },
      });
      assert.equal(dbRecord, null);

      // Strictly verify no credentials, keys, or encrypted data are returned
      assert.equal(res.body.data.token, undefined);
      assert.equal(res.body.data.accessToken, undefined);
      assert.equal(res.body.data.ciphertext, undefined);
      assert.equal(res.body.data.iv, undefined);
      assert.equal(res.body.data.authTag, undefined);
      assert.equal(res.body.data.apiKey, undefined);
      assert.equal(res.body.data.apiSecret, undefined);

      const bodyStr = JSON.stringify(res.body);
      assert.ok(!bodyStr.includes(sampleAccessToken));
      assert.ok(!bodyStr.includes('"ciphertext":'));
      assert.ok(!bodyStr.includes('"iv":'));
      assert.ok(!bodyStr.includes('"authTag":'));
    });

    it('should redact secrets, codes, and states in query strings and error logs', () => {
      const urlWithSecrets = 'http://localhost:5001/api/auth/upstox/callback?code=secret_code_123&state=state_hex_456&access_token=token_789';
      const redacted = redactString(urlWithSecrets);

      assert.ok(!redacted.includes('secret_code_123'));
      assert.ok(!redacted.includes('state_hex_456'));
      assert.ok(!redacted.includes('token_789'));
      assert.ok(redacted.includes('code=[REDACTED]'));
      assert.ok(redacted.includes('state=[REDACTED]'));
      assert.ok(redacted.includes('access_token=[REDACTED]'));
    });

    it('should rate-limit OAuth initiation endpoint after exceeding quota (HTTP 429)', async () => {
      if (isRedisReady() && redisClient) {
        await redisClient.del('stocksense:ratelimit:oauth:start:::ffff:127.0.0.1');
        await redisClient.del('stocksense:ratelimit:oauth:start:127.0.0.1');
        await redisClient.del('stocksense:ratelimit:oauth:start:::1');
      }

      let blocked = false;
      // Send rapid requests (quota is 10/min)
      for (let i = 0; i < 15; i++) {
        const res = await request(app)
          .get('/api/auth/upstox/start')
          .set('Accept', 'application/json');

        if (res.status === 429) {
          blocked = true;
          assert.equal(res.body.error.code, 'TOO_MANY_REQUESTS');
          break;
        }
      }

      assert.ok(blocked, 'Rapid initiation requests exceeding quota must be rate-limited with HTTP 429');
    });
  });

  describe('4. Distributed OAuth Rate Limiter & Safe IP Extraction', () => {
    it('should extract safe client IP and normalize IPv6 loopback addresses', () => {
      assert.equal(getSafeClientIp({ ip: '::1' }), '127.0.0.1');
      assert.equal(getSafeClientIp({ ip: '::ffff:127.0.0.1' }), '127.0.0.1');
      assert.equal(getSafeClientIp({ ip: '203.0.113.195' }), '203.0.113.195');
      assert.equal(getSafeClientIp({ socket: { remoteAddress: '::ffff:192.168.1.50' } }), '192.168.1.50');
      assert.equal(getSafeClientIp({}), '127.0.0.1');
    });

    it('should share rate limits across independent DistributedOAuthRateLimiter instances using Redis', async () => {
      if (!isRedisReady() || !redisClient) {
        return; // Skip if Redis unavailable
      }

      const testIp = '198.51.100.77';
      const redisKey = `stocksense:ratelimit:oauth:start:${testIp}`;
      await redisClient.del(redisKey);

      try {
        const limiterInstance1 = new DistributedOAuthRateLimiter({ limit: 4, windowSeconds: 60 });
        const limiterInstance2 = new DistributedOAuthRateLimiter({ limit: 4, windowSeconds: 60 });

        // Instance 1 consumes 2 tokens
        const r1 = await limiterInstance1.checkLimit(testIp);
        const r2 = await limiterInstance1.checkLimit(testIp);
        assert.equal(r1.allowed, true);
        assert.equal(r2.allowed, true);

        // Instance 2 consumes 2 tokens (reaching 4)
        const r3 = await limiterInstance2.checkLimit(testIp);
        const r4 = await limiterInstance2.checkLimit(testIp);
        assert.equal(r3.allowed, true);
        assert.equal(r4.allowed, true);

        // Instance 1 attempts 5th token -> MUST BE REJECTED by shared Redis quota
        const r5 = await limiterInstance1.checkLimit(testIp);
        assert.equal(r5.allowed, false, '5th attempt across distributed instances must be blocked');
        assert.ok(r5.retryAfter > 0);

        // Instance 2 also sees the block
        const r6 = await limiterInstance2.checkLimit(testIp);
        assert.equal(r6.allowed, false, 'Instance 2 must also observe shared block');
      } finally {
        await redisClient.del(redisKey);
      }
    });

    it('should fail closed with HTTP 503 (RATE_LIMITER_OFFLINE) when Redis is offline and memory fallback is disabled', async () => {
      const offlineLimiter = new DistributedOAuthRateLimiter({
        redisClient: null,
        allowMemoryFallback: false,
      });

      await assert.rejects(
        () => offlineLimiter.checkLimit('198.51.100.88'),
        (err) => {
          assert.equal(err.code, 'RATE_LIMITER_OFFLINE');
          assert.equal(err.statusCode, 503);
          return true;
        }
      );
    });

    it('should pass RATE_LIMITER_OFFLINE error to next() in middleware on Redis failure', async () => {
      const mockFailingRedis = {
        eval: async () => {
          throw new Error('Connection refused by Redis cluster');
        },
      };

      const failingLimiter = new DistributedOAuthRateLimiter({
        redisClient: mockFailingRedis,
        allowMemoryFallback: false,
      });

      let capturedError = null;
      const mockReq = { ip: '198.51.100.99', socket: {} };
      const mockRes = { set: () => {} };
      const mockNext = (err) => {
        capturedError = err;
      };

      await failingLimiter.middleware(mockReq, mockRes, mockNext);

      assert.ok(capturedError, 'Middleware must pass error to next()');
      assert.equal(capturedError.code, 'RATE_LIMITER_OFFLINE');
      assert.equal(capturedError.statusCode, 503);
    });

    it('should ignore arbitrary spoofed X-Forwarded-For headers when trust proxy is disabled', () => {
      // Simulate an incoming request behind an untrusted connection with spoofed headers
      const untrustedReq = {
        ip: '127.0.0.1',
        headers: {
          'x-forwarded-for': '203.0.113.199, 10.0.0.1',
          'x-real-ip': '203.0.113.199',
        },
      };
      const resolvedIp = getSafeClientIp(untrustedReq);
      assert.equal(resolvedIp, '127.0.0.1', 'Must strictly use socket/connection IP, ignoring spoofed headers');
    });

    it('should strictly prohibit in-memory OAuth state fallback when environment is production', async () => {
      const origEnv = config.env;
      try {
        config.env = 'production';
        const prodStateService = new OAuthStateService({
          redisClient: null,
          allowMemoryFallback: true, // Attempted enable
        });

        assert.equal(
          prodStateService.allowMemoryFallback,
          false,
          'allowMemoryFallback MUST be forced to false in production'
        );

        await assert.rejects(
          () => prodStateService.createState(),
          (err) => err.code === 'REDIS_OFFLINE' && err.statusCode === 503
        );
      } finally {
        config.env = origEnv;
      }
    });
  });

  describe('5. OAuth Security Headers, Redirects & Error Sanitization', () => {
    it('should set strict anti-caching and privacy headers across ALL five OAuth endpoints (/start, /login, /callback, /status, /disconnect)', async () => {
      const assertSecurityHeaders = (res, endpointDesc) => {
        assert.equal(
          res.headers['cache-control'],
          'no-store, no-cache, must-revalidate, private',
          `${endpointDesc} must have Cache-Control: no-store, no-cache, must-revalidate, private`
        );
        assert.equal(res.headers['pragma'], 'no-cache', `${endpointDesc} must have Pragma: no-cache`);
        assert.equal(res.headers['expires'], '0', `${endpointDesc} must have Expires: 0`);
        assert.equal(res.headers['referrer-policy'], 'no-referrer', `${endpointDesc} must have Referrer-Policy: no-referrer`);
      };

      // 1. GET /api/auth/upstox/start
      const resStart = await request(app)
        .get('/api/auth/upstox/start')
        .set('Accept', 'application/json');
      assertSecurityHeaders(resStart, 'GET /start');

      // 2. GET /api/auth/upstox/login (alias endpoint, testing both JSON and 302 redirect)
      const resLoginJson = await request(app)
        .get('/api/auth/upstox/login')
        .set('Accept', 'application/json');
      assertSecurityHeaders(resLoginJson, 'GET /login (JSON)');

      const resLoginRedirect = await request(app).get('/api/auth/upstox/login');
      assert.equal(resLoginRedirect.status, 302);
      assertSecurityHeaders(resLoginRedirect, 'GET /login (302 Redirect)');

      // 3. GET /api/auth/upstox/callback (testing both 400 error and 302 provider denial)
      const resCallbackError = await request(app)
        .get('/api/auth/upstox/callback')
        .set('Accept', 'application/json');
      assertSecurityHeaders(resCallbackError, 'GET /callback (400 Error)');

      const resCallbackDenial = await request(app)
        .get('/api/auth/upstox/callback?error=access_denied&error_description=Denied');
      assert.equal(resCallbackDenial.status, 302);
      assertSecurityHeaders(resCallbackDenial, 'GET /callback (302 Denial Redirect)');

      // 4. GET /api/auth/upstox/status
      const resStatus = await request(app).get('/api/auth/upstox/status');
      assertSecurityHeaders(resStatus, 'GET /status');

      // 5. POST /api/auth/upstox/disconnect (testing both 401 unauthorized and 200 authorized)
      const resDiscUnauthorized = await request(app).post('/api/auth/upstox/disconnect');
      assert.equal(resDiscUnauthorized.status, 401);
      assertSecurityHeaders(resDiscUnauthorized, 'POST /disconnect (401 Unauthorized)');

      const validJwt = jwt.sign(
        { userId: 'admin_audit_user', role: 'ADMIN' },
        config.jwt.secret,
        { expiresIn: '5m' }
      );
      const resDiscAuthorized = await request(app)
        .post('/api/auth/upstox/disconnect')
        .set('Authorization', `Bearer ${validJwt}`);
      assert.equal(resDiscAuthorized.status, 200);
      assertSecurityHeaders(resDiscAuthorized, 'POST /disconnect (200 Authorized)');
    });

    it('should verify no diagnostic, test, or debug endpoints are exposed', async () => {
      const resTest = await request(app).get('/api/test');
      assert.equal(resTest.status, 404);

      const resDebug = await request(app).get('/debug');
      assert.equal(resDebug.status, 404);

      const resDiag = await request(app).get('/api/diagnostic');
      assert.equal(resDiag.status, 404);
    });

    it('should perform clean browser redirect to frontend settings without code or tokens in destination URL', async () => {
      const { state } = await oauthStateService.createState();

      const originalHttpClient = upstoxOAuthService.httpClient;
      upstoxOAuthService.httpClient = {
        post: async () => ({
          status: 200,
          data: {
            access_token: 'browser_test_token_clean_redirect',
            user_id: 'USER_CLEAN',
          },
        }),
      };

      try {
        const res = await request(app)
          .get(`/api/auth/upstox/callback?code=sensitive_auth_code_clean_test&state=${state}`);

        assert.equal(res.status, 302);
        const destination = res.headers.location;
        const expectedFrontendUrl = config.corsOrigin || 'http://localhost:5173';
        assert.equal(destination, `${expectedFrontendUrl}/settings?auth=success`);

        // Strictly verify NO sensitive tokens, auth codes, or states are present in destination
        assert.ok(!destination.includes('code='), 'Destination redirect must not contain code');
        assert.ok(!destination.includes('state='), 'Destination redirect must not contain state');
        assert.ok(!destination.includes('browser_test_token'), 'Destination redirect must not contain token');
      } finally {
        upstoxOAuthService.httpClient = originalHttpClient;
      }
    });

    it('should sanitize query parameters in error handler responses (meta.path redaction)', async () => {
      const secretCode = 'super_secret_auth_code_999888';
      const secretState = 'super_secret_state_777666';

      const res = await request(app)
        .get(`/api/auth/upstox/callback?code=${secretCode}&state=${secretState}`)
        .set('Accept', 'application/json');

      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.ok(res.body.meta, 'Response must include meta object');
      assert.ok(res.body.meta.path, 'Response must include meta.path');

      // Verify query string values are masked with [REDACTED]
      assert.ok(res.body.meta.path.includes('code=[REDACTED]'), 'meta.path must redact code parameter');
      assert.ok(res.body.meta.path.includes('state=[REDACTED]'), 'meta.path must redact state parameter');

      // Verify the raw secret strings are nowhere in the JSON payload
      const payloadString = JSON.stringify(res.body);
      assert.ok(!payloadString.includes(secretCode), 'Error response must NEVER leak raw authorization code');
      assert.ok(!payloadString.includes(secretState), 'Error response must NEVER leak raw state');
    });

    it('should redirect browser to frontend settings with error reason when provider cancels or denies', async () => {
      const res = await request(app)
        .get('/api/auth/upstox/callback?error=access_denied&error_description=User%20declined%20consent');

      assert.equal(res.status, 302);
      const destination = res.headers.location;
      const expectedFrontendUrl = config.corsOrigin || 'http://localhost:5173';
      assert.ok(
        destination.startsWith(`${expectedFrontendUrl}/settings?auth=error&reason=`),
        'Must redirect to frontend settings error route'
      );
      assert.ok(destination.includes('User%20declined%20consent'));
    });
  });
});
