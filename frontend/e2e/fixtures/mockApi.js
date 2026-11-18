/**
 * StockSense AI — E2E Controlled API Fixtures & Route Handlers
 * Simulates backend responses for deterministic browser automation testing.
 */

export const mockUser = {
  id: 'e2e-test-user-uuid',
  email: 'playwright.tester@stocksense.ai',
  fullName: 'Playwright E2E Tester',
  role: 'USER',
};

export const mockStockReliance = {
  id: '01931853-9bb6-74b0-a5fc-1b774b789001',
  symbol: 'RELIANCE',
  companyName: 'Reliance Industries Limited',
  exchange: { code: 'NSE', name: 'National Stock Exchange of India' },
  segment: 'EQUITY',
  instrumentType: 'EQUITY',
  isin: 'INE002A01018',
  isActive: true,
};

export const mockPredictions = {
  symbol: 'RELIANCE',
  stockId: '01931853-9bb6-74b0-a5fc-1b774b789001',
  exchange: 'NSE',
  asOfDate: '2026-07-13',
  latestCandleTimestamp: '2026-07-12T09:15:00.000Z',
  candlesUsed: 250,
  disclaimer: 'Statutory Disclaimer: Quantitative forecasts are strictly for educational purposes.',
  totalExecutionTimeMs: 12.5,
  predictions: {
    '1': {
      horizon: 1,
      horizonLabel: '1 Trading Day (Next Session Close)',
      entryTiming: 'Next Session Open (O[t+1])',
      exitTiming: 'Target Session Close (C[t+1])',
      targetThresholdPct: 0.5,
      predictedClass: 1,
      predictedLabel: 'UP',
      confidence: 0.72,
      probabilities: { DOWN: 0.15, NEUTRAL: 0.13, UP: 0.72 },
      model: {
        modelId: 'champion-xgb-h1',
        algorithm: 'XGBoostClassifier',
        artifactSha256: 'a1b2c3d4e5f6',
        featureSchemaVersion: '1.0',
      },
      executionTimeMs: 6.2,
      attributions: [
        { feature: 'rsi_14', value: 48.5, contribution: 0.18, direction: 'UP', displayName: 'Relative Strength Index (RSI 14)', description: 'Momentum oscillator' },
        { feature: 'price_to_sma20', value: 0.015, contribution: 0.12, direction: 'UP', displayName: 'Price to 20-day SMA', description: 'Trend distance' },
      ],
    },
    '3': {
      horizon: 3,
      horizonLabel: '3 Trading Days (Multi-Session Trend)',
      entryTiming: 'Next Session Open (O[t+1])',
      exitTiming: 'Target Session Close (C[t+3])',
      targetThresholdPct: 1.0,
      predictedClass: 1,
      predictedLabel: 'UP',
      confidence: 0.68,
      probabilities: { DOWN: 0.18, NEUTRAL: 0.14, UP: 0.68 },
      model: {
        modelId: 'champion-xgb-h3',
        algorithm: 'XGBoostClassifier',
        artifactSha256: 'b2c3d4e5f6a1',
        featureSchemaVersion: '1.0',
      },
      executionTimeMs: 6.1,
      attributions: [
        { feature: 'macd_signal_ratio', value: 1.02, contribution: 0.15, direction: 'UP', displayName: 'MACD Signal Ratio', description: 'Trend momentum' },
      ],
    },
    '5': {
      horizon: 5,
      horizonLabel: '5 Trading Days (1 Calendar Week)',
      entryTiming: 'Next Session Open (O[t+1])',
      exitTiming: 'Target Session Close (C[t+5])',
      targetThresholdPct: 1.5,
      predictedClass: 0,
      predictedLabel: 'NEUTRAL',
      confidence: 0.54,
      probabilities: { DOWN: 0.23, NEUTRAL: 0.54, UP: 0.23 },
      model: {
        modelId: 'champion-rf-h5',
        algorithm: 'RandomForestClassifier',
        artifactSha256: 'c3d4e5f6a1b2',
        featureSchemaVersion: '1.0',
      },
      executionTimeMs: 5.8,
      attributions: [
        { feature: 'atr_pct', value: 0.021, contribution: 0.11, direction: 'NEUTRAL', displayName: 'ATR Volatility %', description: 'Price volatility' },
      ],
    },
  },
};

export const mockSentiment = {
  symbol: 'RELIANCE',
  overallPolarity: 0.38,
  overall_polarity: 0.38,
  overallLabel: 'BULLISH',
  overall_label: 'BULLISH',
  confidence: 0.76,
  sampleCount: 8,
  sample_count: 8,
  ratios: { bullish: 0.65, bearish: 0.10, neutral: 0.25 },
  headlines: [
    { title: 'Reliance announces strategic energy expansion', polarity: 0.65, label: 'BULLISH' },
  ],
  analyzedAtUtc: new Date().toISOString(),
  analyzed_at_utc: new Date().toISOString(),
  fusion: {
    alignment: 'CONFIRMING',
    alignmentDescription: 'Financial news sentiment confirms technical bullish stance.',
    alignment_description: 'Financial news sentiment confirms technical bullish stance.',
    fusedLabel: 'UP',
    fused_label: 'UP',
    confidence: 0.74,
  },
};

export const mockPatterns = {
  stance: 'BULLISH',
  technical_score: 0.45,
  summary: 'Constructive candlestick reversal near key support.',
  patterns: [
    { name: 'Bullish Engulfing', significance: 'HIGH', type: 'REVERSAL', detected_at: new Date().toISOString() },
  ],
  support_resistance: [
    { level_type: 'SUPPORT', level: 2420.0, strength: 3 },
    { level_type: 'RESISTANCE', level: 2510.0, strength: 2 },
  ],
  signals: [
    { type: 'BREAKOUT', direction: 'BULLISH', description: 'Breakout above 20-day moving average' },
  ],
};

export const mockCandles = [
  { timestamp: '2026-07-10T09:15:00.000Z', open: 2400.0, high: 2430.0, low: 2390.0, close: 2420.0, volume: '150000' },
  { timestamp: '2026-07-11T09:15:00.000Z', open: 2420.0, high: 2445.0, low: 2410.0, close: 2435.0, volume: '180000' },
  { timestamp: '2026-07-12T09:15:00.000Z', open: 2435.0, high: 2460.0, low: 2425.0, close: 2450.0, volume: '220000' },
];

/**
 * Sets up global API route mocks for a Playwright Page.
 */
export async function setupApiMocks(page) {
  // CSRF handshake
  await page.route('**/api/auth/csrf', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { csrfToken: 'mock-e2e-csrf-token-1234567890' } }),
    });
  });

  // User auth me
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { user: mockUser } }),
    });
  });

  // Market overview & indices
  await page.route('**/api/market/overview', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          summary: { totalActiveInstruments: 150, exchanges: { NSE: 100, BSE: 50 }, instrumentTypes: { EQUITY: 150 } },
          provider: { active: true, name: 'Upstox API V3' },
        },
      }),
    });
  });

  await page.route('**/api/market/indices', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { indices: [] } }),
    });
  });

  // Stocks catalogue
  await page.route('**/api/stocks?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          stocks: [mockStockReliance],
          pagination: { page: 1, limit: 20, totalRecords: 1, totalPages: 1 },
        },
      }),
    });
  });

  // Stock detail (matches both UUID and symbol)
  await page.route(/\/api\/stocks\/(RELIANCE|01931853-9bb6-74b0-a5fc-1b774b789001)(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: mockStockReliance }),
    });
  });

  // Stock prices (candles)
  await page.route(/\/api\/stocks\/(RELIANCE|01931853-9bb6-74b0-a5fc-1b774b789001)\/prices(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { candles: mockCandles } }),
    });
  });

  // Stock predictions
  await page.route(/\/api\/stocks\/(RELIANCE|01931853-9bb6-74b0-a5fc-1b774b789001)\/predictions(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: mockPredictions }),
    });
  });

  // Stock sentiment
  await page.route(/\/api\/stocks\/(RELIANCE|01931853-9bb6-74b0-a5fc-1b774b789001)\/sentiment(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: mockSentiment }),
    });
  });

  // Stock patterns
  await page.route(/\/api\/stocks\/(RELIANCE|01931853-9bb6-74b0-a5fc-1b774b789001)\/patterns(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: mockPatterns }),
    });
  });

  // Watchlists
  await page.route('**/api/watchlists*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          watchlists: [{ id: 'wl-1', name: 'My Favorites', items: [{ stock: mockStockReliance }] }],
        },
      }),
    });
  });

  // Alerts
  await page.route('**/api/alerts*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          alerts: [
            {
              id: 'alert-1',
              stockId: mockStockReliance.id,
              alertType: 'PRICE_ABOVE',
              targetValue: 2600.0,
              isActive: true,
              stock: mockStockReliance,
            },
          ],
        },
      }),
    });
  });
}
