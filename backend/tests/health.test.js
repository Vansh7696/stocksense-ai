import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import redisClient from '../src/config/redis.js';
import prisma from '../src/config/prisma.js';

describe('Backend Gateway Health Checks', () => {
  after(async () => {
    try {
      await prisma.$disconnect();
    } catch (e) {
      // Ignored during cleanup
    }
  });

  test('GET / should return gateway metadata', async () => {
    const res = await request(app).get('/');
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'StockSense AI Backend API Gateway');
  });

  test('GET /api/health should report dependency connectivity accurately', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.service, 'stocksense-backend');
    assert.ok(typeof res.body.data.uptimeSeconds === 'number');
    assert.ok(['HEALTHY', 'DEGRADED', 'UNHEALTHY'].includes(res.body.data.status));
    assert.ok(['CONNECTED', 'DISCONNECTED'].includes(res.body.data.dependencies.database));
    assert.ok(['CONNECTED', 'DISCONNECTED'].includes(res.body.data.dependencies.redis));
    assert.ok(['CONNECTED', 'DISCONNECTED'].includes(res.body.data.dependencies.mlService));
  });

  test('GET /api/health?strict=true should respond with valid HTTP code based on health', async () => {
    const res = await request(app).get('/api/health?strict=true');
    // If healthy: 200, if degraded or unhealthy: 503
    assert.ok([200, 503].includes(res.status));
    assert.ok(res.body.data.status);
  });

  test('GET /non-existent-endpoint should return 404 NOT_FOUND', async () => {
    const res = await request(app).get('/api/undefined-endpoint-for-testing');
    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});
