import prisma from '../config/prisma.js';
import cacheService, { CACHE_TTL } from '../services/cache.service.js';
import tokenService from '../services/token.service.js';

/**
 * GET /api/market/overview
 * Real platform market overview aggregate without fabricated live prices.
 * Returns total active instrument counts, exchange breakdowns,
 * instrument type breakdowns, Upstox provider status, and last ingestion metadata.
 */
export async function getMarketOverview(req, res, next) {
  try {
    const cacheKey = cacheService.buildKey('market:overview');

    const { data, cached } = await cacheService.getOrSet(
      cacheKey,
      CACHE_TTL.MARKET_OVERVIEW,
      async () => {
        const [
          totalActiveInstruments,
          exchangesData,
          typeCountsData,
          tokenStatus,
          ingestionConfig,
          latestDataSourceLog,
        ] = await Promise.all([
          // 1. Total active instruments
          prisma.stock.count({ where: { isActive: true } }),

          // 2. Counts grouped by Exchange code
          prisma.exchange.findMany({
            select: {
              code: true,
              _count: {
                select: {
                  stocks: { where: { isActive: true } },
                },
              },
            },
          }),

          // 3. Counts grouped by Instrument Type
          prisma.stock.groupBy({
            by: ['instrumentType'],
            where: { isActive: true },
            _count: { id: true },
          }),

          // 4. Provider token status
          tokenService.getTokenStatus(),

          // 5. Ingestion summary config
          prisma.systemConfig.findUnique({
            where: { key: 'UPSTOX_INSTRUMENT_INGESTION_SUMMARY' },
          }),

          // 6. Latest data source log fallback
          prisma.dataSourceLog.findFirst({
            where: { provider: 'UPSTOX', operation: 'INSTRUMENT_UPDATE' },
            orderBy: { createdAt: 'desc' },
          }),
        ]);

        // Format exchange counts map: e.g. { NSE: 15, BSE: 4 }
        const exchanges = {};
        for (const ex of exchangesData) {
          exchanges[ex.code] = ex._count.stocks;
        }

        // Format instrument type counts map: e.g. { EQUITY: 17, INDEX: 2 }
        const instrumentTypes = {};
        for (const t of typeCountsData) {
          instrumentTypes[t.instrumentType] = t._count.id;
        }

        // Parse last ingestion summary
        let lastIngestion = null;
        if (ingestionConfig?.value) {
          try {
            lastIngestion = JSON.parse(ingestionConfig.value);
          } catch {
            lastIngestion = null;
          }
        }

        if (!lastIngestion && latestDataSourceLog) {
          lastIngestion = {
            status: latestDataSourceLog.status,
            recordsProcessed: latestDataSourceLog.recordsProcessed,
            errorMessage: latestDataSourceLog.errorMessage,
            executionTimeMs: latestDataSourceLog.executionTimeMs,
            timestamp: latestDataSourceLog.createdAt.toISOString(),
          };
        }

        return {
          summary: {
            totalActiveInstruments,
            exchanges,
            instrumentTypes,
          },
          provider: {
            name: 'UPSTOX',
            status: tokenStatus.code,
            configured: tokenStatus.configured,
            active: tokenStatus.active,
            source: tokenStatus.source,
            reason: tokenStatus.reason,
            expiresAt: tokenStatus.expiresAt,
          },
          lastIngestion,
        };
      }
    );

    return res.json({
      success: true,
      data,
      meta: {
        cached,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/market/indices
 * Retrieve verified market indices (e.g. NIFTY 50, SENSEX, NIFTY BANK) stored in the database.
 * Does not synthesize or fabricate live prices.
 */
export async function getMarketIndices(req, res, next) {
  try {
    const cacheKey = cacheService.buildKey('market:indices');

    const { data, cached } = await cacheService.getOrSet(
      cacheKey,
      CACHE_TTL.MARKET_INDICES,
      async () => {
        const indices = await prisma.stock.findMany({
          where: {
            OR: [
              { instrumentType: 'INDEX' },
              { segment: { in: ['NSE_INDEX', 'BSE_INDEX'] } },
            ],
            isActive: true,
          },
          orderBy: { symbol: 'asc' },
          select: {
            id: true,
            symbol: true,
            companyName: true,
            instrumentToken: true,
            exchangeToken: true,
            segment: true,
            instrumentType: true,
            exchange: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
            createdAt: true,
            updatedAt: true,
          },
        });

        return {
          totalIndices: indices.length,
          indices,
        };
      }
    );

    return res.json({
      success: true,
      data,
      meta: {
        cached,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
}
