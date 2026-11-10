import { Router } from 'express';
import {
  getMarketOverview,
  getMarketIndices,
} from '../controllers/market.controller.js';

const router = Router();

/**
 * GET /api/market/overview
 * Real platform market summary, exchange breakdown, and Upstox provider status.
 */
router.get('/overview', getMarketOverview);

/**
 * GET /api/market/indices
 * Verified indices stored in the database (e.g. NIFTY 50, SENSEX).
 */
router.get('/indices', getMarketIndices);

export default router;
