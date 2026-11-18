import { Queue, Worker } from 'bullmq';
import { getQueueConnectionOptions } from './connection.js';
import logger from '../utils/logger.js';

export const MARKET_DATA_QUEUE_NAME = 'stocksense-market-data-ingestion';

let marketDataQueueInstance = null;

export function getMarketDataQueue() {
  if (!marketDataQueueInstance) {
    marketDataQueueInstance = new Queue(MARKET_DATA_QUEUE_NAME, {
      connection: getQueueConnectionOptions(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 2000 },
      },
    });
  }
  return marketDataQueueInstance;
}

/**
 * Enqueue a market data ingestion task.
 *
 * @param {{ symbol: string, exchange: string, interval: string, startDate?: string, endDate?: string }} data
 * @returns {Promise<Job>}
 */
export async function addMarketDataIngestionJob(data) {
  const queue = getMarketDataQueue();
  const dedupKey = `ingest-${data.symbol}-${data.exchange || 'NSE'}-${data.interval || 'day'}-${data.startDate || 'all'}`;

  return queue.add('ingest-historical-candles', data, {
    jobId: dedupKey,
  });
}

/**
 * Creates and starts a BullMQ worker to process market data ingestion jobs.
 *
 * @param {{ concurrency?: number, processor?: Function }} [options]
 * @returns {Worker}
 */
export function createMarketDataWorker(options = {}) {
  const processor = options.processor || (async (job) => {
    logger.info(`[MarketDataWorker] Processing ingestion job ${job.id} for ${job.data.symbol}`);
    // Simulate / execute idempotent ingestion
    return { status: 'success', symbol: job.data.symbol, processedAt: new Date().toISOString() };
  });

  const worker = new Worker(
    MARKET_DATA_QUEUE_NAME,
    processor,
    {
      connection: getQueueConnectionOptions(),
      concurrency: options.concurrency || 2,
    }
  );

  worker.on('completed', (job) => {
    logger.info(`[MarketDataWorker] Ingestion job ${job.id} for ${job.data.symbol} completed successfully.`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[MarketDataWorker] Ingestion job ${job?.id} failed: ${err.message}`, {
      jobId: job?.id,
      symbol: job?.data?.symbol,
      error: err.message,
    });
  });

  return worker;
}
