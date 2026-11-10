/**
 * MarketDataProvider — Abstract Provider Base Interface
 *
 * All market data provider adapters (Upstox, Angel One, Zerodha, etc.)
 * must inherit from this class and implement its interface.
 * Higher layers depend strictly on this abstraction.
 */

export class MarketDataProvider {
  constructor(providerName) {
    if (this.constructor === MarketDataProvider) {
      throw new Error('Abstract class "MarketDataProvider" cannot be instantiated directly.');
    }
    this.name = providerName;
  }

  /**
   * Fetch historical OHLCV candles for an instrument within a date range.
   *
   * @param {string} instrumentKey - e.g. "NSE_EQ|INE002A01018"
   * @param {string} interval - e.g. "1D", "1m", "5m", "15m", "30m", "1h"
   * @param {string} [from] - Start date "YYYY-MM-DD"
   * @param {string} [to] - End date "YYYY-MM-DD"
   * @returns {Promise<{
   *   data: Array,
   *   status: string,
   *   dataFreshness: string,
   *   source: string,
   *   summary: Object
   * }>}
   */
  async getHistoricalCandles(instrumentKey, interval, from, to) {
    throw new Error(`Method "getHistoricalCandles()" must be implemented by ${this.constructor.name}.`);
  }

  /**
   * Fetch intraday candles for the current trading session.
   *
   * @param {string} instrumentKey - e.g. "NSE_EQ|INE002A01018"
   * @param {string} interval - e.g. "1m", "5m", "15m"
   * @returns {Promise<{
   *   data: Array,
   *   status: string,
   *   dataFreshness: string,
   *   source: string
   * }>}
   */
  async getIntradayCandles(instrumentKey, interval) {
    throw new Error(`Method "getIntradayCandles()" must be implemented by ${this.constructor.name}.`);
  }

  /**
   * Fetch full market quote for a single instrument.
   *
   * @param {string} instrumentKey - e.g. "NSE_EQ|INE002A01018"
   * @returns {Promise<Object>} Normalized quote object
   */
  async getQuote(instrumentKey) {
    throw new Error(`Method "getQuote()" must be implemented by ${this.constructor.name}.`);
  }

  /**
   * Fetch market quotes for multiple instruments in a batch.
   *
   * @param {string[]} instrumentKeys - Array of instrument keys
   * @returns {Promise<Map<string, Object>>} Map of instrumentKey -> quote
   */
  async getQuotes(instrumentKeys) {
    throw new Error(`Method "getQuotes()" must be implemented by ${this.constructor.name}.`);
  }

  /**
   * Fetch Last Traded Price (LTP) for an instrument.
   *
   * @param {string} instrumentKey - e.g. "NSE_EQ|INE002A01018"
   * @returns {Promise<{ instrumentKey: string, lastPrice: number, source: string }>}
   */
  async getLtp(instrumentKey) {
    throw new Error(`Method "getLtp()" must be implemented by ${this.constructor.name}.`);
  }

  /**
   * Resolve an internal stock record or symbol to a provider-specific instrument key.
   *
   * @param {Object|string} stockOrSymbol
   * @param {string} [exchangeCode]
   * @returns {string|null}
   */
  resolveInstrumentKey(stockOrSymbol, exchangeCode) {
    throw new Error(`Method "resolveInstrumentKey()" must be implemented by ${this.constructor.name}.`);
  }

  /**
   * Check provider connectivity and authentication status.
   *
   * @returns {Promise<{ provider: string, status: string, token: Object, limits: Object }>}
   */
  async getHealth() {
    throw new Error(`Method "getHealth()" must be implemented by ${this.constructor.name}.`);
  }
}
