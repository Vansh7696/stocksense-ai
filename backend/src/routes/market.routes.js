import { Router } from 'express';
import {
  getMarketOverview,
  getMarketIndices,
} from '../controllers/market.controller.js';
import { streamMarketData } from '../controllers/stream.controller.js';

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

/**
 * GET /api/market/stream
 * Real-time Server-Sent Events (SSE) live streaming endpoint.
 * Supports symbol-isolated streaming, heartbeats, and market status events.
 */
router.get('/stream', streamMarketData);

export default router;
