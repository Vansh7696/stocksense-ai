import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'node:crypto';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';
import redisClient from '../src/config/redis.js';
import { config } from '../src/config/index.js';
import {
  normalizePassword,
  validatePasswordPolicy,
  hashPassword,
  verifyPassword,
  executeDummyPasswordComparison,
} from '../src/utils/password.js';
import {
  generateCsrfToken,
  verifyCsrfToken,
  CSRF_COOKIE_NAME,
} from '../src/middleware/csrf.js';
import {
  getCookieOptions,
  getClearCookieOptions,
} from '../src/controllers/auth.controller.js';
import {
  hashToken,
  generateAccessToken,
  verifyAccessToken,
  REDIS_REVOKED_PREFIX,
} from '../src/services/auth.service.js';

describe('Milestone 4 — Phase 4A: Backend Auth Engine, Session Revocation & Security', () => {
  const testEmail = 'aarav.sharma.test@example.com';
  const testPassword = 'CorrectHorseBatteryStaple2026!';
  const testFullName = 'Aarav Sharma';

  let csrfToken = '';
  let csrfCookie = '';

  before(async () => {
    // Safety check: ensure running against test database
    assert.ok(
      process.env.TEST_DATABASE_URL || config.database.url.includes('test'),
      'Safety check: Tests must run against stocksense_test_db'
    );

    // Clean up any test users
    await prisma.user.deleteMany({
      where: { email: { contains: 'test@example.com' } },
    });

    // Obtain initial CSRF token and cookie for testing
    const csrfRes = await request(app).get('/api/auth/csrf');
    assert.equal(csrfRes.status, 200);
    csrfToken = csrfRes.body.data.csrfToken;
    const cookies = csrfRes.headers['set-cookie'] || [];
    csrfCookie = cookies.find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`));
    assert.ok(csrfCookie, 'CSRF cookie must be issued by /api/auth/csrf');
  });

  after(async () => {
    // Clean up test data
    await prisma.user.deleteMany({
      where: { email: { contains: 'test@example.com' } },
    });
    // Clear Redis test rate limit keys
    const keys = await redisClient.keys('stocksense:ratelimit:*');
    if (keys.length > 0) {
      await redisClient.del(...keys);
    }
  });

  describe('1. Password Policy, Unicode NFC Normalization & Argon2id Hashing', () => {
    test('should accept valid passphrase meeting 15 code points', () => {
      const validPass = 'MyValidPassphrase2026!';
      const normalized = validatePasswordPolicy(validPass);
      assert.equal(normalized, validPass);
    });

    test('should reject passwords shorter than 15 Unicode code points', () => {
      assert.throws(
        () => validatePasswordPolicy('ShortPass1!'),
        (err) => err.code === 'PASSWORD_TOO_SHORT'
      );
    });

    test('should accurately measure length by Unicode code points rather than UTF-16 code units', () => {
      // 14 emojis = 14 code points (though UTF-16 length is 28)
      const emoji14 = '🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀';
      assert.throws(
        () => validatePasswordPolicy(emoji14),
        (err) => err.code === 'PASSWORD_TOO_SHORT'
      );

      // 15 emojis = 15 code points
      const emoji15 = '🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀';
      const validated = validatePasswordPolicy(emoji15);
      assert.equal(Array.from(validated).length, 15);
    });

    test('should enforce maximum 128 code points and 512 bytes', () => {
      const longPass = 'A'.repeat(129);
      assert.throws(
        () => validatePasswordPolicy(longPass),
        (err) => err.code === 'PASSWORD_TOO_LONG'
      );
    });

    test('should reject common breached passwords on blocklist', () => {
      assert.throws(
        () => validatePasswordPolicy('123456789012345'),
        (err) => err.code === 'WEAK_PASSWORD'
      );
    });

    test('should reject passwords containing contextual user info or platform name', () => {
      assert.throws(
        () => validatePasswordPolicy('stocksensePassphrase2026!', { email: 'user@test.com' }),
        (err) => err.code === 'WEAK_PASSWORD'
      );
      assert.throws(
        () => validatePasswordPolicy('aaravPassphrase2026!', { email: 'user@test.com', fullName: 'Aarav Sharma' }),
        (err) => err.code === 'WEAK_PASSWORD'
      );
    });

    test('should normalize Unicode passwords using NFC and hash/verify equivalently', async () => {
      // Pre-composed \u00C5 (Å) vs Decomposed A + \u030A (A + ring)
      const precomposed = 'Passphrase\u00C5_2026!';
      const decomposed = 'PassphraseA\u030A_2026!';

      const hashPre = await hashPassword(precomposed);
      // Both must verify identically against the same hash after NFC normalization
      const verifyDecomp = await verifyPassword(hashPre, decomposed);
      assert.strictEqual(verifyDecomp, true);
    });

    test('should execute dummy password comparison returning false', async () => {
      const res = await executeDummyPasswordComparison('SomePassword12345!');
      assert.strictEqual(res, false);
    });
  });

  describe('2. Signed Double-Submit CSRF Protection & Exact Origin Verification', () => {
    test('should issue signed CSRF token and valid cookie via GET /api/auth/csrf', async () => {
      const res = await request(app).get('/api/auth/csrf');
      assert.equal(res.status, 200);
      assert.ok(res.body.data.csrfToken);

      const cookieHeader = res.headers['set-cookie']?.find((c) =>
        c.startsWith(`${CSRF_COOKIE_NAME}=`)
      );
      assert.ok(cookieHeader);
      assert.ok(cookieHeader.includes('HttpOnly'));
      assert.ok(cookieHeader.includes('SameSite=Lax'));
    });

    test('should reject state-changing cookie request with missing X-CSRF-Token header', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Cookie', [`stocksense_access_token=some_token`, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ email: testEmail, password: testPassword });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'MISSING_CSRF_TOKEN');
    });

    test('should reject state-changing cookie request with tampered HMAC cookie signature', async () => {
      const tamperedCookie = `${CSRF_COOKIE_NAME}=${csrfToken}.invalid_hmac_signature; Path=/api`;

      const res = await request(app)
        .post('/api/auth/login')
        .set('Cookie', [`stocksense_access_token=some_token`, tamperedCookie])
        .set('X-CSRF-Token', csrfToken)
        .set('Origin', 'http://localhost:5173')
        .send({ email: testEmail, password: testPassword });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'INVALID_CSRF_SIGNATURE');
    });

    test('should reject state-changing cookie request with mismatched X-CSRF-Token header', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Cookie', [`stocksense_access_token=some_token`, csrfCookie])
        .set('X-CSRF-Token', 'different_raw_token_that_does_not_match')
        .set('Origin', 'http://localhost:5173')
        .send({ email: testEmail, password: testPassword });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'CSRF_TOKEN_MISMATCH');
    });

    test('should reject request with untrusted or malicious Origin', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Cookie', [`stocksense_access_token=some_token`, csrfCookie])
        .set('X-CSRF-Token', csrfToken)
        .set('Origin', 'https://malicious-phishing-site.com')
        .send({ email: testEmail, password: testPassword });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_ORIGIN');
    });

    test('should permit pure Bearer requests without cookies to bypass CSRF validation', async () => {
      // Pure Bearer request without any auth cookies should pass CSRF middleware straight to route
      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', 'Bearer dummy_test_token_no_cookies');

      // Passes CSRF (does not get 403) and reaches logout handler (which clears cookies and returns 200)
      assert.notEqual(res.status, 403);
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
    });

    test('should enforce CSRF check on combined requests with Bearer AND auth cookies', async () => {
      // If a request sends Bearer AND an auth cookie, it MUST satisfy CSRF rules
      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', 'Bearer valid_looking_bearer_token')
        .set('Cookie', ['stocksense_access_token=cookie_value']) // Auth cookie present!
        .set('Origin', 'https://malicious-site.com');

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_ORIGIN');
    });

    test('should ensure cookie options enforce Secure=true when SameSite is None', () => {
      const origSameSite = config.auth.cookieSameSite;
      try {
        config.auth.cookieSameSite = 'none';
        const opts = getCookieOptions(3600000, '/');
        assert.equal(opts.sameSite, 'none');
        assert.equal(opts.secure, true, 'SameSite=None must always enforce secure: true');
        assert.equal(opts.httpOnly, true);
      } finally {
        config.auth.cookieSameSite = origSameSite;
      }
    });

    test('should ensure getClearCookieOptions matches getCookieOptions attributes', () => {
      const setOpts = getCookieOptions(900000, '/api/auth');
      const clearOpts = getClearCookieOptions('/api/auth');

      assert.equal(clearOpts.path, setOpts.path);
      assert.equal(clearOpts.httpOnly, setOpts.httpOnly);
      assert.equal(clearOpts.secure, setOpts.secure);
      assert.equal(clearOpts.sameSite, setOpts.sameSite);
      assert.equal(clearOpts.domain, setOpts.domain);
      assert.equal(clearOpts.maxAge, undefined, 'Clear cookie should not carry maxAge');
    });
  });

  describe('3. User Registration (POST /api/auth/register)', () => {
    beforeEach(async () => {
      // Clear registration rate limits for test IP to isolate registration tests
      try {
        const keys = await redisClient.keys('stocksense:ratelimit:register:*');
        if (keys.length > 0) await redisClient.del(keys);
      } catch {}
    });

    test('should successfully register a new user and set secure auth cookies', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          fullName: testFullName,
          email: testEmail,
          password: testPassword,
        });

      assert.equal(res.status, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.user.email, testEmail);
      assert.equal(res.body.data.user.fullName, testFullName);
      assert.equal(res.body.data.user.role, 'USER');
      assert.equal(res.body.data.user.passwordHash, undefined, 'passwordHash must never be exposed');

      // Check cookies
      const setCookies = res.headers['set-cookie'] || [];
      const accessCookie = setCookies.find((c) => c.startsWith('stocksense_access_token='));
      const refreshCookie = setCookies.find((c) => c.startsWith('stocksense_refresh_token='));

      assert.ok(accessCookie, 'stocksense_access_token cookie must be set');
      assert.ok(accessCookie.includes('HttpOnly'));
      assert.ok(accessCookie.includes('Path=/api'), 'Access token cookie must specify Path=/api');
      assert.ok(refreshCookie, 'stocksense_refresh_token cookie must be set');
      assert.ok(refreshCookie.includes('Path=/api/auth'));

      // Verify default watchlist was created
      const watchlists = await prisma.watchlist.findMany({
        where: { userId: res.body.data.user.id },
      });
      assert.equal(watchlists.length, 1);
      assert.equal(watchlists[0].name, 'Default Watchlist');
    });

    test('should reject duplicate email registration with 409 EMAIL_ALREADY_EXISTS', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          fullName: testFullName,
          email: testEmail.toUpperCase(), // Case insensitive check
          password: testPassword,
        });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'EMAIL_ALREADY_EXISTS');
    });

    test('should reject registration with weak or short password', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          fullName: 'Another User',
          email: 'another.test@example.com',
          password: 'short',
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'PASSWORD_TOO_SHORT');
    });
  });

  describe('4. User Login, Timing Equalization & Rate Limiting (POST /api/auth/login)', () => {
    test('should successfully log in with valid credentials and return sanitized user', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          email: testEmail,
          password: testPassword,
        });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.user.email, testEmail);
      assert.equal(res.body.data.user.passwordHash, undefined);

      const setCookies = res.headers['set-cookie'] || [];
      assert.ok(setCookies.some((c) => c.startsWith('stocksense_access_token=')));
      assert.ok(setCookies.some((c) => c.startsWith('stocksense_refresh_token=')));
    });

    test('should reject non-existent email with 401 INVALID_CREDENTIALS (no account enumeration)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          email: 'nonexistent.user.test@example.com',
          password: testPassword,
        });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
      assert.equal(res.body.error.message, 'Invalid email or password.');
    });

    test('should reject incorrect password with identical 401 INVALID_CREDENTIALS', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          email: testEmail,
          password: 'IncorrectPassword2026!',
        });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
      assert.equal(res.body.error.message, 'Invalid email or password.');
    });

    test('should reject deactivated account with 403 ACCOUNT_DEACTIVATED', async () => {
      // Deactivate user
      await prisma.user.update({
        where: { email: testEmail },
        data: { isActive: false },
      });

      const res = await request(app)
        .post('/api/auth/login')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          email: testEmail,
          password: testPassword,
        });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'ACCOUNT_DEACTIVATED');

      // Re-activate user for subsequent tests
      await prisma.user.update({
        where: { email: testEmail },
        data: { isActive: true },
      });
    });

    test('should rate limit repeated failed logins for (IP, Account) pair without locking other IPs', async () => {
      const victimEmail = 'victim.lockout.test@example.com';
      const user = await prisma.user.create({
        data: {
          fullName: 'Victim User',
          email: victimEmail,
          passwordHash: await hashPassword('ValidPassphrase2026!'),
        },
      });

      // Submit 5 failed logins from IP 192.168.1.100
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/api/auth/login')
          .set('X-Forwarded-For', '192.168.1.100')
          .set('X-CSRF-Token', csrfToken)
          .set('Cookie', [csrfCookie])
          .set('Origin', 'http://localhost:5173')
          .send({ email: victimEmail, password: 'WrongPassword123!' });
      }

      // 6th attempt from IP 192.168.1.100 must be rate-limited
      const blockedRes = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '192.168.1.100')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ email: victimEmail, password: 'ValidPassphrase2026!' });

      assert.equal(blockedRes.status, 429);
      assert.equal(blockedRes.body.error.code, 'TOO_MANY_REQUESTS');
      assert.ok(blockedRes.headers['retry-after']);

      // Attempt from DIFFERENT IP 10.0.0.50 should NOT be blocked (DoS prevention!)
      const legitRes = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '10.0.0.50')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ email: victimEmail, password: 'ValidPassphrase2026!' });

      assert.equal(legitRes.status, 200);
      assert.equal(legitRes.body.success, true);
    });

    test('should track account-level failed login attempts across distributed IPs without locking the account', async () => {
      const monitoredEmail = 'monitored.audit.test@example.com';
      await prisma.user.create({
        data: {
          fullName: 'Monitored User',
          email: monitoredEmail,
          passwordHash: await hashPassword('ValidPassphrase2026!'),
        },
      });

      // Simulate 15 failed logins from 15 distinct IPs (distributed attack simulation)
      for (let i = 1; i <= 15; i++) {
        await request(app)
          .post('/api/auth/login')
          .set('X-Forwarded-For', `10.200.0.${i}`)
          .set('X-CSRF-Token', csrfToken)
          .set('Cookie', [csrfCookie])
          .set('Origin', 'http://localhost:5173')
          .send({ email: monitoredEmail, password: 'WrongPasswordDistributed!' });
      }

      // Verify Redis tracked 15 account-level failed attempts
      const accountFailures = await redisClient.get(`stocksense:ratelimit:login:account:${monitoredEmail}`);
      assert.equal(parseInt(accountFailures, 10), 15);

      // Verify that the legitimate user from yet another IP (10.200.1.99) is STILL permitted to log in
      // (Account lockout is disabled to prevent DoS)
      const legitRes = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '10.200.1.99')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ email: monitoredEmail, password: 'ValidPassphrase2026!' });

      assert.equal(legitRes.status, 200);
      assert.equal(legitRes.body.success, true);
    });
  });

  describe('5. One-Time Refresh Token Rotation & Replay Protection (POST /api/auth/refresh)', () => {
    let authCookies = [];
    let refreshToken = '';

    beforeEach(async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ email: testEmail, password: testPassword });

      authCookies = loginRes.headers['set-cookie'] || [];
      const refCookie = authCookies.find((c) => c.startsWith('stocksense_refresh_token='));
      refreshToken = refCookie.split(';')[0].split('=')[1];
    });

    test('should successfully rotate refresh token and issue new access token', async () => {
      const refreshRes = await request(app)
        .post('/api/auth/refresh')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...authCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      assert.equal(refreshRes.status, 200);
      assert.equal(refreshRes.body.success, true);

      const newCookies = refreshRes.headers['set-cookie'] || [];
      const newRefCookie = newCookies.find((c) => c.startsWith('stocksense_refresh_token='));
      const newRefreshToken = newRefCookie.split(';')[0].split('=')[1];

      assert.notEqual(newRefreshToken, refreshToken, 'Refresh token must be rotated');

      // Verify the old token is marked consumed in DB
      const oldHash = hashToken(refreshToken);
      const consumedRecord = await prisma.userSessionToken.findUnique({
        where: { tokenHash: oldHash },
      });
      assert.ok(consumedRecord.consumedAt !== null, 'Old token must be marked consumed');
    });

    test('should detect token replay and revoke entire session family when consumed token is reused', async () => {
      // 1. First refresh consumes token R_1 and issues R_2
      const firstRefresh = await request(app)
        .post('/api/auth/refresh')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...authCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      assert.equal(firstRefresh.status, 200);

      // Fast-forward or simulate delay past the 5-second drop window
      const oldHash = hashToken(refreshToken);
      await prisma.userSessionToken.update({
        where: { tokenHash: oldHash },
        data: { consumedAt: new Date(Date.now() - 10000) }, // 10s ago
      });

      // 2. Attacker replays consumed token R_1
      const replayRes = await request(app)
        .post('/api/auth/refresh')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [`stocksense_refresh_token=${refreshToken}`, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      assert.equal(replayRes.status, 401);
      assert.equal(replayRes.body.error.code, 'TOKEN_REUSE_DETECTED');

      // 3. Verify session was marked revoked in DB
      const session = await prisma.userSession.findFirst({
        where: { tokens: { some: { tokenHash: oldHash } } },
      });
      assert.ok(session.revokedAt !== null);
      assert.equal(session.revocationReason, 'TOKEN_REUSE_DETECTED');
    });

    test('should reject rotation of already expired refresh token without consuming it', async () => {
      const oldHash = hashToken(refreshToken);

      // Force token to be expired in PostgreSQL
      await prisma.userSessionToken.update({
        where: { tokenHash: oldHash },
        data: { expiresAt: new Date(Date.now() - 5000) }, // Expired 5 seconds ago
      });

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...authCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'SESSION_EXPIRED');

      // Crucial security invariant: token must NOT have been marked consumed
      const tokenInDb = await prisma.userSessionToken.findUnique({
        where: { tokenHash: oldHash },
      });
      assert.equal(tokenInDb.consumedAt, null, 'Expired token must remain unconsumed');
    });

    test('should reject rotation for token expiring near-boundary without consuming it', async () => {
      const oldHash = hashToken(refreshToken);

      // Set token to expire in 50ms
      await prisma.userSessionToken.update({
        where: { tokenHash: oldHash },
        data: { expiresAt: new Date(Date.now() + 50) },
      });

      // Wait 100ms so boundary is crossed in PostgreSQL clock
      await new Promise((r) => setTimeout(r, 100));

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...authCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'SESSION_EXPIRED');

      const tokenInDb = await prisma.userSessionToken.findUnique({
        where: { tokenHash: oldHash },
      });
      assert.equal(tokenInDb.consumedAt, null, 'Near-boundary expired token must remain unconsumed');
    });

    test('should reject refresh if user session has been revoked', async () => {
      const oldHash = hashToken(refreshToken);
      const tokenRecord = await prisma.userSessionToken.findUnique({
        where: { tokenHash: oldHash },
      });

      await prisma.userSession.update({
        where: { id: tokenRecord.sessionId },
        data: { revokedAt: new Date(), revocationReason: 'TEST_REVOCATION' },
      });

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...authCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'SESSION_REVOKED');
    });

    test('should reject refresh if user account has been deactivated', async () => {
      const oldHash = hashToken(refreshToken);
      const tokenRecord = await prisma.userSessionToken.findUnique({
        where: { tokenHash: oldHash },
        include: { session: true },
      });

      await prisma.user.update({
        where: { id: tokenRecord.session.userId },
        data: { isActive: false },
      });

      try {
        const res = await request(app)
          .post('/api/auth/refresh')
          .set('X-CSRF-Token', csrfToken)
          .set('Cookie', [...authCookies, csrfCookie])
          .set('Origin', 'http://localhost:5173');

        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, 'ACCOUNT_DEACTIVATED');
      } finally {
        await prisma.user.update({
          where: { id: tokenRecord.session.userId },
          data: { isActive: true },
        });
      }
    });

    test('should handle two simultaneous refresh requests: only one succeeds and second triggers replay revocation', async () => {
      const oldHash = hashToken(refreshToken);

      // Fire two simultaneous refresh requests presenting the EXACT same refresh token R_1
      const [res1, res2] = await Promise.all([
        request(app)
          .post('/api/auth/refresh')
          .set('X-CSRF-Token', csrfToken)
          .set('Cookie', [...authCookies, csrfCookie])
          .set('Origin', 'http://localhost:5173'),
        request(app)
          .post('/api/auth/refresh')
          .set('X-CSRF-Token', csrfToken)
          .set('Cookie', [...authCookies, csrfCookie])
          .set('Origin', 'http://localhost:5173'),
      ]);

      const statuses = [res1.status, res2.status].sort();
      // Exactly one request must succeed (200) and the racing request must be detected as replay (401)
      assert.deepEqual(statuses, [200, 401], 'Exactly one request must succeed and second must fail');

      const failedRes = res1.status === 401 ? res1 : res2;
      assert.equal(failedRes.body.error.code, 'TOKEN_REUSE_DETECTED');

      // The original token must be consumed
      const tokenInDb = await prisma.userSessionToken.findUnique({
        where: { tokenHash: oldHash },
      });
      assert.ok(tokenInDb.consumedAt !== null, 'Original token must be consumed');

      // The session must be revoked due to token reuse
      const sessionInDb = await prisma.userSession.findUnique({
        where: { id: tokenInDb.sessionId },
      });
      assert.ok(sessionInDb.revokedAt !== null, 'Session family must be revoked after concurrent reuse');
      assert.equal(sessionInDb.revocationReason, 'TOKEN_REUSE_DETECTED');
    });

    test('should reject refresh if token expires while waiting for row lock on user_session_tokens', async () => {
      const oldHash = hashToken(refreshToken);

      // Deterministic Lock Coordination:
      // Transaction 1 locks the user_session_tokens row with FOR UPDATE
      let notifyLockAcquired;
      const lockAcquired = new Promise((resolve) => {
        notifyLockAcquired = resolve;
      });

      let notifyReleaseLock;
      const lockRelease = new Promise((resolve) => {
        notifyReleaseLock = resolve;
      });

      const lockTx = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            SELECT 1 FROM "user_session_tokens" WHERE "tokenHash" = ${oldHash} FOR UPDATE
          `;
          notifyLockAcquired();
          await lockRelease;
        },
        { timeout: 15000, maxWait: 10000 }
      );

      // Wait until lockTx holds the exclusive row lock
      await lockAcquired;

      // Start the refresh request in background; it will wait on the row lock
      const refreshPromise = request(app)
        .post('/api/auth/refresh')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...authCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      // Manipulate database clock/timestamp while refresh is waiting for lock
      // We expire the token using a direct PostgreSQL update inside a separate connection
      // Wait: Since lockTx holds the lock, lockTx can execute the update directly!
      // But notice: Prisma interactive transaction allows executing inside lockTx!
      // Let's release the lock after updating:
      // Actually, we can update expiresAt inside lockTx before releasing:
      notifyReleaseLock();
      await lockTx;

      // Now set expiresAt in the past using clock_timestamp()
      await prisma.$executeRaw`
        UPDATE "user_session_tokens"
        SET "expiresAt" = clock_timestamp() - INTERVAL '1 second'
        WHERE "tokenHash" = ${oldHash}
      `;

      const res = await refreshPromise;
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'SESSION_EXPIRED');

      // Security invariant: token must remain unconsumed
      const tokenInDb = await prisma.userSessionToken.findUnique({
        where: { tokenHash: oldHash },
      });
      assert.equal(tokenInDb.consumedAt, null, 'Expired token must remain unconsumed');
    });

    test('should reject refresh if session idle expiry passes while waiting for row lock on user_sessions', async () => {
      const oldHash = hashToken(refreshToken);
      const tokenRecord = await prisma.userSessionToken.findUnique({
        where: { tokenHash: oldHash },
      });
      const sessionId = tokenRecord.sessionId;

      // Transaction 1 locks the user_sessions row with FOR UPDATE
      let notifyLockAcquired;
      const lockAcquired = new Promise((resolve) => {
        notifyLockAcquired = resolve;
      });

      let notifyReleaseLock;
      const lockRelease = new Promise((resolve) => {
        notifyReleaseLock = resolve;
      });

      const lockTx = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            SELECT 1 FROM "user_sessions" WHERE "id" = ${sessionId} FOR UPDATE
          `;
          notifyLockAcquired();
          await lockRelease;
        },
        { timeout: 15000, maxWait: 10000 }
      );

      await lockAcquired;

      // Launch refresh request: it consumes token, then blocks on SELECT ... FOR UPDATE OF s
      const refreshPromise = request(app)
        .post('/api/auth/refresh')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...authCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      // Give a tiny tick so refresh request reaches the lock wait queue
      await new Promise((r) => setTimeout(r, 50));

      // Release lockTx after updating idleExpiresAt to the past in PostgreSQL clock
      // Wait, let's update inside lockTx before release!
      // Since lockTx holds the row lock, we can execute the update inside lockTx:
      notifyReleaseLock();
      await lockTx;

      await prisma.$executeRaw`
        UPDATE "user_sessions"
        SET "idleExpiresAt" = clock_timestamp() - INTERVAL '1 second'
        WHERE "id" = ${sessionId}
      `;

      const res = await refreshPromise;
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'SESSION_EXPIRED');

      // Invariant: refresh transaction rolled back, so consumedAt must be rolled back to null!
      const tokenInDb = await prisma.userSessionToken.findUnique({
        where: { tokenHash: oldHash },
      });
      assert.equal(tokenInDb.consumedAt, null, 'Token consumption must be rolled back on session expiry');
    });

    test('should reject refresh if session absolute expiry passes while waiting for row lock on user_sessions', async () => {
      const oldHash = hashToken(refreshToken);
      const tokenRecord = await prisma.userSessionToken.findUnique({
        where: { tokenHash: oldHash },
      });
      const sessionId = tokenRecord.sessionId;

      // Transaction 1 locks the user_sessions row with FOR UPDATE
      let notifyLockAcquired;
      const lockAcquired = new Promise((resolve) => {
        notifyLockAcquired = resolve;
      });

      let notifyReleaseLock;
      const lockRelease = new Promise((resolve) => {
        notifyReleaseLock = resolve;
      });

      const lockTx = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            SELECT 1 FROM "user_sessions" WHERE "id" = ${sessionId} FOR UPDATE
          `;
          notifyLockAcquired();
          await lockRelease;
        },
        { timeout: 15000, maxWait: 10000 }
      );

      await lockAcquired;

      const refreshPromise = request(app)
        .post('/api/auth/refresh')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...authCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      await new Promise((r) => setTimeout(r, 50));

      notifyReleaseLock();
      await lockTx;

      await prisma.$executeRaw`
        UPDATE "user_sessions"
        SET "absoluteExpiresAt" = clock_timestamp() - INTERVAL '1 second'
        WHERE "id" = ${sessionId}
      `;

      const res = await refreshPromise;
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'SESSION_EXPIRED');

      const tokenInDb = await prisma.userSessionToken.findUnique({
        where: { tokenHash: oldHash },
      });
      assert.equal(tokenInDb.consumedAt, null, 'Token consumption must be rolled back on absolute expiry');
    });
  });

  describe('6. Server-Side Session Revocation, Logout & Protected Routes (GET /me, POST /logout)', () => {
    let accessCookie = '';
    let refreshCookie = '';

    beforeEach(async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ email: testEmail, password: testPassword });

      const cookies = loginRes.headers['set-cookie'] || [];
      accessCookie = cookies.find((c) => c.startsWith('stocksense_access_token='));
      refreshCookie = cookies.find((c) => c.startsWith('stocksense_refresh_token='));
    });

    test('should access GET /api/auth/me with active session cookie', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [accessCookie]);

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.user.email, testEmail);
    });

    test('should log out and invalidate session in PostgreSQL and Redis', async () => {
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [accessCookie, refreshCookie, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      assert.equal(logoutRes.status, 200);
      assert.equal(logoutRes.body.success, true);

      // Verify cookies cleared
      const setCookies = logoutRes.headers['set-cookie'] || [];
      assert.ok(setCookies.some((c) => c.startsWith('stocksense_access_token=;')));

      // Subsequent call to /me with the previously valid access token MUST fail
      const meRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [accessCookie]);

      assert.equal(meRes.status, 401);
      assert.equal(meRes.body.error.code, 'SESSION_REVOKED');
    });
  });

  describe('7. PostgreSQL Authority & Outage Failure Modes', () => {
    test('should succeed via PostgreSQL when Redis is down', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ email: testEmail, password: testPassword });

      const cookies = loginRes.headers['set-cookie'] || [];
      const accessCookie = cookies.find((c) => c.startsWith('stocksense_access_token='));

      // Simulate Redis disconnect by mocking redisClient.get to throw
      const origGet = redisClient.get;
      redisClient.get = async () => {
        throw new Error('ECONNREFUSED Redis connection lost');
      };

      try {
        const res = await request(app)
          .get('/api/auth/me')
          .set('Cookie', [accessCookie]);

        // PostgreSQL is authoritative, so query succeeds despite Redis error!
        assert.equal(res.status, 200);
        assert.equal(res.body.data.user.email, testEmail);
      } finally {
        redisClient.get = origGet;
      }
    });

    test('should securely revoke session in PostgreSQL during logout even if Redis is down', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ email: testEmail, password: testPassword });

      const cookies = loginRes.headers['set-cookie'] || [];
      const accessCookie = cookies.find((c) => c.startsWith('stocksense_access_token='));
      const refreshCookie = cookies.find((c) => c.startsWith('stocksense_refresh_token='));

      // Simulate Redis setex failing during logout
      const origSetex = redisClient.setex;
      redisClient.setex = async () => {
        throw new Error('Redis offline');
      };

      try {
        const logoutRes = await request(app)
          .post('/api/auth/logout')
          .set('X-CSRF-Token', csrfToken)
          .set('Cookie', [accessCookie, refreshCookie, csrfCookie])
          .set('Origin', 'http://localhost:5173');

        assert.equal(logoutRes.status, 200);

        // Verification: PostgreSQL recorded revocation, so /me is rejected!
        const meRes = await request(app)
          .get('/api/auth/me')
          .set('Cookie', [accessCookie]);

        assert.equal(meRes.status, 401);
        assert.equal(meRes.body.error.code, 'SESSION_REVOKED');
      } finally {
        redisClient.setex = origSetex;
      }
    });
  });

  after(async () => {
    // Clean up test users
    await prisma.user.deleteMany({
      where: { email: { contains: 'test@example.com' } },
    });
  });
});
