import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../src/app.js';
import { config, validateJwtSecret, INSECURE_JWT_SECRETS } from '../src/config/index.js';
import { requireAuth, JWT_ACCEPTED_ALGORITHMS } from '../src/middleware/auth.js';
import { redactString } from '../src/utils/crypto.js';
import tokenService from '../src/services/token.service.js';

describe('StockSense AI — JWT Configuration, Production Safety & Algorithm Restriction (jwtAuth.test.js)', () => {
  const strongSecret = 'super_secure_production_jwt_secret_key_at_least_32_chars_long!';
  const devDefaultSecret = 'dev_super_secret_jwt_key_stocksense';

  describe('1. Configuration & Production Validation (validateJwtSecret)', () => {
    it('should load JWT secret from environment variable', () => {
      assert.ok(config.jwt.secret);
      assert.equal(typeof config.jwt.secret, 'string');
      assert.equal(config.jwt.algorithm, 'HS256');
    });

    it('should throw fatal error in production if JWT_SECRET is missing or empty', () => {
      assert.throws(
        () => validateJwtSecret('', 'production'),
        /Fatal configuration error: JWT_SECRET environment variable is mandatory in production/
      );
      assert.throws(
        () => validateJwtSecret(null, 'production'),
        /Fatal configuration error: JWT_SECRET environment variable is mandatory in production/
      );
      assert.throws(
        () => validateJwtSecret('   ', 'production'),
        /Fatal configuration error: JWT_SECRET environment variable is mandatory in production/
      );
    });

    it('should throw fatal error in production if JWT_SECRET matches an insecure placeholder', () => {
      for (const insecureSecret of INSECURE_JWT_SECRETS) {
        assert.throws(
          () => validateJwtSecret(insecureSecret, 'production'),
          /Fatal configuration error: Insecure or placeholder JWT_SECRET cannot be used in production/
        );
      }
    });

    it('should throw fatal error in production if JWT_SECRET is shorter than 32 characters', () => {
      const shortSecret = 'short_secret_under_32_chars';
      assert.ok(shortSecret.length < 32);
      assert.throws(
        () => validateJwtSecret(shortSecret, 'production'),
        /Fatal configuration error: JWT_SECRET in production must be at least 32 characters long/
      );
    });

    it('should accept valid strong JWT secret in production', () => {
      const validated = validateJwtSecret(strongSecret, 'production');
      assert.equal(validated, strongSecret);
    });

    it('should safely fall back to dev secret in non-production when secret is unset', () => {
      const devVal = validateJwtSecret('', 'development');
      assert.equal(devVal, devDefaultSecret);

      const testVal = validateJwtSecret(undefined, 'test');
      assert.equal(testVal, devDefaultSecret);
    });
  });

  describe('2. Algorithm Restriction & Signature Verification', () => {
    it('should explicitly define HS256 as the accepted signing algorithm', () => {
      assert.deepEqual(JWT_ACCEPTED_ALGORITHMS, ['HS256']);
    });

    it('should accept tokens signed with HS256 and valid secret', (t, done) => {
      const payload = { userId: 'user_123', role: 'ADMIN' };
      const token = jwt.sign(payload, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

      const req = { headers: { authorization: `Bearer ${token}` } };
      const res = {};
      const next = (err) => {
        assert.equal(err, undefined);
        assert.equal(req.user.userId, 'user_123');
        assert.equal(req.user.role, 'ADMIN');
        done();
      };

      requireAuth(req, res, next);
    });

    it('should reject tokens signed with unapproved algorithms (e.g. HS384, HS512)', (t, done) => {
      const payload = { userId: 'attacker_123', role: 'ADMIN' };
      // Sign with HS512 instead of HS256
      const tokenHS512 = jwt.sign(payload, config.jwt.secret, { algorithm: 'HS512', expiresIn: '1h' });

      const req = { headers: { authorization: `Bearer ${tokenHS512}` } };
      const res = {};
      const next = (err) => {
        assert.ok(err, 'Must reject token with unapproved algorithm');
        assert.equal(err.statusCode, 401);
        assert.equal(err.code, 'INVALID_TOKEN');
        assert.match(err.message, /invalid algorithm/i);
        assert.equal(req.user, undefined, 'Must NEVER populate req.user on algorithm mismatch');
        done();
      };

      requireAuth(req, res, next);
    });

    it('should reject algorithm "none" tokens (signature bypass attack)', (t, done) => {
      // Create token with alg: none
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ userId: 'attacker', role: 'ADMIN' })).toString('base64url');
      const noneToken = `${header}.${payload}.`;

      const req = { headers: { authorization: `Bearer ${noneToken}` } };
      const res = {};
      const next = (err) => {
        assert.ok(err, 'Algorithm "none" token must be strictly rejected');
        assert.equal(err.statusCode, 401);
        assert.equal(err.code, 'INVALID_TOKEN');
        assert.equal(req.user, undefined);
        done();
      };

      requireAuth(req, res, next);
    });

    it('should reject tokens with tampered payloads (signature mismatch)', (t, done) => {
      const token = jwt.sign({ userId: 'legit_user', role: 'USER' }, config.jwt.secret, { algorithm: 'HS256' });
      const [h, p, s] = token.split('.');
      // Tamper with payload to elevate role to ADMIN
      const tamperedPayload = Buffer.from(JSON.stringify({ userId: 'legit_user', role: 'ADMIN' })).toString('base64url');
      const tamperedToken = `${h}.${tamperedPayload}.${s}`;

      const req = { headers: { authorization: `Bearer ${tamperedToken}` } };
      const res = {};
      const next = (err) => {
        assert.ok(err);
        assert.equal(err.statusCode, 401);
        assert.equal(err.code, 'INVALID_TOKEN');
        assert.match(err.message, /invalid signature/i);
        assert.equal(req.user, undefined);
        done();
      };

      requireAuth(req, res, next);
    });

    it('should reject tokens signed with a different secret', (t, done) => {
      const tokenWithWrongSecret = jwt.sign({ userId: 'user_x' }, 'different_unauthorized_key_here!', {
        algorithm: 'HS256',
      });

      const req = { headers: { authorization: `Bearer ${tokenWithWrongSecret}` } };
      const res = {};
      const next = (err) => {
        assert.ok(err);
        assert.equal(err.statusCode, 401);
        assert.equal(err.code, 'INVALID_TOKEN');
        assert.match(err.message, /invalid signature/i);
        done();
      };

      requireAuth(req, res, next);
    });
  });

  describe('3. Token Lifecycle & Expiration Verification', () => {
    it('should reject expired tokens with HTTP 401 (INVALID_TOKEN)', (t, done) => {
      const expiredToken = jwt.sign({ userId: 'expired_user' }, config.jwt.secret, {
        algorithm: 'HS256',
        expiresIn: '-5s', // Already expired
      });

      const req = { headers: { authorization: `Bearer ${expiredToken}` } };
      const res = {};
      const next = (err) => {
        assert.ok(err);
        assert.equal(err.statusCode, 401);
        assert.equal(err.code, 'INVALID_TOKEN');
        assert.match(err.message, /jwt expired/i);
        done();
      };

      requireAuth(req, res, next);
    });

    it('should reject malformed or non-JWT tokens', (t, done) => {
      const req = { headers: { authorization: 'Bearer completely_bogus_token_format' } };
      const res = {};
      const next = (err) => {
        assert.ok(err);
        assert.equal(err.statusCode, 401);
        assert.equal(err.code, 'INVALID_TOKEN');
        assert.match(err.message, /jwt malformed/i);
        done();
      };

      requireAuth(req, res, next);
    });
  });

  describe('4. Token Redaction & Leakage Prevention', () => {
    it('should scrub bare JWTs in logs and text via redactString()', () => {
      const testJwt = jwt.sign({ data: 'confidential' }, config.jwt.secret, { algorithm: 'HS256' });
      const logMessage = `User request authenticated with token: ${testJwt} from internal service`;

      const redacted = redactString(logMessage);
      assert.ok(!redacted.includes(testJwt), 'Log message must NOT contain raw JWT');
      assert.ok(redacted.includes('[REDACTED_JWT]'));
    });

    it('should scrub Authorization Bearer JWT headers via redactString()', () => {
      const testJwt = jwt.sign({ user: 'trader' }, config.jwt.secret, { algorithm: 'HS256' });
      const headerString = `Headers: { Authorization: Bearer ${testJwt} }`;

      const redacted = redactString(headerString);
      assert.ok(!redacted.includes(testJwt));
      assert.ok(redacted.includes('Bearer [REDACTED]'));
    });
  });

  describe('5. Integration with Protected Disconnect Endpoint', () => {
    it('should allow disconnect when presented with valid HS256 JWT', async () => {
      await tokenService.saveAccessToken('sample_token_for_disconnect_test');
      assert.ok(await tokenService.getAccessToken());

      const validJwt = jwt.sign({ userId: 'admin_1', role: 'ADMIN' }, config.jwt.secret, {
        algorithm: 'HS256',
        expiresIn: '5m',
      });

      const res = await request(app)
        .post('/api/auth/upstox/disconnect')
        .set('Authorization', `Bearer ${validJwt}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.active, false);

      const after = await tokenService.getAccessToken();
      assert.equal(after, null);
    });

    it('should reject disconnect when presented with token signed with unapproved algorithm (HS512)', async () => {
      await tokenService.saveAccessToken('sample_token_should_not_be_cleared');

      const hs512Jwt = jwt.sign({ userId: 'admin_1', role: 'ADMIN' }, config.jwt.secret, {
        algorithm: 'HS512',
        expiresIn: '5m',
      });

      const res = await request(app)
        .post('/api/auth/upstox/disconnect')
        .set('Authorization', `Bearer ${hs512Jwt}`);

      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_TOKEN');

      // Verify token was NOT deleted
      const stored = await tokenService.getAccessToken();
      assert.equal(stored, 'sample_token_should_not_be_cleared');

      await tokenService.clearToken();
    });
  });
});
