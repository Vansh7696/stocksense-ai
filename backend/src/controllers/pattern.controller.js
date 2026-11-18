/**
 * StockSense AI — Technical Pattern & Breakout Controller
 * Orchestrates candlestick pattern detection, S/R clustering, and breakout triggers.
 */

import prisma from '../config/prisma.js';
import cacheService, { CACHE_TTL } from '../services/cache.service.js';
import mlClientService from '../services/mlClient.service.js';
import { resolveStockIdentifier } from './stock.controller.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

const ALLOWED_PRICE_INTERVALS = new Set([
  '1m',
  '5m',
  '15m',
  '30m',
  '1h',
  '1D',
  '1W',
  '1M',
]);

/**
 * GET /api/stocks/:id/patterns
 * Analyzes candlestick patterns, support/resistance levels, and breakout momentum.
 */
export async function getStockPatterns(req, res, next) {
  try {
    const { id } = req.params;
    const { exchange, interval = '1D' } = req.query;

    if (!ALLOWED_PRICE_INTERVALS.has(interval)) {
      throw new AppError(
        `Invalid interval "${interval}". Allowed intervals: ${Array.from(ALLOWED_PRICE_INTERVALS).join(', ')}`,
        400,
        'INVALID_INTERVAL'
      );
    }

    // 1. Resolve stock identifier
    const stock = await resolveStockIdentifier(id, exchange, {
      include: { exchange: true },
    });

    // 2. Check Redis cache
    const cacheKey = cacheService.buildKey('stocks:patterns', `${stock.id}:${interval}`);
    const cachedData = await cacheService.get(cacheKey);

    if (cachedData) {
      return res.status(200).json({
        success: true,
        data: cachedData,
        meta: {
          cached: true,
          timestamp: new Date().toISOString(),
          stock: {
            id: stock.id,
            symbol: stock.symbol,
            companyName: stock.companyName,
            exchange: stock.exchange.code,
          },
        },
      });
    }

    // 3. Query historical candles from PostgreSQL (up to 300 chronological bars)
    const candles = await prisma.historicalPrice.findMany({
      where: {
        stockId: stock.id,
        interval,
      },
      orderBy: { timestamp: 'asc' },
      take: 300,
    });

    if (candles.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          stance: 'NEUTRAL',
          technical_score: 0.0,
          summary: `No historical ${interval} candle data found for ${stock.symbol}. Ingest market data first.`,
          patterns: [],
          support_resistance: [],
          signals: [],
          indicators: { close_price: 0.0 },
          total_candles_analyzed: 0,
        },
        meta: {
          cached: false,
          timestamp: new Date().toISOString(),
          stock: {
            id: stock.id,
            symbol: stock.symbol,
            companyName: stock.companyName,
            exchange: stock.exchange.code,
          },
        },
      });
    }

    // 4. Invoke ML Service for technical pattern analysis
    const patternResult = await mlClientService.analyzeTechnicalPatterns(
      candles,
      stock.symbol,
      { correlationId: req.correlationId }
    );

    // 5. Cache result in Redis (300 seconds TTL)
    await cacheService.set(cacheKey, patternResult, CACHE_TTL.MEDIUM || 300);

    return res.status(200).json({
      success: true,
      data: patternResult,
      meta: {
        cached: false,
        timestamp: new Date().toISOString(),
        stock: {
          id: stock.id,
          symbol: stock.symbol,
          companyName: stock.companyName,
          exchange: stock.exchange.code,
        },
      },
    });
  } catch (error) {
    logger.error('Error fetching stock technical patterns', {
      error: error.message,
      stockId: req.params.id,
      correlationId: req.correlationId,
    });
    next(error);
  }
}
