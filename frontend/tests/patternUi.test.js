import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getStanceMeta,
  calculateGaugePercentage,
  formatScore,
  formatDistance,
  getPatternTypeMeta,
} from '../src/utils/patterns.js';
import { getStockPatterns } from '../src/services/api.js';

describe('Phase 5C.10: Frontend Technical Patterns & Breakout UI Tests', () => {
  test('1. getStanceMeta resolves valid metadata across all stances', () => {
    const strongBull = getStanceMeta('STRONG_BULLISH');
    assert.equal(strongBull.label, 'Strong Bullish');
    assert.equal(strongBull.badgeVariant, 'success');
    assert.ok(strongBull.color.includes('emerald'));

    const bull = getStanceMeta('BULLISH');
    assert.equal(bull.label, 'Bullish');
    assert.equal(bull.badgeVariant, 'success');

    const neutral = getStanceMeta('NEUTRAL');
    assert.equal(neutral.label, 'Neutral / Range-Bound');
    assert.equal(neutral.badgeVariant, 'neutral');

    const bear = getStanceMeta('BEARISH');
    assert.equal(bear.label, 'Bearish');
    assert.equal(bear.badgeVariant, 'danger');

    const strongBear = getStanceMeta('STRONG_BEARISH');
    assert.equal(strongBear.label, 'Strong Bearish');
    assert.equal(strongBear.badgeVariant, 'danger');
  });

  test('2. calculateGaugePercentage maps technical score accurately', () => {
    assert.equal(calculateGaugePercentage(-1.0), 0.0);
    assert.equal(calculateGaugePercentage(0.0), 50.0);
    assert.equal(calculateGaugePercentage(1.0), 100.0);
    assert.equal(calculateGaugePercentage(0.5), 75.0);
    assert.equal(calculateGaugePercentage(-0.5), 25.0);

    // Clamping & fallback
    assert.equal(calculateGaugePercentage(-2.0), 0.0);
    assert.equal(calculateGaugePercentage(2.0), 100.0);
    assert.equal(calculateGaugePercentage(null), 50.0);
    assert.equal(calculateGaugePercentage(undefined), 50.0);
  });

  test('3. formatScore formats signed numbers properly', () => {
    assert.equal(formatScore(0.385), '+0.39');
    assert.equal(formatScore(-0.42), '-0.42');
    assert.equal(formatScore(0.0), '0.00');
    assert.equal(formatScore(null), '0.00');
  });

  test('4. formatDistance formats percentage distance safely', () => {
    assert.equal(formatDistance(2.84), '+2.84%');
    assert.equal(formatDistance(-1.50), '-1.50%');
    assert.equal(formatDistance(0.0), '0.00%');
    assert.equal(formatDistance(NaN), '0.0%');
  });

  test('5. getPatternTypeMeta maps pattern types correctly', () => {
    const bull = getPatternTypeMeta('BULLISH');
    assert.equal(bull.badgeVariant, 'success');
    assert.ok(bull.textColor.includes('emerald'));

    const bear = getPatternTypeMeta('BEARISH');
    assert.equal(bear.badgeVariant, 'danger');
    assert.ok(bear.textColor.includes('rose'));

    const neutral = getPatternTypeMeta('NEUTRAL');
    assert.equal(neutral.badgeVariant, 'neutral');
  });

  test('6. getStockPatterns is exported as an async function in api.js', () => {
    assert.equal(typeof getStockPatterns, 'function');
  });
});
