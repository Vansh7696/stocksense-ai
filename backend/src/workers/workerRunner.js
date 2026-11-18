import { createAlertWorker } from '../queues/alert.queue.js';
import { createMarketDataWorker } from '../queues/marketData.queue.js';
import logger from '../utils/logger.js';

let alertWorker = null;
let marketDataWorker = null;

export async function startWorkers() {
  logger.info('[Workers] Starting StockSense AI background task workers...');
  alertWorker = createAlertWorker({ concurrency: 5 });
  marketDataWorker = createMarketDataWorker({ concurrency: 2 });
  logger.info('[Workers] AlertWorker and MarketDataWorker initialized and listening for jobs.');
}

export async function stopWorkers() {
  logger.info('[Workers] Gracefully shutting down background workers...');
  const promises = [];
  if (alertWorker) promises.push(alertWorker.close());
  if (marketDataWorker) promises.push(marketDataWorker.close());

  await Promise.allSettled(promises);
  logger.info('[Workers] All background workers shut down cleanly.');
}

if (process.env.START_WORKER === 'true') {
  startWorkers();

  const handleSignal = async (signal) => {
    logger.info(`[Workers] Received ${signal}. Initiating graceful teardown...`);
    await stopWorkers();
    process.exit(0);
  };

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));
}
