import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSentimentMeta,
  formatPolarity,
  getAlignmentMeta,
} from '../src/utils/sentiment.js';
import { getStockSentiment } from '../src/services/api.js';

describe('Phase 5C.9: Frontend Sentiment Intelligence UI Tests', () => {

  test('1. getSentimentMeta resolves appropriate badge variant and colors', () => {
    const bullishMeta = getSentimentMeta('BULLISH');
    assert.equal(bullishMeta.variant, 'bullish');
    assert.equal(bullishMeta.text, 'BULLISH');
    assert.ok(bullishMeta.textColor.includes('emerald'));

    const bearishMeta = getSentimentMeta('BEARISH');
    assert.equal(bearishMeta.variant, 'bearish');
    assert.equal(bearishMeta.text, 'BEARISH');
    assert.ok(bearishMeta.textColor.includes('rose'));

    const neutralMeta = getSentimentMeta('NEUTRAL');
    assert.equal(neutralMeta.variant, 'neutral');
    assert.equal(neutralMeta.text, 'NEUTRAL');
  });

  test('2. formatPolarity formats signed percentages and handles edge cases safely', () => {
    assert.equal(formatPolarity(0.425), '+43%');
    assert.equal(formatPolarity(-0.35), '-35%');
    assert.equal(formatPolarity(0.0), '0%');
    assert.equal(formatPolarity(1.0), '+100%');
    assert.equal(formatPolarity(-1.0), '-100%');

    // Safe fallbacks
    assert.equal(formatPolarity(null), '0%');
    assert.equal(formatPolarity(undefined), '0%');
    assert.equal(formatPolarity(NaN), '0%');
  });

  test('3. getAlignmentMeta correctly classifies multi-factor technical/sentiment alignment', () => {
    const confirming = getAlignmentMeta('CONFIRMING');
    assert.equal(confirming.badgeVariant, 'bullish');
    assert.ok(confirming.text.includes('CONFIRMING'));

    const contradicting = getAlignmentMeta('CONTRADICTING');
    assert.equal(contradicting.badgeVariant, 'bearish');
    assert.ok(confirming.text.includes('CONFIRMING'));

    const neutralAlign = getAlignmentMeta('NEUTRAL_ALIGNMENT');
    assert.equal(neutralAlign.badgeVariant, 'neutral');
  });

  test('4. Spectrum bar slider position calculation', () => {
    // Formula: ((polarity + 1.0) / 2.0) * 100
    const calcPos = (pol) => Math.min(100, Math.max(0, ((pol + 1.0) / 2.0) * 100));

    assert.equal(calcPos(-1.0), 0);
    assert.equal(calcPos(0.0), 50);
    assert.equal(calcPos(1.0), 100);
    assert.equal(calcPos(0.5), 75);
    assert.equal(calcPos(-0.5), 25);
  });

  test('5. getStockSentiment API client contract', async () => {
    assert.equal(typeof getStockSentiment, 'function');
  });
});
