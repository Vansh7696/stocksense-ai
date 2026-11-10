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

export default router;
