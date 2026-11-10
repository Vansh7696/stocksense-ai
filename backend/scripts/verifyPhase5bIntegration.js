import express from 'express';
import request from 'supertest';
import stockRoutes from '../src/routes/stock.routes.js';
import prisma from '../src/config/prisma.js';
import cacheService from '../src/services/cache.service.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const app = express();
app.use(express.json());
app.use('/api/stocks', stockRoutes);
app.use(errorHandler);

async function testLiveIntegration() {
  console.log('=== Testing Live Express <-> ML Service <-> Redis Integration ===\n');

  const symbols = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK'];

  for (const symbol of symbols) {
    const stock = await prisma.stock.findFirst({
      where: { symbol, exchange: { code: 'NSE' } },
      include: { exchange: true },
    });
    if (!stock) {
      console.error(`Stock not found: ${symbol}`);
      continue;
    }

    console.log(`--- Testing ${symbol} (ID: ${stock.id}) ---`);

    // 1. Clear any existing cache for this stock
    await cacheService.invalidateStockPricesCache(stock.id);

    // 2. First call to /indicators (Cache Miss)
    const t0 = Date.now();
    const res1 = await request(app)
      .get(`/api/stocks/${stock.id}/indicators?interval=1D&limit=800`)
      .expect(200);
    const t1 = Date.now();

    console.log(`[Indicators] 1st request (Cache Miss): status=${res1.status}, cached=${res1.body.meta.cached}, totalCandles=${res1.body.data.totalCandles}, time=${t1 - t0}ms`);
    if (res1.body.meta.cached !== false || res1.body.data.totalCandles !== 743) {
      throw new Error(`Unexpected res1 body: cached=${res1.body.meta.cached}, total=${res1.body.data.totalCandles}`);
    }

    // 3. Second call to /indicators (Cache Hit)
    const t2 = Date.now();
    const res2 = await request(app)
      .get(`/api/stocks/${stock.id}/indicators?interval=1D&limit=800`)
      .expect(200);
    const t3 = Date.now();

    console.log(`[Indicators] 2nd request (Cache Hit): status=${res2.status}, cached=${res2.body.meta.cached}, totalCandles=${res2.body.data.totalCandles}, time=${t3 - t2}ms`);
    if (res2.body.meta.cached !== true) {
      throw new Error(`Expected cache hit on 2nd request for ${symbol}`);
    }

    // 4. Test Features endpoint
    const f0 = Date.now();
    const resFeatures = await request(app)
      .get(`/api/stocks/${stock.id}/features?interval=1D&limit=800&dropNa=true`)
      .expect(200);
    const f1 = Date.now();

    console.log(`[Features] dropNa=true: status=${resFeatures.status}, totalRows=${resFeatures.body.data.totalRows}, featureCount=${resFeatures.body.data.featureCount}, time=${f1 - f0}ms`);
    if (resFeatures.body.data.totalRows !== 544 || resFeatures.body.data.featureCount !== 23) {
      throw new Error(`Unexpected features output: totalRows=${resFeatures.body.data.totalRows}, count=${resFeatures.body.data.featureCount}`);
    }

    // 5. Test Cache Invalidation
    const invalidated = await cacheService.invalidateStockPricesCache(stock.id);
    console.log(`[Cache Invalidation] Removed ${invalidated} keys for ${symbol}`);

    // 6. Third call to /indicators (Should be Cache Miss again)
    const res3 = await request(app)
      .get(`/api/stocks/${stock.id}/indicators?interval=1D&limit=800`)
      .expect(200);
    console.log(`[Indicators] 3rd request after invalidation (Cache Miss): cached=${res3.body.meta.cached}`);
    if (res3.body.meta.cached !== false) {
      throw new Error(`Expected cache miss after invalidation for ${symbol}`);
    }

    console.log(`✓ ${symbol} fully verified.\n`);
  }

  console.log('=== All 5 Stocks Live Integration Verified Successfully! ===');
  await prisma.$disconnect();
}

testLiveIntegration().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
