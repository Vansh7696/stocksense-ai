import { MarketDataProvider } from '../MarketDataProvider.js';
import upstoxClient from './upstox.client.js';
import {
  UPSTOX_ENDPOINTS,
  INTERVAL_TO_V3_MAP,
} from './upstox.constants.js';
import {
  encodeInstrumentKey,
  resolveInstrumentKey,
  mapQuoteResponse,
  mapLtpResponse,
} from './upstox.mapper.js';
import marketDataValidatorService from '../../services/marketDataValidator.service.js';
import tokenService from '../../services/token.service.js';
import { config } from '../../config/index.js';
import { AppError } from '../../middleware/errorHandler.js';

export class UpstoxProvider extends MarketDataProvider {
  constructor({
    client = upstoxClient,
    validator = marketDataValidatorService,
    tokenManager = tokenService,
  } = {}) {
    super('UPSTOX');
    this.client = client;
    this.validator = validator;
    this.tokenManager = tokenManager;
  }

  /**
   * Resolve an internal stock record or symbol to an Upstox instrument key.
   */
  resolveInstrumentKey(stockOrSymbol, exchangeCode = 'NSE') {
    return resolveInstrumentKey(stockOrSymbol, exchangeCode);
  }

  /**
   * Split a date range [fromDateStr, toDateStr] into chunks of at most `maxDays` days.
   * Chunks are ordered chronologically from earliest to latest.
   *
   * @param {string} fromDateStr - "YYYY-MM-DD"
   * @param {string} toDateStr - "YYYY-MM-DD"
   * @param {number} maxDays - Chunk size in days
   * @returns {Array<{ from: string, to: string }>}
   */
  chunkDateRange(fromDateStr, toDateStr, maxDays = 30) {
    if (!fromDateStr || !toDateStr) {
      throw new Error('[UpstoxProvider] Both fromDate and toDate are required for date chunking.');
    }

    // Ensure dates are parsed as UTC calendar dates to prevent timezone drift across midnight
    const startParts = fromDateStr.split('-').map(Number);
    const endParts = toDateStr.split('-').map(Number);

    if (startParts.length !== 3 || endParts.length !== 3) {
      throw new Error(`[UpstoxProvider] Invalid date format for chunking: from="${fromDateStr}", to="${toDateStr}". Expected YYYY-MM-DD.`);
    }

    const startDate = new Date(Date.UTC(startParts[0], startParts[1] - 1, startParts[2]));
    const endDate = new Date(Date.UTC(endParts[0], endParts[1] - 1, endParts[2]));

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw new Error(`[UpstoxProvider] Invalid date format for chunking: from="${fromDateStr}", to="${toDateStr}"`);
    }

    if (startDate > endDate) {
      throw new Error(`[UpstoxProvider] fromDate (${fromDateStr}) cannot be after toDate (${toDateStr})`);
    }

    const chunks = [];
    let currentStart = new Date(startDate);

    while (currentStart <= endDate) {
      const currentEnd = new Date(currentStart);
      currentEnd.setUTCDate(currentEnd.getUTCDate() + maxDays - 1);

      const effectiveEnd = currentEnd > endDate ? endDate : currentEnd;

      chunks.push({
        from: currentStart.toISOString().split('T')[0],
        to: effectiveEnd.toISOString().split('T')[0],
      });

      // Move currentStart forward by exactly 1 calendar day past effectiveEnd
      currentStart = new Date(effectiveEnd);
      currentStart.setUTCDate(currentStart.getUTCDate() + 1);
    }

    return chunks;
  }

  /**
   * Fetch historical candles using official Upstox API V3.
   *
   * @param {string} instrumentKey - e.g. "NSE_EQ|INE002A01018"
   * @param {string} [interval='1D'] - e.g. "1m", "5m", "15m", "30m", "1h", "1D", "1W", "1M"
   * @param {string} [from] - Start date "YYYY-MM-DD"
   * @param {string} [to] - End date "YYYY-MM-DD"
   * @param {Object} [options] - Optional execution options (continueOnError, onChunk, onChunkError)
   * @returns {Promise<Object>}
   */
  async getHistoricalCandles(instrumentKey, interval = '1D', from = null, to = null, options = {}) {
    if (!instrumentKey) {
      throw new AppError('Instrument key is required for historical candle retrieval', 400, 'MISSING_INSTRUMENT_KEY');
    }

    const mapping = INTERVAL_TO_V3_MAP[interval] || INTERVAL_TO_V3_MAP['1D'];
    const { unit, interval: v3Interval, maxSpanDays } = mapping;

    const toDate = to || new Date().toISOString().split('T')[0];
    const fromDate = from || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const chunks = this.chunkDateRange(fromDate, toDate, maxSpanDays);
    const encodedKey = encodeInstrumentKey(instrumentKey);
    const rawCandles = [];
    const failedChunks = [];

    // Fetch chunks sequentially to strictly enforce rate limits
    for (const chunk of chunks) {
      if (options.beforeChunk) {
        await options.beforeChunk({ chunk });
      }

      const url = `${UPSTOX_ENDPOINTS.HISTORICAL_CANDLE_V3}/${encodedKey}/${unit}/${v3Interval}/${chunk.to}/${chunk.from}`;
      try {
        const response = await this.client.get(url, { permitType: 'historical' });
        const chunkCandles = response?.data?.candles || [];
        rawCandles.push(...chunkCandles);
        if (options.onChunk) {
          await options.onChunk({ chunk, candles: chunkCandles });
        }
      } catch (err) {
        if (err.code === 'INGESTION_LOCK_LOST') {
          throw err;
        }
        failedChunks.push({ chunk, error: err.message, code: err.code || 'CHUNK_FETCH_ERROR' });
        if (options.onChunkError) {
          await options.onChunkError({ chunk, error: err });
        }
        if (!options.continueOnError) {
          throw err;
        }
      }
    }

    // Validate candles through market data quality validator
    const validated = this.validator.validateCandleBatch(rawCandles);

    return {
      data: validated.valid,
      rejected: validated.rejected,
      summary: validated.summary,
      status: failedChunks.length === 0 ? 'SUCCESS' : (rawCandles.length > 0 ? 'PARTIAL' : 'FAILED'),
      failedChunks,
      dataFreshness: 'LIVE',
      source: 'UPSTOX_V3',
      interval,
      unit,
      instrumentKey,
    };
  }

  /**
   * Fetch intraday candles for current trading session using Upstox API V3.
   *
   * @param {string} instrumentKey - e.g. "NSE_EQ|INE002A01018"
   * @param {string} [interval='1m'] - e.g. "1m", "5m", "15m", "30m"
   * @returns {Promise<Object>}
   */
  async getIntradayCandles(instrumentKey, interval = '1m') {
    if (!instrumentKey) {
      throw new AppError('Instrument key is required for intraday candle retrieval', 400, 'MISSING_INSTRUMENT_KEY');
    }

    const mapping = INTERVAL_TO_V3_MAP[interval] || INTERVAL_TO_V3_MAP['1m'];
    const { unit, interval: v3Interval } = mapping;
    const encodedKey = encodeInstrumentKey(instrumentKey);

    const url = `${UPSTOX_ENDPOINTS.INTRADAY_CANDLE_V3}/${encodedKey}/${unit}/${v3Interval}`;
    const response = await this.client.get(url, { permitType: 'historical' });

    const rawCandles = response?.data?.candles || [];
    const validated = this.validator.validateCandleBatch(rawCandles);

    return {
      data: validated.valid,
      rejected: validated.rejected,
      summary: validated.summary,
      status: 'SUCCESS',
      dataFreshness: 'LIVE',
      source: 'UPSTOX_V3',
      interval,
      unit,
      instrumentKey,
    };
  }

  /**
   * Fetch full market quote for a single instrument via Upstox V2 Quote API.
   *
   * @param {string} instrumentKey
   * @returns {Promise<Object>} Normalized quote object
   */
  async getQuote(instrumentKey) {
    if (!instrumentKey) {
      throw new AppError('Instrument key is required for quote retrieval', 400, 'MISSING_INSTRUMENT_KEY');
    }

    const encodedKey = encodeInstrumentKey(instrumentKey);
    const url = `${UPSTOX_ENDPOINTS.MARKET_QUOTE_V2}?instrument_key=${encodedKey}`;

    const response = await this.client.get(url, { permitType: 'quote' });
    const quoteMap = response?.data || {};

    // Upstox formats response keys with colon, e.g. "NSE_EQ:RELIANCE"
    const rawKey = Object.keys(quoteMap)[0];
    const rawItem = rawKey ? quoteMap[rawKey] : null;

    if (!rawItem) {
      throw new AppError(`No quote data returned for instrument "${instrumentKey}"`, 404, 'QUOTE_NOT_FOUND');
    }

    return mapQuoteResponse(rawItem, instrumentKey);
  }

  /**
   * Fetch market quotes for multiple instruments in a batch.
   *
   * @param {string[]} instrumentKeys
   * @returns {Promise<Map<string, Object>>}
   */
  async getQuotes(instrumentKeys) {
    if (!Array.isArray(instrumentKeys) || instrumentKeys.length === 0) {
      return new Map();
    }

    const encodedParam = instrumentKeys.map((k) => encodeInstrumentKey(k)).join(',');
    const url = `${UPSTOX_ENDPOINTS.MARKET_QUOTE_V2}?instrument_key=${encodedParam}`;

    const response = await this.client.get(url, { permitType: 'quote' });
    const quoteMap = response?.data || {};
    const result = new Map();

    for (const [key, rawItem] of Object.entries(quoteMap)) {
      const normalized = mapQuoteResponse(rawItem, key);
      result.set(key, normalized);
    }

    return result;
  }

  /**
   * Fetch Last Traded Price (LTP) for an instrument via Upstox V3 LTP API.
   *
   * @param {string} instrumentKey
   * @returns {Promise<Object>}
   */
  async getLtp(instrumentKey) {
    if (!instrumentKey) {
      throw new AppError('Instrument key is required for LTP retrieval', 400, 'MISSING_INSTRUMENT_KEY');
    }

    const encodedKey = encodeInstrumentKey(instrumentKey);
    const url = `${UPSTOX_ENDPOINTS.MARKET_LTP_V3}?instrument_key=${encodedKey}`;

    const response = await this.client.get(url, { permitType: 'quote' });
    const ltpMap = response?.data || {};
    const rawKey = Object.keys(ltpMap)[0];
    const rawItem = rawKey ? ltpMap[rawKey] : null;

    if (!rawItem) {
      throw new AppError(`No LTP data returned for instrument "${instrumentKey}"`, 404, 'LTP_NOT_FOUND');
    }

    return mapLtpResponse(rawItem, instrumentKey);
  }

  /**
   * Return provider operational health and token status.
   */
  async getHealth() {
    const tokenStatus = await this.tokenManager.getTokenStatus();

    return {
      provider: this.name,
      configured: Boolean(config.upstox?.apiKey && config.upstox?.apiSecret),
      token: tokenStatus,
      limits: {
        historicalReqPerSec: config.upstox?.historicalRateLimit || 5,
        quoteReqPerSec: config.upstox?.quoteRateLimit || 8,
        minuteAggregateLimit: config.upstox?.minuteRateLimit || 250,
        thirtyMinAggregateLimit: config.upstox?.thirtyMinRateLimit || 1000,
      },
      status: tokenStatus.active ? 'CONNECTED' : 'STANDBY',
    };
  }
}

export default new UpstoxProvider();
