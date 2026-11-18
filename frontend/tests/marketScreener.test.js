/**
 * StockSense AI — Milestone 6D.1: Intelligent Market Screener Unit Tests
 * Tests screener filtering by signal stance, confidence threshold, news sentiment,
 * breakout alerts, text queries, and empty result handling.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Pure logic unit test mirroring MarketScreener filter logic
function filterScreenerStocks(stocks, { search, signalStance, minConfidence, sentimentFilter, technicalSignal }) {
  return stocks.filter((item) => {
    // 1. Text search
    if (search) {
      const q = search.toLowerCase();
      const matchesSym = item.symbol.toLowerCase().includes(q);
      const matchesName = (item.companyName || '').toLowerCase().includes(q);
      if (!matchesSym && !matchesName) return false;
    }

    // 2. Signal Stance
    if (signalStance && signalStance !== 'ALL' && item.screenerStance !== signalStance) {
      return false;
    }

    // 3. Min Confidence
    if (minConfidence && minConfidence !== 'ALL') {
      const threshold = parseFloat(minConfidence) / 100;
      if (item.confidence < threshold) return false;
    }

    // 4. Sentiment
    if (sentimentFilter && sentimentFilter !== 'ALL' && item.sentimentLabel !== sentimentFilter) {
      return false;
    }

    // 5. Technical Signal
    if (technicalSignal && technicalSignal !== 'ALL') {
      if (technicalSignal === 'BREAKOUT' && item.breakoutSignal !== 'BULLISH_BREAKOUT') {
        return false;
      }
    }

    return true;
  });
}

describe('Milestone 6D.1: Intelligent Market Screener Filter Tests', () => {
  const sampleStocks = [
    {
      symbol: 'RELIANCE',
      companyName: 'Reliance Industries Limited',
      screenerStance: 'BULLISH',
      confidence: 0.72,
      sentimentPolarity: 0.42,
      sentimentLabel: 'BULLISH',
      detectedPattern: 'Bullish Engulfing',
      breakoutSignal: 'BULLISH_BREAKOUT',
    },
    {
      symbol: 'TCS',
      companyName: 'Tata Consultancy Services',
      screenerStance: 'NEUTRAL',
      confidence: 0.65,
      sentimentPolarity: 0.05,
      sentimentLabel: 'NEUTRAL',
      detectedPattern: 'Consolidation Box',
      breakoutSignal: 'RANGE_BOUND',
    },
    {
      symbol: 'INFY',
      companyName: 'Infosys Limited',
      screenerStance: 'BULLISH',
      confidence: 0.58,
      sentimentPolarity: 0.28,
      sentimentLabel: 'BULLISH',
      detectedPattern: 'Hammer Reversal',
      breakoutSignal: 'RANGE_BOUND',
    },
    {
      symbol: 'HDFCBANK',
      companyName: 'HDFC Bank Limited',
      screenerStance: 'BEARISH',
      confidence: 0.69,
      sentimentPolarity: -0.35,
      sentimentLabel: 'BEARISH',
      detectedPattern: 'Evening Star',
      breakoutSignal: 'RANGE_BOUND',
    },
  ];

  test('1. Filters stocks by Bullish stance', () => {
    const results = filterScreenerStocks(sampleStocks, { signalStance: 'BULLISH' });
    assert.equal(results.length, 2);
    assert.ok(results.every((s) => s.screenerStance === 'BULLISH'));
  });

  test('2. Filters stocks by Bearish stance', () => {
    const results = filterScreenerStocks(sampleStocks, { signalStance: 'BEARISH' });
    assert.equal(results.length, 1);
    assert.equal(results[0].symbol, 'HDFCBANK');
  });

  test('3. Filters stocks by Minimum Confidence threshold >= 70%', () => {
    const results = filterScreenerStocks(sampleStocks, { minConfidence: '70' });
    assert.equal(results.length, 1);
    assert.equal(results[0].symbol, 'RELIANCE');
  });

  test('4. Filters stocks by Positive News Sentiment', () => {
    const results = filterScreenerStocks(sampleStocks, { sentimentFilter: 'BULLISH' });
    assert.equal(results.length, 2);
    assert.ok(results.every((s) => s.sentimentPolarity > 0.15));
  });

  test('5. Filters stocks by Momentum Breakout signal', () => {
    const results = filterScreenerStocks(sampleStocks, { technicalSignal: 'BREAKOUT' });
    assert.equal(results.length, 1);
    assert.equal(results[0].symbol, 'RELIANCE');
    assert.equal(results[0].breakoutSignal, 'BULLISH_BREAKOUT');
  });

  test('6. Filters stocks by text query on company name or symbol', () => {
    const results = filterScreenerStocks(sampleStocks, { search: 'Tata' });
    assert.equal(results.length, 1);
    assert.equal(results[0].symbol, 'TCS');
  });

  test('7. Returns empty array when combined filters find no matches', () => {
    const results = filterScreenerStocks(sampleStocks, {
      signalStance: 'BEARISH',
      technicalSignal: 'BREAKOUT',
    });
    assert.equal(results.length, 0);
  });
});
