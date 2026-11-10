import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';
import redisClient from '../src/config/redis.js';
import { config } from '../src/config/index.js';

describe('Milestone 4 — Phase 4B: Persistent Watchlists & Stock Alerts Integration Tests', () => {
  const userAEmail = 'watchlist.userA.test@example.com';
  const userBEmail = 'watchlist.userB.test@example.com';
  const testPassword = 'StrongPassword2026!Staple';

  let userACookies = [];
  let userBCookies = [];
  let userAId = '';
  let userBId = '';

  let csrfToken = '';
  let csrfCookie = '';

  let seededStockNse = null;
  let seededStockBse = null;

  before(async () => {
    // Safety check: ensure running against test database
    assert.ok(
      process.env.TEST_DATABASE_URL || config.database.url.includes('test'),
      'Safety check: Tests must run against stocksense_test_db'
    );

    // Clean up test data and rate limit counters
    try {
      const keys = await redisClient.keys('stocksense:ratelimit:register:*');
      if (keys.length > 0) await redisClient.del(keys);
    } catch {}

    await prisma.user.deleteMany({
      where: { email: { contains: 'watchlist.user' } },
    });

    // Obtain CSRF token
    const csrfRes = await request(app).get('/api/auth/csrf');
    assert.equal(csrfRes.status, 200);
    csrfToken = csrfRes.body.data.csrfToken;
    const setCookie = csrfRes.headers['set-cookie'] || [];
    csrfCookie = setCookie.find((c) => c.startsWith('stocksense_csrf_token='));

    // 1. Register User A
    const regARes = await request(app)
      .post('/api/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .set('Cookie', [csrfCookie])
      .set('Origin', 'http://localhost:5173')
      .send({
        fullName: 'User A Watchlist',
        email: userAEmail,
        password: testPassword,
      });
    assert.equal(regARes.status, 201);
    userAId = regARes.body.data.user.id;
    userACookies = regARes.headers['set-cookie'] || [];

    // 2. Register User B
    const regBRes = await request(app)
      .post('/api/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .set('Cookie', [csrfCookie])
      .set('Origin', 'http://localhost:5173')
      .send({
        fullName: 'User B Watchlist',
        email: userBEmail,
        password: testPassword,
      });
    assert.equal(regBRes.status, 201);
    userBId = regBRes.body.data.user.id;
    userBCookies = regBRes.headers['set-cookie'] || [];

    // 3. Fetch seeded stocks for testing
    seededStockNse = await prisma.stock.findFirst({
      where: { symbol: 'RELIANCE', segment: 'NSE_EQ' },
      include: { exchange: true },
    });
    assert.ok(seededStockNse, 'Seeded RELIANCE stock must exist in test database');

    seededStockBse = await prisma.stock.findFirst({
      where: { symbol: '500325', segment: 'BSE_EQ' },
      include: { exchange: true },
    });
    assert.ok(seededStockBse, 'Seeded 500325 BSE stock must exist in test database');
  });

  after(async () => {
    await prisma.user.deleteMany({
      where: { email: { contains: 'watchlist.user' } },
    });
  });

  // -------------------------------------------------------------
  // 1. Authentication & Access Control
  // -------------------------------------------------------------
  describe('1. Authentication & Security Enforcement', () => {
    test('should reject unauthenticated GET /api/watchlists with 401', async () => {
      const res = await request(app).get('/api/watchlists');
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'UNAUTHORIZED');
    });

    test('should reject unauthenticated POST /api/watchlists with 401', async () => {
      const res = await request(app)
        .post('/api/watchlists')
        .send({ name: 'My Watchlist' });
      assert.equal(res.status, 401);
    });

    test('should reject unauthenticated POST /api/watchlists/:id/items with 401', async () => {
      const res = await request(app)
        .post('/api/watchlists/some-id/items')
        .send({ stockId: seededStockNse.id });
      assert.equal(res.status, 401);
    });

    test('should reject unauthenticated DELETE /api/watchlists/:id/items/:stockId with 401', async () => {
      const res = await request(app)
        .delete(`/api/watchlists/some-id/items/${seededStockNse.id}`);
      assert.equal(res.status, 401);
    });
  });

  // -------------------------------------------------------------
  // 2. Watchlist Management & Ownership Scoping
  // -------------------------------------------------------------
  describe('2. Watchlist CRUD & Ownership Isolation', () => {
    let userAWatchlistId = '';

    test('should list User A default watchlist created upon registration', async () => {
      const res = await request(app)
        .get('/api/watchlists')
        .set('Cookie', [...userACookies]);

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(Array.isArray(res.body.data.watchlists));
      assert.equal(res.body.data.watchlists.length, 1);

      const defaultWl = res.body.data.watchlists[0];
      assert.equal(defaultWl.name, 'Default Watchlist');
      assert.equal(defaultWl.isDefault, true);
      assert.equal(defaultWl.itemCount, 0);
      assert.deepEqual(defaultWl.items, []);
      userAWatchlistId = defaultWl.id;
    });

    test('should create a custom watchlist for User A', async () => {
      const res = await request(app)
        .post('/api/watchlists')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ name: 'Banking & Energy' });

      assert.equal(res.status, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.watchlist.name, 'Banking & Energy');
      assert.equal(res.body.data.watchlist.isDefault, false);
      assert.equal(res.body.data.watchlist.itemCount, 0);
    });

    test('should reject duplicate watchlist name for the same user with 409', async () => {
      const res = await request(app)
        .post('/api/watchlists')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ name: 'Banking & Energy' });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'WATCHLIST_NAME_EXISTS');
    });

    test('should reject invalid or empty watchlist names with 400', async () => {
      const resEmpty = await request(app)
        .post('/api/watchlists')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ name: '   ' });

      assert.equal(resEmpty.status, 400);
      assert.equal(resEmpty.body.error.code, 'INVALID_WATCHLIST_NAME');

      const resTooLong = await request(app)
        .post('/api/watchlists')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ name: 'A'.repeat(51) });

      assert.equal(resTooLong.status, 400);
      assert.equal(resTooLong.body.error.code, 'INVALID_WATCHLIST_NAME');
    });

    test('should prevent User B from viewing User A custom or default watchlist', async () => {
      // User B attempts to access User A's watchlist ID
      const res = await request(app)
        .get(`/api/watchlists/${userAWatchlistId}`)
        .set('Cookie', [...userBCookies]);

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'WATCHLIST_NOT_FOUND');
    });

    test('should prevent User B from renaming User A watchlist', async () => {
      const res = await request(app)
        .put(`/api/watchlists/${userAWatchlistId}`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userBCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ name: 'Hacked Name' });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'WATCHLIST_NOT_FOUND');
    });

    test('should prevent deletion of primary default watchlist', async () => {
      const res = await request(app)
        .delete(`/api/watchlists/${userAWatchlistId}`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'CANNOT_DELETE_DEFAULT_WATCHLIST');
    });

    test('should prevent duplicate default watchlist creation via PostgreSQL partial unique index', async () => {
      await assert.rejects(
        async () => {
          await prisma.watchlist.create({
            data: {
              userId: userAId,
              name: 'Duplicate Default Watchlist',
              isDefault: true,
            },
          });
        },
        (err) => {
          assert.match(
            err.message,
            /Unique constraint failed on the fields: \(`userId`\)|watchlists_userId_isDefault_unique_idx/
          );
          return true;
        }
      );
    });
  });

  // -------------------------------------------------------------
  // 3. Watchlist Items CRUD & Constraint Enforcement
  // -------------------------------------------------------------
  describe('3. Watchlist Items & Stock Association', () => {
    let userAWatchlistId = '';

    before(async () => {
      const res = await request(app)
        .get('/api/watchlists')
        .set('Cookie', [...userACookies]);
      userAWatchlistId = res.body.data.watchlists[0].id;
    });

    test('should successfully add a valid active stock to User A watchlist', async () => {
      const res = await request(app)
        .post(`/api/watchlists/${userAWatchlistId}/items`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ stockId: seededStockNse.id });

      assert.equal(res.status, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.item.stock.symbol, 'RELIANCE');
      assert.equal(res.body.data.item.stock.exchange, 'NSE');
      assert.ok(res.body.data.item.addedAt);
    });

    test('should reject adding a duplicate stock to the same watchlist with 409', async () => {
      const res = await request(app)
        .post(`/api/watchlists/${userAWatchlistId}/items`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ stockId: seededStockNse.id });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'STOCK_ALREADY_IN_WATCHLIST');
    });

    test('should add a second distinct stock (BSE) to the same watchlist', async () => {
      const res = await request(app)
        .post(`/api/watchlists/${userAWatchlistId}/items`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ stockId: seededStockBse.id });

      assert.equal(res.status, 201);
      assert.equal(res.body.data.item.stock.symbol, '500325');
      assert.equal(res.body.data.item.stock.exchange, 'BSE');
    });

    test('should list all added stocks in User A watchlist with complete metadata', async () => {
      const res = await request(app)
        .get(`/api/watchlists/${userAWatchlistId}`)
        .set('Cookie', [...userACookies]);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.watchlist.itemCount, 2);
      assert.equal(res.body.data.watchlist.items.length, 2);

      const symbols = res.body.data.watchlist.items.map((i) => i.stock.symbol);
      assert.ok(symbols.includes('RELIANCE'));
      assert.ok(symbols.includes('500325'));
    });

    test('should reject adding non-existent stock with 404', async () => {
      const res = await request(app)
        .post(`/api/watchlists/${userAWatchlistId}/items`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ stockId: '00000000-0000-0000-0000-000000000000' });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'STOCK_NOT_FOUND');
    });

    test('should reject adding inactive stock with 400 STOCK_INACTIVE', async () => {
      // Create a temporary inactive stock for testing
      const nseEx = await prisma.exchange.findUnique({ where: { code: 'NSE' } });
      const inactiveStock = await prisma.stock.create({
        data: {
          exchangeId: nseEx.id,
          symbol: 'INACTIVE_TEST_STOCK',
          companyName: 'Inactive Test Co',
          instrumentToken: 'NSE_EQ|INACTIVE_TEST_01',
          segment: 'NSE_EQ',
          instrumentType: 'EQUITY',
          series: 'EQ',
          isActive: false, // Inactive!
        },
      });

      try {
        const res = await request(app)
          .post(`/api/watchlists/${userAWatchlistId}/items`)
          .set('X-CSRF-Token', csrfToken)
          .set('Cookie', [...userACookies, csrfCookie])
          .set('Origin', 'http://localhost:5173')
          .send({ stockId: inactiveStock.id });

        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'STOCK_INACTIVE');
      } finally {
        await prisma.stock.delete({ where: { id: inactiveStock.id } });
      }
    });

    test('should prevent User B from adding stocks to User A watchlist', async () => {
      const res = await request(app)
        .post(`/api/watchlists/${userAWatchlistId}/items`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userBCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ stockId: seededStockNse.id });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'WATCHLIST_NOT_FOUND');
    });

    test('should prevent User B from removing stocks from User A watchlist', async () => {
      const res = await request(app)
        .delete(`/api/watchlists/${userAWatchlistId}/items/${seededStockNse.id}`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userBCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'WATCHLIST_NOT_FOUND');
    });

    test('should successfully remove a stock from User A watchlist', async () => {
      const res = await request(app)
        .delete(`/api/watchlists/${userAWatchlistId}/items/${seededStockNse.id}`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);

      // Verify removal in database
      const checkRes = await request(app)
        .get(`/api/watchlists/${userAWatchlistId}`)
        .set('Cookie', [...userACookies]);

      assert.equal(checkRes.body.data.watchlist.itemCount, 1);
      const remainingSymbols = checkRes.body.data.watchlist.items.map((i) => i.stock.symbol);
      assert.ok(!remainingSymbols.includes('RELIANCE'));
      assert.ok(remainingSymbols.includes('500325'));
    });

    test('should return 404 when attempting to remove a stock not present in watchlist', async () => {
      const res = await request(app)
        .delete(`/api/watchlists/${userAWatchlistId}/items/${seededStockNse.id}`) // Already removed!
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'STOCK_NOT_IN_WATCHLIST');
    });

    test('should add stock by verified instrument key (instrumentToken)', async () => {
      const res = await request(app)
        .post(`/api/watchlists/${userAWatchlistId}/items`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ instrumentToken: 'NSE_EQ|INE467B01029' });

      assert.equal(res.status, 201);
      assert.equal(res.body.data.item.stock.symbol, 'TCS');
      assert.equal(res.body.data.item.stock.exchange, 'NSE');
    });

    test('should reject ambiguous symbol with HTTP 409 AMBIGUOUS_STOCK_IDENTIFIER when present on multiple exchanges', async () => {
      const bseExchange = await prisma.exchange.findUnique({ where: { code: 'BSE' } });
      const bseInfy = await prisma.stock.create({
        data: {
          exchangeId: bseExchange.id,
          symbol: 'INFY',
          companyName: 'Infosys Limited (BSE Test)',
          segment: 'BSE_EQ',
          instrumentType: 'EQ',
          isin: 'INE009A01021',
          instrumentToken: 'BSE_EQ|INE009A01021_TEST',
          lotSize: 1,
          tickSize: 0.05,
          isActive: true,
        },
      });

      try {
        const res = await request(app)
          .post(`/api/watchlists/${userAWatchlistId}/items`)
          .set('X-CSRF-Token', csrfToken)
          .set('Cookie', [...userACookies, csrfCookie])
          .set('Origin', 'http://localhost:5173')
          .send({ symbol: 'INFY' });

        assert.equal(res.status, 409);
        assert.equal(res.body.error.code, 'AMBIGUOUS_STOCK_IDENTIFIER');
        assert.ok(Array.isArray(res.body.error.details.matches));
        assert.equal(res.body.error.details.matches.length, 2);
      } finally {
        await prisma.stock.delete({ where: { id: bseInfy.id } });
      }
    });

    test('should successfully resolve ambiguous symbol when exchange parameter is explicitly provided', async () => {
      const bseExchange = await prisma.exchange.findUnique({ where: { code: 'BSE' } });
      const bseInfy = await prisma.stock.create({
        data: {
          exchangeId: bseExchange.id,
          symbol: 'INFY',
          companyName: 'Infosys Limited (BSE Test)',
          segment: 'BSE_EQ',
          instrumentType: 'EQ',
          isin: 'INE009A01021',
          instrumentToken: 'BSE_EQ|INE009A01021_TEST',
          lotSize: 1,
          tickSize: 0.05,
          isActive: true,
        },
      });

      try {
        const res = await request(app)
          .post(`/api/watchlists/${userAWatchlistId}/items`)
          .set('X-CSRF-Token', csrfToken)
          .set('Cookie', [...userACookies, csrfCookie])
          .set('Origin', 'http://localhost:5173')
          .send({ symbol: 'INFY', exchange: 'NSE' });

        assert.equal(res.status, 201);
        assert.equal(res.body.data.item.stock.symbol, 'INFY');
        assert.equal(res.body.data.item.stock.exchange, 'NSE');
      } finally {
        await prisma.stock.delete({ where: { id: bseInfy.id } });
      }
    });
  });

  // -------------------------------------------------------------
  // 4. Guest Watchlist Synchronization Preparation Endpoint
  // -------------------------------------------------------------
  describe('4. Guest Watchlist Synchronization Preparation', () => {
    test('should idempotently ingest guest items into User B default watchlist', async () => {
      const guestItems = [
        { stockId: seededStockNse.id },
        { symbol: '500325', exchange: 'BSE' },
        { stockId: 'non-existent-id' }, // Should be safely ignored
      ];

      const res = await request(app)
        .post('/api/watchlists/sync')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userBCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ items: guestItems });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.addedCount, 2);

      // Re-running sync with identical items should be idempotent (0 added)
      const resIdempotent = await request(app)
        .post('/api/watchlists/sync')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userBCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ items: guestItems });

      assert.equal(resIdempotent.status, 200);
      assert.equal(resIdempotent.body.data.addedCount, 0);
    });

    test('should accurately report addedCount, skippedCount, invalidCount, and preserve existing server items', async () => {
      const mixedItems = [
        { instrumentToken: 'NSE_EQ|INE090A01021' }, // ICICIBANK
        { stockId: seededStockNse.id },             // RELIANCE (already present for User B)
        { symbol: 'NONEXISTENT_STOCK_TICKER' },
        null,
      ];

      const res = await request(app)
        .post('/api/watchlists/sync')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userBCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ items: mixedItems });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.addedCount, 1);
      assert.equal(res.body.data.skippedCount, 1);
      assert.equal(res.body.data.invalidCount, 2);
      assert.equal(res.body.data.watchlist.itemCount, 3);

      // Verify User A watchlist was completely unaffected (cross-user isolation)
      const userARes = await request(app)
        .get('/api/watchlists')
        .set('Cookie', [...userACookies]);
      const userAItems = userARes.body.data.watchlists[0].items;
      const userASymbols = userAItems.map((i) => i.stock.symbol);
      assert.ok(!userASymbols.includes('ICICIBANK'));
    });
  });

  // -------------------------------------------------------------
  // 5. User Stock Alerts & Ownership Isolation
  // -------------------------------------------------------------
  describe('5. Stock Alerts CRUD & Ownership Isolation', () => {
    let userAAlertId = '';

    test('should create a price alert for User A', async () => {
      const res = await request(app)
        .post('/api/alerts')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          stockId: seededStockNse.id,
          alertType: 'PRICE_ABOVE',
          targetValue: 3100.5,
          notes: 'Target resistance breakout alert',
        });

      assert.equal(res.status, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.alert.alertType, 'PRICE_ABOVE');
      assert.equal(res.body.data.alert.targetValue, 3100.5);
      assert.equal(res.body.data.alert.notes, 'Target resistance breakout alert');
      assert.equal(res.body.data.alert.isActive, true);
      assert.equal(res.body.data.alert.stock.symbol, 'RELIANCE');
      userAAlertId = res.body.data.alert.id;
    });

    test('should list only User A alerts when queried by User A', async () => {
      const res = await request(app)
        .get('/api/alerts')
        .set('Cookie', [...userACookies]);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.alerts.length, 1);
      assert.equal(res.body.data.alerts[0].id, userAAlertId);
    });

    test('should return empty list when User B queries /api/alerts', async () => {
      const res = await request(app)
        .get('/api/alerts')
        .set('Cookie', [...userBCookies]);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.alerts.length, 0);
    });

    test('should prevent User B from viewing User A alert by ID', async () => {
      const res = await request(app)
        .get(`/api/alerts/${userAAlertId}`)
        .set('Cookie', [...userBCookies]);

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'ALERT_NOT_FOUND');
    });

    test('should prevent User B from updating User A alert', async () => {
      const res = await request(app)
        .patch(`/api/alerts/${userAAlertId}`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userBCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ targetValue: 3500 });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'ALERT_NOT_FOUND');
    });

    test('should prevent User B from deleting User A alert', async () => {
      const res = await request(app)
        .delete(`/api/alerts/${userAAlertId}`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userBCookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'ALERT_NOT_FOUND');
    });

    test('should update User A alert by User A', async () => {
      const res = await request(app)
        .patch(`/api/alerts/${userAAlertId}`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({ targetValue: 3200, isActive: false });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.alert.targetValue, 3200);
      assert.equal(res.body.data.alert.isActive, false);
    });

    test('should delete User A alert by User A', async () => {
      const res = await request(app)
        .delete(`/api/alerts/${userAAlertId}`)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173');

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);

      // Verify deletion in DB
      const checkRes = await request(app)
        .get(`/api/alerts/${userAAlertId}`)
        .set('Cookie', [...userACookies]);

      assert.equal(checkRes.status, 404);
    });

    test('should reject alert creation with invalid parameters', async () => {
      const resBadType = await request(app)
        .post('/api/alerts')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          stockId: seededStockNse.id,
          alertType: 'INVALID_TYPE',
          targetValue: 3000,
        });

      assert.equal(resBadType.status, 400);
      assert.equal(resBadType.body.error.code, 'INVALID_ALERT_TYPE');

      const resNegative = await request(app)
        .post('/api/alerts')
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [...userACookies, csrfCookie])
        .set('Origin', 'http://localhost:5173')
        .send({
          stockId: seededStockNse.id,
          alertType: 'PRICE_ABOVE',
          targetValue: -100,
        });

      assert.equal(resNegative.status, 400);
      assert.equal(resNegative.body.error.code, 'INVALID_TARGET_VALUE');
    });
  });
});
