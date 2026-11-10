import defaultPrisma from '../../config/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';

export class InstrumentPersistence {
  /**
   * @param {Object} [options]
   * @param {Object} [options.prisma] Injected Prisma Client
   * @param {number} [options.batchSize=250] Batch size for database transactions
   */
  constructor(options = {}) {
    this.prisma = options.prisma || defaultPrisma;
    this.batchSize = options.batchSize || 250;
    this.exchangeCache = new Map();
  }

  /**
   * Resolves and caches exchange IDs for NSE and BSE.
   *
   * @returns {Promise<Map<string, string>>} Map of exchangeCode -> exchangeId
   */
  async getExchangeIdMap() {
    if (this.exchangeCache.size >= 2) {
      return this.exchangeCache;
    }

    const exchanges = await this.prisma.exchange.findMany({
      where: { code: { in: ['NSE', 'BSE'] } },
      select: { id: true, code: true },
    });

    for (const ex of exchanges) {
      this.exchangeCache.set(ex.code.toUpperCase(), ex.id);
    }

    if (!this.exchangeCache.has('NSE') || !this.exchangeCache.has('BSE')) {
      throw new AppError(
        'Database configuration error: NSE or BSE exchange record is missing in database.',
        500,
        'MISSING_EXCHANGE_RECORDS'
      );
    }

    return this.exchangeCache;
  }

  /**
   * Persists a list of normalized instrument records to PostgreSQL in chunks.
   * Safe and idempotent: updates existing instruments without duplicates,
   * inserts new instruments, and preserves existing valid data.
   *
   * @param {Array<Object>} normalizedRecords
   * @param {Object} [options]
   * @param {boolean} [options.dryRun=false] When true, simulates persistence without writing
   * @param {Function} [options.onProgress] Optional progress callback (processed, total)
   * @returns {Promise<{ inserted: number, updated: number, skipped: number, errors: Array<Object> }>}
   */
  async persistBatch(normalizedRecords, options = {}) {
    const { dryRun = false, onProgress } = options;

    if (!normalizedRecords || normalizedRecords.length === 0) {
      return { inserted: 0, updated: 0, skipped: 0, errors: [] };
    }

    const exchangeMap = await this.getExchangeIdMap();

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    // Deduplicate within the input batch by instrumentToken (Upstox instrument_key is unique)
    const uniqueRecords = [];
    const seenTokens = new Set();

    for (const item of normalizedRecords) {
      if (!item.instrumentToken || seenTokens.has(item.instrumentToken)) {
        skipped++;
        continue;
      }
      seenTokens.add(item.instrumentToken);
      uniqueRecords.push(item);
    }

    // Split into memory-efficient chunks
    const totalRecords = uniqueRecords.length;
    for (let i = 0; i < totalRecords; i += this.batchSize) {
      const chunk = uniqueRecords.slice(i, i + this.batchSize);

      if (dryRun) {
        // In dry run, check how many exist in DB without mutating
        const tokens = chunk.map((c) => c.instrumentToken);
        const existingCount = await this.prisma.stock.count({
          where: { instrumentToken: { in: tokens } },
        });
        updated += existingCount;
        inserted += chunk.length - existingCount;

        if (onProgress) {
          onProgress(Math.min(i + chunk.length, totalRecords), totalRecords);
        }
        continue;
      }

      // Execute chunk within a Prisma transaction
      try {
        const chunkTokens = chunk.map((c) => c.instrumentToken);
        const existingStocks = await this.prisma.stock.findMany({
          where: { instrumentToken: { in: chunkTokens } },
          select: { id: true, instrumentToken: true },
        });
        const existingTokenSet = new Set(existingStocks.map((s) => s.instrumentToken));

        let chunkInserted = 0;
        let chunkUpdated = 0;
        let chunkSkipped = 0;

        const operations = chunk.map((item) => {
          const exchangeId = exchangeMap.get(item.exchange);
          if (!exchangeId) {
            chunkSkipped++;
            return null;
          }

          const isUpdate = existingTokenSet.has(item.instrumentToken);
          if (isUpdate) {
            chunkUpdated++;
          } else {
            chunkInserted++;
          }

          return this.prisma.stock.upsert({
            where: { instrumentToken: item.instrumentToken },
            update: {
              companyName: item.companyName,
              isin: item.isin,
              exchangeToken: item.exchangeToken,
              segment: item.segment,
              instrumentType: item.instrumentType,
              series: item.series,
              lotSize: item.lotSize,
              tickSize: item.tickSize,
              expiryDate: item.expiryDate,
              isActive: item.isActive,
            },
            create: {
              exchangeId,
              symbol: item.symbol,
              companyName: item.companyName,
              isin: item.isin,
              instrumentToken: item.instrumentToken,
              exchangeToken: item.exchangeToken,
              segment: item.segment,
              instrumentType: item.instrumentType,
              series: item.series,
              lotSize: item.lotSize,
              tickSize: item.tickSize,
              expiryDate: item.expiryDate,
              isActive: item.isActive,
            },
          });
        }).filter(Boolean);

        if (operations.length > 0) {
          await this.prisma.$transaction(operations);
        }

        // Tally committed records only after successful transaction execution
        inserted += chunkInserted;
        updated += chunkUpdated;
        skipped += chunkSkipped;

        if (onProgress) {
          onProgress(Math.min(i + chunk.length, totalRecords), totalRecords);
        }
      } catch (chunkErr) {
        errors.push({
          chunkIndex: Math.floor(i / this.batchSize),
          error: chunkErr.message,
        });
        // Never halt or delete entire valid catalogue because one chunk failed
      }
    }

    return {
      inserted,
      updated,
      skipped,
      insertedRecords: inserted,
      updatedRecords: updated,
      skippedRecords: skipped,
      errors,
    };
  }
}

export default new InstrumentPersistence();
