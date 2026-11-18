import { Queue, Worker } from 'bullmq';
import { getQueueConnectionOptions } from './connection.js';
import { evaluateAlertsForStock } from '../services/alertEvaluator.service.js';
import logger from '../utils/logger.js';

export const ALERT_QUEUE_NAME = 'stocksense-price-alerts';

let alertQueueInstance = null;

export function getAlertQueue() {
  if (!alertQueueInstance) {
    alertQueueInstance = new Queue(ALERT_QUEUE_NAME, {
      connection: getQueueConnectionOptions(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 500,
        },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return alertQueueInstance;
}

/**
 * Enqueue an alert evaluation task for a stock.
 *
 * @param {{ stockId: string, symbol?: string, currentPrice: number, candleTimestamp?: string|Date }} data
 * @returns {Promise<Job>}
 */
export async function addAlertEvaluationJob(data) {
  const queue = getAlertQueue();
  const safePrice = String(data.currentPrice).replace(/[^0-9]/g, '_');
  const dedupKey = `alert-eval-${data.stockId}-${safePrice}-${Math.floor(Date.now() / 1000)}`;

  return queue.add('evaluate-stock-alerts', data, {
    jobId: dedupKey,
  });
}

/**
 * Creates and starts a BullMQ worker to process alert evaluation jobs.
 *
 * @param {{ concurrency?: number }} [options]
 * @returns {Worker}
 */
export function createAlertWorker(options = {}) {
  const worker = new Worker(
    ALERT_QUEUE_NAME,
    async (job) => {
      logger.info(`[AlertWorker] Processing job ${job.id} for stock ${job.data.stockId} at price ${job.data.currentPrice}`);
      const triggered = await evaluateAlertsForStock(job.data);
      return { triggeredCount: triggered.length, triggered };
    },
    {
      connection: getQueueConnectionOptions(),
      concurrency: options.concurrency || 5,
    }
  );

  worker.on('completed', (job, result) => {
    logger.info(`[AlertWorker] Job ${job.id} completed. Triggered ${result.triggeredCount} alerts.`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[AlertWorker] Job ${job?.id} failed after attempts: ${err.message}`, {
      jobId: job?.id,
      error: err.message,
    });
  });

  return worker;
}
