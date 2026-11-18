import { Router } from 'express';
import {
  getStocks,
  searchStocks,
  getStockById,
  getStockPrices,
} from '../controllers/stock.controller.js';
import {
  getStockIndicators,
  getStockFeatures,
} from '../controllers/indicator.controller.js';
import {
  getStockPredictions,
  getActiveModelChampions,
} from '../controllers/prediction.controller.js';
import { getStockSentiment } from '../controllers/sentiment.controller.js';
import { getStockPatterns } from '../controllers/pattern.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { predictionRateLimiter } from '../middleware/authRateLimiter.js';

const router = Router();

/**
 * GET /api/stocks
 * Paginated list of stocks with filtering by exchange, instrumentType, segment, active status.
 */
router.get('/', getStocks);

/**
 * GET /api/stocks/search
 * Fast typeahead search by symbol and company name.
 * Declared before /:id to avoid route shadowing.
 */
router.get('/search', searchStocks);

/**
 * GET /api/stocks/predictions/models
 * Retrieve metadata for active champion prediction models.
 * Declared before /:id to avoid route shadowing.
 */
router.get(
  '/predictions/models',
  requireAuth,
  predictionRateLimiter,
  getActiveModelChampions
);

/**
 * GET /api/stocks/:id
 * Retrieve stock details by UUID, instrumentToken, or symbol.
 */
router.get('/:id', getStockById);

/**
 * GET /api/stocks/:id/prices
 * Retrieve chronological historical candle prices for a stock.
 */
router.get('/:id/prices', getStockPrices);

/**
 * GET /api/stocks/:id/indicators
 * Retrieve computed technical indicators for a stock from historical candles.
 */
router.get('/:id/indicators', getStockIndicators);

/**
 * GET /api/stocks/:id/features
 * Retrieve engineered ML feature matrix for a stock from historical candles.
 */
router.get('/:id/features', getStockFeatures);

/**
 * GET /api/stocks/:id/predictions
 * Generate multi-horizon directional forecast (h=1, 3, 5) for a stock.
 */
router.get(
  '/:id/predictions',
  requireAuth,
  predictionRateLimiter,
  getStockPredictions
);

/**
 * GET /api/stocks/:id/sentiment
 * Retrieve real-time financial market news sentiment intelligence and multi-factor fusion metrics.
 */
router.get(
  '/:id/sentiment',
  requireAuth,
  getStockSentiment
);

/**
 * GET /api/stocks/:id/patterns
 * Retrieve candlestick patterns, support/resistance zones, and breakout momentum signals.
 */
router.get(
  '/:id/patterns',
  requireAuth,
  getStockPatterns
);

export default router;
