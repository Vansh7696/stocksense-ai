#!/usr/bin/env node
/**
 * StockSense AI — Historical Market Data Ingestion CLI
 *
 * Downloads, validates, and persists historical OHLCV candlestick data
 * using the official Upstox API V3 provider.
 *
 * Usage:
 *   npm run ingest:historical -- --symbol=RELIANCE --from=2025-01-01 --to=2025-12-31
 *   npm run ingest:historical -- --symbols=RELIANCE,TCS,INFY --from=2025-01-01 --to=2025-12-31
 *   npm run ingest:historical -- --all --from=2025-01-01 --to=2025-12-31
 *   npm run ingest:historical -- --symbol=RELIANCE --dry-run
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import historicalIngestionService, {
  HistoricalIngestionService,
  INITIAL_NSE_EQUITIES,
  DEFAULT_HISTORICAL_YEARS,
} from '../src/services/historical/historicalIngestion.service.js';
import tokenService from '../src/services/token.service.js';
import prisma from '../src/config/prisma.js';
import redisClient from '../src/config/redis.js';
import { getExpectedTradingDays } from '../src/utils/tradingCalendar.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
StockSense AI — Historical OHLCV Ingestion Tool
Usage:
  npm run ingest:historical -- [options]

Options:
  --symbol=SYM        Single NSE equity symbol (e.g. RELIANCE)
  --symbols=S1,S2     Comma-separated list of symbols (e.g. RELIANCE,TCS,INFY)
  --all               Ingest all 5 initial NSE equities (${INITIAL_NSE_EQUITIES.join(', ')})
  --from=YYYY-MM-DD   Start date (defaults to 3 years ago in Asia/Kolkata)
  --to=YYYY-MM-DD     End date (defaults to today in Asia/Kolkata)
  --years=N           Number of historical years when --from is omitted (default: 3)
  --interval=INTERVAL Candle interval (default: 1D)
  --incremental       Only ingest missing days since latest stored candle
  --dry-run           Simulate ingestion without writing to PostgreSQL
  --mock              Use offline simulated provider (for testing when Upstox token is not configured)
  --help, -h          Show this help message
`);
  process.exit(0);
}

const isAll = args.includes('--all');
const isDryRun = args.includes('--dry-run');
const isIncremental = args.includes('--incremental');
const isMock = args.includes('--mock');

const symbolArg = args.find((a) => a.startsWith('--symbol='));
const symbolsArg = args.find((a) => a.startsWith('--symbols='));
const fromArg = args.find((a) => a.startsWith('--from='));
const toArg = args.find((a) => a.startsWith('--to='));
const yearsArg = args.find((a) => a.startsWith('--years='));
const intervalArg = args.find((a) => a.startsWith('--interval='));

const singleSymbol = symbolArg ? symbolArg.split('=')[1].trim().toUpperCase() : undefined;
const multipleSymbols = symbolsArg ? symbolsArg.split('=')[1].trim().toUpperCase().split(',') : undefined;
const from = fromArg ? fromArg.split('=')[1].trim() : undefined;
const to = toArg ? toArg.split('=')[1].trim() : undefined;
const years = yearsArg ? parseInt(yearsArg.split('=')[1].trim(), 10) : DEFAULT_HISTORICAL_YEARS;
const interval = intervalArg ? intervalArg.split('=')[1].trim() : '1D';

/**
 * Creates a deterministic mock Upstox provider for offline simulation/dry-run testing.
 */
function createMockProvider() {
  const basePrices = {
    RELIANCE: 2850.0,
    TCS: 3950.0,
    INFY: 1520.0,
    HDFCBANK: 1680.0,
    ICICIBANK: 1150.0,
  };

  return {
    resolveInstrumentKey(stockOrSymbol, exchangeCode = 'NSE') {
      const sym = typeof stockOrSymbol === 'string' ? stockOrSymbol : stockOrSymbol?.symbol;
      return `NSE_EQ|MOCK_${sym || 'STOCK'}`;
    },
    async getHistoricalCandles(instrumentKey, reqInterval = '1D', reqFrom, reqTo) {
      const sym = instrumentKey.replace('NSE_EQ|MOCK_', '').replace('NSE_EQ|', '');
      const base = basePrices[sym] || 1000.0;
      const expectedDays = getExpectedTradingDays(reqFrom, reqTo);

      const validCandles = expectedDays.map((dateStr, idx) => {
        const drift = Math.sin(idx / 10) * (base * 0.05);
        const close = Number((base + drift).toFixed(4));
        const open = Number((close - 5.0).toFixed(4));
        const high = Number((Math.max(open, close) + 10.0).toFixed(4));
        const low = Number((Math.min(open, close) - 10.0).toFixed(4));
        const volume = BigInt(1000000 + (idx % 500) * 10000);

        return {
          timestamp: new Date(`${dateStr}T09:15:00+05:30`),
          open: open.toFixed(4),
          high: high.toFixed(4),
          low: low.toFixed(4),
          close: close.toFixed(4),
          volume,
          volumeString: volume.toString(),
          openDecimal: open.toFixed(4),
          highDecimal: high.toFixed(4),
          lowDecimal: low.toFixed(4),
          closeDecimal: close.toFixed(4),
          dataSource: 'MOCK',
        };
      });

      return {
        status: 'SUCCESS',
        data: validCandles,
        rejected: [],
        failedChunks: [],
        dataFreshness: 'MOCK_DATASET',
        source: 'MOCK_UPSTOX',
        interval: reqInterval,
        instrumentKey,
      };
    },
  };
}

async function main() {
  console.log('===============================================================');
  console.log('  StockSense AI — Historical Market Data Ingestion Pipeline    ');
  console.log('===============================================================');
  console.log(`- Mode:        ${isDryRun ? 'DRY RUN (Simulates persistence without writing to database)' : 'LIVE DATABASE WRITE'}`);
  console.log(`- Strategy:    ${isIncremental ? 'INCREMENTAL (Only ingests missing days since latest candle)' : 'FULL RANGE'}`);
  console.log(`- Provider:    ${isMock ? 'OFFLINE MOCK PROVIDER (Simulated)' : 'UPSTOX API V3 (Official Broker)'}`);
  console.log(`- Interval:    ${interval}`);
  console.log(`- Scope:       ${isAll ? 'ALL INITIAL NSE EQUITIES' : (singleSymbol || (multipleSymbols ? multipleSymbols.join(', ') : 'DEFAULT INITIAL 5'))}`);
  console.log(`- Date From:   ${from || `Default (${years} years ago in Asia/Kolkata)`}`);
  console.log(`- Date To:     ${to || 'Default (today in Asia/Kolkata)'}`);
  console.log('---------------------------------------------------------------');

  // Verify active Upstox credentials before executing live pipeline
  if (!isMock) {
    const activeToken = await tokenService.getAccessToken();
    if (!activeToken) {
      console.error('\n❌ UPSTOX AUTHENTICATION REQUIRED');
      console.error('The historical market data pipeline requires an active Upstox access token for live API calls.');
      console.error('No active or valid access token was found in Redis, database, or environment.');
      console.error('\nAction Required to Authorize Upstox:');
      console.error('  1. Start the API gateway: npm run dev');
      console.error('  2. Visit in your browser: http://localhost:5001/api/auth/upstox/start');
      console.error('  3. Log in with your Upstox credentials and approve the application.');
      console.error('  4. The OAuth callback will automatically store and encrypt the token in PostgreSQL and Redis.');
      console.error('\nAlternatively, set UPSTOX_ACCESS_TOKEN in backend/.env for non-interactive execution.');
      console.error('\nFor offline simulation or dry-run validation without live broker credentials:');
      console.error('  npm run ingest:historical -- --all --dry-run --mock\n');
      console.log('===============================================================');
      process.exit(1);
    }
  }

  console.log('⏳ Initiating historical ingestion pipeline...');

  const service = isMock
    ? new HistoricalIngestionService({ provider: createMockProvider() })
    : historicalIngestionService;

  try {
    const result = await service.ingest({
      symbol: singleSymbol,
      symbols: multipleSymbols,
      all: isAll,
      from,
      to,
      years,
      interval,
      incremental: isIncremental,
      dryRun: isDryRun,
      onProgress: ({ symbol, stockIndex, totalStocks, currentRecords, totalRecords }) => {
        if (currentRecords % 100 === 0 || currentRecords === totalRecords) {
          process.stdout.write(
            `\r  [${stockIndex}/${totalStocks}] ${symbol}: Persisted ${currentRecords}/${totalRecords} candles...`
          );
        }
      },
    });

    console.log('\n---------------------------------------------------------------');
    console.log('📊 HISTORICAL INGESTION SUMMARY REPORT:');
    console.log('---------------------------------------------------------------');
    console.log(`- Final Status:         ${result.status === 'SUCCESS' ? '✅ SUCCESS' : result.status === 'PARTIAL' ? '⚠️ PARTIAL' : '❌ FAILED'}`);
    console.log(`- Mode:                 ${result.mode}`);
    console.log(`- Interval:             ${result.interval}`);
    console.log(`- Date Range:           ${result.dateRange.from} to ${result.dateRange.to}`);
    console.log(`- Stocks Processed:     ${result.stocksProcessed} / ${result.totalStocks}`);
    console.log(`- Total Candles Fetched:${result.totalFetched.toLocaleString()}`);
    console.log(`- Total Inserted:       ${result.totalInserted.toLocaleString()}`);
    console.log(`- Total Updated:        ${result.totalUpdated.toLocaleString()}`);
    console.log(`- Total Rejected:       ${result.totalRejected.toLocaleString()}`);
    console.log(`- Total Duplicates:     ${result.totalDuplicates.toLocaleString()}`);
    console.log(`- Expected Trading Days:${result.totalExpectedTradingDays.toLocaleString()}`);
    console.log(`- Missing Trading Days: ${result.totalMissingTradingDays.toLocaleString()}`);
    console.log(`- Overall Coverage:     ${result.overallCoveragePercentage}%`);
    console.log(`- Execution Duration:   ${(result.durationMs / 1000).toFixed(2)} seconds`);
    console.log('---------------------------------------------------------------');
    console.log('Per-Stock Breakdown:');
    for (const d of result.details) {
      const statusIcon = d.status === 'SUCCESS' ? '✅' : d.status === 'PARTIAL' ? '⚠️' : '❌';
      const upToDateTag = d.alreadyUpToDate ? ' (Up to date)' : '';
      console.log(`  ${statusIcon} ${d.symbol.padEnd(10)}${upToDateTag} | Fetched: ${String(d.fetched).padStart(4)} | Ins: ${String(d.inserted).padStart(4)} | Upd: ${String(d.updated).padStart(4)} | Rej: ${String(d.rejected).padStart(2)} | Expected: ${String(d.expectedTradingDaysCount || 0).padStart(4)} | Missing: ${String(d.missingTradingDaysCount || 0).padStart(3)} | Coverage: ${(d.coveragePercentage || 100).toFixed(1)}% | Fresh: ${d.dataFreshness || 'N/A'}`);
      if (d.error) {
        console.log(`     Error: ${d.error}`);
      }
      if (d.failedChunks && d.failedChunks.length > 0) {
        for (const fc of d.failedChunks) {
          console.log(`     Chunk Error [${fc.chunk?.from} to ${fc.chunk?.to}]: ${fc.error}`);
        }
      }
    }
    console.log('===============================================================');

    const hasAuthError = result.details.some(
      (d) => d.code === 'REAUTHORIZATION_REQUIRED' || d.error?.includes('REAUTHORIZATION_REQUIRED')
    );
    if (hasAuthError) {
      console.log('\n⚠️ Authentication notice: Provider returned REAUTHORIZATION_REQUIRED for one or more instruments.');
      console.log('   Re-authenticate at: http://localhost:5001/api/auth/upstox/start');
    }

    process.exit(result.status === 'FAILED' ? 1 : 0);
  } catch (err) {
    console.error('\n❌ Ingestion Failed:');
    console.error(`- Error Code: ${err.code || 'UNKNOWN_ERROR'}`);
    console.error(`- Message:    ${err.message}`);
    if (err.code === 'REAUTHORIZATION_REQUIRED' || err.statusCode === 401) {
      console.error('\nAction Required:');
      console.error('  Upstox session expired. Please re-authenticate via:');
      console.error('  http://localhost:5001/api/auth/upstox/start');
    }
    console.log('===============================================================');
    process.exit(1);
  } finally {
    try {
      if (redisClient) await redisClient.quit();
      await prisma.$disconnect();
    } catch {
      // Ignore disconnect cleanup errors
    }
  }
}

main();
