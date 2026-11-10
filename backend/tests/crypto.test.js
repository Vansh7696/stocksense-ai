import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEncryptionKey,
  getEncryptionKey,
  encrypt,
  decrypt,
  redactSecrets,
  redactString,
  isSensitiveKey,
} from '../src/utils/crypto.js';
import {
  validateAppEncryptionKey,
  validateCsrfSecret,
  validateJwtSecret,
} from '../src/config/index.js';

describe('Milestone 3 — Step 1: Security & Cryptography Module (Comprehensive Audit)', () => {
  const validTestKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const alternateKey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

  describe('1. Environment Key Validation (validateEncryptionKey)', () => {
    it('should validate and return a 32-byte Buffer for a 64-char hex key', () => {
      const buffer = validateEncryptionKey(validTestKey);
      assert.ok(Buffer.isBuffer(buffer), 'Should return a Buffer');
      assert.equal(buffer.length, 32, 'Key buffer must be exactly 32 bytes (256 bits)');
    });

    it('should throw when the key is missing or empty', () => {
      assert.throws(() => validateEncryptionKey(null), /missing or empty/i);
      assert.throws(() => validateEncryptionKey(undefined), /missing or empty/i);
      assert.throws(() => validateEncryptionKey(''), /missing or empty/i);
      assert.throws(() => validateEncryptionKey(12345), /missing or empty/i);
    });

    it('should throw when the key length is not 64 hex characters', () => {
      assert.throws(() => validateEncryptionKey('abcdef'), /Expected 64 hexadecimal characters/i);
      assert.throws(
        () => validateEncryptionKey('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde'), // 63 chars
        /Expected 64 hexadecimal characters/i
      );
      assert.throws(
        () => validateEncryptionKey('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0'), // 65 chars
        /Expected 64 hexadecimal characters/i
      );
    });

    it('should throw when the key contains non-hexadecimal characters', () => {
      const invalidHexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg'; // 'g' is invalid
      assert.throws(() => validateEncryptionKey(invalidHexKey), /Invalid APP_ENCRYPTION_KEY/i);
    });

    it('should use default key from config when called with no arguments', () => {
      const keyBuffer = getEncryptionKey();
      assert.ok(Buffer.isBuffer(keyBuffer));
      assert.equal(keyBuffer.length, 32);
    });

    it('should never expose the raw encryption key in error messages', () => {
      const badKey = 'secret_password_that_must_not_leak_in_logs';
      try {
        validateEncryptionKey(badKey);
        assert.fail('Should have thrown an error');
      } catch (err) {
        assert.ok(!err.message.includes(badKey), 'Error message must not contain the sensitive key string');
      }
    });
  });

  describe('2. AES-256-GCM Encryption (encrypt) & Fresh IV Guarantee', () => {
    it('should encrypt plaintext into an object with hex iv, authTag, and ciphertext', () => {
      const plaintext = 'upstox_access_token_secret_xyz12345';
      const result = encrypt(plaintext, validTestKey);

      assert.ok(result, 'Result should exist');
      assert.equal(typeof result.iv, 'string', 'IV should be a string');
      assert.equal(result.iv.length, 24, 'IV should be 24 hex characters (12 bytes / 96 bits)');

      assert.equal(typeof result.authTag, 'string', 'authTag should be a string');
      assert.equal(result.authTag.length, 32, 'authTag should be 32 hex characters (16 bytes / 128 bits)');

      assert.equal(typeof result.ciphertext, 'string', 'ciphertext should be a string');
      assert.ok(result.ciphertext.length > 0, 'ciphertext should not be empty');
      assert.notEqual(result.ciphertext, plaintext, 'ciphertext must not match plaintext');
    });

    it('should generate a fresh, unique IV for every single encryption call (100 iterations)', () => {
      const plaintext = 'constant_market_feed_auth_token';
      const ivSet = new Set();
      const ciphertextSet = new Set();

      for (let i = 0; i < 100; i++) {
        const result = encrypt(plaintext, validTestKey);
        ivSet.add(result.iv);
        ciphertextSet.add(result.ciphertext);
      }

      assert.equal(ivSet.size, 100, 'All 100 generated IVs must be strictly unique');
      assert.equal(ciphertextSet.size, 100, 'All 100 ciphertexts must be strictly unique');
    });

    it('should reject non-string or empty plaintexts without printing plaintext in errors', () => {
      assert.throws(() => encrypt('', validTestKey), /non-empty string/i);
      assert.throws(() => encrypt(null, validTestKey), /non-empty string/i);
      assert.throws(() => encrypt(undefined, validTestKey), /non-empty string/i);
      assert.throws(() => encrypt(12345, validTestKey), /non-empty string/i);
      assert.throws(() => encrypt({ secret: 'data' }, validTestKey), /non-empty string/i);
    });
  });

  describe('3. AES-256-GCM Decryption & Integrity Verification (decrypt)', () => {
    it('should successfully decrypt ciphertext back to original plaintext', () => {
      const plaintext = 'jwt.header.payload.signature_token_from_upstox_api_v3';
      const encrypted = encrypt(plaintext, validTestKey);
      const decrypted = decrypt(encrypted, validTestKey);

      assert.equal(decrypted, plaintext, 'Decrypted text must match original plaintext');
    });

    it('should correctly handle multi-byte Unicode and JSON strings', () => {
      const complexData = JSON.stringify({
        token: '₹-rupee-symbol-and-emojis-📈🚀',
        symbol: 'RELIANCE',
        expiry: '2026-11-08T03:30:00.000+05:30',
      });

      const encrypted = encrypt(complexData, validTestKey);
      const decrypted = decrypt(encrypted, validTestKey);

      assert.equal(decrypted, complexData);
      assert.deepEqual(JSON.parse(decrypted), JSON.parse(complexData));
    });

    it('should fail safely if ciphertext is tampered with', () => {
      const plaintext = 'sensitive_broker_credential';
      const encrypted = encrypt(plaintext, validTestKey);

      // Tamper with the last character of ciphertext
      const tamperedChar = encrypted.ciphertext.slice(-1) === 'a' ? 'b' : 'a';
      const tamperedCiphertext = encrypted.ciphertext.slice(0, -1) + tamperedChar;

      assert.throws(
        () =>
          decrypt(
            {
              iv: encrypted.iv,
              authTag: encrypted.authTag,
              ciphertext: tamperedCiphertext,
            },
            validTestKey
          ),
        /Authentication tag verification failed/i
      );
    });

    it('should fail safely if authTag is altered or forged', () => {
      const plaintext = 'sensitive_broker_credential';
      const encrypted = encrypt(plaintext, validTestKey);

      assert.throws(
        () =>
          decrypt(
            {
              iv: encrypted.iv,
              authTag: '0'.repeat(32),
              ciphertext: encrypted.ciphertext,
            },
            validTestKey
          ),
        /Authentication tag verification failed/i
      );
    });

    it('should fail safely if decrypted with an incorrect key', () => {
      const plaintext = 'classified_financial_data';
      const encrypted = encrypt(plaintext, validTestKey);

      assert.throws(
        () => decrypt(encrypted, alternateKey),
        /Authentication tag verification failed/i
      );
    });

    it('should fail safely on malformed inputs (non-hex, odd length, invalid lengths)', () => {
      assert.throws(() => decrypt(null, validTestKey), /Invalid decryption payload/i);
      assert.throws(() => decrypt({}, validTestKey), /Invalid IV/i);
      assert.throws(
        () => decrypt({ iv: 'short', authTag: '0'.repeat(32), ciphertext: 'abcd' }, validTestKey),
        /Invalid IV/i
      );
      assert.throws(
        () => decrypt({ iv: 'z'.repeat(24), authTag: '0'.repeat(32), ciphertext: 'abcd' }, validTestKey),
        /Invalid IV/i
      );
      assert.throws(
        () => decrypt({ iv: '0'.repeat(24), authTag: 'short', ciphertext: 'abcd' }, validTestKey),
        /Invalid Auth Tag/i
      );
      assert.throws(
        () => decrypt({ iv: '0'.repeat(24), authTag: 'g'.repeat(32), ciphertext: 'abcd' }, validTestKey),
        /Invalid Auth Tag/i
      );
      assert.throws(
        () => decrypt({ iv: '0'.repeat(24), authTag: '0'.repeat(32), ciphertext: '' }, validTestKey),
        /Invalid Ciphertext/i
      );
      assert.throws(
        () => decrypt({ iv: '0'.repeat(24), authTag: '0'.repeat(32), ciphertext: 'abc' }, validTestKey), // odd length
        /Invalid Ciphertext/i
      );
    });
  });

  describe('4. Token & Secret Redaction (redactSecrets & redactString)', () => {
    it('should scrub secrets embedded in URLs and query parameters', () => {
      const url1 = 'https://api.upstox.com/v2/login/authorization/dialog?code=auth_code_secret_123&client_id=my_id';
      const url2 = 'https://api.upstox.com/v3/historical-candle/NSE_EQ?access_token=token_xyz_456&interval=1D';
      const url3 = 'https://gateway.internal/token?client_secret=super_secret_key&api_key=apikey_789';

      assert.equal(
        redactString(url1),
        'https://api.upstox.com/v2/login/authorization/dialog?code=[REDACTED]&client_id=my_id'
      );
      assert.equal(
        redactString(url2),
        'https://api.upstox.com/v3/historical-candle/NSE_EQ?access_token=[REDACTED]&interval=1D'
      );
      assert.equal(
        redactString(url3),
        'https://gateway.internal/token?client_secret=[REDACTED]&api_key=[REDACTED]'
      );
    });

    it('should redact secrets inside nested JSON strings', () => {
      const serializedJson = JSON.stringify({
        error: 'invalid_grant',
        access_token: 'secret_raw_token_xyz',
        symbol: 'RELIANCE',
      });

      const sanitizedJsonStr = redactString(serializedJson);
      const parsed = JSON.parse(sanitizedJsonStr);

      assert.equal(parsed.error, 'invalid_grant');
      assert.equal(parsed.access_token, '[REDACTED]');
      assert.equal(parsed.symbol, 'RELIANCE');
    });

    it('should sanitize Error messages and stack traces containing secrets', () => {
      const err = new Error('HTTP 401: Authorization: Bearer secret_jwt_token_456 failed for url https://api.upstox.com?client_secret=shhh');
      const sanitizedErr = redactSecrets(err);

      assert.ok(sanitizedErr instanceof Error);
      assert.ok(!sanitizedErr.message.includes('secret_jwt_token_456'));
      assert.ok(!sanitizedErr.message.includes('shhh'));
      assert.ok(sanitizedErr.message.includes('Bearer [REDACTED]'));
      assert.ok(sanitizedErr.message.includes('client_secret=[REDACTED]'));
    });

    it('should scrub Authorization headers and Bearer/Basic tokens across log formats', () => {
      const logs = [
        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test',
        'bearer: eyJhbGciOiJIUzI1NiJ9.test',
        'Authorization: Basic dXNlcjpwYXNz',
        "headers: { 'authorization': 'Bearer token123' }",
        'access_token: "secret456"',
      ];

      for (const log of logs) {
        const sanitized = redactString(log);
        assert.ok(!sanitized.includes('eyJhbGciOiJIUzI1NiJ9.test'), `Failed on: ${log}`);
        assert.ok(!sanitized.includes('dXNlcjpwYXNz'), `Failed on: ${log}`);
        assert.ok(!sanitized.includes('token123'), `Failed on: ${log}`);
        assert.ok(!sanitized.includes('secret456'), `Failed on: ${log}`);
      }
    });

    it('should NEVER falsely redact ordinary business fields containing "key" or "auth"', () => {
      const businessObject = {
        instrumentKey: 'NSE_EQ|INE002A01018',
        instrument_key: 'BSE_EQ|500325',
        routingKey: 'nse_order_router',
        primaryKey: 'uuid-1234-5678',
        author: 'Warren Buffett',
        authorName: 'Benjamin Graham',
        authority: 'Securities and Exchange Board of India (SEBI)',
        authenticated: true,
        authType: 'OAUTH2_CODE_GRANT',
        authenticationMethod: 'HMAC_SHA256',
        keyboard: 'QWERTY',
      };

      const sanitized = redactSecrets(businessObject);

      // Verify ZERO false positives
      assert.equal(sanitized.instrumentKey, 'NSE_EQ|INE002A01018', 'instrumentKey must not be redacted');
      assert.equal(sanitized.instrument_key, 'BSE_EQ|500325', 'instrument_key must not be redacted');
      assert.equal(sanitized.routingKey, 'nse_order_router', 'routingKey must not be redacted');
      assert.equal(sanitized.primaryKey, 'uuid-1234-5678', 'primaryKey must not be redacted');
      assert.equal(sanitized.author, 'Warren Buffett', 'author must not be redacted');
      assert.equal(sanitized.authorName, 'Benjamin Graham', 'authorName must not be redacted');
      assert.equal(sanitized.authority, 'Securities and Exchange Board of India (SEBI)', 'authority must not be redacted');
      assert.equal(sanitized.authenticated, true, 'authenticated status must not be redacted');
      assert.equal(sanitized.authType, 'OAUTH2_CODE_GRANT', 'authType must not be redacted');
      assert.equal(sanitized.authenticationMethod, 'HMAC_SHA256', 'authenticationMethod must not be redacted');
      assert.equal(sanitized.keyboard, 'QWERTY', 'keyboard must not be redacted');
    });

    it('should NOT falsely classify shared non-circular object references (DAGs) as circular', () => {
      const sharedExchange = {
        code: 'NSE',
        name: 'National Stock Exchange of India',
        country: 'India',
      };

      const portfolio = {
        stock1: {
          symbol: 'RELIANCE',
          exchange: sharedExchange,
        },
        stock2: {
          symbol: 'TCS',
          exchange: sharedExchange, // Repeated, non-circular reference!
        },
        stock3: {
          symbol: 'INFY',
          exchange: sharedExchange, // Repeated, non-circular reference!
        },
      };

      const sanitized = redactSecrets(portfolio);

      // Neither stock2.exchange nor stock3.exchange should be '[Circular]'!
      assert.deepEqual(sanitized.stock1.exchange, sharedExchange);
      assert.deepEqual(sanitized.stock2.exchange, sharedExchange, 'Repeated reference must NOT be marked [Circular]');
      assert.deepEqual(sanitized.stock3.exchange, sharedExchange, 'Repeated reference must NOT be marked [Circular]');
    });

    it('should correctly detect and break true circular references', () => {
      const nodeA = { name: 'NodeA' };
      const nodeB = { name: 'NodeB' };
      nodeA.next = nodeB;
      nodeB.next = nodeA; // True circular reference!

      assert.doesNotThrow(() => {
        const sanitized = redactSecrets(nodeA);
        assert.equal(sanitized.name, 'NodeA');
        assert.equal(sanitized.next.name, 'NodeB');
        assert.equal(sanitized.next.next, '[Circular]', 'True cycle must be marked [Circular]');
      });
    });

    it('should preserve primitives, arrays, and null values without modification', () => {
      assert.equal(redactSecrets(null), null);
      assert.equal(redactSecrets(undefined), undefined);
      assert.equal(redactSecrets(42), 42);
      assert.equal(redactSecrets(true), true);
      assert.deepEqual(redactSecrets([1, 2, 'hello']), [1, 2, 'hello']);
    });
  });

  describe('7. Application Security Configuration & Environment Safety', () => {
    const validHexKey = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const samplePlaceholderKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    it('validateAppEncryptionKey: fails safely in production if key is missing or empty', () => {
      assert.throws(
        () => validateAppEncryptionKey('', 'production'),
        /APP_ENCRYPTION_KEY environment variable is mandatory/i
      );
      assert.throws(
        () => validateAppEncryptionKey(undefined, 'production'),
        /APP_ENCRYPTION_KEY environment variable is mandatory/i
      );
    });

    it('validateAppEncryptionKey: fails safely in development if key is missing or empty', () => {
      assert.throws(
        () => validateAppEncryptionKey('', 'development'),
        /APP_ENCRYPTION_KEY environment variable is mandatory/i
      );
    });

    it('validateAppEncryptionKey: rejects invalid length or format in all environments', () => {
      assert.throws(
        () => validateAppEncryptionKey('short_key', 'production'),
        /must be exactly 64 hexadecimal characters/i
      );
      assert.throws(
        () => validateAppEncryptionKey('short_key', 'test'),
        /must be exactly 64 hexadecimal characters/i
      );
      assert.throws(
        () => validateAppEncryptionKey('z'.repeat(64), 'production'),
        /must be exactly 64 hexadecimal characters/i
      );
    });

    it('validateAppEncryptionKey: rejects known sample/placeholder keys in production', () => {
      assert.throws(
        () => validateAppEncryptionKey(samplePlaceholderKey, 'production'),
        /Known sample or placeholder APP_ENCRYPTION_KEY cannot be used in production/i
      );
    });

    it('validateAppEncryptionKey: accepts valid 64-hex key in production', () => {
      const result = validateAppEncryptionKey(validHexKey, 'production');
      assert.equal(result, validHexKey);
    });

    it('validateAppEncryptionKey: provides isolated test key in test environment when unset', () => {
      const result = validateAppEncryptionKey(undefined, 'test');
      assert.equal(result.length, 64);
      assert.match(result, /^[0-9a-f]{64}$/);
    });

    it('validateCsrfSecret: enforces 32-character requirement and rejects placeholders in production', () => {
      assert.throws(
        () => validateCsrfSecret('', 'production'),
        /CSRF_SECRET environment variable is mandatory in production/i
      );
      assert.throws(
        () => validateCsrfSecret('short', 'production'),
        /at least 32 characters long/i
      );
      assert.throws(
        () => validateCsrfSecret('dev_super_secret_csrf_hmac_signing_key_32chars!', 'production'),
        /Insecure or placeholder CSRF_SECRET/i
      );
      const validCsrf = 'my_super_secure_production_csrf_token_signing_key_12345';
      assert.equal(validateCsrfSecret(validCsrf, 'production'), validCsrf);
    });
  });
});
