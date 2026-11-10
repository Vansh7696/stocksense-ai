/**
 * Official Upstox API V3 & V2 Constants & Endpoint Specifications
 *
 * Official Documentation References:
 * - Upstox Developer Documentation: https://upstox.com/developer/api-documentation
 * - Historical Candle Data V3: https://api.upstox.com/v3/historical-candle
 * - Market Quotes V2: https://api.upstox.com/v2/market-quote/quotes
 * - LTP Quotes V3: https://upstox.com/developer/api-documentation/ltp-v3/
 */

export const UPSTOX_ENDPOINTS = {
  // Official V3 Candle Endpoints
  HISTORICAL_CANDLE_V3: 'https://api.upstox.com/v3/historical-candle',
  INTRADAY_CANDLE_V3: 'https://api.upstox.com/v3/historical-candle/intraday',

  // Official V3 LTP Endpoint (Deprecated /v2/market-quote/ltp replaced)
  MARKET_LTP_V3: 'https://api.upstox.com/v3/market-quote/ltp',

  // Official V2 Market Quote Endpoint
  MARKET_QUOTE_V2: 'https://api.upstox.com/v2/market-quote/quotes',

  // Master Instruments Feeds
  NSE_INSTRUMENTS: 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz',
  BSE_INSTRUMENTS: 'https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz',
  COMPLETE_INSTRUMENTS: 'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz',
};

/**
 * Official Plural Resolution Units for Upstox API V3
 */
export const UPSTOX_UNITS = {
  MINUTES: 'minutes',
  HOURS: 'hours',
  DAYS: 'days',
  WEEKS: 'weeks',
  MONTHS: 'months',
};

/**
 * Platform Interval to Upstox V3 Parameter Mapping
 * Includes official V3 chunk retrieval boundaries:
 * - 1m–15m: Maximum 1 month (30 days chunk)
 * - >15m (30m): Maximum 1 quarter (90 days chunk)
 * - Hours (1h): Maximum 1 quarter (90 days chunk)
 * - Days (1D): Maximum 1 decade (365 days chunk for safe paging)
 * - Weeks (1W): No stated limit (730 days chunk)
 * - Months (1M): No stated limit (1825 days chunk)
 */
export const INTERVAL_TO_V3_MAP = {
  '1m': { unit: UPSTOX_UNITS.MINUTES, interval: '1', maxSpanDays: 30 },
  '5m': { unit: UPSTOX_UNITS.MINUTES, interval: '5', maxSpanDays: 30 },
  '15m': { unit: UPSTOX_UNITS.MINUTES, interval: '15', maxSpanDays: 30 },
  '30m': { unit: UPSTOX_UNITS.MINUTES, interval: '30', maxSpanDays: 90 },
  '1h': { unit: UPSTOX_UNITS.HOURS, interval: '1', maxSpanDays: 90 },
  '60m': { unit: UPSTOX_UNITS.HOURS, interval: '1', maxSpanDays: 90 },
  '1D': { unit: UPSTOX_UNITS.DAYS, interval: '1', maxSpanDays: 365 },
  '1d': { unit: UPSTOX_UNITS.DAYS, interval: '1', maxSpanDays: 365 },
  'DAY': { unit: UPSTOX_UNITS.DAYS, interval: '1', maxSpanDays: 365 },
  '1W': { unit: UPSTOX_UNITS.WEEKS, interval: '1', maxSpanDays: 730 },
  '1w': { unit: UPSTOX_UNITS.WEEKS, interval: '1', maxSpanDays: 730 },
  'WEEK': { unit: UPSTOX_UNITS.WEEKS, interval: '1', maxSpanDays: 730 },
  '1M': { unit: UPSTOX_UNITS.MONTHS, interval: '1', maxSpanDays: 1825 },
  '1mo': { unit: UPSTOX_UNITS.MONTHS, interval: '1', maxSpanDays: 1825 },
  'MONTH': { unit: UPSTOX_UNITS.MONTHS, interval: '1', maxSpanDays: 1825 },
};

export const DEFAULT_TIMEOUT_MS = 10000;
export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1000;
export const RETRY_MAX_DELAY_MS = 10000;
