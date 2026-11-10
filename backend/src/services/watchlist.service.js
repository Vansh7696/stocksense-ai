import { Prisma } from '@prisma/client';
import prisma from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * Validates watchlist name string.
 *
 * @param {string} name
 * @returns {string} Trimmed valid name
 */
export function validateWatchlistName(name) {
  if (!name || typeof name !== 'string') {
    throw new AppError('Watchlist name is required.', 400, 'INVALID_WATCHLIST_NAME');
  }
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 50) {
    throw new AppError(
      'Watchlist name must be between 1 and 50 characters in length.',
      400,
      'INVALID_WATCHLIST_NAME'
    );
  }
  return trimmed;
}

/**
 * Formats a stock entity for consistent client-facing responses.
 */
function formatStockSummary(stock) {
  if (!stock) return null;
  return {
    id: stock.id,
    symbol: stock.symbol,
    companyName: stock.companyName,
    exchange: stock.exchange?.code || null,
    exchangeName: stock.exchange?.name || null,
    segment: stock.segment,
    instrumentType: stock.instrumentType,
    isin: stock.isin,
    lotSize: stock.lotSize,
    tickSize: stock.tickSize ? parseFloat(stock.tickSize) : 0.05,
    isActive: stock.isActive,
    series: stock.series,
  };
}

/**
 * Retrieve all watchlists belonging strictly to the authenticated user.
 *
 * @param {string} userId
 * @returns {Promise<Array>}
 */
export async function getUserWatchlists(userId) {
  if (!userId) {
    throw new AppError('User ID is required.', 401, 'UNAUTHORIZED');
  }

  const watchlists = await prisma.watchlist.findMany({
    where: { userId },
    orderBy: [
      { isDefault: 'desc' },
      { createdAt: 'asc' },
    ],
    include: {
      stocks: {
        orderBy: { addedAt: 'desc' },
        include: {
          stock: {
            include: {
              exchange: {
                select: {
                  code: true,
                  name: true,
                },
              },
            },
          },
        },
      },
    },
  });

  return watchlists.map((wl) => ({
    id: wl.id,
    name: wl.name,
    isDefault: wl.isDefault,
    itemCount: wl.stocks.length,
    createdAt: wl.createdAt,
    updatedAt: wl.updatedAt,
    items: wl.stocks.map((item) => ({
      id: item.id,
      addedAt: item.addedAt,
      stock: formatStockSummary(item.stock),
    })),
  }));
}

/**
 * Retrieve a specific watchlist by ID with strict ownership validation.
 *
 * @param {string} userId
 * @param {string} watchlistId
 * @returns {Promise<Object>}
 */
export async function getWatchlistById(userId, watchlistId) {
  if (!userId) throw new AppError('User ID is required.', 401, 'UNAUTHORIZED');
  if (!watchlistId) throw new AppError('Watchlist ID is required.', 400, 'INVALID_WATCHLIST_ID');

  const watchlist = await prisma.watchlist.findFirst({
    where: {
      id: watchlistId,
      userId,
    },
    include: {
      stocks: {
        orderBy: { addedAt: 'desc' },
        include: {
          stock: {
            include: {
              exchange: {
                select: {
                  code: true,
                  name: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!watchlist) {
    throw new AppError('Watchlist not found or access denied.', 404, 'WATCHLIST_NOT_FOUND');
  }

  return {
    id: watchlist.id,
    name: watchlist.name,
    isDefault: watchlist.isDefault,
    itemCount: watchlist.stocks.length,
    createdAt: watchlist.createdAt,
    updatedAt: watchlist.updatedAt,
    items: watchlist.stocks.map((item) => ({
      id: item.id,
      addedAt: item.addedAt,
      stock: formatStockSummary(item.stock),
    })),
  };
}

/**
 * Create a custom watchlist for the authenticated user.
 *
 * @param {string} userId
 * @param {{ name: string }} data
 * @returns {Promise<Object>}
 */
export async function createWatchlist(userId, { name }) {
  if (!userId) throw new AppError('User ID is required.', 401, 'UNAUTHORIZED');
  const validName = validateWatchlistName(name);

  // Check if a watchlist with this name already exists for this user
  const existing = await prisma.watchlist.findFirst({
    where: {
      userId,
      name: { equals: validName, mode: 'insensitive' },
    },
  });

  if (existing) {
    throw new AppError(
      `A watchlist named "${validName}" already exists in your account.`,
      409,
      'WATCHLIST_NAME_EXISTS'
    );
  }

  const created = await prisma.watchlist.create({
    data: {
      userId,
      name: validName,
      isDefault: false,
    },
  });

  return {
    id: created.id,
    name: created.name,
    isDefault: created.isDefault,
    itemCount: 0,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
    items: [],
  };
}

/**
 * Rename a user's watchlist.
 *
 * @param {string} userId
 * @param {string} watchlistId
 * @param {{ name: string }} data
 * @returns {Promise<Object>}
 */
export async function renameWatchlist(userId, watchlistId, { name }) {
  if (!userId) throw new AppError('User ID is required.', 401, 'UNAUTHORIZED');
  if (!watchlistId) throw new AppError('Watchlist ID is required.', 400, 'INVALID_WATCHLIST_ID');
  const validName = validateWatchlistName(name);

  const watchlist = await prisma.watchlist.findFirst({
    where: { id: watchlistId, userId },
  });

  if (!watchlist) {
    throw new AppError('Watchlist not found or access denied.', 404, 'WATCHLIST_NOT_FOUND');
  }

  // Prevent duplicate names
  const existingWithSameName = await prisma.watchlist.findFirst({
    where: {
      userId,
      id: { not: watchlistId },
      name: { equals: validName, mode: 'insensitive' },
    },
  });

  if (existingWithSameName) {
    throw new AppError(
      `Another watchlist named "${validName}" already exists in your account.`,
      409,
      'WATCHLIST_NAME_EXISTS'
    );
  }

  const updated = await prisma.watchlist.update({
    where: { id: watchlistId },
    data: { name: validName },
  });

  return {
    id: updated.id,
    name: updated.name,
    isDefault: updated.isDefault,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  };
}

/**
 * Delete a custom watchlist. Preserves default watchlist.
 *
 * @param {string} userId
 * @param {string} watchlistId
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function deleteWatchlist(userId, watchlistId) {
  if (!userId) throw new AppError('User ID is required.', 401, 'UNAUTHORIZED');
  if (!watchlistId) throw new AppError('Watchlist ID is required.', 400, 'INVALID_WATCHLIST_ID');

  const watchlist = await prisma.watchlist.findFirst({
    where: { id: watchlistId, userId },
  });

  if (!watchlist) {
    throw new AppError('Watchlist not found or access denied.', 404, 'WATCHLIST_NOT_FOUND');
  }

  if (watchlist.isDefault) {
    throw new AppError(
      'The primary default watchlist cannot be deleted.',
      400,
      'CANNOT_DELETE_DEFAULT_WATCHLIST'
    );
  }

  await prisma.watchlist.delete({
    where: { id: watchlistId },
  });

  return {
    success: true,
    message: 'Watchlist deleted successfully.',
  };
}

/**
 * Add a stock to a user's watchlist with transactional consistency and duplicate prevention.
 *
 * @param {string} userId
 * @param {string} watchlistId
 * @param {{ stockId?: string, symbol?: string, exchange?: string }} data
 * @returns {Promise<Object>} Added watchlist item with stock details
 */
export async function addStockToWatchlist(userId, watchlistId, data) {
  if (!userId) throw new AppError('User ID is required.', 401, 'UNAUTHORIZED');
  if (!watchlistId) throw new AppError('Watchlist ID is required.', 400, 'INVALID_WATCHLIST_ID');

  const { stockId, symbol, exchange, instrumentToken } = data || {};
  if (!stockId && !symbol && !instrumentToken) {
    throw new AppError(
      'Either stockId, instrumentToken, or symbol parameter is required to add stock to watchlist.',
      400,
      'MISSING_STOCK_IDENTIFIER'
    );
  }

  return prisma.$transaction(async (tx) => {
    // 1. Verify watchlist ownership
    const watchlist = await tx.watchlist.findFirst({
      where: { id: watchlistId, userId },
    });

    if (!watchlist) {
      throw new AppError('Watchlist not found or access denied.', 404, 'WATCHLIST_NOT_FOUND');
    }

    // 2. Resolve target stock
    let targetStock = null;
    if (instrumentToken) {
      targetStock = await tx.stock.findUnique({
        where: { instrumentToken: String(instrumentToken).trim() },
        include: { exchange: true },
      });
    } else if (stockId) {
      const rawStockId = String(stockId).trim();
      if (rawStockId.includes('|')) {
        targetStock = await tx.stock.findUnique({
          where: { instrumentToken: rawStockId },
          include: { exchange: true },
        });
      } else {
        targetStock = await tx.stock.findUnique({
          where: { id: rawStockId },
          include: { exchange: true },
        });
        if (!targetStock) {
          targetStock = await tx.stock.findUnique({
            where: { instrumentToken: rawStockId },
            include: { exchange: true },
          });
        }
      }
    } else if (symbol) {
      const cleanSymbol = symbol.trim().toUpperCase();
      const where = { symbol: cleanSymbol };
      if (exchange) {
        const cleanExchange = exchange.trim().toUpperCase();
        const ex = await tx.exchange.findUnique({ where: { code: cleanExchange } });
        if (ex) where.exchangeId = ex.id;
      }

      const matches = await tx.stock.findMany({
        where,
        include: { exchange: true },
      });

      if (matches.length > 1) {
        throw new AppError(
          `Ambiguous symbol "${symbol}". Multiple stocks found across exchanges (${matches.map((m) => m.exchange?.code).join(', ')}). Please provide exact exchange or stockId.`,
          409,
          'AMBIGUOUS_STOCK_IDENTIFIER',
          {
            matches: matches.map((m) => ({
              id: m.id,
              symbol: m.symbol,
              exchange: m.exchange?.code,
              segment: m.segment,
              instrumentToken: m.instrumentToken,
            })),
          }
        );
      }
      targetStock = matches[0] || null;
    }

    if (!targetStock) {
      throw new AppError('Stock not found.', 404, 'STOCK_NOT_FOUND');
    }

    if (!targetStock.isActive) {
      throw new AppError(
        'Cannot add inactive or delisted stock to watchlist.',
        400,
        'STOCK_INACTIVE'
      );
    }

    // 3. Pre-check for duplicate in watchlist
    const existingEntry = await tx.watchlistStock.findUnique({
      where: {
        watchlistId_stockId: {
          watchlistId,
          stockId: targetStock.id,
        },
      },
    });

    if (existingEntry) {
      throw new AppError(
        `"${targetStock.symbol}" is already in this watchlist.`,
        409,
        'STOCK_ALREADY_IN_WATCHLIST'
      );
    }

    // 4. Create WatchlistStock record
    try {
      const createdItem = await tx.watchlistStock.create({
        data: {
          watchlistId,
          stockId: targetStock.id,
        },
        include: {
          stock: {
            include: { exchange: true },
          },
        },
      });

      return {
        id: createdItem.id,
        watchlistId: createdItem.watchlistId,
        addedAt: createdItem.addedAt,
        stock: formatStockSummary(createdItem.stock),
      };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError(
          `"${targetStock.symbol}" is already in this watchlist.`,
          409,
          'STOCK_ALREADY_IN_WATCHLIST'
        );
      }
      throw err;
    }
  });
}

/**
 * Remove a stock from a user's watchlist with strict ownership enforcement.
 *
 * @param {string} userId
 * @param {string} watchlistId
 * @param {string} stockId
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function removeStockFromWatchlist(userId, watchlistId, stockId) {
  if (!userId) throw new AppError('User ID is required.', 401, 'UNAUTHORIZED');
  if (!watchlistId) throw new AppError('Watchlist ID is required.', 400, 'INVALID_WATCHLIST_ID');
  if (!stockId) throw new AppError('Stock ID is required.', 400, 'INVALID_STOCK_ID');

  return prisma.$transaction(async (tx) => {
    // 1. Verify watchlist belongs to user
    const watchlist = await tx.watchlist.findFirst({
      where: { id: watchlistId, userId },
    });

    if (!watchlist) {
      throw new AppError('Watchlist not found or access denied.', 404, 'WATCHLIST_NOT_FOUND');
    }

    // 2. Check if stock exists in watchlist
    const entry = await tx.watchlistStock.findUnique({
      where: {
        watchlistId_stockId: {
          watchlistId,
          stockId,
        },
      },
    });

    if (!entry) {
      throw new AppError(
        'Stock is not present in this watchlist.',
        404,
        'STOCK_NOT_IN_WATCHLIST'
      );
    }

    // 3. Remove entry
    await tx.watchlistStock.delete({
      where: {
        watchlistId_stockId: {
          watchlistId,
          stockId,
        },
      },
    });

    return {
      success: true,
      message: 'Stock removed from watchlist successfully.',
    };
  });
}

/**
 * Guest Watchlist Synchronization Preparation Endpoint.
 * Ingests guest localStorage watchlist items into user's default PostgreSQL watchlist.
 *
 * @param {string} userId
 * @param {Array<{ stockId?: string, symbol?: string, exchange?: string }>} items
 * @returns {Promise<Object>}
 */
export async function syncGuestWatchlist(userId, items = []) {
  if (!userId) throw new AppError('User ID is required.', 401, 'UNAUTHORIZED');

  if (!Array.isArray(items)) {
    throw new AppError('Items must be an array of stock identifiers.', 400, 'INVALID_SYNC_PAYLOAD');
  }

  return prisma.$transaction(async (tx) => {
    // 1. Find or create user's default watchlist
    let defaultWatchlist = await tx.watchlist.findFirst({
      where: { userId, isDefault: true },
    });

    if (!defaultWatchlist) {
      defaultWatchlist = await tx.watchlist.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
    }

    if (!defaultWatchlist) {
      defaultWatchlist = await tx.watchlist.create({
        data: {
          userId,
          name: 'Default Watchlist',
          isDefault: true,
        },
      });
    }

    let addedCount = 0;
    let skippedCount = 0;
    let invalidCount = 0;

    for (const item of items) {
      if (!item || typeof item !== 'object') {
        invalidCount++;
        continue;
      }
      const { stockId, symbol, exchange, instrumentToken } = item;

      let stock = null;
      if (instrumentToken) {
        stock = await tx.stock.findUnique({
          where: { instrumentToken: String(instrumentToken).trim() },
        });
      } else if (stockId) {
        const rawStockId = String(stockId).trim();
        if (rawStockId.includes('|')) {
          stock = await tx.stock.findUnique({ where: { instrumentToken: rawStockId } });
        } else {
          stock = await tx.stock.findUnique({ where: { id: rawStockId } });
          if (!stock) {
            stock = await tx.stock.findUnique({ where: { instrumentToken: rawStockId } });
          }
        }
      } else if (symbol) {
        const cleanSymbol = String(symbol).trim().toUpperCase();
        const where = { symbol: cleanSymbol, isActive: true };
        if (exchange) {
          const ex = await tx.exchange.findUnique({
            where: { code: String(exchange).trim().toUpperCase() },
          });
          if (ex) where.exchangeId = ex.id;
        }
        stock = await tx.stock.findFirst({ where });
      }

      if (!stock || !stock.isActive) {
        invalidCount++;
        continue;
      }

      // Idempotently skip if already in watchlist
      const exists = await tx.watchlistStock.findUnique({
        where: {
          watchlistId_stockId: {
            watchlistId: defaultWatchlist.id,
            stockId: stock.id,
          },
        },
      });

      if (!exists) {
        await tx.watchlistStock.create({
          data: {
            watchlistId: defaultWatchlist.id,
            stockId: stock.id,
          },
        });
        addedCount++;
      } else {
        skippedCount++;
      }
    }

    const updated = await tx.watchlist.findUnique({
      where: { id: defaultWatchlist.id },
      include: {
        stocks: {
          orderBy: { addedAt: 'desc' },
          include: {
            stock: { include: { exchange: true } },
          },
        },
      },
    });

    return {
      success: true,
      addedCount,
      skippedCount,
      invalidCount,
      watchlist: {
        id: updated.id,
        name: updated.name,
        isDefault: updated.isDefault,
        itemCount: updated.stocks.length,
        items: updated.stocks.map((item) => ({
          id: item.id,
          addedAt: item.addedAt,
          stock: formatStockSummary(item.stock),
        })),
      },
    };
  });
}
