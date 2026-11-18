/**
 * StockSense AI — Milestone 6B.2: Environment Validation & Secrets Management Tests
 * Tests fail-closed validation of critical production configuration parameters,
 * weak secret rejection, database URI validation, and CORS restrictions.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionEnvironment } from '../src/config/index.js';

describe('Milestone 6B.2: Secrets Management & Environment Validation Tests', () => {
  const validProductionEnv = {
    NODE_ENV: 'production',
    PORT: '5001',
    DATABASE_URL: 'postgresql://prod_app_user:StrongRandomPassw0rd987654321@db-cluster.internal:5432/stocksense_db?sslmode=require',
    REDIS_URL: 'rediss://:StrongRedisAuthToken12345@redis-cluster.internal:6379',
    JWT_SECRET: '48b84bff11fcd4ce330072752d8cc2159f886567418ca6d4742ce6427dc2bf25',
    APP_ENCRYPTION_KEY: '61f46d549d73155d7467f219a8c4bcd413bddcdfb925f1475914ab039e9d5bd1',
    CSRF_SECRET: 'csrf_secret_high_entropy_32_character_signing_key_production!',
    CORS_ORIGIN: 'https://stocksense.ai',
  };

  test('1. Valid production environment passes validation without error', () => {
    const result = validateProductionEnvironment(validProductionEnv, 'production');
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  test('2. Rejects missing or weak JWT_SECRET in production', () => {
    // Missing JWT_SECRET
    const missingSecretEnv = { ...validProductionEnv, JWT_SECRET: '' };
    assert.throws(
      () => validateProductionEnvironment(missingSecretEnv, 'production'),
      /JWT_SECRET environment variable is mandatory in production/
    );

    // Insecure placeholder JWT_SECRET
    const placeholderSecretEnv = { ...validProductionEnv, JWT_SECRET: 'dev_super_secret_jwt_key_stocksense' };
    assert.throws(
      () => validateProductionEnvironment(placeholderSecretEnv, 'production'),
      /Insecure or placeholder JWT_SECRET cannot be used in production/
    );

    // Short (<32 chars) JWT_SECRET
    const shortSecretEnv = { ...validProductionEnv, JWT_SECRET: 'too-short-secret' };
    assert.throws(
      () => validateProductionEnvironment(shortSecretEnv, 'production'),
      /must be at least 32 characters long/
    );
  });

  test('3. Rejects missing, invalid length, or placeholder APP_ENCRYPTION_KEY in production', () => {
    const placeholderKeyEnv = {
      ...validProductionEnv,
      APP_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };
    assert.throws(
      () => validateProductionEnvironment(placeholderKeyEnv, 'production'),
      /Known sample or placeholder APP_ENCRYPTION_KEY cannot be used in production/
    );

    const nonHexKeyEnv = {
      ...validProductionEnv,
      APP_ENCRYPTION_KEY: 'not_a_valid_hex_key_must_be_64_characters_long_0123456789abcdefzzzz',
    };
    assert.throws(
      () => validateProductionEnvironment(nonHexKeyEnv, 'production'),
      /must be exactly 64 hexadecimal characters/
    );
  });

  test('4. Rejects invalid or insecure default credentials in DATABASE_URL', () => {
    const defaultCredentialsEnv = {
      ...validProductionEnv,
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/stocksense_db',
    };
    assert.throws(
      () => validateProductionEnvironment(defaultCredentialsEnv, 'production'),
      /must not use default or trivial credentials/
    );

    const nonPostgresEnv = {
      ...validProductionEnv,
      DATABASE_URL: 'mysql://user:pass@localhost:3306/db',
    };
    assert.throws(
      () => validateProductionEnvironment(nonPostgresEnv, 'production'),
      /must be a valid postgresql:\/\/ connection URI/
    );
  });

  test('5. Rejects missing or non-redis protocol in REDIS_URL', () => {
    const invalidRedisEnv = {
      ...validProductionEnv,
      REDIS_URL: 'http://localhost:6379',
    };
    assert.throws(
      () => validateProductionEnvironment(invalidRedisEnv, 'production'),
      /REDIS_URL must begin with redis:\/\/ or rediss:\/\/ protocol/
    );
  });

  test('6. Rejects wildcard CORS_ORIGIN in production', () => {
    const wildcardCorsEnv = {
      ...validProductionEnv,
      CORS_ORIGIN: '*',
    };
    assert.throws(
      () => validateProductionEnvironment(wildcardCorsEnv, 'production'),
      /CORS_ORIGIN cannot be a wildcard/
    );
  });

  test('7. Environment validation is permissive in development mode', () => {
    const devEnv = {
      NODE_ENV: 'development',
      JWT_SECRET: '',
    };
    const result = validateProductionEnvironment(devEnv, 'development');
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });
});
