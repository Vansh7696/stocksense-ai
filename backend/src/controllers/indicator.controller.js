/**
 * StockSense AI — Technical Indicators & Feature Controller
 * Orchestrates historical candle retrieval and analytical computations
 * via the Python FastAPI ML microservice.
 */

import prisma from '../config/prisma.js';
import cacheService, {
  CACHE_TTL,
  buildDeterministicQueryString,
} from '../services/cache.service.js';
import mlClientService from '../services/mlClient.service.js';
import { resolveStockIdentifier } from './stock.controller.js';
import { AppError } from '../middleware/errorHandler.js';

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
 * GET /api/stocks/:id/indicators
 * Retrieves technical indicators (SMA, EMA, RSI, MACD, Bollinger Bands, ATR, Volatility, RVOL)
 * for a stock based on its stored historical OHLCV data.
 */
export async function getStockIndicators(req, res, next) {
  try {
    const { id } = req.params;
    const {
      exchange,
      interval = '1D',
      limit = '500',
    } = req.query;

    if (!ALLOWED_PRICE_INTERVALS.has(interval)) {
      throw new AppError(
        `Invalid interval "${interval}". Allowed intervals: ${Array.from(ALLOWED_PRICE_INTERVALS).join(', ')}`,
        400,
        'INVALID_INTERVAL'
      );
    }

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 1000);

    // 1. Resolve stock identifier
    const stock = await resolveStockIdentifier(id, exchange, {
      include: { exchange: true },
    });

    // 2. Check Redis cache
    const queryString = buildDeterministicQueryString({
      interval,
      limit: parsedLimit,
    });
    const cacheKey = cacheService.buildKey('stocks:indicators', `${stock.id}:${queryString}`);
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

    // 3. Query historical candles from PostgreSQL
    const candles = await prisma.historicalPrice.findMany({
      where: {
        stockId: stock.id,
        interval,
      },
      orderBy: { timestamp: 'asc' },
      take: parsedLimit,
    });

    if (candles.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          hasData: false,
          totalCandles: 0,
          warmupStatus: 'NO_DATA',
          message: `No historical ${interval} candles available for ${stock.symbol}. Ingest market data first.`,
          indicators: null,
          latest: null,
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

    // 4. Compute indicators via Python FastAPI ML microservice
    const mlResponse = await mlClientService.computeIndicators(stock.symbol, candles);

    const payload = {
      hasData: true,
      totalCandles: mlResponse.total_candles,
      warmupStatus: mlResponse.warmup_status,
      indicators: mlResponse.indicators,
      latest: mlResponse.latest,
      metadata: mlResponse.metadata,
    };

    // Cache computed indicators for 5 minutes (300s)
    await cacheService.set(cacheKey, payload, CACHE_TTL.DEFAULT);

    return res.status(200).json({
      success: true,
      data: payload,
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
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/stocks/:id/features
 * Extracts ML feature matrix from historical candles for the given stock.
 */
export async function getStockFeatures(req, res, next) {
  try {
    const { id } = req.params;
    const {
      exchange,
      interval = '1D',
      limit = '500',
      dropNa = 'false',
    } = req.query;

    if (!ALLOWED_PRICE_INTERVALS.has(interval)) {
      throw new AppError(
        `Invalid interval "${interval}". Allowed intervals: ${Array.from(ALLOWED_PRICE_INTERVALS).join(', ')}`,
        400,
        'INVALID_INTERVAL'
      );
    }

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 1000);
    const shouldDropNa = dropNa === 'true';

    // 1. Resolve stock identifier
    const stock = await resolveStockIdentifier(id, exchange, {
      include: { exchange: true },
    });

    // 2. Query historical candles from PostgreSQL
    const candles = await prisma.historicalPrice.findMany({
      where: {
        stockId: stock.id,
        interval,
      },
      orderBy: { timestamp: 'asc' },
      take: parsedLimit,
    });

    if (candles.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          hasData: false,
          totalRows: 0,
          featureCount: 0,
          message: `No historical ${interval} candles available for ${stock.symbol}. Ingest market data first.`,
          features: [],
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

    // 3. Extract features via ML microservice
    const mlResponse = await mlClientService.engineerFeatures(stock.symbol, candles, shouldDropNa);

    return res.status(200).json({
      success: true,
      data: {
        hasData: true,
        totalRows: mlResponse.total_rows,
        featureCount: mlResponse.feature_count,
        featureNames: mlResponse.feature_names,
        features: mlResponse.features,
        metadata: mlResponse.metadata,
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
  } catch (err) {
    next(err);
  }
}
