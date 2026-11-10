/**
 * StockSense AI — Indian Equity Trading Calendar & Market Holidays
 *
 * Provides official NSE / BSE exchange holiday schedules (2021–2026),
 * weekend detection in Asia/Kolkata timezone (UTC+05:30), expected
 * trading-day calculation, and historical data gap analysis.
 */

export const INDIAN_EXCHANGE_HOLIDAYS = {
  // 2021 Holidays
  '2021-01-26': 'Republic Day',
  '2021-03-11': 'Mahashivratri',
  '2021-03-29': 'Holi',
  '2021-04-02': 'Good Friday',
  '2021-04-14': 'Dr. Ambedkar Jayanti',
  '2021-04-21': 'Ram Navami',
  '2021-04-25': 'Mahavir Jayanti',
  '2021-05-13': 'Id-Ul-Fitr',
  '2021-07-21': 'Bakri Id',
  '2021-08-19': 'Muharram',
  '2021-09-10': 'Ganesh Chaturthi',
  '2021-10-02': 'Mahatma Gandhi Jayanti',
  '2021-10-15': 'Dussehra',
  '2021-11-04': 'Diwali Laxmi Pujan',
  '2021-11-05': 'Diwali Balipratipada',
  '2021-11-19': 'Gurunanak Jayanti',

  // 2022 Holidays
  '2022-01-26': 'Republic Day',
  '2022-03-01': 'Mahashivratri',
  '2022-03-18': 'Holi',
  '2022-04-14': 'Dr. Ambedkar Jayanti / Mahavir Jayanti',
  '2022-04-15': 'Good Friday',
  '2022-05-03': 'Id-Ul-Fitr',
  '2022-08-09': 'Muharram',
  '2022-08-15': 'Independence Day',
  '2022-08-31': 'Ganesh Chaturthi',
  '2022-10-02': 'Mahatma Gandhi Jayanti',
  '2022-10-05': 'Dussehra',
  '2022-10-24': 'Diwali Laxmi Pujan',
  '2022-10-26': 'Diwali Balipratipada',
  '2022-11-08': 'Gurunanak Jayanti',

  // 2023 Holidays
  '2023-01-26': 'Republic Day',
  '2023-03-07': 'Holi',
  '2023-03-30': 'Ram Navami',
  '2023-04-04': 'Mahavir Jayanti',
  '2023-04-07': 'Good Friday',
  '2023-04-14': 'Dr. Ambedkar Jayanti',
  '2023-04-21': 'Id-Ul-Fitr',
  '2023-05-01': 'Maharashtra Day',
  '2023-06-29': 'Bakri Id',
  '2023-08-15': 'Independence Day',
  '2023-09-19': 'Ganesh Chaturthi',
  '2023-10-02': 'Mahatma Gandhi Jayanti',
  '2023-10-24': 'Dussehra',
  '2023-11-14': 'Diwali Balipratipada',
  '2023-11-27': 'Gurunanak Jayanti',
  '2023-12-25': 'Christmas',

  // 2024 Holidays
  '2024-01-22': 'Special Holiday (Ayodhya Pran Pratishtha)',
  '2024-01-26': 'Republic Day',
  '2024-03-08': 'Mahashivratri',
  '2024-03-25': 'Holi',
  '2024-03-29': 'Good Friday',
  '2024-04-11': 'Id-Ul-Fitr',
  '2024-04-17': 'Ram Navami',
  '2024-05-01': 'Maharashtra Day',
  '2024-05-20': 'General Elections (Mumbai Lok Sabha)',
  '2024-06-17': 'Bakri Id',
  '2024-07-17': 'Muharram',
  '2024-08-15': 'Independence Day',
  '2024-10-02': 'Mahatma Gandhi Jayanti',
  '2024-11-01': 'Diwali Laxmi Pujan',
  '2024-11-15': 'Gurunanak Jayanti',
  '2024-11-20': 'Maharashtra Assembly Elections',
  '2024-12-25': 'Christmas',

  // 2025 Holidays
  '2025-01-26': 'Republic Day',
  '2025-02-26': 'Mahashivratri',
  '2025-03-14': 'Holi',
  '2025-03-31': 'Id-Ul-Fitr',
  '2025-04-10': 'Mahavir Jayanti',
  '2025-04-14': 'Dr. Ambedkar Jayanti',
  '2025-04-18': 'Good Friday',
  '2025-05-01': 'Maharashtra Day',
  '2025-06-07': 'Bakri Id',
  '2025-08-15': 'Independence Day',
  '2025-08-27': 'Ganesh Chaturthi',
  '2025-10-02': 'Mahatma Gandhi Jayanti',
  '2025-10-21': 'Diwali Laxmi Pujan',
  '2025-10-22': 'Diwali Balipratipada',
  '2025-11-05': 'Gurunanak Jayanti',
  '2025-12-25': 'Christmas',

  // 2026 Holidays
  '2026-01-15': 'Municipal Corporation Election (Maharashtra)',
  '2026-01-26': 'Republic Day',
  '2026-03-03': 'Holi',
  '2026-03-26': 'Shri Ram Navami',
  '2026-03-31': 'Shri Mahavir Jayanti',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr. Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day',
  '2026-05-28': 'Bakri Id (Id-Ul-Adha)',
  '2026-06-26': 'Muharram',
  '2026-08-15': 'Independence Day',
  '2026-09-14': 'Ganesh Chaturthi',
  '2026-10-02': 'Mahatma Gandhi Jayanti',
  '2026-10-20': 'Dussehra',
  '2026-11-08': 'Diwali Laxmi Pujan',
  '2026-11-10': 'Diwali Balipratipada',
  '2026-11-24': 'Gurunanak Jayanti',
  '2026-12-25': 'Christmas',
};

/**
 * Converts a Date or YYYY-MM-DD string to a canonical YYYY-MM-DD in Asia/Kolkata timezone.
 *
 * @param {Date|string} dateOrStr
 * @returns {string} YYYY-MM-DD
 */
export function toKolkataDateString(dateOrStr) {
  if (typeof dateOrStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateOrStr)) {
    return dateOrStr;
  }
  const d = dateOrStr instanceof Date ? dateOrStr : new Date(dateOrStr);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Checks whether a given calendar date falls on a weekend (Saturday or Sunday)
 * in the Asia/Kolkata timezone.
 *
 * @param {Date|string} dateOrStr
 * @returns {boolean}
 */
export function isWeekend(dateOrStr) {
  let dateObj;
  if (typeof dateOrStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateOrStr)) {
    const [y, m, d] = dateOrStr.split('-').map(Number);
    // 12:00 UTC corresponds to 17:30 IST on the same calendar day
    dateObj = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  } else {
    dateObj = dateOrStr instanceof Date ? dateOrStr : new Date(dateOrStr);
  }

  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
  }).format(dateObj);

  return weekday === 'Sat' || weekday === 'Sun';
}

/**
 * Checks whether a given date is an official Indian exchange holiday.
 *
 * @param {Date|string} dateOrStr
 * @returns {string|null} Holiday description if holiday, null otherwise
 */
export function getExchangeHoliday(dateOrStr) {
  const dateKey = toKolkataDateString(dateOrStr);
  return INDIAN_EXCHANGE_HOLIDAYS[dateKey] || null;
}

/**
 * Determines whether a date is an official expected trading day on Indian exchanges.
 * A day is a trading day if and only if it is NOT a weekend and NOT an exchange holiday.
 *
 * @param {Date|string} dateOrStr
 * @returns {boolean}
 */
export function isTradingDay(dateOrStr) {
  if (isWeekend(dateOrStr)) {
    return false;
  }
  return !getExchangeHoliday(dateOrStr);
}

/**
 * Computes all expected trading days between fromDate and toDate (inclusive)
 * in chronological order.
 *
 * @param {string} fromDateStr - YYYY-MM-DD
 * @param {string} toDateStr - YYYY-MM-DD
 * @returns {Array<string>} Array of YYYY-MM-DD trading day strings
 */
export function getExpectedTradingDays(fromDateStr, toDateStr) {
  if (!fromDateStr || !toDateStr) return [];

  const [fromY, fromM, fromD] = fromDateStr.split('-').map(Number);
  const [toY, toM, toD] = toDateStr.split('-').map(Number);

  let cur = new Date(Date.UTC(fromY, fromM - 1, fromD, 12, 0, 0));
  const end = new Date(Date.UTC(toY, toM - 1, toD, 12, 0, 0));

  const tradingDays = [];

  while (cur <= end) {
    const dateStr = cur.toISOString().split('T')[0];
    if (isTradingDay(dateStr)) {
      tradingDays.push(dateStr);
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return tradingDays;
}

/**
 * Analyzes market candle coverage against expected Indian trading days.
 *
 * Identifies:
 * - Expected trading days count.
 * - Present candle days count.
 * - Missing trading days (expected trading day with no candle).
 * - Multi-day unexpected gaps (>= 2 consecutive missing trading days).
 * - Coverage percentage.
 *
 * @param {Array<string>} expectedTradingDays - Array of YYYY-MM-DD expected trading days
 * @param {Array<Date|string>} candleTimestamps - Array of actual candle timestamps
 * @returns {{
 *   expectedTradingDaysCount: number,
 *   actualCandlesCount: number,
 *   uniqueTradingDaysCount: number,
 *   missingTradingDaysCount: number,
 *   missingTradingDays: Array<string>,
 *   unexpectedGaps: Array<{ from: string, to: string, daysCount: number }>,
 *   coveragePercentage: number
 * }}
 */
export function analyzeCandleGaps(expectedTradingDays, candleTimestamps) {
  const actualDaySet = new Set();

  for (const ts of candleTimestamps) {
    if (!ts) continue;
    actualDaySet.add(toKolkataDateString(ts));
  }

  const missingTradingDays = [];
  const unexpectedGaps = [];
  let currentGap = [];

  for (const day of expectedTradingDays) {
    if (!actualDaySet.has(day)) {
      missingTradingDays.push(day);
      currentGap.push(day);
    } else {
      if (currentGap.length >= 2) {
        unexpectedGaps.push({
          from: currentGap[0],
          to: currentGap[currentGap.length - 1],
          daysCount: currentGap.length,
        });
      }
      currentGap = [];
    }
  }

  if (currentGap.length >= 2) {
    unexpectedGaps.push({
      from: currentGap[0],
      to: currentGap[currentGap.length - 1],
      daysCount: currentGap.length,
    });
  }

  const expectedCount = expectedTradingDays.length;
  const uniqueActualCount = expectedTradingDays.filter((d) => actualDaySet.has(d)).length;
  const coveragePercentage = expectedCount > 0
    ? Number(((uniqueActualCount / expectedCount) * 100).toFixed(2))
    : 100.0;

  return {
    expectedTradingDaysCount: expectedCount,
    actualCandlesCount: candleTimestamps.length,
    uniqueTradingDaysCount: uniqueActualCount,
    missingTradingDaysCount: missingTradingDays.length,
    missingTradingDays,
    unexpectedGaps,
    coveragePercentage,
  };
}
