import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';
import redisClient from '../src/config/redis.js';
import { config } from '../src/config/index.js';

describe('Milestone 4 — Phase 4D: Full-System End-to-End Audit & Verification', () => {
  const testPassword = 'CorrectHorseBatteryStaple2026!';

  let csrfToken = '';
  let csrfCookie = '';

  let seededNseStock = null;
  let seededBseStock = null;

  before(async () => {
    // Environment safety assertion
    assert.ok(
      process.env.TEST_DATABASE_URL || config.database.url.includes('test'),
      'Safety check: Tests must run against stocksense_test_db'
    );

    // Clean up Redis rate limits and test accounts
    try {
      const keys = await redisClient.keys('stocksense:ratelimit:*');
      if (keys.length > 0) await redisClient.del(keys);
    } catch {}

    await prisma.user.deleteMany({
      where: { email: { contains: 'e2e.' } },
    });

    // Obtain CSRF token pair
    const csrfRes = await request(app).get('/api/auth/csrf');
    assert.equal(csrfRes.status, 200);
    csrfToken = csrfRes.body.data.csrfToken;
    const setCookie = csrfRes.headers['set-cookie'] || [];
    csrfCookie = setCookie.find((c) => c.startsWith('stocksense_csrf_token='));
    assert.ok(csrfCookie, 'CSRF cookie must be issued by /api/auth/csrf');

    // Retrieve seeded stocks
    seededNseStock = await prisma.stock.findFirst({
      where: { symbol: 'RELIANCE', segment: 'NSE_EQ' },
      include: { exchange: true },
    });
    assert.ok(seededNseStock, 'Seeded RELIANCE stock must exist in test database');

    seededBseStock = await prisma.stock.findFirst({
      where: { symbol: '500325', segment: 'BSE_EQ' },
      include: { exchange: true },
    });
    assert.ok(seededBseStock, 'Seeded 500325 stock must exist in test database');
  });

  beforeEach(async () => {
    try {
      const keys = await redisClient.keys('stocksense:ratelimit:*');
      if (keys.length > 0) await redisClient.del(keys);
    } catch {}
  });

  after(async () => {
    await prisma.user.deleteMany({
      where: { email: { contains: 'e2e.' } },
    });
  });

  // -------------------------------------------------------------
  // Scenario 1: Unauthenticated Public Market Browsing
  // -------------------------------------------------------------
  describe('1. Unauthenticated Public Browsing & Guest Access', () => {
    test('guest can browse stock catalogue without credentials', async () => {
      const res = await request(app).get('/api/stocks');
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(Array.isArray(res.body.data.stocks));
    });

    test('guest can access market overview aggregate without credentials', async () => {
      const res = await request(app).get('/api/market/overview');
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.data.summary);
    });

    test('guest can inspect specific stock details and prices', async () => {
      const res = await request(app).get(`/api/stocks/${seededNseStock.id}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.symbol, 'RELIANCE');
    });

    test('guest is strictly rejected from protected account endpoints with 401', async () => {
      const resWl = await request(app).get('/api/watchlists');
      assert.equal(resWl.status, 401);
      assert.equal(resWl.body.error.code, 'UNAUTHORIZED');

      const resAlerts = await request(app).get('/api/alerts');
      assert.equal(resAlerts.status, 401);
      assert.equal(resAlerts.body.error.code, 'UNAUTHORIZED');
    });
  });

  // -------------------------------------------------------------
  // Scenarios 2 & 3: Registration, Login & Session Cookies
  // -------------------------------------------------------------
  describe('2. User Registration & Login Authentication Scenarios', () => {
    const userEmail = 'e2e.reglogin@example.com';
    let userCookies = [];
    let userId = '';

    after(async () => {
      await prisma.user.deleteMany({ where: { email: userEmail } });
    });

    test('visitor can register a new account and receive session cookies', async () => {
      const regRes = await request(app)
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          fullName: 'Registration Test User',
          email: userEmail,
          password: testPassword,
        });

      assert.equal(regRes.status, 201);
      assert.equal(regRes.body.success, true);
      assert.equal(regRes.body.data.user.email, userEmail.toLowerCase());

      userId = regRes.body.data.user.id;
      userCookies = regRes.headers['set-cookie'] || [];

      // Verify cookies issued with exact paths
      const accessCookie = userCookies.find((c) => c.startsWith('stocksense_access_token='));
      const refreshCookie = userCookies.find((c) => c.startsWith('stocksense_refresh_token='));
      assert.ok(accessCookie, 'Access token cookie must be set');
      assert.ok(accessCookie.includes('Path=/api'), 'Access token cookie must specify Path=/api');
      assert.ok(refreshCookie, 'Refresh token cookie must be set');
      assert.ok(refreshCookie.includes('Path=/api/auth'), 'Refresh token cookie must specify Path=/api/auth');
    });

    test('registration automatically creates exactly one default watchlist', async () => {
      const wlRes = await request(app)
        .get('/api/watchlists')
        .set('Cookie', [...userCookies]);

      assert.equal(wlRes.status, 200);
      assert.equal(wlRes.body.data.watchlists.length, 1);
      assert.equal(wlRes.body.data.watchlists[0].name, 'Default Watchlist');
      assert.equal(wlRes.body.data.watchlists[0].isDefault, true);
    });

    test('user can log in with valid credentials and update lastLoginAt', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          email: userEmail,
          password: testPassword,
        });

      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.body.success, true);
      assert.equal(loginRes.body.data.user.email, userEmail.toLowerCase());

      const dbUser = await prisma.user.findUnique({ where: { id: userId } });
      assert.ok(dbUser.lastLoginAt, 'lastLoginAt must be populated in database');

      userCookies = loginRes.headers['set-cookie'] || [];
    });

    test('login with invalid password fails with 401 without timing leak', async () => {
      const badRes = await request(app)
        .post('/api/auth/login')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          email: userEmail,
          password: 'WrongPassword2026!Invalid',
        });

      assert.equal(badRes.status, 401);
      assert.equal(badRes.body.error.code, 'INVALID_CREDENTIALS');
    });
  });

  // -------------------------------------------------------------
  // Scenarios 4, 5 & 6: Session Restoration, Refresh & Replay
  // -------------------------------------------------------------
  describe('3. Session Restoration, Refresh Rotation & Replay Protection', () => {
    const userEmail = 'e2e.rotation@example.com';
    let userCookies = [];
    let userId = '';
    let sessionId = '';

    before(async () => {
      const reg = await request(app)
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          fullName: 'Rotation Test User',
          email: userEmail,
          password: testPassword,
        });
      userId = reg.body.data.user.id;
      userCookies = reg.headers['set-cookie'] || [];

      const session = await prisma.userSession.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
      sessionId = session.id;
    });

    after(async () => {
      await prisma.user.deleteMany({ where: { email: userEmail } });
    });

    test('authenticated session is verified via GET /api/auth/me', async () => {
      const meRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [...userCookies]);

      assert.equal(meRes.status, 200);
      assert.equal(meRes.body.data.user.email, userEmail.toLowerCase());
    });

    test('one-time refresh token rotation issues fresh tokens and updates database', async () => {
      const refreshCookie = userCookies.find((c) => c.startsWith('stocksense_refresh_token='));
      assert.ok(refreshCookie, 'Refresh cookie must exist');

      const refRes = await request(app)
        .post('/api/auth/refresh')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [refreshCookie, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      assert.equal(refRes.status, 200);
      assert.equal(refRes.body.success, true);

      const newCookies = refRes.headers['set-cookie'] || [];
      const newRefreshCookie = newCookies.find((c) => c.startsWith('stocksense_refresh_token='));
      assert.ok(newRefreshCookie, 'Rotated refresh token must be issued');

      // Attempting to reuse the consumed old refresh token must trigger replay detection
      const replayRes = await request(app)
        .post('/api/auth/refresh')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [refreshCookie, csrfCookie]) // Reusing old consumed token!
        .set('Origin', 'http://localhost:5173');

      assert.equal(replayRes.status, 401);
      assert.equal(replayRes.body.error.code, 'TOKEN_REUSE_DETECTED');

      // Replay detection must revoke the entire session family in PostgreSQL
      const sessionInDb = await prisma.userSession.findUnique({
        where: { id: sessionId },
      });
      assert.ok(sessionInDb.revokedAt !== null, 'Session family must be revoked upon replay detection');
    });
  });

  // -------------------------------------------------------------
  // Scenario 10: Inactive User Immediate Revocation
  // -------------------------------------------------------------
  describe('4. Deactivated User Immediate Revocation', () => {
    const userEmail = 'e2e.deactivated@example.com';
    let inactiveUserId = '';
    let inactiveCookies = [];

    before(async () => {
      const reg = await request(app)
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          fullName: 'Deactivated Test User',
          email: userEmail,
          password: testPassword,
        });
      inactiveUserId = reg.body.data.user.id;
      inactiveCookies = reg.headers['set-cookie'] || [];
    });

    after(async () => {
      await prisma.user.deleteMany({ where: { email: userEmail } });
    });

    test('deactivating user in PostgreSQL immediately rejects active session on next request', async () => {
      // 1. Session is active initially
      const meBefore = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [...inactiveCookies]);
      assert.equal(meBefore.status, 200);

      // 2. Administrator deactivates user in PostgreSQL
      await prisma.user.update({
        where: { id: inactiveUserId },
        data: { isActive: false },
      });

      // 3. User makes request with existing active session: must be rejected with 403
      const meAfter = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [...inactiveCookies]);

      assert.equal(meAfter.status, 403);
      assert.equal(meAfter.body.error.code, 'ACCOUNT_DEACTIVATED');

      // 4. Attempting to refresh token must also be rejected with 403
      const refreshCookie = inactiveCookies.find((c) => c.startsWith('stocksense_refresh_token='));
      const refRes = await request(app)
        .post('/api/auth/refresh')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [refreshCookie, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      assert.equal(refRes.status, 403);
      assert.equal(refRes.body.error.code, 'ACCOUNT_DEACTIVATED');
    });
  });

  // -------------------------------------------------------------
  // Scenario 8 & 9: Server-Side Logout & Session Revocation
  // -------------------------------------------------------------
  describe('5. Logout & Session Invalidation Scenarios', () => {
    const userEmail = 'e2e.logout@example.com';
    let freshCookies = [];
    let freshSessionId = '';

    before(async () => {
      const reg = await request(app)
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          fullName: 'Logout Test User',
          email: userEmail,
          password: testPassword,
        });
      freshCookies = reg.headers['set-cookie'] || [];
      const dbSession = await prisma.userSession.findFirst({
        where: { userId: reg.body.data.user.id },
        orderBy: { createdAt: 'desc' },
      });
      freshSessionId = dbSession.id;
    });

    after(async () => {
      await prisma.user.deleteMany({ where: { email: userEmail } });
    });

    test('logout revokes PostgreSQL session and clears cookies with matching paths', async () => {
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...freshCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      assert.equal(logoutRes.status, 200);
      assert.equal(logoutRes.body.success, true);

      // Verify clear-cookie headers
      const clearedCookies = logoutRes.headers['set-cookie'] || [];
      const accessCleared = clearedCookies.find((c) => c.includes('stocksense_access_token=;'));
      const refreshCleared = clearedCookies.find((c) => c.includes('stocksense_refresh_token=;'));
      assert.ok(accessCleared, 'Access token cookie must be cleared');
      assert.ok(accessCleared.includes('Path=/api'), 'Access clear cookie must specify Path=/api');
      assert.ok(refreshCleared, 'Refresh token cookie must be cleared');
      assert.ok(refreshCleared.includes('Path=/api/auth'), 'Refresh clear cookie must specify Path=/api/auth');

      // Verify PostgreSQL revocation timestamp set
      const dbSession = await prisma.userSession.findUnique({
        where: { id: freshSessionId },
      });
      assert.ok(dbSession.revokedAt !== null, 'Session revokedAt must be recorded in database');

      // Post-logout request with previous access token is rejected
      const meRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [...freshCookies]);

      assert.equal(meRes.status, 401);
      assert.equal(meRes.body.error.code, 'SESSION_REVOKED');
    });
  });

  // -------------------------------------------------------------
  // Scenario 4: Multi-User Isolation & Tenant Boundaries
  // -------------------------------------------------------------
  describe('6. Multi-User Isolation & Tenant Boundaries', () => {
    const userAEmail = 'e2e.tenantA@example.com';
    const userBEmail = 'e2e.tenantB@example.com';

    let userACookies = [];
    let userBCookies = [];
    let userAWatchlistId = '';
    let userBWatchlistId = '';
    let userAAlertId = '';

    before(async () => {
      await prisma.user.deleteMany({
        where: { email: { in: [userAEmail, userBEmail] } },
      });

      // Register User A
      const regA = await request(app)
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          fullName: 'Tenant User A',
          email: userAEmail,
          password: testPassword,
        });
      userACookies = regA.headers['set-cookie'] || [];

      // Register User B
      const regB = await request(app)
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          fullName: 'Tenant User B',
          email: userBEmail,
          password: testPassword,
        });
      userBCookies = regB.headers['set-cookie'] || [];

      // Get User A and User B default watchlists
      const resWlA = await request(app).get('/api/watchlists').set('Cookie', [...userACookies]);
      userAWatchlistId = resWlA.body.data.watchlists[0].id;

      const resWlB = await request(app).get('/api/watchlists').set('Cookie', [...userBCookies]);
      userBWatchlistId = resWlB.body.data.watchlists[0].id;

      // User A adds stock RELIANCE
      await request(app)
        .post(`/api/watchlists/${userAWatchlistId}/items`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ stockId: seededNseStock.id });

      // User B adds stock 500325 (BSE)
      await request(app)
        .post(`/api/watchlists/${userBWatchlistId}/items`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userBCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ stockId: seededBseStock.id });

      // User A creates price alert
      const alertRes = await request(app)
        .post('/api/alerts')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          stockId: seededNseStock.id,
          alertType: 'PRICE_ABOVE',
          targetValue: 3500,
        });
      userAAlertId = alertRes.body.data.alert.id;
    });

    after(async () => {
      await prisma.user.deleteMany({
        where: { email: { in: [userAEmail, userBEmail] } },
      });
    });

    test('User A lists watchlists and sees only their own stocks', async () => {
      const res = await request(app).get('/api/watchlists').set('Cookie', [...userACookies]);
      assert.equal(res.status, 200);
      const symbols = res.body.data.watchlists[0].items.map((i) => i.stock.symbol);
      assert.ok(symbols.includes('RELIANCE'));
      assert.ok(!symbols.includes('500325'));
    });

    test('User B lists watchlists and sees only their own stocks', async () => {
      const res = await request(app).get('/api/watchlists').set('Cookie', [...userBCookies]);
      assert.equal(res.status, 200);
      const symbols = res.body.data.watchlists[0].items.map((i) => i.stock.symbol);
      assert.ok(symbols.includes('500325'));
      assert.ok(!symbols.includes('RELIANCE'));
    });

    test('User B cannot view, modify, or delete User A watchlist by ID', async () => {
      const viewRes = await request(app)
        .get(`/api/watchlists/${userAWatchlistId}`)
        .set('Cookie', [...userBCookies]);
      assert.equal(viewRes.status, 404);
      assert.equal(viewRes.body.error.code, 'WATCHLIST_NOT_FOUND');

      const renameRes = await request(app)
        .put(`/api/watchlists/${userAWatchlistId}`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userBCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ name: 'Hacked Watchlist' });
      assert.equal(renameRes.status, 404);

      const delRes = await request(app)
        .delete(`/api/watchlists/${userAWatchlistId}`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userBCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');
      assert.equal(delRes.status, 404);
    });

    test('User B cannot view, modify, or delete User A alert by ID', async () => {
      const viewRes = await request(app)
        .get(`/api/alerts/${userAAlertId}`)
        .set('Cookie', [...userBCookies]);
      assert.equal(viewRes.status, 404);
      assert.equal(viewRes.body.error.code, 'ALERT_NOT_FOUND');

      const delRes = await request(app)
        .delete(`/api/alerts/${userAAlertId}`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userBCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');
      assert.equal(delRes.status, 404);
    });
  });

  // -------------------------------------------------------------
  // Scenario 3: Cookie, CSRF, CORS & Browser Security Controls
  // -------------------------------------------------------------
  describe('7. Cookie Attributes, CSRF, CORS & Origin Security', () => {
    const userEmail = 'e2e.csrf@example.com';
    let userCookies = [];

    before(async () => {
      const reg = await request(app)
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          fullName: 'CSRF Test User',
          email: userEmail,
          password: testPassword,
        });
      userCookies = reg.headers['set-cookie'] || [];
    });

    after(async () => {
      await prisma.user.deleteMany({ where: { email: userEmail } });
    });

    test('rejects state mutation with missing CSRF token with 403', async () => {
      const res = await request(app)
        .post('/api/watchlists')
        .set('Cookie', [...userCookies])
        .set('Origin', 'http://localhost:5173')
        .send({ name: 'New Watchlist' });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'MISSING_CSRF_TOKEN');
    });

    test('rejects state mutation with tampered CSRF signature with 403', async () => {
      const res = await request(app)
        .post('/api/watchlists')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userCookies, 'stocksense_csrf_token=tampered_signature.12345'])
        .set('Origin', 'http://localhost:5173')
        .send({ name: 'New Watchlist' });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'INVALID_CSRF_SIGNATURE');
    });

    test('rejects state mutation with mismatched CSRF tokens with 403', async () => {
      const res = await request(app)
        .post('/api/watchlists')
        .set('X-CSRF-Token', 'different_raw_token_that_does_not_match_cookie')
        .set('Cookie', [...userCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ name: 'New Watchlist' });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'CSRF_TOKEN_MISMATCH');
    });

    test('rejects cross-site request with untrusted Origin header with 403', async () => {
      const res = await request(app)
        .post('/api/watchlists')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userCookies, csrfCookie])
        .set('Origin', 'https://malicious-phishing-site.com')
        .send({ name: 'New Watchlist' });

      assert.equal(res.status, 403);
      assert.ok(
        res.body.error.code === 'FORBIDDEN_ORIGIN' || res.body.error.code === 'CORS_FORBIDDEN',
        `Expected FORBIDDEN_ORIGIN or CORS_FORBIDDEN, got ${res.body.error.code}`
      );
    });

    test('enforces CSRF when both cookie and Bearer authorization header are present', async () => {
      // Cookie is present + Bearer header present: must NOT bypass CSRF!
      const res = await request(app)
        .post('/api/watchlists')
        .set('Authorization', 'Bearer some_token')
        .set('Cookie', [...userCookies]) // Auth cookie present, but missing CSRF header!
        .set('Origin', 'http://localhost:5173')
        .send({ name: 'New Watchlist' });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'MISSING_CSRF_TOKEN');
    });

    test('bypasses CSRF only for pure non-cookie Bearer requests', async () => {
      // Pure Bearer request without cookies should pass CSRF middleware (handled by requireAuth)
      const res = await request(app)
        .post('/api/watchlists')
        .set('Authorization', 'Bearer invalid_bearer_token')
        .send({ name: 'New Watchlist' });

      // Passes CSRF middleware, rejected by requireAuth with 401 INVALID_TOKEN (not 403 CSRF)
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_TOKEN');
    });
  });
});
