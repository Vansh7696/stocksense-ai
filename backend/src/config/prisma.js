import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

/**
 * Validates that automated tests never run against development or production databases.
 * Throws a fatal safety error if NODE_ENV === 'test' and the active database URL
 * points to the development database (stocksense_db) or does not designate an isolated test database.
 *
 * @param {string} url
 */
export function assertTestDatabaseSafety(url) {
  if (process.env.NODE_ENV === 'test') {
    if (!url || typeof url !== 'string') {
      throw new Error(
        'DATABASE SAFETY ERROR: TEST_DATABASE_URL is required when NODE_ENV === "test". Automated tests are strictly prohibited from running without an isolated test database.'
      );
    }
    const isExplicitTestDb = url.includes('test_db') || url.includes('_test') || url.includes('/test');
    const isDevOrProdDb = url.endsWith('/stocksense_db') || url.includes('/stocksense_db?');
    if (!isExplicitTestDb || isDevOrProdDb) {
      throw new Error(
        `DATABASE SAFETY VIOLATION: Automated tests are prohibited from running against development or production database (${url}). Tests must point to an isolated test database (e.g. stocksense_test_db).`
      );
    }
  }
}

const isTest = process.env.NODE_ENV === 'test';
const resolvedDbUrl = isTest
  ? process.env.TEST_DATABASE_URL
  : process.env.DATABASE_URL;

if (isTest) {
  assertTestDatabaseSafety(resolvedDbUrl);
}

let prisma;

if (process.env.NODE_ENV === 'production') {
  prisma = new PrismaClient();
} else {
  if (!global.__db) {
    global.__db = new PrismaClient({
      datasources: resolvedDbUrl ? { db: { url: resolvedDbUrl } } : undefined,
      log: ['error', 'warn']
    });
  }
  prisma = global.__db;
}

export default prisma;
