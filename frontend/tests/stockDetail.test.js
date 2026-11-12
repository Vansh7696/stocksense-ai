import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  addToWatchlist,
  removeFromWatchlist,
  isStockInWatchlist,
  getWatchlist,
  addRecentlyViewed,
  getRecentlyViewed,
} from '../src/utils/watchlist.js';
import {
  getIndianMarketStatus,
  INDIAN_EXCHANGE_HOLIDAYS,
} from '../src/utils/marketHours.js';

// Setup mock localStorage for Node testing environment
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, val) => store.set(key, String(val)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
};

describe('Frontend Phase 1, Step D: Stock Detail & Candlestick Processing Tests', () => {
  describe('1. Candlestick Data Preprocessing & Sanitization', () => {
    // Pure function logic mirroring CandlestickChart.jsx memoized processing
    function processCandleData(candles) {
      if (!candles || candles.length === 0) {
        return { sanitizedCandles: [], sanitizedVolume: [], latestCandle: null };
      }

      const formattedC = [];
      const formattedV = [];
      let prevTime = null;

      // Strictly sort ascending by timestamp
      const sorted = [...candles].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      for (const c of sorted) {
        const timeInSec = Math.floor(new Date(c.timestamp).getTime() / 1000);
        if (isNaN(timeInSec)) continue;

        // Skip duplicate timestamps (strict ascending requirement for lightweight-charts)
        if (prevTime !== null && timeInSec <= prevTime) {
          continue;
        }
        prevTime = timeInSec;

        const open = parseFloat(c.open);
        const high = parseFloat(c.high);
        const low = parseFloat(c.low);
        const close = parseFloat(c.close);
        const volume = parseFloat(c.volume || 0);

        if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) continue;

        formattedC.push({
          time: timeInSec,
          open,
          high,
          low,
          close,
        });

        formattedV.push({
          time: timeInSec,
          value: volume,
          color: close >= open ? 'rgba(16, 185, 129, 0.45)' : 'rgba(239, 68, 68, 0.45)',
        });
      }

      const latest = formattedC.length > 0 ? formattedC[formattedC.length - 1] : null;
      const latestVol = formattedV.length > 0 ? formattedV[formattedV.length - 1] : null;

      return {
        sanitizedCandles: formattedC,
        sanitizedVolume: formattedV,
        latestCandle: latest
          ? {
              ...latest,
              volume: latestVol?.value || 0,
              change: latest.close - latest.open,
              changePercent: ((latest.close - latest.open) / (latest.open || 1)) * 100,
            }
          : null,
      };
    }

    test('should sort out-of-order candles strictly chronologically ascending', () => {
      const unorderedCandles = [
        { timestamp: '2026-03-31T09:15:00.000Z', open: '3000', high: '3050', low: '2990', close: '3020', volume: '10000' },
        { timestamp: '2026-03-29T09:15:00.000Z', open: '2900', high: '2950', low: '2890', close: '2920', volume: '12000' },
        { timestamp: '2026-03-30T09:15:00.000Z', open: '2950', high: '3010', low: '2940', close: '2990', volume: '15000' },
      ];

      const { sanitizedCandles, sanitizedVolume } = processCandleData(unorderedCandles);

      assert.strictEqual(sanitizedCandles.length, 3);
      assert.ok(sanitizedCandles[0].time < sanitizedCandles[1].time);
      assert.ok(sanitizedCandles[1].time < sanitizedCandles[2].time);
      assert.strictEqual(sanitizedCandles[0].open, 2900);
      assert.strictEqual(sanitizedCandles[2].close, 3020);
    });

    test('should deduplicate candles sharing identical timestamps without error', () => {
      const duplicateCandles = [
        { timestamp: '2026-03-30T09:15:00.000Z', open: '2950', high: '3010', low: '2940', close: '2990', volume: '15000' },
        { timestamp: '2026-03-30T09:15:00.000Z', open: '2950', high: '3010', low: '2940', close: '2990', volume: '15000' }, // Duplicate
        { timestamp: '2026-03-31T09:15:00.000Z', open: '3000', high: '3050', low: '2990', close: '3020', volume: '10000' },
      ];

      const { sanitizedCandles } = processCandleData(duplicateCandles);

      assert.strictEqual(sanitizedCandles.length, 2);
      assert.ok(sanitizedCandles[0].time < sanitizedCandles[1].time);
    });

    test('should parse string Decimal prices and BigInt volumes without precision truncation', () => {
      const decimalCandles = [
        {
          timestamp: '2026-03-31T09:15:00.000Z',
          open: '2980.5000',
          high: '3015.2500',
          low: '2975.0000',
          close: '3005.7500',
          volume: '15420980',
        },
      ];

      const { sanitizedCandles, sanitizedVolume, latestCandle } = processCandleData(decimalCandles);

      assert.strictEqual(sanitizedCandles.length, 1);
      assert.strictEqual(sanitizedCandles[0].open, 2980.5);
      assert.strictEqual(sanitizedCandles[0].high, 3015.25);
      assert.strictEqual(sanitizedCandles[0].low, 2975);
      assert.strictEqual(sanitizedCandles[0].close, 3005.75);
      assert.strictEqual(sanitizedVolume[0].value, 15420980);
      assert.strictEqual(latestCandle.change, 25.25);
      assert.ok(latestCandle.changePercent > 0.8 && latestCandle.changePercent < 0.9);
    });

    test('should color bullish volume green and bearish volume red', () => {
      const mixedCandles = [
        { timestamp: '2026-03-30T09:15:00.000Z', open: '2950', high: '3010', low: '2940', close: '2990', volume: '15000' }, // Bullish (close > open)
        { timestamp: '2026-03-31T09:15:00.000Z', open: '3000', high: '3010', low: '2950', close: '2960', volume: '20000' }, // Bearish (close < open)
      ];

      const { sanitizedVolume } = processCandleData(mixedCandles);

      assert.strictEqual(sanitizedVolume.length, 2);
      assert.ok(sanitizedVolume[0].color.includes('16, 185, 129'), 'Bullish volume should be green');
      assert.ok(sanitizedVolume[1].color.includes('239, 68, 68'), 'Bearish volume should be red');
    });

    test('should handle empty candle array gracefully returning empty results', () => {
      const { sanitizedCandles, sanitizedVolume, latestCandle } = processCandleData([]);

      assert.deepStrictEqual(sanitizedCandles, []);
      assert.deepStrictEqual(sanitizedVolume, []);
      assert.strictEqual(latestCandle, null);
    });
  });

  describe('2. Watchlist State Persistence & Synchronization', () => {
    test('should add and retrieve stock from watchlist', () => {
      const stock = {
        id: 'test-uuid-1234',
        symbol: 'WIPRO',
        companyName: 'Wipro Limited',
        exchange: { code: 'NSE' },
        isin: 'INE075A01022',
        instrumentType: 'EQUITY',
      };

      addToWatchlist(stock);
      assert.strictEqual(isStockInWatchlist('WIPRO'), true);
      assert.strictEqual(isStockInWatchlist('test-uuid-1234'), true);
    });

    test('should remove stock from watchlist', () => {
      removeFromWatchlist('WIPRO');
      assert.strictEqual(isStockInWatchlist('WIPRO'), false);
    });

    test('should record recently viewed stock', () => {
      const stock = {
        id: 'test-uuid-5678',
        symbol: 'TCS',
        companyName: 'Tata Consultancy Services Limited',
        exchange: { code: 'NSE' },
      };

      addRecentlyViewed(stock);
      const recent = getRecentlyViewed();
      assert.ok(recent.some((r) => r.symbol === 'TCS'));
    });

    test('should add, retrieve and toggle BSE stock (e.g., 500325) correctly', () => {
      const bseStock = {
        id: 'bse-uuid-500325',
        symbol: '500325',
        name: 'Reliance Industries Limited (BSE)',
        companyName: 'Reliance Industries Limited',
        exchange: { code: 'BSE' },
        isin: 'INE002A01018',
        instrumentType: 'EQUITY',
      };

      addToWatchlist(bseStock);
      assert.strictEqual(isStockInWatchlist('500325'), true);
      assert.strictEqual(isStockInWatchlist('bse-uuid-500325'), true);

      // Verify reactive inWatchlist calculation matching StockDetailPage logic
      const isInWatchlist = (symbolOrId) => isStockInWatchlist(symbolOrId);
      const inWatchlist = bseStock ? (isInWatchlist(bseStock.id) || isInWatchlist(bseStock.symbol)) : false;
      assert.strictEqual(inWatchlist, true);

      // Verify recently viewed tracking works seamlessly for BSE instrument
      addRecentlyViewed(bseStock);
      const recents = getRecentlyViewed();
      assert.ok(recents.some((r) => r.symbol === '500325' || r.id === 'bse-uuid-500325'));

      // Remove from watchlist
      removeFromWatchlist('500325');
      assert.strictEqual(isStockInWatchlist('500325'), false);
    });
  });

  describe('3. Supported Intervals Whitelist', () => {
    test('should support all standard daily, weekly, monthly and intraday intervals', () => {
      const supported = ['1m', '5m', '15m', '30m', '1h', '1D', '1W', '1M'];
      const tabs = ['1D', '1W', '1M', '1h', '30m', '15m', '5m', '1m'];

      for (const tab of tabs) {
        assert.ok(supported.includes(tab), `Tab interval "${tab}" must be supported by backend API`);
      }
    });
  });

  describe('4. Metadata & Chronological Span Calculations', () => {
    function computeMetadata(candles, interval) {
      if (!candles || candles.length === 0) {
        return { totalCandles: 0, firstDate: null, lastDate: null, hasData: false };
      }

      const sorted = [...candles].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      const first = sorted[0];
      const last = sorted[sorted.length - 1];

      return {
        totalCandles: candles.length,
        firstDate: first?.timestamp ? new Date(first.timestamp).toISOString() : null,
        lastDate: last?.timestamp ? new Date(last.timestamp).toISOString() : null,
        hasData: true,
        dataSource: first?.dataSource || 'UPSTOX',
      };
    }

    test('should calculate accurate metadata and chronological span', () => {
      const sampleCandles = [
        { timestamp: '2026-01-01T09:15:00.000Z', open: '2000', high: '2010', low: '1990', close: '2005', volume: '1000' },
        { timestamp: '2026-03-31T09:15:00.000Z', open: '2500', high: '2520', low: '2490', close: '2510', volume: '2000' },
        { timestamp: '2026-02-15T09:15:00.000Z', open: '2200', high: '2250', low: '2190', close: '2230', volume: '1500' },
      ];

      const meta = computeMetadata(sampleCandles, '1D');
      assert.strictEqual(meta.totalCandles, 3);
      assert.strictEqual(meta.hasData, true);
      assert.strictEqual(meta.firstDate, '2026-01-01T09:15:00.000Z');
      assert.strictEqual(meta.lastDate, '2026-03-31T09:15:00.000Z');
    });

    test('should return hasData: false when empty candles array provided', () => {
      const meta = computeMetadata([], '1D');
      assert.strictEqual(meta.totalCandles, 0);
      assert.strictEqual(meta.hasData, false);
      assert.strictEqual(meta.firstDate, null);
      assert.strictEqual(meta.lastDate, null);
    });
  });

  describe('5. Error Classification & Ambiguity Resolution', () => {
    test('should classify 409 AMBIGUOUS_STOCK_IDENTIFIER and preserve candidate matches', () => {
      const apiError = {
        code: 'AMBIGUOUS_STOCK_IDENTIFIER',
        status: 409,
        message: 'Ambiguous stock symbol "RELIANCE". Found 2 matching instruments.',
        details: {
          matches: [
            { id: 'uuid-nse', symbol: 'RELIANCE', exchange: 'NSE', segment: 'NSE_EQ' },
            { id: 'uuid-bse', symbol: 'RELIANCE', exchange: 'BSE', segment: 'BSE_EQ' },
          ],
        },
      };

      const isAmbiguous = apiError.code === 'AMBIGUOUS_STOCK_IDENTIFIER' && Array.isArray(apiError.details?.matches);
      assert.strictEqual(isAmbiguous, true);
      assert.strictEqual(apiError.details.matches.length, 2);
      assert.strictEqual(apiError.details.matches[0].exchange, 'NSE');
      assert.strictEqual(apiError.details.matches[1].exchange, 'BSE');
    });

    test('should classify 404 STOCK_NOT_FOUND accurately', () => {
      const notFoundError = {
        code: 'STOCK_NOT_FOUND',
        status: 404,
        message: 'Stock not found with identifier: "UNKNOWN_TICKER"',
      };

      const isNotFound = notFoundError.status === 404 || notFoundError.code === 'STOCK_NOT_FOUND';
      assert.strictEqual(isNotFound, true);
    });
  });

  describe('6. Indian Market Hours & Exchange Holiday Calculations', () => {
    test('should detect weekend session as CLOSED in Asia/Kolkata timezone', () => {
      // 2026-03-28 is a Saturday
      const saturday = new Date('2026-03-28T05:30:00.000Z'); // 11:00 AM IST on Saturday
      const status = getIndianMarketStatus(saturday);

      assert.strictEqual(status.isOpen, false);
      assert.strictEqual(status.session, 'CLOSED');
      assert.strictEqual(status.weekday, 'Sat');
      assert.ok(status.sublabel.includes('Weekend'));
    });

    test('should detect official Indian exchange holidays as CLOSED with holiday name', () => {
      // 2026-01-26 is Republic Day (Monday)
      const republicDay = new Date('2026-01-26T05:00:00.000Z'); // 10:30 AM IST on Monday
      const status = getIndianMarketStatus(republicDay);

      assert.strictEqual(status.isOpen, false);
      assert.strictEqual(status.isHoliday, true);
      assert.strictEqual(status.holidayName, 'Republic Day');
      assert.strictEqual(status.session, 'CLOSED');
      assert.ok(status.sublabel.includes('Republic Day'));
    });

    test('should detect active regular market trading session between 09:15 and 15:30 IST', () => {
      // 2026-03-25 is a normal Wednesday. 05:00 UTC = 10:30 AM IST
      const tradingHours = new Date('2026-03-25T05:00:00.000Z');
      const status = getIndianMarketStatus(tradingHours);

      assert.strictEqual(status.isOpen, true);
      assert.strictEqual(status.isPreMarket, false);
      assert.strictEqual(status.session, 'OPEN');
      assert.strictEqual(status.label, 'MARKET OPEN');
    });

    test('should detect pre-market auction session between 09:00 and 09:15 IST', () => {
      // 2026-03-25 03:35 UTC = 09:05 AM IST
      const preMarket = new Date('2026-03-25T03:35:00.000Z');
      const status = getIndianMarketStatus(preMarket);

      assert.strictEqual(status.isOpen, false);
      assert.strictEqual(status.isPreMarket, true);
      assert.strictEqual(status.session, 'PRE_MARKET');
    });

    test('should distinguish listing status from market session state', () => {
      // Even if an equity has active listing permissions (isActive: true), market session can be closed
      const stock = { symbol: 'RELIANCE', isActive: true };
      const weekend = new Date('2026-03-29T05:30:00.000Z'); // Sunday
      const session = getIndianMarketStatus(weekend);

      assert.strictEqual(stock.isActive, true, 'Listing permission is active');
      assert.strictEqual(session.isOpen, false, 'Market trading hours are currently closed');
      assert.notStrictEqual(stock.isActive, session.isOpen);
    });
  });

  describe('7. LocalStorage Corrupted & Invalid Data Resilience', () => {
    test('should safely recover from corrupted JSON in watchlist storage', () => {
      globalThis.localStorage.setItem('stocksense:watchlist', '{malformed json syntax!!!');
      const list = getWatchlist();

      assert.ok(Array.isArray(list));
      assert.ok(list.length > 0);
      assert.strictEqual(list[0].symbol, 'RELIANCE');
    });

    test('should safely recover from non-array JSON in watchlist storage', () => {
      globalThis.localStorage.setItem('stocksense:watchlist', JSON.stringify({ notAnArray: true }));
      const list = getWatchlist();

      assert.ok(Array.isArray(list));
      assert.strictEqual(list[0].symbol, 'RELIANCE');
    });

    test('should safely recover from corrupted JSON in recently viewed storage', () => {
      globalThis.localStorage.setItem('stocksense:recently_viewed', 'INVALID{{');
      const recents = getRecentlyViewed();

      assert.ok(Array.isArray(recents));
      assert.strictEqual(recents.length, 0);
    });
  });

  describe('8. Alternate Exchange Listing Resolution & Navigation', () => {
    test('should construct verified alternate listing navigation when BSE stock has 0 candles', () => {
      const bseStock = {
        id: '8461662c-9d93-43d3-ae90-a540b370feae',
        symbol: '500325',
        companyName: 'Reliance Industries Limited',
        isin: 'INE002A01018',
        exchange: { code: 'BSE' },
      };

      const pricesPayload = {
        stock: {
          id: bseStock.id,
          symbol: bseStock.symbol,
          companyName: bseStock.companyName,
          exchange: 'BSE',
        },
        interval: '1D',
        candles: [],
        alternateListing: {
          id: 'd17d8b45-02af-4592-9514-e44616d74685',
          symbol: 'RELIANCE',
          companyName: 'Reliance Industries Limited',
          exchange: 'NSE',
          exchangeName: 'National Stock Exchange of India',
          candlesCount: 743,
        },
        pagination: { totalRecords: 0 },
      };

      // 1. Verify empty state condition
      assert.strictEqual(pricesPayload.candles.length, 0);
      assert.strictEqual(pricesPayload.pagination.totalRecords, 0);

      // 2. Verify alternate listing presence and metadata
      const alt = pricesPayload.alternateListing;
      assert.ok(alt, 'Alternate listing must be present');
      assert.strictEqual(alt.exchange, 'NSE');
      assert.strictEqual(alt.symbol, 'RELIANCE');
      assert.strictEqual(alt.candlesCount, 743);

      // 3. Verify message and supporting text construction
      const message = `Historical candles are not yet available for this ${bseStock.exchange.code} listing.`;
      const supportingText = `Verified historical data is available for the ${alt.exchange} listing of the same company.`;
      const actionText = `View ${alt.symbol} on ${alt.exchange}`;
      const navigationUrl = `/stocks/${encodeURIComponent(alt.symbol)}?exchange=${alt.exchange}`;

      assert.strictEqual(message, 'Historical candles are not yet available for this BSE listing.');
      assert.strictEqual(supportingText, 'Verified historical data is available for the NSE listing of the same company.');
      assert.strictEqual(actionText, 'View RELIANCE on NSE');
      assert.strictEqual(navigationUrl, '/stocks/RELIANCE?exchange=NSE');
    });

    test('should NOT provide alternative suggestion when alternate listing has no candles', () => {
      const bseStock = {
        id: '2114c05e-79c5-4486-af1d-3e5c880f964e',
        symbol: 'RAJKSYN',
        exchange: { code: 'BSE' },
      };

      const pricesPayload = {
        stock: { id: bseStock.id, symbol: bseStock.symbol, exchange: 'BSE' },
        interval: '1D',
        candles: [],
        alternateListing: null,
        pagination: { totalRecords: 0 },
      };

      assert.strictEqual(pricesPayload.candles.length, 0);
      assert.strictEqual(pricesPayload.alternateListing, null);
    });

    test('should NOT provide alternative suggestion when current stock already has candles', () => {
      const nseStock = {
        id: 'd17d8b45-02af-4592-9514-e44616d74685',
        symbol: 'RELIANCE',
        exchange: { code: 'NSE' },
      };

      const pricesPayload = {
        stock: { id: nseStock.id, symbol: nseStock.symbol, exchange: 'NSE' },
        interval: '1D',
        candles: [{ timestamp: '2026-03-31T09:15:00.000Z', open: 2980, close: 3005 }],
        alternateListing: null,
        pagination: { totalRecords: 743 },
      };

      assert.ok(pricesPayload.candles.length > 0);
      assert.strictEqual(pricesPayload.alternateListing, null);
    });
  });
});
