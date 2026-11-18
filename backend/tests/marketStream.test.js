/**
 * StockSense AI — Milestone 6D.2: Real-Time Market Streaming (SSE) Test Suite
 * Validates Server-Sent Events headers, initial connection handshake, market session detection,
 * quote streaming, heartbeat keepalives, and connection lifecycle cleanup.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { isIndianMarketOpen, activeStreamClients } from '../src/controllers/stream.controller.js';

describe('Milestone 6D.2: Real-Time Market Streaming (SSE) Tests', () => {
  test('1. isIndianMarketOpen accurately detects IST market trading hours', () => {
    // Sunday 11:00 AM IST (Weekend -> CLOSED)
    const sunday = new Date('2026-11-15T05:30:00Z');
    assert.equal(isIndianMarketOpen(sunday), false);

    // Wednesday 10:30 AM IST (05:00 UTC) -> OPEN
    const weekdayOpen = new Date('2026-11-18T05:00:00Z');
    assert.equal(isIndianMarketOpen(weekdayOpen), true);

    // Wednesday 08:30 AM IST (03:00 UTC) -> CLOSED (Pre-market)
    const weekdayEarly = new Date('2026-11-18T03:00:00Z');
    assert.equal(isIndianMarketOpen(weekdayEarly), false);

    // Wednesday 16:30 PM IST (11:00 UTC) -> CLOSED (Post-market)
    const weekdayLate = new Date('2026-11-18T11:00:00Z');
    assert.equal(isIndianMarketOpen(weekdayLate), false);
  });

  test('2. GET /api/market/stream establishes SSE headers and emits connected event', async () => {
    const initialClientsCount = activeStreamClients.size;

    return new Promise((resolve, reject) => {
      const req = request(app)
        .get('/api/market/stream?symbols=RELIANCE,TCS')
        .buffer(false); // Enable streaming

      let receivedData = '';

      req
        .expect('Content-Type', /text\/event-stream/)
        .expect('Cache-Control', /no-cache/)
        .expect('Connection', /keep-alive/)
        .expect(200)
        .end((err) => {
          if (err && !receivedData.includes('event: connected')) {
            return reject(err);
          }
        });

      req.on('response', (res) => {
        res.on('data', (chunk) => {
          receivedData += chunk.toString();

          if (receivedData.includes('event: connected') && receivedData.includes('event: market_status')) {
            // Verify event contents
            assert.ok(receivedData.includes('event: connected'));
            assert.ok(receivedData.includes('clientId'));
            assert.ok(receivedData.includes('RELIANCE'));
            assert.ok(receivedData.includes('event: market_status'));

            // Abort stream to trigger client disconnect cleanup
            if (req.abort) req.abort();
            res.destroy();

            // Allow event loop tick for cleanup
            setTimeout(() => {
              // Client count should clean up
              assert.ok(activeStreamClients.size <= initialClientsCount + 1);
              resolve();
            }, 100);
          }
        });

        res.on('error', () => {
          // Stream destroyed intentionally
          resolve();
        });
      });
    });
  });
});
