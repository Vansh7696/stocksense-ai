import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/config/prisma.js';
import redisClient, { isRedisReady } from '../src/config/redis.js';
import tokenService from '../src/services/token.service.js';

describe('Milestone 3 — Step 2: Token Manager (token.service.js) (Code-Level Audit)', () => {
  const sampleToken = 'upstox_access_token_official_v3_sample_secret_xyz123';

  before(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  beforeEach(async () => {
    await tokenService.clearToken();
  });

  after(async () => {
    await tokenService.clearToken();
  });

  describe('1. Token Encryption & Persistence', () => {
    it('should encrypt token before storing in PostgreSQL system_configs', async () => {
      const result = await tokenService.saveAccessToken(sampleToken);

      assert.equal(result.success, true);
      assert.ok(result.expiresAt);

      const record = await prisma.systemConfig.findUnique({
        where: { key: 'UPSTOX_AUTH_TOKEN_ENCRYPTED' },
      });

      assert.ok(record, 'Record must exist in system_configs table');
      assert.ok(!record.value.includes(sampleToken), 'Database must NEVER store plaintext token');

      const parsed = JSON.parse(record.value);
      assert.ok(parsed.iv, 'Payload must contain IV');
      assert.ok(parsed.authTag, 'Payload must contain authTag');
      assert.ok(parsed.ciphertext, 'Payload must contain ciphertext');
      assert.ok(parsed.expiresAt, 'Payload must contain expiresAt');
    });

    it('should cache encrypted token in Redis with TTL strictly bounded by expiresAt', async () => {
      // Set custom expiry 100 seconds from now
      const customExpiresAt = new Date(Date.now() + 100000);
      await tokenService.saveAccessToken(sampleToken, customExpiresAt);

      if (isRedisReady() && redisClient) {
        const cached = await redisClient.get('stocksense:auth:upstox:token');
        assert.ok(cached, 'Encrypted token must be cached in Redis');
        assert.ok(!cached.includes(sampleToken), 'Redis must NEVER store plaintext token');

        const ttl = await redisClient.ttl('stocksense:auth:upstox:token');
        assert.ok(ttl > 0 && ttl <= 100, `Redis TTL (${ttl}s) must be bounded by token expiresAt (100s)`);
      }
    });

    it('should decrypt and retrieve original plaintext token', async () => {
      await tokenService.saveAccessToken(sampleToken);

      const retrieved = await tokenService.getAccessToken();
      assert.equal(retrieved, sampleToken, 'Decrypted token must match original plaintext');
    });

    it('should reject invalid or empty token strings', async () => {
      await assert.rejects(() => tokenService.saveAccessToken(''), /non-empty string/i);
      await assert.rejects(() => tokenService.saveAccessToken(null), /non-empty string/i);
      await assert.rejects(() => tokenService.saveAccessToken(undefined), /non-empty string/i);
      await assert.rejects(() => tokenService.saveAccessToken('   '), /non-empty string/i);
    });
  });

  describe('2. 03:30 AM IST Daily Expiry Boundary Logic (Deterministic Clock Injection)', () => {
    it('should compute same day 03:30 AM IST when reference is 03:29:59 AM IST (1 second before)', () => {
      // 03:29:59 AM IST on Nov 7, 2026 -> UTC: Nov 6, 2026 21:59:59 UTC
      const mockBeforeBoundary = new Date('2026-11-06T21:59:59.000Z');
      const expiry = tokenService.calculateUpstoxExpiryDate(mockBeforeBoundary);

      // Expiry is 03:30:00 AM IST on Nov 7, 2026 -> UTC: Nov 6, 2026 22:00:00 UTC
      assert.equal(expiry.toISOString(), '2026-11-06T22:00:00.000Z');
    });

    it('should compute next day 03:30 AM IST when reference is exactly 03:30:00 AM IST', () => {
      // Exactly 03:30:00 AM IST on Nov 7, 2026 -> UTC: Nov 6, 2026 22:00:00 UTC
      const mockAtBoundary = new Date('2026-11-06T22:00:00.000Z');
      const expiry = tokenService.calculateUpstoxExpiryDate(mockAtBoundary);

      // Expiry is 03:30:00 AM IST on Nov 8, 2026 -> UTC: Nov 7, 2026 22:00:00 UTC
      assert.equal(expiry.toISOString(), '2026-11-07T22:00:00.000Z');
    });

    it('should compute next day 03:30 AM IST when reference is 03:30:01 AM IST (1 second after)', () => {
      // 03:30:01 AM IST on Nov 7, 2026 -> UTC: Nov 6, 2026 22:00:01 UTC
      const mockAfterBoundary = new Date('2026-11-06T22:00:01.000Z');
      const expiry = tokenService.calculateUpstoxExpiryDate(mockAfterBoundary);

      // Expiry is 03:30:00 AM IST on Nov 8, 2026 -> UTC: Nov 7, 2026 22:00:00 UTC
      assert.equal(expiry.toISOString(), '2026-11-07T22:00:00.000Z');
    });

    it('should return null and report REAUTHORIZATION_REQUIRED deterministically when time passes expiry', async () => {
      // Token fixed to expire at 2026-11-07T22:00:00.000Z
      const fixedExpiry = new Date('2026-11-07T22:00:00.000Z');
      await tokenService.saveAccessToken(sampleToken, fixedExpiry);

      // Check 1: Time is before expiry (2026-11-07T21:59:00.000Z) -> Valid!
      const validToken = await tokenService.getAccessToken('2026-11-07T21:59:00.000Z');
      assert.equal(validToken, sampleToken);

      const activeStatus = await tokenService.getTokenStatus('2026-11-07T21:59:00.000Z');
      assert.equal(activeStatus.active, true);
      assert.equal(activeStatus.code, 'ACTIVE');

      // Check 2: Time is after expiry (2026-11-07T22:00:01.000Z) -> Expired!
      const expiredToken = await tokenService.getAccessToken('2026-11-07T22:00:01.000Z');
      assert.equal(expiredToken, null, 'Expired token must return null');

      const expiredStatus = await tokenService.getTokenStatus('2026-11-07T22:00:01.000Z');
      assert.equal(expiredStatus.active, false);
      assert.equal(expiredStatus.code, 'REAUTHORIZATION_REQUIRED');
      assert.ok(expiredStatus.reason.includes('03:30 AM IST'));
    });
  });

  describe('3. Missing, Corrupted & Tampered Token Handling', () => {
    it('should report REAUTHORIZATION_REQUIRED when no token is configured', async () => {
      const status = await tokenService.getTokenStatus();

      assert.equal(status.configured, false);
      assert.equal(status.active, false);
      assert.equal(status.code, 'REAUTHORIZATION_REQUIRED');
      assert.ok(status.reason.includes('/api/auth/upstox/login'));

      const token = await tokenService.getAccessToken();
      assert.equal(token, null);
    });

    it('should fail safely on corrupted JSON in database', async () => {
      await prisma.systemConfig.upsert({
        where: { key: 'UPSTOX_AUTH_TOKEN_ENCRYPTED' },
        update: { value: 'not_valid_json_string{' },
        create: { key: 'UPSTOX_AUTH_TOKEN_ENCRYPTED', value: 'not_valid_json_string{' },
      });

      const token = await tokenService.getAccessToken();
      assert.equal(token, null);

      const status = await tokenService.getTokenStatus();
      assert.equal(status.active, false);
      assert.equal(status.code, 'REAUTHORIZATION_REQUIRED');
      assert.ok(status.reason.includes('corrupted'));
    });

    it('should fail safely when stored ciphertext is tampered with', async () => {
      await tokenService.saveAccessToken(sampleToken);

      const record = await prisma.systemConfig.findUnique({
        where: { key: 'UPSTOX_AUTH_TOKEN_ENCRYPTED' },
      });
      const payload = JSON.parse(record.value);
      payload.ciphertext = payload.ciphertext.slice(0, -2) + '00';

      await prisma.systemConfig.update({
        where: { key: 'UPSTOX_AUTH_TOKEN_ENCRYPTED' },
        data: { value: JSON.stringify(payload) },
      });

      if (isRedisReady() && redisClient) {
        await redisClient.del('stocksense:auth:upstox:token');
      }

      const token = await tokenService.getAccessToken();
      assert.equal(token, null, 'Tampered token must fail authentication verification and return null');
    });

    it('should never expose secret token or encryption keys in getTokenStatus()', async () => {
      await tokenService.saveAccessToken(sampleToken);

      const status = await tokenService.getTokenStatus();
      const statusStr = JSON.stringify(status);

      assert.ok(!statusStr.includes(sampleToken), 'Status must not contain plaintext token');
      assert.equal(status.iv, undefined, 'Status must not leak IV');
      assert.equal(status.authTag, undefined, 'Status must not leak authTag');
      assert.equal(status.ciphertext, undefined, 'Status must not leak ciphertext');
      assert.equal(status.active, true);
      assert.equal(status.code, 'ACTIVE');
    });

    it('should remove token from PostgreSQL and Redis on clearToken()', async () => {
      await tokenService.saveAccessToken(sampleToken);
      const clearResult = await tokenService.clearToken();

      assert.equal(clearResult.success, true);

      const dbRecord = await prisma.systemConfig.findUnique({
        where: { key: 'UPSTOX_AUTH_TOKEN_ENCRYPTED' },
      });
      assert.equal(dbRecord, null);

      if (isRedisReady() && redisClient) {
        const cached = await redisClient.get('stocksense:auth:upstox:token');
        assert.equal(cached, null);
      }

      const token = await tokenService.getAccessToken();
      assert.equal(token, null);
    });
  });
});
