/**
 * Upstox Instrument & Data Format Mapper
 *
 * Handles:
 * - Translating between internal stock entities and verified Upstox instrument keys.
 * - Sourcing instrument keys strictly from verified Upstox instrument metadata.
 *   Never assumes an unverified ISIN can be converted merely by prefixing exchange codes.
 * - URL-encoding of instrument keys (pipe '|' to '%7C').
 * - Transforming Upstox V2 Quote & Upstox V3 LTP responses into standardized internal models.
 * - Transforming Upstox V3 Candle array responses into raw candle objects.
 */

/**
 * Official verified metadata for seeded core blue-chip instruments.
 * Verified against official Upstox instrument master files (NSE.json.gz / BSE.json.gz).
 */
export const VERIFIED_INSTRUMENTS_METADATA = {
  'NSE:RELIANCE': {
    segment: 'NSE_EQ',
    exchange: 'NSE',
    symbol: 'RELIANCE',
    isin: 'INE002A01018',
    instrumentType: 'EQ',
    instrumentKey: 'NSE_EQ|INE002A01018',
  },
  'NSE:TCS': {
    segment: 'NSE_EQ',
    exchange: 'NSE',
    symbol: 'TCS',
    isin: 'INE467B01029',
    instrumentType: 'EQ',
    instrumentKey: 'NSE_EQ|INE467B01029',
  },
  'NSE:INFY': {
    segment: 'NSE_EQ',
    exchange: 'NSE',
    symbol: 'INFY',
    isin: 'INE009A01021',
    instrumentType: 'EQ',
    instrumentKey: 'NSE_EQ|INE009A01021',
  },
  'NSE:HDFCBANK': {
    segment: 'NSE_EQ',
    exchange: 'NSE',
    symbol: 'HDFCBANK',
    isin: 'INE040A01034',
    instrumentType: 'EQ',
    instrumentKey: 'NSE_EQ|INE040A01034',
  },
  'NSE:ICICIBANK': {
    segment: 'NSE_EQ',
    exchange: 'NSE',
    symbol: 'ICICIBANK',
    isin: 'INE090A01021',
    instrumentType: 'EQ',
    instrumentKey: 'NSE_EQ|INE090A01021',
  },
  'BSE:500325': {
    segment: 'BSE_EQ',
    exchange: 'BSE',
    symbol: '500325',
    isin: 'INE002A01018',
    instrumentType: 'A',
    instrumentKey: 'BSE_EQ|INE002A01018',
  },
  'BSE:532540': {
    segment: 'BSE_EQ',
    exchange: 'BSE',
    symbol: '532540',
    isin: 'INE467B01029',
    instrumentType: 'A',
    instrumentKey: 'BSE_EQ|INE467B01029',
  },
};

// Quick lookup map: key -> instrumentKey
export const VERIFIED_SEED_INSTRUMENTS = Object.fromEntries(
  Object.entries(VERIFIED_INSTRUMENTS_METADATA).map(([k, v]) => [k, v.instrumentKey])
);

/**
 * Encode an instrument key for safe inclusion in URL paths or query parameters.
 * Encodes pipe '|' character to '%7C'.
 *
 * @param {string} instrumentKey - e.g. "NSE_EQ|INE002A01018"
 * @returns {string} e.g. "NSE_EQ%7CINE002A01018"
 */
export function encodeInstrumentKey(instrumentKey) {
  if (!instrumentKey || typeof instrumentKey !== 'string') {
    throw new Error(`[UpstoxMapper] Invalid instrument key for encoding: "${instrumentKey}"`);
  }
  return encodeURIComponent(instrumentKey.trim());
}

/**
 * Resolve an Upstox instrument key strictly from verified instrument metadata or verified stored token.
 * Never guesses, fabricates, or assumes an unverified ISIN format.
 * If a mapping cannot be verified, returns null (or throws if strict).
 *
 * @param {Object|string} stockOrSymbol - Stock entity { symbol, isin, instrumentToken, exchange } or symbol string
 * @param {string} [exchangeCode='NSE'] - Exchange code if symbol string passed
 * @returns {string|null} Verified Upstox instrument key, or null if unverified
 */
export function resolveInstrumentKey(stockOrSymbol, exchangeCode = 'NSE') {
  if (!stockOrSymbol) return null;

  // 1. If an object is provided
  if (typeof stockOrSymbol === 'object') {
    // If the record already has a verified instrumentToken from database seeding / official sync
    if (stockOrSymbol.instrumentToken && typeof stockOrSymbol.instrumentToken === 'string') {
      const token = stockOrSymbol.instrumentToken.trim();
      if (token.includes('|') && /^(NSE_EQ|BSE_EQ|NSE_INDEX|BSE_INDEX)\|.+/.test(token)) {
        return token;
      }
    }

    const exCode = stockOrSymbol.exchange?.code || stockOrSymbol.exchange || exchangeCode;
    const symbol = stockOrSymbol.symbol;
    const isin = stockOrSymbol.isin;

    // Verify against official verified metadata by symbol + exchange
    if (symbol && exCode) {
      const lookupKey = `${exCode}:${symbol}`;
      if (VERIFIED_INSTRUMENTS_METADATA[lookupKey]) {
        return VERIFIED_INSTRUMENTS_METADATA[lookupKey].instrumentKey;
      }
    }

    // Verify against official verified metadata by ISIN + exchange
    if (isin && exCode) {
      for (const meta of Object.values(VERIFIED_INSTRUMENTS_METADATA)) {
        if (meta.exchange === exCode && meta.isin === isin) {
          return meta.instrumentKey;
        }
      }
    }

    // If not verified in official metadata or verified instrumentToken, return null
    return null;
  }

  // 2. If a string is provided
  if (typeof stockOrSymbol === 'string') {
    const trimmed = stockOrSymbol.trim();

    // If directly passing an instrument key, verify it conforms to standard segment|identifier pattern
    if (trimmed.includes('|')) {
      if (/^(NSE_EQ|BSE_EQ|NSE_INDEX|BSE_INDEX)\|[a-zA-Z0-9_-]+/.test(trimmed)) {
        return trimmed;
      }
      return null;
    }

    // Lookup by symbol + exchange in verified metadata
    const lookupKey = `${exchangeCode}:${trimmed}`;
    if (VERIFIED_INSTRUMENTS_METADATA[lookupKey]) {
      return VERIFIED_INSTRUMENTS_METADATA[lookupKey].instrumentKey;
    }

    return null;
  }

  return null;
}

import { toDecimalSafeString } from '../../services/marketDataValidator.service.js';

/**
 * Format Upstox V2 Quote response into internal quote object.
 *
 * @param {Object} rawItem - Single quote item from Upstox response
 * @param {string} instrumentKey - Resolved instrument key
 * @returns {Object} Normalized quote object
 */
export function mapQuoteResponse(rawItem, instrumentKey) {
  if (!rawItem) return null;

  const ohlc = rawItem.ohlc || {};
  const safeDecimal = (v) => {
    if (v == null) return null;
    try {
      return toDecimalSafeString(v, 4);
    } catch {
      return null;
    }
  };

  const volumeBigInt = rawItem.volume != null ? BigInt(Math.floor(Number(rawItem.volume))) : BigInt(0);
  const buyQty = rawItem.total_buy_quantity != null ? BigInt(Math.floor(Number(rawItem.total_buy_quantity))) : null;
  const sellQty = rawItem.total_sell_quantity != null ? BigInt(Math.floor(Number(rawItem.total_sell_quantity))) : null;

  return {
    instrumentKey,
    symbol: rawItem.symbol || '',
    lastPrice: rawItem.last_price != null ? Number(rawItem.last_price) : null,
    lastPriceDecimal: safeDecimal(rawItem.last_price),
    open: ohlc.open != null ? Number(ohlc.open) : null,
    openDecimal: safeDecimal(ohlc.open),
    high: ohlc.high != null ? Number(ohlc.high) : null,
    highDecimal: safeDecimal(ohlc.high),
    low: ohlc.low != null ? Number(ohlc.low) : null,
    lowDecimal: safeDecimal(ohlc.low),
    close: ohlc.close != null ? Number(ohlc.close) : null,
    closeDecimal: safeDecimal(ohlc.close),
    volume: volumeBigInt,
    volumeString: volumeBigInt.toString(),
    netChange: rawItem.net_change != null ? Number(rawItem.net_change) : 0,
    percentageChange: rawItem.percentage_change != null ? Number(rawItem.percentage_change) : 0,
    averagePrice: rawItem.average_price != null ? Number(rawItem.average_price) : null,
    averagePriceDecimal: safeDecimal(rawItem.average_price),
    marketTimestamp: rawItem.timestamp || null,
    upperCircuit: rawItem.upper_circuit_limit != null ? Number(rawItem.upper_circuit_limit) : null,
    lowerCircuit: rawItem.lower_circuit_limit != null ? Number(rawItem.lower_circuit_limit) : null,
    totalBuyQuantity: buyQty,
    totalBuyQuantityString: buyQty != null ? buyQty.toString() : null,
    totalSellQuantity: sellQty,
    totalSellQuantityString: sellQty != null ? sellQty.toString() : null,
    source: 'UPSTOX_V2',
    dataFreshness: 'LIVE',
  };
}

/**
 * Format Upstox V3 LTP response into internal LTP object.
 * Maps: last_price, instrument_token, ltq (last traded quantity), volume, cp (previous close).
 *
 * @param {Object} rawItem - Single LTP item from Upstox V3 response
 * @param {string} instrumentKey - Resolved instrument key
 * @returns {Object} Normalized LTP object
 */
export function mapLtpResponse(rawItem, instrumentKey) {
  if (!rawItem) return null;

  const safeDecimal = (v) => {
    if (v == null) return null;
    try {
      return toDecimalSafeString(v, 4);
    } catch {
      return null;
    }
  };

  const volumeBigInt = rawItem.volume != null ? BigInt(Math.floor(Number(rawItem.volume))) : BigInt(0);
  const ltqBigInt = rawItem.ltq != null ? BigInt(Math.floor(Number(rawItem.ltq))) : null;

  return {
    instrumentKey,
    instrumentToken: rawItem.instrument_token || instrumentKey,
    lastPrice: rawItem.last_price != null ? Number(rawItem.last_price) : null,
    lastPriceDecimal: safeDecimal(rawItem.last_price),
    ltq: ltqBigInt,
    ltqString: ltqBigInt != null ? ltqBigInt.toString() : null,
    volume: volumeBigInt,
    volumeString: volumeBigInt.toString(),
    closePrice: rawItem.cp != null ? Number(rawItem.cp) : null,
    closePriceDecimal: safeDecimal(rawItem.cp),
    cp: rawItem.cp != null ? Number(rawItem.cp) : null,
    source: 'UPSTOX_V3',
    dataFreshness: 'LIVE',
  };
}

/**
 * Format raw Upstox V3 candle array element into raw candle object for validation.
 * Upstox array structure: [timestamp, open, high, low, close, volume, open_interest]
 *
 * @param {Array} candleArray
 * @returns {Object|null}
 */
export function mapRawCandleArray(candleArray) {
  if (!Array.isArray(candleArray) || candleArray.length < 5) {
    return null;
  }

  return {
    timestamp: candleArray[0],
    open: candleArray[1],
    high: candleArray[2],
    low: candleArray[3],
    close: candleArray[4],
    volume: candleArray[5] ?? 0,
    openInterest: candleArray[6] ?? 0,
  };
}
