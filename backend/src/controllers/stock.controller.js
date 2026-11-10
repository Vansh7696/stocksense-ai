import prisma from '../config/prisma.js';
import cacheService, {
  CACHE_TTL,
  buildDeterministicQueryString,
} from '../services/cache.service.js';
import { AppError } from '../middleware/errorHandler.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_EXCHANGES = new Set(['NSE', 'BSE']);
const ALLOWED_INSTRUMENT_TYPES = new Set(['EQUITY', 'INDEX', 'FUTURES', 'OPTIONS', 'BOND']);
const ALLOWED_SORT_FIELDS = new Set(['symbol', 'companyName', 'createdAt', 'updatedAt']);
const ALLOWED_SORT_ORDERS = new Set(['asc', 'desc']);
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
 * Normalizes and formats candle records for API responses, ensuring Decimal and BigInt
 * values are formatted accurately as strings.
 */
function formatCandleRecord(candle) {
  return {
    id: candle.id,
    timestamp: candle.timestamp.toISOString(),
    open: candle.open.toString(),
    high: candle.high.toString(),
    low: candle.low.toString(),
    close: candle.close.toString(),
    volume: candle.volume.toString(),
    interval: candle.interval,
    dataSource: candle.dataSource,
  };
}

/**
 * Resolves a stock by UUID, Upstox instrumentToken, or Symbol.
 *
 * Rules:
 * 1. UUID lookup returns the exact record.
 * 2. Upstox instrument key lookup returns the exact record.
 * 3. Symbol lookup does not silently return an arbitrary record when multiple matches exist.
 * 4. If a symbol is ambiguous across exchanges/segments:
 *    - If an exchange parameter is supplied, filters down to that exchange.
 *    - If multiple matches remain (or no exchange is provided), throws HTTP 409 AMBIGUOUS_STOCK_IDENTIFIER
 *      with the list of safe matching candidate identifiers.
 *
 * @param {string} rawId Identifier (UUID, instrumentToken, or symbol)
 * @param {string} [exchangeParam] Optional exchange filter (NSE/BSE)
 * @param {Object} [queryOptions] Optional Prisma select or include options
 * @returns {Promise<Object>} The resolved unique stock record
 */
export async function resolveStockIdentifier(rawId, exchangeParam = null, queryOptions = null) {
  const id = rawId.trim();

  const defaultIncludes = {
    include: {
      exchange: {
        select: {
          id: true,
          code: true,
          name: true,
          currency: true,
          timezone: true,
        },
      },
    },
  };
  const relations = queryOptions || defaultIncludes;

  // 1. UUID lookup -> exact unique record
  if (UUID_REGEX.test(id)) {
    const found = await prisma.stock.findUnique({
      where: { id },
      ...relations,
    });
    if (!found) {
      throw new AppError(`Stock not found with UUID: "${id}"`, 404, 'STOCK_NOT_FOUND');
    }
    return found;
  }

  // 2. Upstox instrument key lookup -> exact unique record
  if (id.includes('|')) {
    const found = await prisma.stock.findUnique({
      where: { instrumentToken: id },
      ...relations,
    });
    if (!found) {
      throw new AppError(`Stock not found with instrument token: "${id}"`, 404, 'STOCK_NOT_FOUND');
    }
    return found;
  }

  // 3. Symbol lookup (or exchange token)
  const symbolUpper = id.toUpperCase();
  const where = {
    OR: [
      { symbol: symbolUpper },
      { exchangeToken: id },
    ],
  };

  if (exchangeParam) {
    const cleanExchange = exchangeParam.trim().toUpperCase();
    if (!ALLOWED_EXCHANGES.has(cleanExchange)) {
      throw new AppError(
        `Invalid exchange filter "${exchangeParam}". Allowed: ${Array.from(ALLOWED_EXCHANGES).join(', ')}`,
        400,
        'INVALID_EXCHANGE'
      );
    }
    where.exchange = { code: cleanExchange };
  }

  const matches = await prisma.stock.findMany({
    where,
    ...relations,
  });

  if (matches.length === 0) {
    const msg = exchangeParam
      ? `Stock not found with symbol "${id}" on exchange "${exchangeParam.toUpperCase()}"`
      : `Stock not found with identifier: "${id}"`;
    throw new AppError(msg, 404, 'STOCK_NOT_FOUND');
  }

  if (matches.length > 1) {
    const safeMatches = matches.map((m) => ({
      id: m.id,
      symbol: m.symbol,
      companyName: m.companyName,
      instrumentToken: m.instrumentToken,
      segment: m.segment,
      exchange: m.exchange?.code,
    }));

    throw new AppError(
      `Ambiguous stock symbol "${id}". Found ${matches.length} matching instruments across exchanges/segments. Please specify the "exchange" query parameter (e.g. ?exchange=NSE) or query by exact UUID or instrumentToken.`,
      409,
      'AMBIGUOUS_STOCK_IDENTIFIER',
      { matches: safeMatches }
    );
  }

  return matches[0];
}

/**
 * GET /api/stocks
 * Paginated list of stocks with filtering by exchange, instrumentType, segment, and status.
 */
export async function getStocks(req, res, next) {
  try {
    const {
      page: rawPage = '1',
      limit: rawLimit = '20',
      search,
      q,
      exchange,
      instrumentType,
      segment,
      isActive,
      sortBy = 'symbol',
      sortOrder = 'asc',
    } = req.query;

    const page = parseInt(rawPage, 10);
    const limit = parseInt(rawLimit, 10);

    if (isNaN(page) || page < 1) {
      throw new AppError('Query parameter "page" must be a positive integer >= 1.', 400, 'INVALID_PAGINATION_PAGE');
    }
    if (isNaN(limit) || limit < 1 || limit > 100) {
      throw new AppError('Query parameter "limit" must be an integer between 1 and 100.', 400, 'INVALID_PAGINATION_LIMIT');
    }
    if (!ALLOWED_SORT_FIELDS.has(sortBy)) {
      throw new AppError(`Invalid sortBy field "${sortBy}". Allowed: ${Array.from(ALLOWED_SORT_FIELDS).join(', ')}`, 400, 'INVALID_SORT_BY');
    }
    if (!ALLOWED_SORT_ORDERS.has(sortOrder.toLowerCase())) {
      throw new AppError('Invalid sortOrder. Allowed: asc, desc', 400, 'INVALID_SORT_ORDER');
    }

    // Validate exchange filter
    let cleanExchange;
    if (exchange !== undefined && exchange !== '') {
      cleanExchange = String(exchange).trim().toUpperCase();
      if (!ALLOWED_EXCHANGES.has(cleanExchange)) {
        throw new AppError(
          `Invalid exchange filter "${exchange}". Allowed: ${Array.from(ALLOWED_EXCHANGES).join(', ')}`,
          400,
          'INVALID_EXCHANGE'
        );
      }
    }

    // Validate instrumentType filter
    let cleanInstrumentType;
    if (instrumentType !== undefined && instrumentType !== '') {
      cleanInstrumentType = String(instrumentType).trim().toUpperCase();
      if (!ALLOWED_INSTRUMENT_TYPES.has(cleanInstrumentType)) {
        throw new AppError(
          `Invalid instrumentType filter "${instrumentType}". Allowed: ${Array.from(ALLOWED_INSTRUMENT_TYPES).join(', ')}`,
          400,
          'INVALID_INSTRUMENT_TYPE'
        );
      }
    }

    // Validate isActive filter
    let parsedIsActive;
    if (isActive !== undefined && isActive !== '') {
      if (isActive !== 'true' && isActive !== 'false' && isActive !== true && isActive !== false) {
        throw new AppError(
          `Invalid isActive filter "${isActive}". Allowed: true, false`,
          400,
          'INVALID_FILTER_IS_ACTIVE'
        );
      }
      parsedIsActive = isActive === 'true' || isActive === true;
    }

    // Build deterministic cache key
    const queryString = buildDeterministicQueryString({
      page,
      limit,
      search: search || q,
      exchange: cleanExchange,
      instrumentType: cleanInstrumentType,
      segment: segment ? String(segment).trim().toUpperCase() : undefined,
      isActive: parsedIsActive,
      sortBy,
      sortOrder: sortOrder.toLowerCase(),
    });
    const cacheKey = cacheService.buildKey('stocks:list', queryString);

    const { data, cached } = await cacheService.getOrSet(
      cacheKey,
      CACHE_TTL.STOCKS_LIST,
      async () => {
        const where = {};

        // Search by symbol or company name
        const searchQuery = (search || q || '').trim();
        if (searchQuery.length > 0) {
          where.OR = [
            { symbol: { contains: searchQuery, mode: 'insensitive' } },
            { companyName: { contains: searchQuery, mode: 'insensitive' } },
          ];
        }

        // Filter by Exchange
        if (cleanExchange) {
          where.exchange = { code: cleanExchange };
        }

        // Filter by Instrument Type
        if (cleanInstrumentType) {
          where.instrumentType = cleanInstrumentType;
        }

        // Filter by Segment
        if (segment && typeof segment === 'string') {
          where.segment = segment.trim().toUpperCase();
        }

        // Filter by Active Status
        if (parsedIsActive !== undefined) {
          where.isActive = parsedIsActive;
        }

        const skip = (page - 1) * limit;

        const [totalRecords, stocks] = await Promise.all([
          prisma.stock.count({ where }),
          prisma.stock.findMany({
            where,
            skip,
            take: limit,
            orderBy: [
              { [sortBy]: sortOrder.toLowerCase() },
              { id: 'asc' }, // Secondary deterministic sort tie-breaker
            ],
            include: {
              exchange: {
                select: {
                  code: true,
                  name: true,
                  country: true,
                  currency: true,
                },
              },
            },
          }),
        ]);

        const totalPages = Math.ceil(totalRecords / limit);

        return {
          stocks,
          pagination: {
            page,
            limit,
            totalRecords,
            totalPages,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
          },
        };
      }
    );

    return res.json({
      success: true,
      data,
      meta: {
        cached,
        timestamp: new Date().toISOString(),
        pagination: data.pagination,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/stocks/search?q=
 * Fast typeahead search returning relevant matching symbols and companies.
 */
export async function searchStocks(req, res, next) {
  try {
    const rawQ = req.query.q || req.query.search;
    if (!rawQ || typeof rawQ !== 'string' || rawQ.trim().length === 0) {
      throw new AppError('Search query parameter "q" is required.', 400, 'MISSING_SEARCH_QUERY');
    }

    const query = rawQ.trim();
    if (query.length > 50) {
      throw new AppError('Search query cannot exceed 50 characters.', 400, 'INVALID_SEARCH_QUERY');
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 25);
    const cacheKey = cacheService.buildKey('stocks:search', `${query.toUpperCase()}:${limit}`);

    const { data, cached } = await cacheService.getOrSet(
      cacheKey,
      CACHE_TTL.STOCK_SEARCH,
      async () => {
        const where = {
          OR: [
            { symbol: { contains: query, mode: 'insensitive' } },
            { companyName: { contains: query, mode: 'insensitive' } },
          ],
          isActive: true,
        };

        const results = await prisma.stock.findMany({
          where,
          take: limit,
          orderBy: [
            { symbol: 'asc' },
            { id: 'asc' }, // Deterministic tie-breaker
          ],
          select: {
            id: true,
            symbol: true,
            companyName: true,
            isin: true,
            instrumentToken: true,
            instrumentType: true,
            segment: true,
            exchange: {
              select: {
                code: true,
                name: true,
              },
            },
          },
        });

        return {
          query,
          totalMatches: results.length,
          results,
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
 * GET /api/stocks/:id
 * Retrieve comprehensive details for a specific stock by UUID, instrumentToken, or symbol.
 * Accepts optional ?exchange=NSE|BSE query parameter to disambiguate identical symbols.
 */
export async function getStockById(req, res, next) {
  try {
    const { id: rawId } = req.params;
    const { exchange } = req.query;

    if (!rawId || typeof rawId !== 'string' || rawId.trim().length === 0) {
      throw new AppError('Stock identifier parameter is required.', 400, 'INVALID_STOCK_ID');
    }

    const id = rawId.trim();
    let exchangeParam;
    if (exchange !== undefined && exchange !== '') {
      exchangeParam = String(exchange).trim().toUpperCase();
      if (!ALLOWED_EXCHANGES.has(exchangeParam)) {
        throw new AppError(
          `Invalid exchange filter "${exchange}". Allowed: ${Array.from(ALLOWED_EXCHANGES).join(', ')}`,
          400,
          'INVALID_EXCHANGE'
        );
      }
    }

    // Build deterministic cache key incorporating exchange to prevent cross-exchange collision
    const queryString = exchangeParam ? `exchange=${exchangeParam}` : '';
    const cacheKey = cacheService.buildKey('stocks:detail', queryString ? `${id.toUpperCase()}:${queryString}` : id);

    const { data: stock, cached } = await cacheService.getOrSet(
      cacheKey,
      CACHE_TTL.STOCK_DETAIL,
      async () => {
        return resolveStockIdentifier(id, exchangeParam);
      }
    );

    return res.json({
      success: true,
      data: stock,
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
 * GET /api/stocks/:id/prices
 * Retrieve chronological historical candle records for a stock.
 * Accepts optional ?exchange=NSE|BSE query parameter to disambiguate identical symbols.
 */
export async function getStockPrices(req, res, next) {
  try {
    const { id: rawId } = req.params;
    const {
      interval = '1D',
      from,
      to,
      exchange,
      page: rawPage = '1',
      limit: rawLimit = '100',
    } = req.query;

    if (!rawId || typeof rawId !== 'string' || rawId.trim().length === 0) {
      throw new AppError('Stock identifier parameter is required.', 400, 'INVALID_STOCK_ID');
    }

    if (!ALLOWED_PRICE_INTERVALS.has(interval)) {
      throw new AppError(
        `Invalid interval "${interval}". Allowed intervals: ${Array.from(ALLOWED_PRICE_INTERVALS).join(', ')}`,
        400,
        'INVALID_INTERVAL'
      );
    }

    const page = parseInt(rawPage, 10);
    const limit = parseInt(rawLimit, 10);

    if (isNaN(page) || page < 1) {
      throw new AppError('Query parameter "page" must be a positive integer >= 1.', 400, 'INVALID_PAGINATION_PAGE');
    }
    if (isNaN(limit) || limit < 1 || limit > 1000) {
      throw new AppError('Query parameter "limit" must be an integer between 1 and 1000.', 400, 'INVALID_PAGINATION_LIMIT');
    }

    let fromDate = null;
    if (from) {
      const parsed = new Date(from);
      if (isNaN(parsed.getTime())) {
        throw new AppError(`Invalid "from" date format: "${from}". Must be ISO-8601 or YYYY-MM-DD.`, 400, 'INVALID_DATE_FROM');
      }
      fromDate = parsed;
    }

    let toDate = null;
    if (to) {
      const parsed = new Date(to);
      if (isNaN(parsed.getTime())) {
        throw new AppError(`Invalid "to" date format: "${to}". Must be ISO-8601 or YYYY-MM-DD.`, 400, 'INVALID_DATE_TO');
      }
      toDate = parsed;
    }

    if (fromDate && toDate && fromDate > toDate) {
      throw new AppError('"from" date cannot be after "to" date.', 400, 'INVALID_DATE_RANGE');
    }

    let exchangeParam;
    if (exchange !== undefined && exchange !== '') {
      exchangeParam = String(exchange).trim().toUpperCase();
      if (!ALLOWED_EXCHANGES.has(exchangeParam)) {
        throw new AppError(
          `Invalid exchange filter "${exchange}". Allowed: ${Array.from(ALLOWED_EXCHANGES).join(', ')}`,
          400,
          'INVALID_EXCHANGE'
        );
      }
    }

    // Resolve stock unambiguously
    const stock = await resolveStockIdentifier(rawId, exchangeParam, {
      select: {
        id: true,
        symbol: true,
        companyName: true,
        instrumentToken: true,
        exchange: { select: { code: true } },
      },
    });

    // Build deterministic cache key using resolved unique stock.id (UUID)
    const queryString = buildDeterministicQueryString({
      interval,
      from: fromDate ? fromDate.toISOString() : undefined,
      to: toDate ? toDate.toISOString() : undefined,
      page,
      limit,
    });
    const cacheKey = cacheService.buildKey('stocks:prices', `${stock.id}:${queryString}`);

    const { data, cached } = await cacheService.getOrSet(
      cacheKey,
      CACHE_TTL.STOCK_PRICES,
      async () => {
        const where = {
          stockId: stock.id,
          interval,
        };

        if (fromDate || toDate) {
          where.timestamp = {};
          if (fromDate) where.timestamp.gte = fromDate;
          if (toDate) where.timestamp.lte = toDate;
        }

        const skip = (page - 1) * limit;

        const [totalRecords, rawCandles] = await Promise.all([
          prisma.historicalPrice.count({ where }),
          prisma.historicalPrice.findMany({
            where,
            orderBy: [
              { timestamp: 'asc' },
              { id: 'asc' }, // Secondary deterministic tie-breaker
            ],
            skip,
            take: limit,
          }),
        ]);

        const totalPages = Math.ceil(totalRecords / limit);

        return {
          stock: {
            id: stock.id,
            symbol: stock.symbol,
            companyName: stock.companyName,
            instrumentToken: stock.instrumentToken,
            exchange: stock.exchange.code,
          },
          interval,
          candles: rawCandles.map(formatCandleRecord),
          pagination: {
            page,
            limit,
            totalRecords,
            totalPages,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
          },
        };
      }
    );

    return res.json({
      success: true,
      data,
      meta: {
        cached,
        timestamp: new Date().toISOString(),
        pagination: data.pagination,
      },
    });
  } catch (err) {
    next(err);
  }
}
