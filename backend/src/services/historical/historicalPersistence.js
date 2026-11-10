import defaultPrisma from '../../config/prisma.js';

export class HistoricalPersistence {
  /**
   * @param {Object} [options]
   * @param {Object} [options.prisma] Injected Prisma Client
   * @param {number} [options.batchSize=250] Batch size for database transactions
   */
  constructor(options = {}) {
    this.prisma = options.prisma || defaultPrisma;
    this.batchSize = options.batchSize || 250;
  }

  /**
   * Persists a batch of validated candle records to PostgreSQL via Prisma.
   *
   * Idempotent & Transactionally Safe:
   * - Uses compound unique constraint [stockId, timestamp, interval].
   * - Preserves BigInt volume precision.
   * - Never deletes existing valid records on partial batch error.
   * - In dry-run mode, computes insertion vs update metrics without database mutation.
   *
   * @param {string} stockId - Stock UUID in database
   * @param {string} interval - e.g. "1D", "1m"
   * @param {Array<Object>} validatedCandles - Array of validated candle objects
   * @param {Object} [options]
   * @param {boolean} [options.dryRun=false]
   * @param {Function} [options.onProgress]
   * @returns {Promise<{ inserted: number, updated: number, skipped: number, errors: Array<Object> }>}
   */
  async persistBatch(stockId, interval, validatedCandles, options = {}) {
    const { dryRun = false, onProgress } = options;

    if (!stockId || !interval || !Array.isArray(validatedCandles) || validatedCandles.length === 0) {
      return { inserted: 0, updated: 0, skipped: 0, errors: [] };
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    // Deduplicate within the input batch by timestamp to prevent duplicate operations in same transaction
    const uniqueCandles = [];
    const seenTimes = new Set();

    for (const c of validatedCandles) {
      const timeMs = c.timestamp instanceof Date ? c.timestamp.getTime() : new Date(c.timestamp).getTime();
      if (seenTimes.has(timeMs)) {
        skipped++;
        continue;
      }
      seenTimes.add(timeMs);
      uniqueCandles.push(c);
    }

    const totalRecords = uniqueCandles.length;

    for (let i = 0; i < totalRecords; i += this.batchSize) {
      const chunk = uniqueCandles.slice(i, i + this.batchSize);

      try {
        if (typeof options.beforeBatch === 'function') {
          await options.beforeBatch({ index: i, total: totalRecords, count: chunk.length });
        }

        const timestamps = chunk.map((c) => (c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp)));
        const existingRecords = await this.prisma.historicalPrice.findMany({
          where: {
            stockId,
            interval,
            timestamp: { in: timestamps },
          },
          select: { timestamp: true },
        });

        const existingSet = new Set(existingRecords.map((r) => r.timestamp.getTime()));

        let chunkInserted = 0;
        let chunkUpdated = 0;

        if (dryRun) {
          for (const c of chunk) {
            const t = (c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp)).getTime();
            if (existingSet.has(t)) {
              chunkUpdated++;
            } else {
              chunkInserted++;
            }
          }
        } else {
          const operations = chunk.map((candle) => {
            const candleDate = candle.timestamp instanceof Date ? candle.timestamp : new Date(candle.timestamp);
            const isUpdate = existingSet.has(candleDate.getTime());
            if (isUpdate) {
              chunkUpdated++;
            } else {
              chunkInserted++;
            }

            return this.prisma.historicalPrice.upsert({
              where: {
                stockId_timestamp_interval: {
                  stockId,
                  timestamp: candleDate,
                  interval,
                },
              },
              update: {
                open: candle.openDecimal || candle.open,
                high: candle.highDecimal || candle.high,
                low: candle.lowDecimal || candle.low,
                close: candle.closeDecimal || candle.close,
                volume: candle.volume, // Native BigInt preserved
                dataSource: candle.dataSource || 'UPSTOX',
              },
              create: {
                stockId,
                timestamp: candleDate,
                open: candle.openDecimal || candle.open,
                high: candle.highDecimal || candle.high,
                low: candle.lowDecimal || candle.low,
                close: candle.closeDecimal || candle.close,
                volume: candle.volume, // Native BigInt preserved
                interval,
                dataSource: candle.dataSource || 'UPSTOX',
              },
            });
          });

          await this.prisma.$transaction(operations);
        }

        inserted += chunkInserted;
        updated += chunkUpdated;

        if (onProgress) {
          onProgress(Math.min(i + chunk.length, totalRecords), totalRecords);
        }
      } catch (err) {
        if (err.code === 'INGESTION_LOCK_LOST') {
          throw err;
        }
        errors.push({
          batchIndex: Math.floor(i / this.batchSize),
          recordCount: chunk.length,
          error: err.message,
        });
      }
    }

    return { inserted, updated, skipped, errors };
  }
}

export default new HistoricalPersistence();
