import * as watchlistService from '../services/watchlist.service.js';

/**
 * GET /api/watchlists
 * List all watchlists for the authenticated user.
 */
export async function getWatchlists(req, res, next) {
  try {
    const watchlists = await watchlistService.getUserWatchlists(req.user.id);
    return res.json({
      success: true,
      data: {
        watchlists,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/watchlists/:id
 * Retrieve specific watchlist by ID.
 */
export async function getWatchlist(req, res, next) {
  try {
    const watchlist = await watchlistService.getWatchlistById(req.user.id, req.params.id);
    return res.json({
      success: true,
      data: {
        watchlist,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/watchlists
 * Create a new custom watchlist.
 */
export async function createWatchlist(req, res, next) {
  try {
    const { name } = req.body || {};
    const created = await watchlistService.createWatchlist(req.user.id, { name });
    return res.status(201).json({
      success: true,
      data: {
        watchlist: created,
      },
      message: 'Watchlist created successfully.',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/watchlists/:id
 * Rename a custom watchlist.
 */
export async function renameWatchlist(req, res, next) {
  try {
    const { name } = req.body || {};
    const updated = await watchlistService.renameWatchlist(req.user.id, req.params.id, { name });
    return res.json({
      success: true,
      data: {
        watchlist: updated,
      },
      message: 'Watchlist renamed successfully.',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/watchlists/:id
 * Delete a custom watchlist.
 */
export async function deleteWatchlist(req, res, next) {
  try {
    const result = await watchlistService.deleteWatchlist(req.user.id, req.params.id);
    return res.json({
      success: true,
      message: result.message,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/watchlists/:id/items
 * Add a stock to a user's watchlist.
 */
export async function addStockToWatchlist(req, res, next) {
  try {
    const item = await watchlistService.addStockToWatchlist(
      req.user.id,
      req.params.id,
      req.body || {}
    );
    return res.status(201).json({
      success: true,
      data: {
        item,
      },
      message: 'Stock added to watchlist successfully.',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/watchlists/:id/items/:stockId
 * Remove a stock from a user's watchlist.
 */
export async function removeStockFromWatchlist(req, res, next) {
  try {
    const result = await watchlistService.removeStockFromWatchlist(
      req.user.id,
      req.params.id,
      req.params.stockId
    );
    return res.json({
      success: true,
      message: result.message,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/watchlists/sync
 * Bulk synchronize guest localStorage items into user's default watchlist.
 */
export async function syncGuestWatchlist(req, res, next) {
  try {
    const { items } = req.body || {};
    const result = await watchlistService.syncGuestWatchlist(req.user.id, items);
    return res.json({
      success: true,
      data: result,
      message: `Successfully synchronized ${result.addedCount} items into your watchlist.`,
    });
  } catch (err) {
    next(err);
  }
}
