/**
 * Official Indian Equity Market (NSE / BSE) Trading Holidays for 2025 & 2026
 * (Excludes Muhurat trading special sessions)
 */
export const INDIAN_EXCHANGE_HOLIDAYS = {
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
  '2026-01-26': 'Republic Day',
  '2026-03-03': 'Holi',
  '2026-03-20': 'Id-Ul-Fitr (Ramadan Eid)',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr. Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day',
  '2026-05-27': 'Bakri Id (Id-Ul-Adha)',
  '2026-08-15': 'Independence Day',
  '2026-10-02': 'Mahatma Gandhi Jayanti',
  '2026-10-20': 'Dussehra',
  '2026-11-08': 'Diwali Laxmi Pujan',
  '2026-11-10': 'Diwali Balipratipada',
  '2026-11-24': 'Gurunanak Jayanti',
  '2026-12-25': 'Christmas',
};

/**
 * Utility to determine current Indian Market trading session (NSE / BSE)
 * in Asia/Kolkata timezone (UTC+05:30).
 */
export function getIndianMarketStatus(referenceDate = new Date()) {
  const istFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = istFormatter.formatToParts(referenceDate);
  const partMap = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }

  const weekday = partMap.weekday; // 'Mon', 'Tue', ... 'Sat', 'Sun'
  const hour = parseInt(partMap.hour, 10);
  const minute = parseInt(partMap.minute, 10);
  const totalMinutes = hour * 60 + minute;

  const dateKey = `${partMap.year}-${partMap.month}-${partMap.day}`;
  const holidayName = INDIAN_EXCHANGE_HOLIDAYS[dateKey];

  const isWeekend = weekday === 'Sat' || weekday === 'Sun';

  // 09:00 to 09:15 IST is Pre-Market
  const preMarketStart = 9 * 60;
  // 09:15 to 15:30 IST is Regular Trading Session
  const regularStart = 9 * 60 + 15;
  const regularEnd = 15 * 60 + 30;

  const pad = (n) => String(n).padStart(2, '0');
  const timeString = `${pad(hour)}:${pad(minute)} IST`;

  if (holidayName) {
    return {
      isOpen: false,
      isPreMarket: false,
      isHoliday: true,
      holidayName,
      session: 'CLOSED',
      label: 'MARKET CLOSED',
      sublabel: `Exchange Holiday (${holidayName})`,
      timeString,
      weekday,
    };
  }

  if (isWeekend) {
    return {
      isOpen: false,
      isPreMarket: false,
      isHoliday: false,
      session: 'CLOSED',
      label: 'MARKET CLOSED',
      sublabel: 'Weekend — Opens Mon 09:15 IST',
      timeString,
      weekday,
    };
  }

  if (totalMinutes >= regularStart && totalMinutes < regularEnd) {
    return {
      isOpen: true,
      isPreMarket: false,
      session: 'OPEN',
      label: 'MARKET OPEN',
      sublabel: 'Live Session (09:15 - 15:30 IST)',
      timeString,
      weekday,
    };
  }

  if (totalMinutes >= preMarketStart && totalMinutes < regularStart) {
    return {
      isOpen: false,
      isPreMarket: true,
      session: 'PRE_MARKET',
      label: 'PRE-MARKET',
      sublabel: 'Pre-Open Call Auction (09:00 - 09:15 IST)',
      timeString,
      weekday,
    };
  }

  return {
    isOpen: false,
    isPreMarket: false,
    session: 'CLOSED',
    label: 'MARKET CLOSED',
    sublabel: totalMinutes < preMarketStart ? 'Opens Today at 09:15 IST' : 'Closed — Opens Next Session',
    timeString,
    weekday,
  };
}
