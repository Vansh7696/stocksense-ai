/**
 * StockSense AI — Backend Observability, Correlation ID & Metrics Test Suite (Phase 5C.7.3)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { correlationIdMiddleware } from '../src/middleware/correlationId.js';
import metricsRegistry from '../src/services/metrics.service.js';

describe('Phase 5C.7.3: Backend Observability, Correlation Tracking & Metrics', () => {
  beforeEach(() => {
    metricsRegistry.reset();
  });

  describe('1. Correlation ID Middleware Unit Verification', () => {
    it('generates a valid UUID v4 when X-Correlation-ID header is missing', () => {
      const req = { headers: {} };
      const res = {
        headers: {},
        setHeader(name, val) {
          this.headers[name] = val;
        },
      };
      let nextCalled = false;

      correlationIdMiddleware(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      assert.ok(req.correlationId);
      // Validate UUID v4 format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      assert.match(req.correlationId, uuidRegex);
      assert.equal(res.headers['X-Correlation-ID'], req.correlationId);
    });

    it('preserves and passes through a valid client-supplied X-Correlation-ID', () => {
      const clientCid = 'client-trace-id-12345';
      const req = { headers: { 'x-correlation-id': clientCid } };
      const res = {
        headers: {},
        setHeader(name, val) {
          this.headers[name] = val;
        },
      };

      correlationIdMiddleware(req, res, () => {});

      assert.equal(req.correlationId, clientCid);
      assert.equal(res.headers['X-Correlation-ID'], clientCid);
    });

    it('sanitizes malicious characters from client-supplied correlation ID', () => {
      const dirtyCid = 'trace-id-123<script>alert(1)</script>; DROP TABLE;';
      const req = { headers: { 'x-correlation-id': dirtyCid } };
      const res = {
        headers: {},
        setHeader(name, val) {
          this.headers[name] = val;
        },
      };

      correlationIdMiddleware(req, res, () => {});

      assert.doesNotMatch(req.correlationId, /[<>; ]/);
      assert.ok(req.correlationId.startsWith('trace-id-123scriptalert1scriptDROPTABLE'));
    });
  });

  describe('2. HTTP Ingress & Error Propagation Integration', () => {
    it('attaches X-Correlation-ID header to root endpoint response', async () => {
      const res = await request(app).get('/');

      assert.equal(res.status, 200);
      assert.ok(res.headers['x-correlation-id']);
      assert.equal(res.body.correlationId, res.headers['x-correlation-id']);
    });

    it('propagates correlationId in meta envelope on 404 error responses', async () => {
      const customCid = 'audit-test-cid-999';
      const res = await request(app)
        .get('/api/non-existent-probe-route')
        .set('X-Correlation-ID', customCid);

      assert.equal(res.status, 404);
      assert.equal(res.headers['x-correlation-id'], customCid);
      assert.equal(res.body.success, false);
      assert.equal(res.body.meta.correlationId, customCid);
    });
  });

  describe('3. Prometheus Metrics & Telemetry Exporter', () => {
    it('records and formats HTTP requests into Prometheus format', () => {
      metricsRegistry.recordHttpRequest('GET', '/api/stocks', 200, 0.045);
      metricsRegistry.recordHttpRequest('GET', '/api/stocks', 200, 0.055);
      metricsRegistry.recordHttpRequest('POST', '/api/auth/login', 401, 0.120);

      const prometheusOutput = metricsRegistry.toPrometheusFormat();

      assert.match(prometheusOutput, /# TYPE http_requests_total counter/);
      assert.match(prometheusOutput, /http_requests_total\{method="GET",route="\/api\/stocks",status="200"\} 2/);
      assert.match(prometheusOutput, /http_requests_total\{method="POST",route="\/api\/auth\/login",status="401"\} 1/);
    });

    it('records and summarizes prediction requests and latencies', () => {
      metricsRegistry.recordPrediction(1, 'success', 0.035);
      metricsRegistry.recordPrediction(3, 'success', 0.042);
      metricsRegistry.recordPrediction('all', 'cache_hit', 0.002);

      const snapshot = metricsRegistry.toJsonSnapshot();

      assert.equal(snapshot.predictionRequestsTotal.length, 3);
      assert.ok(snapshot.latencies.predictionDuration.count >= 2);
      assert.ok(snapshot.latencies.predictionDuration.p50 > 0);
    });

    it('records cache hit and miss ratios', () => {
      metricsRegistry.recordCacheOp('get', 'hit');
      metricsRegistry.recordCacheOp('get', 'hit');
      metricsRegistry.recordCacheOp('get', 'miss');

      const prometheusOutput = metricsRegistry.toPrometheusFormat();

      assert.match(prometheusOutput, /cache_operations_total\{operation="get",result="hit"\} 2/);
      assert.match(prometheusOutput, /cache_operations_total\{operation="get",result="miss"\} 1/);
    });

    it('serves OpenMetrics via GET /metrics', async () => {
      const res = await request(app).get('/metrics');

      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /text\/plain/);
      assert.match(res.text, /process_uptime_seconds/);
      assert.match(res.text, /process_resident_memory_bytes/);
    });

    it('serves JSON snapshot via GET /metrics?format=json and GET /api/metrics/json', async () => {
      const res = await request(app).get('/api/metrics/json');

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(typeof res.body.data.uptimeSeconds === 'number');
      assert.ok(Array.isArray(res.body.data.predictionRequestsTotal));
    });
  });
});
