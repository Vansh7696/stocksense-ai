import { Router } from 'express';
import {
  getWatchlists,
  getWatchlist,
  createWatchlist,
  renameWatchlist,
  deleteWatchlist,
  addStockToWatchlist,
  removeStockFromWatchlist,
  syncGuestWatchlist,
} from '../controllers/watchlist.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';

const router = Router();

// All watchlist routes require authenticated user session
router.use(requireAuth);

/**
 * GET /api/watchlists
 * List all watchlists for authenticated user.
 */
router.get('/', getWatchlists);

/**
 * POST /api/watchlists
 * Create custom watchlist.
 */
router.post('/', csrfProtection, createWatchlist);

/**
 * POST /api/watchlists/sync
 * Bulk synchronize guest localStorage items into default watchlist.
 */
router.post('/sync', csrfProtection, syncGuestWatchlist);

/**
 * GET /api/watchlists/:id
 * Retrieve specific watchlist with items.
 */
router.get('/:id', getWatchlist);

/**
 * PUT /api/watchlists/:id
 * Rename watchlist.
 */
router.put('/:id', csrfProtection, renameWatchlist);

/**
 * DELETE /api/watchlists/:id
 * Delete custom watchlist.
 */
router.delete('/:id', csrfProtection, deleteWatchlist);

/**
 * POST /api/watchlists/:id/items
 * Add a stock to watchlist.
 */
router.post('/:id/items', csrfProtection, addStockToWatchlist);

/**
 * DELETE /api/watchlists/:id/items/:stockId
 * Remove a stock from watchlist.
 */
router.delete('/:id/items/:stockId', csrfProtection, removeStockFromWatchlist);

export default router;
