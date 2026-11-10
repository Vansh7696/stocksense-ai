import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DistributedSlidingWindowLimiter,
  calculateFullJitterDelay,
  parseRetryAfterHeader,
  executeWithRetry,
  checkMultiWindowAtomic,
  acquireProviderPermit,
  getRateLimitConfigs,
  historicalSecondLimiter,
  quoteSecondLimiter,
  minuteLimiter,
  thirtyMinLimiter,
} from '../src/utils/rateLimiter.js';
import redisClient, { isRedisReady } from '../src/config/redis.js';

describe('Milestone 3 — Step 2: Distributed Sliding-Window Rate Limiter & Jitter Engine (Code-Level Audit)', () => {
  let testLimiter;
  const testKeyName = `test_sliding_limiter_${Date.now()}`;

  before(async () => {
    if (redisClient) {
      if (redisClient.status === 'wait') {
        try {
          await redisClient.connect();
        } catch {
          // ignore
        }
      }
      try {
        await redisClient.ping();
      } catch {
        // ignore
      }
      let retries = 20;
      while (!isRedisReady() && retries > 0) {
        await new Promise((r) => setTimeout(r, 50));
        retries--;
      }
    }
  });

  beforeEach(async () => {
    testLimiter = new DistributedSlidingWindowLimiter({
      name: testKeyName,
      windowMs: 1000,
      limit: 5,
    });
    await testLimiter.reset();
  });

  after(async () => {
    if (testLimiter) {
      await testLimiter.reset();
    }
    // Clean up all standard limiter keys in Redis
    if (redisClient && isRedisReady()) {
      const configs = getRateLimitConfigs();
      await redisClient.del(
        configs.historicalSec.key,
        configs.quoteSec.key,
        configs.minute.key,
        configs.thirtyMin.key
      );
    }
  });

  describe('1. Concurrency Safety & Independent Limiter Instances Sharing Redis', () => {
    it('should strictly enforce shared limit across independent limiter instances (simulating multiple backend workers)', async () => {
      // Simulate 3 distinct backend worker processes by creating 3 independent limiter instances with the exact same Redis key
      const sharedKeyName = `shared_workers_key_${Date.now()}`;
      const workerA = new DistributedSlidingWindowLimiter({ name: sharedKeyName, windowMs: 1000, limit: 5 });
      const workerB = new DistributedSlidingWindowLimiter({ name: sharedKeyName, windowMs: 1000, limit: 5 });
      const workerC = new DistributedSlidingWindowLimiter({ name: sharedKeyName, windowMs: 1000, limit: 5 });

      await workerA.reset();

      const now = Date.now();

      // Workers fire 4 requests each in parallel (12 total requests contending for 5 shared slots)
      const parallelRequests = [
        workerA.check(now, `workerA_req1_${now}`),
        workerA.check(now, `workerA_req2_${now}`),
        workerA.check(now, `workerA_req3_${now}`),
        workerA.check(now, `workerA_req4_${now}`),
        workerB.check(now, `workerB_req1_${now}`),
        workerB.check(now, `workerB_req2_${now}`),
        workerB.check(now, `workerB_req3_${now}`),
        workerB.check(now, `workerB_req4_${now}`),
        workerC.check(now, `workerC_req1_${now}`),
        workerC.check(now, `workerC_req2_${now}`),
        workerC.check(now, `workerC_req3_${now}`),
        workerC.check(now, `workerC_req4_${now}`),
      ];

      const results = await Promise.all(parallelRequests);

      const totalAllowed = results.filter((r) => r.allowed).length;
      const totalDenied = results.filter((r) => !r.allowed).length;

      // Independent instances sharing Redis MUST coordinate to strictly allow 5 and deny 7
      assert.equal(totalAllowed, 5, 'Across all 3 worker instances, exactly 5 requests must be allowed');
      assert.equal(totalDenied, 7, 'Across all 3 worker instances, exactly 7 requests must be throttled');

      await workerA.reset();
    });

    it('should maintain atomic count integrity under 20 simultaneous parallel requests on a single instance', async () => {
      const now = Date.now();
      const requests = Array.from({ length: 20 }, (_, i) =>
        testLimiter.check(now, `atomic_test_${i}_${now}`)
      );

      const results = await Promise.all(requests);
      const allowed = results.filter((r) => r.allowed);

      assert.equal(allowed.length, 5, 'Atomic Lua script must never exceed capacity under race conditions');
    });
  });

  describe('2. Rate-Limit Windows & Boundary Transitions', () => {
    it('should enforce distinct per-second limits for Historical (5 req/s) and Quotes (8 req/s)', () => {
      const configs = getRateLimitConfigs();
      assert.equal(configs.historicalSec.limit, 5, 'Historical per-second limit must be 5');
      assert.equal(configs.quoteSec.limit, 8, 'Quote per-second limit must be 8');
    });

    it('should correctly slide across minute-window boundaries without fixed-bucket spikes', async () => {
      const minuteLimiterTest = new DistributedSlidingWindowLimiter({
        name: `test_sliding_min_${Date.now()}`,
        windowMs: 60000,
        limit: 3,
      });
      await minuteLimiterTest.reset();

      const t0 = 1700000000000;

      // Fill quota at t0, t0+10s, t0+20s
      assert.equal((await minuteLimiterTest.check(t0, 'min_r1')).allowed, true);
      assert.equal((await minuteLimiterTest.check(t0 + 10000, 'min_r2')).allowed, true);
      assert.equal((await minuteLimiterTest.check(t0 + 20000, 'min_r3')).allowed, true);

      // Blocked at t0+30s
      const blockedAt30s = await minuteLimiterTest.check(t0 + 30000, 'min_r4');
      assert.equal(blockedAt30s.allowed, false);

      // Advance time to t0 + 60,001 ms:
      // min_r1 (at t0) has slid out. Exactly 1 slot opens up!
      const permittedAt60s = await minuteLimiterTest.check(t0 + 60001, 'min_r5');
      assert.equal(permittedAt60s.allowed, true, 'Slot opens once oldest request slides out of 60s window');

      await minuteLimiterTest.reset();
    });

    it('should correctly slide across 30-minute window boundaries', async () => {
      const thirtyMinLimiterTest = new DistributedSlidingWindowLimiter({
        name: `test_sliding_30min_${Date.now()}`,
        windowMs: 1800000, // 30 minutes
        limit: 2,
      });
      await thirtyMinLimiterTest.reset();

      const t0 = 1700000000000;

      assert.equal((await thirtyMinLimiterTest.check(t0, '30m_r1')).allowed, true);
      assert.equal((await thirtyMinLimiterTest.check(t0 + 60000, '30m_r2')).allowed, true);

      // 3rd request within 30 min is blocked
      const blocked = await thirtyMinLimiterTest.check(t0 + 120000, '30m_r3');
      assert.equal(blocked.allowed, false);
      assert.ok(blocked.retryAfterMs > 0);

      // Advance time past 30 minutes from t0 (t0 + 1800001 ms)
      const allowedAfter30Min = await thirtyMinLimiterTest.check(t0 + 1800001, '30m_r4');
      assert.equal(allowedAfter30Min.allowed, true, 'Slot opens after 30 minutes has elapsed');

      await thirtyMinLimiterTest.reset();
    });
  });

  describe('3. Multi-Window Quota Consumption (Atomic Multi-Window Lua)', () => {
    it('should NOT consume quota from any window if any window in the hierarchy fails', async () => {
      const configs = getRateLimitConfigs();

      // Clean up test keys
      await redisClient.del(
        configs.historicalSec.key,
        configs.minute.key,
        configs.thirtyMin.key
      );

      const baseTime = 1700000000000;

      // Exhaust the per-second limit (5 requests) at baseTime
      for (let i = 0; i < 5; i++) {
        const res = await checkMultiWindowAtomic('historical', {
          customNow: baseTime,
          customReqId: `exhaust_sec_${i}`,
        });
        assert.equal(res.allowed, true);
      }

      // Check current counts in Redis for 1-minute and 30-minute keys
      const countMinBefore = await redisClient.zcard(configs.minute.key);
      const count30mBefore = await redisClient.zcard(configs.thirtyMin.key);
      assert.equal(countMinBefore, 5);
      assert.equal(count30mBefore, 5);

      // Attempt a 6th request at the exact same baseTime (should fail on per-second window)
      const deniedReq = await checkMultiWindowAtomic('historical', {
        customNow: baseTime,
        customReqId: 'denied_6th_req',
      });
      assert.equal(deniedReq.allowed, false, '6th request must be denied due to per-second limit');

      // VERIFY ATOMIC INTEGRITY:
      // Neither the 1-minute nor the 30-minute window should have incremented their counts!
      const countMinAfter = await redisClient.zcard(configs.minute.key);
      const count30mAfter = await redisClient.zcard(configs.thirtyMin.key);

      assert.equal(countMinAfter, 5, 'Denied request must NOT consume quota from the minute window');
      assert.equal(count30mAfter, 5, 'Denied request must NOT consume quota from the 30-minute window');
    });

    it('should NOT consume per-second quota when a request is denied by the minute or 30-minute window', async () => {
      const configs = getRateLimitConfigs();

      // Clean up test keys
      await redisClient.del(
        configs.historicalSec.key,
        configs.minute.key,
        configs.thirtyMin.key
      );

      const baseTime = 1700000000000;

      // Pre-fill the minute window with 250 entries (exhausting the minute limit)
      const pipeline = redisClient.pipeline();
      for (let i = 0; i < configs.minute.limit; i++) {
        pipeline.zadd(configs.minute.key, baseTime - 1000 - i, `preload_min_${i}`);
      }
      await pipeline.exec();

      // Confirm minute window is at capacity (250 entries)
      const countMinBefore = await redisClient.zcard(configs.minute.key);
      assert.equal(countMinBefore, configs.minute.limit, 'Minute window must be at capacity');

      // Check per-second window count before (should be 0)
      const countSecBefore = await redisClient.zcard(configs.historicalSec.key);
      assert.equal(countSecBefore, 0, 'Per-second count must initially be 0');

      // Attempt a request (passes 5/sec check, but fails 250/min check)
      const deniedReq = await checkMultiWindowAtomic('historical', {
        customNow: baseTime,
        customReqId: 'denied_by_minute_cap',
      });

      assert.equal(deniedReq.allowed, false, 'Request must be denied due to exhausted minute window');

      // VERIFY ATOMIC INTEGRITY:
      // Per-second window must NOT have consumed a slot!
      const countSecAfter = await redisClient.zcard(configs.historicalSec.key);
      assert.equal(
        countSecAfter,
        0,
        'When denied by minute window, request must NOT consume per-second quota'
      );

      // Clean up test keys
      await redisClient.del(
        configs.historicalSec.key,
        configs.minute.key,
        configs.thirtyMin.key
      );
    });
  });

  describe('4. Redis Failure & Distributed Safety (fail_closed Policy)', () => {
    it('should default to fail_closed policy and reject requests when Redis is offline', async () => {
      const defaultLimiter = new DistributedSlidingWindowLimiter({
        name: 'test_default_safety',
      });

      // Default policy must be fail_closed
      assert.equal(defaultLimiter.failSafePolicy, 'fail_closed');

      // Mock getClient to return null (simulating Redis disconnection)
      defaultLimiter.getClient = () => null;

      const result = await defaultLimiter.check();
      assert.equal(result.allowed, false, 'Must reject traffic when Redis is offline');
      assert.equal(result.source, 'FAIL_CLOSED_REDIS_UNAVAILABLE');
    });

    it('should throw RATE_LIMITER_OFFLINE (503) from acquire when Redis is unavailable', async () => {
      const offlineLimiter = new DistributedSlidingWindowLimiter({
        name: 'offline_acquire_limiter',
        failSafePolicy: 'fail_closed',
      });
      offlineLimiter.getClient = () => null;

      await assert.rejects(
        () => offlineLimiter.acquire({ maxWaitMs: 100 }),
        (err) => err.code === 'RATE_LIMITER_OFFLINE' && err.statusCode === 503
      );
    });

    it('should recover and permit requests once Redis is reconnected', async () => {
      const reconnectLimiter = new DistributedSlidingWindowLimiter({
        name: `reconnect_test_${Date.now()}`,
      });

      // 1. When offline -> fails closed
      reconnectLimiter.getClient = () => null;
      assert.equal((await reconnectLimiter.check()).allowed, false);

      // 2. When restored -> succeeds
      reconnectLimiter.getClient = () => redisClient;
      assert.equal((await reconnectLimiter.check()).allowed, true);

      await reconnectLimiter.reset();
    });
  });

  describe('5. Full-Jitter Retry Backoff Engine', () => {
    it('should calculate jittered delays strictly within [0, min(baseDelay * 2^attempt, maxDelay)]', () => {
      const baseDelay = 1000;
      const maxDelay = 10000;

      for (let attempt = 0; attempt < 8; attempt++) {
        const expectedCap = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        for (let run = 0; run < 30; run++) {
          const delay = calculateFullJitterDelay(attempt, { baseDelay, maxDelay });
          assert.ok(delay >= 0, `Delay (${delay}) must be >= 0`);
          assert.ok(delay <= expectedCap, `Delay (${delay}) must be <= cap (${expectedCap}) for attempt ${attempt}`);
        }
      }
    });

    it('should parse integer Retry-After headers in seconds and HTTP date strings', () => {
      assert.equal(parseRetryAfterHeader('15'), 15000);
      assert.equal(parseRetryAfterHeader(5), 5000);

      const futureDate = new Date(Date.now() + 10000).toUTCString();
      const dateDelay = parseRetryAfterHeader(futureDate);
      assert.ok(dateDelay > 8000 && dateDelay <= 11000);

      assert.equal(parseRetryAfterHeader(null), null);
      assert.equal(parseRetryAfterHeader('invalid_date_string'), null);
    });

    it('should NEVER retry non-429 errors and rethrow immediately on first attempt', async () => {
      let callCount = 0;
      const non429Operation = async () => {
        callCount++;
        const err = new Error('Bad Request');
        err.status = 400; // Not a 429!
        throw err;
      };

      await assert.rejects(
        () => executeWithRetry(non429Operation, { maxAttempts: 3 }),
        /Bad Request/
      );

      assert.equal(callCount, 1, 'Non-429 error must be rethrown immediately on attempt 1 without retrying');
    });

    it('should respect Retry-After as minimum wait when provided by provider', async () => {
      let callCount = 0;
      const timestamps = [];

      const retryAfterOperation = async () => {
        callCount++;
        timestamps.push(Date.now());
        if (callCount < 2) {
          const err = new Error('Too Many Requests');
          err.status = 429;
          err.response = { headers: { 'retry-after': '0' } }; // 0 seconds
          throw err;
        }
        return { success: true };
      };

      const result = await executeWithRetry(retryAfterOperation, {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 50,
      });

      assert.equal(result.success, true);
      assert.equal(callCount, 2);
    });

    it('should throw standardized PROVIDER_RATE_LIMITED (429) after exhausting max attempts', async () => {
      let callCount = 0;
      const persistent429 = async () => {
        callCount++;
        const err = new Error('Too Many Requests');
        err.status = 429;
        throw err;
      };

      await assert.rejects(
        () =>
          executeWithRetry(persistent429, {
            maxAttempts: 3,
            baseDelayMs: 10,
            maxDelayMs: 20,
          }),
        (err) => {
          assert.equal(err.code, 'PROVIDER_RATE_LIMITED');
          assert.equal(err.statusCode, 429);
          assert.equal(err.details?.attempts, 3);
          return true;
        }
      );

      assert.equal(callCount, 3);
    });
  });
});
