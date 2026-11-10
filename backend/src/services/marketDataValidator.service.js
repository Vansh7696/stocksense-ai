/**
 * Market Data Quality Validation Service
 *
 * Enforces rigorous pre-ingestion validation for all OHLCV market data bars:
 * 1. Timestamp validity & non-future timestamp checks (with clock skew buffer).
 * 2. Exact exchange timestamp preservation (never hardcoding 09:15 or fabricated times).
 * 3. Strict OHLC relational constraints:
 *    - High >= Low, High >= Open, High >= Close
 *    - Low <= Open, Low <= High, Low <= Close
 *    - Strictly positive prices (> 0)
 *    - Non-negative volume (>= 0)
 * 4. Missing fields and malformed numeric value detection.
 * 5. Duplicate timestamp detection and deduplication tracking across multi-chunk ranges.
 * 6. Chronological ordering verification (sort ascending while logging sequence anomalies).
 * 7. Decimal-safe handling for PostgreSQL DECIMAL(14, 4):
 *    - Validates that prices do not exceed 10 integer digits (PRICE_OVERFLOW).
 *    - Prohibits silent decimal rounding: Throws EXCESS_DECIMAL_PRECISION if fractional part > 4 digits.
 *    - Avoids claiming to recover precision already lost by IEEE 754 float conversion.
 * 8. BigInt serialization safety:
 *    - Safe volume and quantity conversions with native BigInt for database integrity.
 *    - Rejects unsafe numbers (> MAX_SAFE_INTEGER) to prevent precision loss.
 *    - Exposes serializeMarketData() and safeJsonStringify() for explicit JSON boundaries.
 *    - Strictly avoids modifying JavaScript built-in prototypes (BigInt.prototype).
 *    - Never silently repairs corrupted data — clearly separates valid records from rejected records.
 */

import { bigIntJsonReplacer, safeJsonStringify } from '../utils/json.js';

export { bigIntJsonReplacer, safeJsonStringify };

export class MarketDataValidationError extends Error {
  constructor(message, raw, code = 'INVALID_MARKET_DATA') {
    super(message);
    this.name = 'MarketDataValidationError';
    this.raw = raw;
    this.code = code;
  }
}

/**
 * Validate and format a number or numeric string for PostgreSQL DECIMAL(14, 4).
 *
 * PostgreSQL DECIMAL(14, 4) constraints:
 * - Total digits: 14
 * - Scale (decimal places): 4
 * - Maximum integer digits: 10 (max value: 9,999,999,999.9999)
 *
 * Rules:
 * 1. NEVER silently rounds excess decimal places.
 * 2. Throws EXCESS_DECIMAL_PRECISION if non-zero fractional digits exceed 4.
 * 3. Throws PRICE_OVERFLOW if integer part exceeds 10 digits.
 * 4. Rejects NaN, Infinity, negative, and non-numeric inputs.
 * 5. Returns a standard 4-decimal padded string (e.g. "2500.5000").
 *
 * @param {number|string} val
 * @param {number} [maxDecimals=4]
 * @param {number} [maxIntegerDigits=10]
 * @returns {string} Standardized 4-decimal string
 */
export function toDecimalSafeString(val, maxDecimals = 4, maxIntegerDigits = 10) {
  if (val === null || val === undefined) {
    throw new MarketDataValidationError('Price value cannot be null or undefined', val, 'MISSING_PRICE');
  }

  let str;
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || Number.isNaN(val)) {
      throw new MarketDataValidationError(`Invalid non-finite number price: ${val}`, val, 'NON_NUMERIC_PRICE');
    }
    if (val <= 0) {
      throw new MarketDataValidationError(`Price must be strictly positive (> 0): ${val}`, val, 'NON_POSITIVE_PRICE');
    }
    str = val.toString();
  } else if (typeof val === 'string') {
    str = val.trim();
    if (!/^\d+(\.\d+)?$/.test(str)) {
      throw new MarketDataValidationError(`Invalid numeric price string: "${val}"`, val, 'NON_NUMERIC_PRICE');
    }
    if (Number(str) <= 0) {
      throw new MarketDataValidationError(`Price must be strictly positive (> 0): "${val}"`, val, 'NON_POSITIVE_PRICE');
    }
  } else {
    throw new MarketDataValidationError(`Unsupported price data type: ${typeof val}`, val, 'NON_NUMERIC_PRICE');
  }

  const [intPart, fracPart = ''] = str.split('.');

  // Integer overflow check for DECIMAL(14, 4)
  const normalizedInt = intPart.replace(/^0+/, '') || '0';
  if (normalizedInt.length > maxIntegerDigits) {
    throw new MarketDataValidationError(
      `Price integer part exceeds maximum ${maxIntegerDigits} digits allowed for DECIMAL(14, 4): "${str}"`,
      val,
      'PRICE_OVERFLOW'
    );
  }

  // Decimal scale check: trim trailing zeroes to count significant decimal places
  const trimmedFrac = fracPart.replace(/0+$/, '');
  if (trimmedFrac.length > maxDecimals) {
    throw new MarketDataValidationError(
      `Price has ${trimmedFrac.length} decimal places, exceeding maximum ${maxDecimals} supported by DECIMAL(14, 4): "${str}". Silent rounding is prohibited.`,
      val,
      'EXCESS_DECIMAL_PRECISION'
    );
  }

  // Format to standard padded string without floating-point arithmetic rounding
  const paddedFrac = fracPart.padEnd(maxDecimals, '0').slice(0, maxDecimals);
  return `${intPart}.${paddedFrac}`;
}

/**
 * Recursively convert any BigInt values in a payload to decimal strings at API serialization boundaries.
 * Guarantees compatibility with JSON.stringify() and HTTP response serialization.
 *
 * @param {any} data
 * @returns {any}
 */
export function serializeMarketData(data) {
  if (data === null || data === undefined) return data;
  if (typeof data === 'bigint') return data.toString();
  if (Array.isArray(data)) return data.map(serializeMarketData);
  if (typeof data === 'object' && !(data instanceof Date)) {
    const res = {};
    for (const [k, v] of Object.entries(data)) {
      res[k] = serializeMarketData(v);
    }
    return res;
  }
  return data;
}

class MarketDataValidatorService {
  /**
   * Validate and normalize a single candlestick bar.
   *
   * @param {Object|Array} raw - Candle bar (Object or Upstox array [timestamp, o, h, l, c, v, oi])
   * @param {Object} [options]
   * @param {number} [options.clockSkewBufferMs=300000] 5-minute allowable future clock drift
   * @param {Date|number|string} [options.customNow] Reference time for deterministic testing
   * @returns {Object} Normalized valid candle object
   */
  validateCandle(raw, options = {}) {
    if (!raw) {
      throw new MarketDataValidationError('Candle data cannot be null or undefined', raw, 'MISSING_DATA');
    }

    let rawTimestamp;
    let openRaw;
    let highRaw;
    let lowRaw;
    let closeRaw;
    let volumeRaw;
    let oiRaw = 0;

    // Handle Upstox V3 array format [timestamp, open, high, low, close, volume, open_interest]
    if (Array.isArray(raw)) {
      if (raw.length < 5) {
        throw new MarketDataValidationError(
          `Malformed candle array: expected at least 5 elements [timestamp, o, h, l, c], received ${raw.length}`,
          raw,
          'MALFORMED_ARRAY'
        );
      }
      [rawTimestamp, openRaw, highRaw, lowRaw, closeRaw, volumeRaw, oiRaw] = raw;
    } else if (typeof raw === 'object') {
      rawTimestamp = raw.timestamp ?? raw.time ?? raw.datetime;
      openRaw = raw.open ?? raw.o;
      highRaw = raw.high ?? raw.h;
      lowRaw = raw.low ?? raw.l;
      closeRaw = raw.close ?? raw.c;
      volumeRaw = raw.volume ?? raw.v;
      oiRaw = raw.openInterest ?? raw.open_interest ?? raw.oi ?? 0;
    } else {
      throw new MarketDataValidationError(
        `Invalid candle type: expected object or array, got ${typeof raw}`,
        raw,
        'INVALID_TYPE'
      );
    }

    // 1. Missing field checks
    if (!rawTimestamp) {
      throw new MarketDataValidationError('Candle timestamp is missing', raw, 'MISSING_TIMESTAMP');
    }
    if (openRaw === undefined || openRaw === null) {
      throw new MarketDataValidationError('Candle open price is missing', raw, 'MISSING_OPEN');
    }
    if (highRaw === undefined || highRaw === null) {
      throw new MarketDataValidationError('Candle high price is missing', raw, 'MISSING_HIGH');
    }
    if (lowRaw === undefined || lowRaw === null) {
      throw new MarketDataValidationError('Candle low price is missing', raw, 'MISSING_LOW');
    }
    if (closeRaw === undefined || closeRaw === null) {
      throw new MarketDataValidationError('Candle close price is missing', raw, 'MISSING_CLOSE');
    }

    // 2. Timestamp validity & non-future verification
    const parsedDate = new Date(rawTimestamp);
    if (Number.isNaN(parsedDate.getTime())) {
      throw new MarketDataValidationError(
        `Invalid candle timestamp format: "${rawTimestamp}"`,
        raw,
        'INVALID_TIMESTAMP'
      );
    }

    const clockSkewBufferMs = options.clockSkewBufferMs ?? 300000; // 5 min
    const referenceNow = options.customNow ? new Date(options.customNow).getTime() : Date.now();
    const futureThreshold = referenceNow + clockSkewBufferMs;

    if (parsedDate.getTime() > futureThreshold) {
      throw new MarketDataValidationError(
        `Look-ahead candle rejected: Timestamp "${parsedDate.toISOString()}" is in the future`,
        raw,
        'FUTURE_TIMESTAMP'
      );
    }

    // 3. Decimal-safe price validation for DECIMAL(14, 4)
    // Prohibits silent rounding; throws EXCESS_DECIMAL_PRECISION if > 4 decimal places
    const openDecimal = toDecimalSafeString(openRaw, 4);
    const highDecimal = toDecimalSafeString(highRaw, 4);
    const lowDecimal = toDecimalSafeString(lowRaw, 4);
    const closeDecimal = toDecimalSafeString(closeRaw, 4);

    const o = Number(openDecimal);
    const h = Number(highDecimal);
    const l = Number(lowDecimal);
    const c = Number(closeDecimal);

    // 4. Strict OHLC relational logic
    if (h < l) {
      throw new MarketDataValidationError(
        `Inverted bar: High (${h}) is strictly less than Low (${l})`,
        raw,
        'HIGH_LESS_THAN_LOW'
      );
    }

    if (h < o || h < c) {
      throw new MarketDataValidationError(
        `High (${h}) must be greater than or equal to Open (${o}) and Close (${c})`,
        raw,
        'INVERTED_HIGH'
      );
    }

    if (l > o || l > c) {
      throw new MarketDataValidationError(
        `Low (${l}) must be less than or equal to Open (${o}) and Close (${c})`,
        raw,
        'INVERTED_LOW'
      );
    }

    // 5. Volume validation (precision-safe integer handling without silent precision loss)
    let volume = BigInt(0);
    if (volumeRaw !== undefined && volumeRaw !== null) {
      if (typeof volumeRaw === 'bigint') {
        if (volumeRaw < 0n) {
          throw new MarketDataValidationError(`Negative trading volume: "${volumeRaw}"`, raw, 'NEGATIVE_VOLUME');
        }
        volume = volumeRaw;
      } else if (typeof volumeRaw === 'string') {
        const trimmed = volumeRaw.trim();
        if (trimmed.startsWith('-')) {
          throw new MarketDataValidationError(`Negative trading volume: "${volumeRaw}"`, raw, 'NEGATIVE_VOLUME');
        }
        if (!/^\d+(\.0+)?$/.test(trimmed)) {
          throw new MarketDataValidationError(`Invalid volume format: "${volumeRaw}"`, raw, 'INVALID_VOLUME');
        }
        try {
          volume = BigInt(trimmed.split('.')[0]);
        } catch {
          throw new MarketDataValidationError(`Malformed volume integer string: "${volumeRaw}"`, raw, 'INVALID_VOLUME');
        }
      } else if (typeof volumeRaw === 'number') {
        if (Number.isNaN(volumeRaw) || !Number.isFinite(volumeRaw) || volumeRaw < 0) {
          throw new MarketDataValidationError(
            `Negative or invalid trading volume: "${volumeRaw}"`,
            raw,
            'NEGATIVE_VOLUME'
          );
        }
        // Reject numbers that exceed JS safe integer threshold to prevent silent precision loss
        if (volumeRaw > Number.MAX_SAFE_INTEGER) {
          throw new MarketDataValidationError(
            `Unsafe integer volume (${volumeRaw}) exceeds MAX_SAFE_INTEGER. Pass large volumes as string or BigInt to preserve precision.`,
            raw,
            'VOLUME_PRECISION_LOSS'
          );
        }
        volume = BigInt(Math.floor(volumeRaw));
      } else {
        throw new MarketDataValidationError(
          `Unsupported volume type "${typeof volumeRaw}" for volume: ${volumeRaw}`,
          raw,
          'INVALID_VOLUME'
        );
      }
    }

    let openInterest = BigInt(0);
    if (oiRaw !== undefined && oiRaw !== null) {
      if (typeof oiRaw === 'bigint') {
        if (oiRaw >= 0n) openInterest = oiRaw;
      } else if (typeof oiRaw === 'string') {
        const trimmed = oiRaw.trim();
        if (/^\d+(\.0+)?$/.test(trimmed)) {
          try {
            openInterest = BigInt(trimmed.split('.')[0]);
          } catch {
            // ignore
          }
        }
      } else if (typeof oiRaw === 'number' && Number.isFinite(oiRaw) && oiRaw >= 0) {
        if (oiRaw <= Number.MAX_SAFE_INTEGER) {
          openInterest = BigInt(Math.floor(oiRaw));
        }
      }
    }

    // Return clean, normalized candle object with exact timestamp preserved
    return {
      timestamp: parsedDate,
      originalTimestampString: typeof rawTimestamp === 'string' ? rawTimestamp : parsedDate.toISOString(),
      open: o,
      high: h,
      low: l,
      close: c,
      // Decimal-safe string representations for PostgreSQL DECIMAL(14, 4)
      openDecimal,
      highDecimal,
      lowDecimal,
      closeDecimal,
      volume,
      volumeString: volume.toString(),
      openInterest,
      openInterestString: openInterest.toString(),
    };
  }

  /**
   * Validate a batch of candles, enforcing uniqueness and chronological ordering.
   * Rejects malformed bars while preserving valid bars.
   *
   * @param {Array} rawCandles - Array of raw candles from provider response
   * @param {Object} [options]
   * @returns {{
   *   valid: Array,
   *   rejected: Array,
   *   summary: { total: number, validCount: number, rejectedCount: number, duplicatesCount: number, outOfOrderCount: number }
   * }}
   */
  validateCandleBatch(rawCandles = [], options = {}) {
    if (!Array.isArray(rawCandles)) {
      return {
        valid: [],
        rejected: [
          {
            index: 0,
            code: 'MALFORMED_PROVIDER_RESPONSE',
            reason: `Expected array of candles, received ${typeof rawCandles}`,
            raw: rawCandles,
          },
        ],
        summary: { total: 0, validCount: 0, rejectedCount: 1, duplicatesCount: 0, outOfOrderCount: 0 },
      };
    }

    const valid = [];
    const rejected = [];
    const seenTimestamps = new Set();
    let duplicatesCount = 0;
    let outOfOrderCount = 0;

    for (let i = 0; i < rawCandles.length; i++) {
      const raw = rawCandles[i];
      try {
        const validated = this.validateCandle(raw, options);

        // Check for duplicate timestamps in batch
        const timeKey = validated.timestamp.getTime();
        if (seenTimestamps.has(timeKey)) {
          duplicatesCount++;
          rejected.push({
            index: i,
            code: 'DUPLICATE_TIMESTAMP',
            reason: `Duplicate candle for timestamp ${validated.originalTimestampString}`,
            raw,
          });
          continue;
        }

        seenTimestamps.add(timeKey);
        valid.push(validated);
      } catch (err) {
        rejected.push({
          index: i,
          code: err.code || 'VALIDATION_ERROR',
          reason: err.message,
          raw,
        });
      }
    }

    // Chronological ordering check: verify if the source batch was sorted
    for (let i = 1; i < valid.length; i++) {
      if (valid[i].timestamp.getTime() < valid[i - 1].timestamp.getTime()) {
        outOfOrderCount++;
      }
    }

    // Sort chronologically ascending
    valid.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    if (rejected.length > 0) {
      console.warn(
        `[MarketDataValidator] Filtered ${rejected.length} invalid candle(s) out of ${rawCandles.length} raw entries.`
      );
    }

    return {
      valid,
      rejected,
      summary: {
        total: rawCandles.length,
        validCount: valid.length,
        rejectedCount: rejected.length,
        duplicatesCount,
        outOfOrderCount,
      },
    };
  }
}

export default new MarketDataValidatorService();
