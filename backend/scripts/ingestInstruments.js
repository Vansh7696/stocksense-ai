#!/usr/bin/env node
/**
 * StockSense AI — Manual Instrument Master Ingestion Script
 *
 * Executes the complete Upstox instrument master download, parsing,
 * validation, and database upsert workflow.
 *
 * Usage:
 *   npm run ingest:instruments
 *   npm run ingest:instruments -- --all
 *   npm run ingest:instruments -- --dry-run
 *   npm run ingest:instruments -- --limit=1000
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import instrumentIngestionService from '../src/services/instruments/instrumentIngestion.service.js';
import prisma from '../src/config/prisma.js';
import redisClient from '../src/config/redis.js';

const args = process.argv.slice(2);
const isAllSegments = args.includes('--all');
const isDryRun = args.includes('--dry-run');

const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined;

async function main() {
  console.log('===============================================================');
  console.log('  StockSense AI — Official Upstox Instrument Master Ingestion  ');
  console.log('===============================================================');
  console.log(`- Mode: ${isDryRun ? 'DRY RUN (simulation only)' : 'LIVE DATABASE WRITE'}`);
  console.log(`- Scope: ${isAllSegments ? 'ALL SEGMENTS (Equities + Derivatives)' : 'EQUITIES & INDICES ONLY (NSE_EQ, BSE_EQ, NSE_INDEX, BSE_INDEX)'}`);
  if (limit) console.log(`- Limit: ${limit} records`);
  console.log('---------------------------------------------------------------');
  console.log('⏳ Downloading & processing official Upstox instrument master...');

  try {
    const result = await instrumentIngestionService.ingest({
      allSegments: isAllSegments,
      dryRun: isDryRun,
      limit,
      onProgress: (current, total) => {
        if (current % 2500 === 0 || current === total) {
          process.stdout.write(`\r  Database progress: ${current}/${total} records processed...`);
        }
      },
    });

    console.log('\n---------------------------------------------------------------');
    console.log('📊 INGESTION SUMMARY REPORT:');
    console.log('---------------------------------------------------------------');
    console.log(`- Final Status:                     ${result.status === 'SUCCESS' ? '✅ SUCCESS' : '⚠️ ' + result.status}`);
    console.log(`- Total Downloaded:                 ${result.totalDownloaded.toLocaleString()}`);
    console.log(`- Valid In-Scope:                   ${result.validInScope.toLocaleString()}`);
    console.log(`- Valid Out-of-Scope (Derivatives): ${result.validOutOfScope.toLocaleString()}`);
    console.log(`- Invalid Records:                  ${result.invalidRecords.toLocaleString()}`);
    console.log(`- NSE Records:                      ${result.nseRecords.toLocaleString()}`);
    console.log(`- BSE Records:                      ${result.bseRecords.toLocaleString()}`);
    console.log(`- Inserted Records:                 ${result.insertedRecords.toLocaleString()}`);
    console.log(`- Updated Records:                  ${result.updatedRecords.toLocaleString()}`);
    console.log(`- Skipped Records:                  ${result.skippedRecords.toLocaleString()}`);
    console.log(`- Total Duration:                   ${(result.durationMs / 1000).toFixed(2)} seconds`);
    console.log('===============================================================');

    if (result.errors && result.errors.length > 0) {
      console.warn(`⚠️ Warning: ${result.errors.length} batch errors occurred.`);
    }

    process.exit(0);
  } catch (err) {
    console.error('\n❌ Ingestion Failed:');
    console.error(`- Error Code: ${err.code || 'UNKNOWN_ERROR'}`);
    console.error(`- Message:    ${err.message}`);
    console.log('===============================================================');
    process.exit(1);
  } finally {
    try {
      if (redisClient) await redisClient.quit();
      await prisma.$disconnect();
    } catch {
      // Ignore disconnect errors
    }
  }
}

main();
