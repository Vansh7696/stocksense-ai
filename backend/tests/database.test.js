import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import prisma, { assertTestDatabaseSafety } from '../src/config/prisma.js';
import { isRedisReady } from '../src/config/redis.js';
import { verifiedExchanges, verifiedStocks, seed } from '../prisma/seed.js';
import request from 'supertest';
import app from '../src/app.js';

describe('Milestone 2: Database & Relational Schema Integration Tests', () => {
  let isDbConnected = false;

  before(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      isDbConnected = true;
      console.log('✔ [Test Setup] PostgreSQL connection established successfully.');
    } catch (err) {
      isDbConnected = false;
      console.warn(`ℹ [Test Setup] PostgreSQL is currently offline (${err.message}).`);
    }
  });

  test('1. Prisma 6 Client models verification', () => {
    // Verify all 7 required models exist on the generated Prisma client
    const requiredModels = [
      'user',
      'exchange',
      'stock',
      'historicalPrice',
      'watchlist',
      'watchlistStock',
      'dataSourceLog',
    ];

    for (const model of requiredModels) {
      assert.ok(
        prisma[model],
        `Prisma client must expose delegate for model "${model}"`
      );
    }
  });

  test('2. Seed metadata verification (No fabricated data & valid ISINs)', () => {
    // Task 4: Verify exchanges
    assert.equal(verifiedExchanges.length, 2);
    const codes = verifiedExchanges.map((e) => e.code);
    assert.ok(codes.includes('NSE'));
    assert.ok(codes.includes('BSE'));

    // Task 4: Verify stocks metadata
    assert.ok(verifiedStocks.length >= 5);
    const symbols = verifiedStocks.map((s) => s.symbol);
    assert.ok(symbols.includes('RELIANCE'));
    assert.ok(symbols.includes('TCS'));
    assert.ok(symbols.includes('INFY'));
    assert.ok(symbols.includes('HDFCBANK'));
    assert.ok(symbols.includes('ICICIBANK'));

    // Task 4: Verify Indian ISIN format (12 alphanumeric chars starting with 'INE')
    for (const stock of verifiedStocks) {
      assert.match(
        stock.isin,
        /^INE[0-9A-Z]{9}$/,
        `Stock ${stock.symbol} must have a valid Indian ISIN`
      );
      // Strictly verify no fabricated prices or volumes are in the seed
      assert.equal(stock.price, undefined);
      assert.equal(stock.volume, undefined);
    }
  });

  test('3. Database health endpoint reflects actual connectivity', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const expectedDbStatus = isDbConnected ? 'CONNECTED' : 'DISCONNECTED';
    assert.equal(res.body.data.dependencies.database, expectedDbStatus);

    if (!isDbConnected) {
      assert.equal(res.body.data.status, 'UNHEALTHY');
      assert.ok(Array.isArray(res.body.data.issues));
    }
  });

  test('4. Redis connection state accurately tracked', () => {
    const redisStatus = isRedisReady();
    assert.equal(typeof redisStatus, 'boolean');
    // If Redis is offline, client must not crash the test suite
  });

  test('5. Live PostgreSQL CRUD, Foreign Keys & Unique Constraints', async (t) => {
    if (!isDbConnected) {
      t.skip('Skipping live DB CRUD test: PostgreSQL daemon is not active on localhost:5432 (Docker Desktop pending).');
      return;
    }

    // Isolated test exchange
    const testExchange = await prisma.exchange.create({
      data: {
        code: `TEST_${Date.now()}`,
        name: 'Test Exchange Organization',
        country: 'India',
        currency: 'INR',
      },
    });
    assert.ok(testExchange.id);

    try {
      // 1. Insert Stock linked by Foreign Key
      const testStock = await prisma.stock.create({
        data: {
          exchangeId: testExchange.id,
          symbol: 'TESTEQ',
          companyName: 'Test Equity Ltd',
          isin: 'INE999A01099',
          series: 'EQ',
        },
      });
      assert.equal(testStock.exchangeId, testExchange.id);

      // 2. Test Unique Constraint on [exchangeId, symbol]
      await assert.rejects(
        async () => {
          await prisma.stock.create({
            data: {
              exchangeId: testExchange.id,
              symbol: 'TESTEQ', // Duplicate symbol on same exchange!
              companyName: 'Duplicate Symbol Ltd',
            },
          });
        },
        (err) => {
          assert.equal(err.code, 'P2002'); // Prisma unique constraint violation code
          return true;
        },
        'Inserting duplicate symbol on same exchange must fail with P2002'
      );

      // 3. Test HistoricalPrice insertion & Decimal precision
      const timestamp = new Date('2026-11-06T00:00:00.000Z');
      const candle = await prisma.historicalPrice.create({
        data: {
          stockId: testStock.id,
          timestamp,
          open: '2540.50',
          high: '2580.00',
          low: '2530.25',
          close: '2575.80',
          volume: BigInt(1250000),
          interval: '1D',
          dataSource: 'UPSTOX',
        },
      });
      assert.equal(candle.stockId, testStock.id);
      assert.equal(candle.open.toString(), '2540.5');
      assert.equal(candle.volume.toString(), '1250000');
      assert.equal(typeof candle.volume, 'bigint', 'Prisma must store and return native BigInt for volume');

      // 4. Test Duplicate Candle Prevention on [stockId, timestamp, interval]
      await assert.rejects(
        async () => {
          await prisma.historicalPrice.create({
            data: {
              stockId: testStock.id,
              timestamp, // Exact same timestamp and interval!
              open: '2540.50',
              high: '2580.00',
              low: '2530.25',
              close: '2575.80',
              volume: BigInt(1250000),
              interval: '1D',
              dataSource: 'UPSTOX',
            },
          });
        },
        (err) => {
          assert.equal(err.code, 'P2002');
          return true;
        },
        'Duplicate historical candle must be rejected by unique constraint [stockId, timestamp, interval]'
      );

      // 5. Test Cascade Deletion: Deleting exchange should cascade to stock and candle
      await prisma.exchange.delete({
        where: { id: testExchange.id },
      });

      const deletedStock = await prisma.stock.findUnique({
        where: { id: testStock.id },
      });
      assert.equal(deletedStock, null, 'Stock must be cascade deleted when Exchange is deleted');

      const deletedCandle = await prisma.historicalPrice.findUnique({
        where: { id: candle.id },
      });
      assert.equal(deletedCandle, null, 'HistoricalPrice must be cascade deleted when Stock is deleted');
    } finally {
      // Ensure test cleanup
      await prisma.exchange.deleteMany({
        where: { id: testExchange.id },
      });
    }
  });

  test('6. Environment safety check prevents tests from running against development or production database', () => {
    // Development database is rejected
    assert.throws(
      () => assertTestDatabaseSafety('postgresql://stocksense_user:test_placeholder_password@localhost:5432/stocksense_db?schema=public'),
      (err) => err.message.includes('DATABASE SAFETY VIOLATION')
    );

    // Production database is rejected
    assert.throws(
      () => assertTestDatabaseSafety('postgresql://prod_user:secret@prod.host:5432/stocksense_prod?schema=public'),
      (err) => err.message.includes('DATABASE SAFETY VIOLATION')
    );

    // Missing / empty URL is rejected
    assert.throws(
      () => assertTestDatabaseSafety(''),
      (err) => err.message.includes('DATABASE SAFETY ERROR')
    );

    // Dedicated test database passes
    assert.doesNotThrow(
      () => assertTestDatabaseSafety('postgresql://stocksense_user:test_placeholder_password@localhost:5432/stocksense_test_db?schema=public')
    );
  });

  after(async () => {
    try {
      await prisma.$disconnect();
    } catch (e) {
      // Ignored during cleanup
    }
  });
});
