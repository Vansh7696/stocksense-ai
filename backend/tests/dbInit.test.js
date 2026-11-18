import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { waitForDatabase, applyPendingMigrations, ensureDatabaseSeeded, initializeDatabase } from '../src/utils/dbInit.js';

describe('Phase 5C.7.4: Automated Database Migration & Seeding Resilience Tests', () => {

  test('1. waitForDatabase returns true immediately when client.$queryRaw succeeds', async () => {
    let callCount = 0;
    const mockClient = {
      $queryRaw: async () => {
        callCount++;
        return [{ 1: 1 }];
      },
    };

    const result = await waitForDatabase(mockClient, {
      maxRetries: 3,
      initialDelayMs: 10,
      factor: 1,
      throwOnFailure: true,
    });

    assert.equal(result, true);
    assert.equal(callCount, 1);
  });

  test('2. waitForDatabase retries with exponential backoff on transient failure and recovers', async () => {
    let attempts = 0;
    const mockClient = {
      $queryRaw: async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Connection refused: PostgreSQL starting up');
        }
        return [{ 1: 1 }];
      },
    };

    const result = await waitForDatabase(mockClient, {
      maxRetries: 5,
      initialDelayMs: 20,
      factor: 1.2,
      throwOnFailure: true,
    });

    assert.equal(result, true);
    assert.equal(attempts, 3);
  });

  test('3. waitForDatabase returns false or throws when maxRetries exhausted', async () => {
    const mockClient = {
      $queryRaw: async () => {
        throw new Error('Fatal connection refused');
      },
    };

    // With throwOnFailure = false
    const result = await waitForDatabase(mockClient, {
      maxRetries: 2,
      initialDelayMs: 10,
      factor: 1,
      throwOnFailure: false,
    });
    assert.equal(result, false);

    // With throwOnFailure = true
    await assert.rejects(
      async () => {
        await waitForDatabase(mockClient, {
          maxRetries: 2,
          initialDelayMs: 10,
          factor: 1,
          throwOnFailure: true,
        });
      },
      /Database connection failed after 2 attempts/
    );
  });

  test('4. applyPendingMigrations safely skips in test environment', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const result = await applyPendingMigrations();
      assert.equal(result.applied, false);
      assert.match(result.message, /Skipped in test environment/);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  test('5. ensureDatabaseSeeded skips seeding if database already contains records', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const mockClient = {
        exchange: { count: async () => 2 },
        stock: { count: async () => 7 },
      };

      const result = await ensureDatabaseSeeded(mockClient);
      assert.equal(result.seeded, false);
      assert.equal(result.details.exchangeCount, 2);
      assert.equal(result.details.stockCount, 7);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  test('6. ensureDatabaseSeeded executes seed if records are 0', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      let seedExecuted = false;
      const mockClient = {
        exchange: {
          count: async () => 0,
          upsert: async ({ create }) => ({ id: 'ex-1', code: create.code, name: create.name }),
        },
        stock: {
          count: async () => 0,
          upsert: async ({ create }) => ({ id: 'stk-1', symbol: create.symbol }),
        },
      };

      const result = await ensureDatabaseSeeded(mockClient);
      assert.equal(result.seeded, true);
      assert.ok(result.details.exchangeCount >= 2);
      assert.ok(result.details.stockCount >= 5);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  test('7. initializeDatabase coordinates full check', async () => {
    const mockClient = {
      $queryRaw: async () => [{ 1: 1 }],
      exchange: { count: async () => 2 },
      stock: { count: async () => 7 },
    };

    // Run in test environment
    const result = await initializeDatabase({
      maxRetries: 2,
      initialDelayMs: 10,
    });

    assert.equal(result.connected, true);
    assert.equal(result.initialized, true);
  });
});
