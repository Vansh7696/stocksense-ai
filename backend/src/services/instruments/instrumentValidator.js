/**
 * Instrument Validator & Normalizer
 *
 * Enforces strict Indian market data integrity:
 * - Differentiates EQUITY, INDEX, FUTURES, OPTIONS, and BOND instruments.
 * - Slices and normalizes exchange segments (NSE, BSE).
 * - Distinguishes between ISIN (12 alphanumeric security code) and Upstox Instrument Key.
 * - Never treats ISIN and Instrument Key as interchangeable.
 * - Preserves exchange-specific identifiers (exchange_token / scrip code).
 * - Validates required fields, reporting invalid/malformed records.
 */

export const SUPPORTED_EXCHANGES = new Set(['NSE', 'BSE']);

export const EQUITY_INSTRUMENT_TYPES = new Set([
  'EQ', // NSE Normal Equity
  'BE', // NSE Book Entry (Trade-to-Trade)
  'SM', // NSE SME Equity
  'ST', // NSE SME Trade-to-Trade
  'BZ', // NSE Trade-to-Trade
  'A',  // BSE Group A (Large Cap Liquid)
  'B',  // BSE Group B (Mid/Small Cap)
  'T',  // BSE Group T (Trade-to-Trade)
  'Z',  // BSE Group Z (Non-Compliant)
  'X',  // BSE Group X
  'XT', // BSE Group XT
  'MS', // BSE SME Equity
  'MT', // BSE SME Trade-to-Trade
  'P',  // BSE Preference Shares
  'MF', // Mutual Fund ETF
]);

export const BOND_INSTRUMENT_TYPES = new Set([
  'SG', // Sovereign Gold Bond
  'GB', // Government Securities / Bonds
  'GS', // Government Securities
  'TB', // Treasury Bills
  'F',  // BSE Fixed Income / Debt
  'N',  // BSE Non-Convertible Debentures
]);

/**
 * Classifies the high-level instrument type from Upstox segment and instrument_type.
 *
 * @param {string} segment - e.g. "NSE_EQ", "NSE_INDEX", "NSE_FO", "BSE_EQ"
 * @param {string} rawType - e.g. "EQ", "A", "INDEX", "FUT", "CE", "PE", "SG"
 * @returns {string} Standardized type: 'EQUITY' | 'INDEX' | 'FUTURES' | 'OPTIONS' | 'BOND' | 'OTHER'
 */
export function classifyInstrumentType(segment, rawType) {
  const normSeg = (segment || '').toUpperCase().trim();
  const normType = (rawType || '').toUpperCase().trim();

  if (normSeg.endsWith('_INDEX') || normType === 'INDEX') {
    return 'INDEX';
  }

  if (normType === 'FUT' || (normSeg.endsWith('_FO') && normType === 'FUT')) {
    return 'FUTURES';
  }

  if (normType === 'CE' || normType === 'PE') {
    return 'OPTIONS';
  }

  if (BOND_INSTRUMENT_TYPES.has(normType)) {
    return 'BOND';
  }

  if (normSeg === 'NSE_EQ' || normSeg === 'BSE_EQ') {
    if (EQUITY_INSTRUMENT_TYPES.has(normType)) {
      return 'EQUITY';
    }
    return 'EQUITY';
  }

  return 'OTHER';
}

/**
 * Validates whether a string conforms to the 12-character Indian ISIN standard.
 * Format: 2-letter country code + 9 alphanumeric characters + 1 check digit (e.g. INE002A01018, INF769K01QB4).
 *
 * @param {string} isin
 * @returns {boolean}
 */
export function isValidISIN(isin) {
  if (!isin || typeof isin !== 'string') return false;
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin.trim().toUpperCase());
}

export class InstrumentValidator {
  /**
   * @param {Object} [options]
   * @param {Set<string>} [options.supportedExchanges] Set of allowed exchange codes
   * @param {Set<string>} [options.allowedSegments] Optional whitelist of segments
   */
  constructor(options = {}) {
    this.supportedExchanges = options.supportedExchanges || SUPPORTED_EXCHANGES;
    this.allowedSegments = options.allowedSegments || null;
  }

  /**
   * Validates and normalizes an individual raw instrument record.
   *
   * @param {Object} raw - Raw item from Upstox master file
   * @returns {{ valid: boolean, scope: 'IN_SCOPE' | 'OUT_OF_SCOPE' | 'INVALID', normalized?: Object, reason?: string }}
   */
  validate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { valid: false, scope: 'INVALID', reason: 'RECORD_NOT_AN_OBJECT' };
    }

    const instrumentKey = typeof raw.instrument_key === 'string' ? raw.instrument_key.trim() : '';
    if (!instrumentKey || !instrumentKey.includes('|')) {
      return { valid: false, scope: 'INVALID', reason: 'INVALID_OR_MISSING_INSTRUMENT_KEY' };
    }

    const rawSymbol = raw.trading_symbol || raw.short_name || raw.exchange_token;
    if (!rawSymbol || typeof rawSymbol !== 'string' || rawSymbol.trim().length === 0) {
      return { valid: false, scope: 'INVALID', reason: 'MISSING_TRADING_SYMBOL' };
    }
    const symbol = rawSymbol.trim().toUpperCase();

    const segment = typeof raw.segment === 'string' ? raw.segment.toUpperCase().trim() : '';
    if (!segment) {
      return { valid: false, scope: 'INVALID', reason: 'MISSING_SEGMENT' };
    }

    const exchange = typeof raw.exchange === 'string' ? raw.exchange.toUpperCase().trim() : '';
    if (!this.supportedExchanges.has(exchange)) {
      return { valid: false, scope: 'OUT_OF_SCOPE', reason: `UNSUPPORTED_EXCHANGE_${exchange || 'EMPTY'}` };
    }

    if (this.allowedSegments && !this.allowedSegments.has(segment)) {
      return { valid: false, scope: 'OUT_OF_SCOPE', reason: `SEGMENT_FILTERED_${segment}` };
    }

    const companyName = (typeof raw.name === 'string' && raw.name.trim().length > 0)
      ? raw.name.trim()
      : symbol;

    const rawType = typeof raw.instrument_type === 'string' ? raw.instrument_type.trim() : '';
    const instrumentType = classifyInstrumentType(segment, rawType);

    // Validate ISIN strictly (never confuse with instrument key)
    let isin = null;
    if (typeof raw.isin === 'string' && raw.isin.trim().length > 0) {
      const trimmedIsin = raw.isin.trim().toUpperCase();
      if (isValidISIN(trimmedIsin)) {
        isin = trimmedIsin;
      }
    }

    // Lot Size
    const parsedLot = parseInt(raw.lot_size, 10);
    const lotSize = !isNaN(parsedLot) && parsedLot > 0 ? parsedLot : 1;

    // Tick Size
    let tickSize = null;
    if (raw.tick_size !== undefined && raw.tick_size !== null) {
      const parsedTick = parseFloat(raw.tick_size);
      if (!isNaN(parsedTick) && parsedTick > 0) {
        tickSize = parsedTick.toFixed(4);
      }
    }

    // Expiry Date (derivatives / bonds)
    let expiryDate = null;
    if (raw.expiry) {
      const parsedTime = Number(raw.expiry);
      if (!isNaN(parsedTime) && parsedTime > 0) {
        const d = new Date(parsedTime);
        if (!isNaN(d.getTime())) {
          expiryDate = d;
        }
      } else {
        const d = new Date(raw.expiry);
        if (!isNaN(d.getTime())) {
          expiryDate = d;
        }
      }
    }

    const exchangeToken = raw.exchange_token ? String(raw.exchange_token).trim() : null;
    const series = rawType || (instrumentType === 'INDEX' ? 'INDEX' : 'EQ');

    return {
      valid: true,
      scope: 'IN_SCOPE',
      normalized: {
        exchange,
        segment,
        symbol,
        companyName,
        isin,
        instrumentToken: instrumentKey,
        exchangeToken,
        instrumentType,
        series,
        lotSize,
        tickSize,
        expiryDate,
        isActive: true,
      },
    };
  }

  /**
   * Validates a batch of raw records, categorizing valid in-scope,
   * valid out-of-scope (e.g. derivatives or other exchanges), and genuinely invalid records.
   *
   * @param {Array<Object>} rawRecords
   * @returns {{
   *   validRecords: Array<Object>,
   *   validInScope: number,
   *   validOutOfScope: number,
   *   invalidRecords: number,
   *   invalidCount: number,
   *   errorReasons: Object
   * }}
   */
  validateBatch(rawRecords) {
    const validRecords = [];
    let validInScope = 0;
    let validOutOfScope = 0;
    let invalidRecords = 0;
    const errorReasons = new Map();

    for (const raw of rawRecords) {
      const res = this.validate(raw);
      if (res.valid && res.scope === 'IN_SCOPE') {
        validRecords.push(res.normalized);
        validInScope++;
      } else if (res.scope === 'OUT_OF_SCOPE') {
        validOutOfScope++;
        errorReasons.set(res.reason, (errorReasons.get(res.reason) || 0) + 1);
      } else {
        invalidRecords++;
        errorReasons.set(res.reason, (errorReasons.get(res.reason) || 0) + 1);
      }
    }

    return {
      validRecords,
      validInScope,
      validOutOfScope,
      invalidRecords,
      invalidCount: invalidRecords, // Backward-compatibility alias
      errorReasons: Object.fromEntries(errorReasons),
    };
  }
}

export default new InstrumentValidator();
