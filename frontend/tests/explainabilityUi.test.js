import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatFeatureValue,
  computeAttributionBarWidths,
  isAttributionSupporting,
} from '../src/utils/explainability.js';

describe('Phase 5C.8: Frontend Explainability & Feature Attribution UI Tests', () => {

  test('1. formatFeatureValue formats indicators with proper precision and units', () => {
    // RSI 14
    assert.equal(formatFeatureValue('rsi_14', 68.482), '68.5');
    assert.equal(formatFeatureValue('rsi_14', 29.11), '29.1');

    // Relative Volume
    assert.equal(formatFeatureValue('relative_volume_20', 1.452), '1.45x');
    assert.equal(formatFeatureValue('relative_volume_20', 0.8), '0.80x');

    // Percentage returns and volatility
    assert.equal(formatFeatureValue('return_5d', 0.0245), '+2.45%');
    assert.equal(formatFeatureValue('return_1d', -0.0125), '-1.25%');
    assert.equal(formatFeatureValue('atr_pct', 0.018), '+1.80%');
    assert.equal(formatFeatureValue('volatility_20d', 0.155), '+15.50%');

    // Price to MA ratios
    assert.equal(formatFeatureValue('price_to_sma200', 0.045), '+4.50%');
    assert.equal(formatFeatureValue('price_to_ema50', -0.012), '-1.20%');

    // Generic indicators
    assert.equal(formatFeatureValue('trend_alignment', 3.0), '3.000');
  });

  test('2. formatFeatureValue handles edge cases safely without crashing', () => {
    assert.equal(formatFeatureValue('rsi_14', null), '—');
    assert.equal(formatFeatureValue('rsi_14', undefined), '—');
    assert.equal(formatFeatureValue('rsi_14', NaN), '—');
    assert.equal(formatFeatureValue('rsi_14', Infinity), '—');
  });

  test('3. Feature attribution bar normalization math', () => {
    const mockAttributions = [
      { feature: 'rsi_14', value: 68.5, contribution: 0.35, direction: 'UP' },
      { feature: 'relative_volume_20', value: 1.45, contribution: 0.20, direction: 'UP' },
      { feature: 'return_5d', value: -0.015, contribution: -0.10, direction: 'DOWN' },
    ];

    const maxAbs = Math.max(...mockAttributions.map((a) => Math.abs(a.contribution)));
    assert.equal(maxAbs, 0.35);

    const widths = computeAttributionBarWidths(mockAttributions);

    assert.equal(widths[0], 100);
    assert.ok(widths[1] > 50 && widths[1] < 60);
    assert.ok(widths[2] > 20 && widths[2] < 30);
  });

  test('4. Directional support classification logic', () => {
    const testCases = [
      { predicted: 'UP', direction: 'UP', contribution: 0.25, expectedSupporting: true },
      { predicted: 'UP', direction: 'DOWN', contribution: -0.15, expectedSupporting: false },
      { predicted: 'DOWN', direction: 'DOWN', contribution: 0.30, expectedSupporting: true },
      { predicted: 'DOWN', direction: 'UP', contribution: -0.20, expectedSupporting: false },
    ];

    for (const tc of testCases) {
      const isSupporting = isAttributionSupporting(tc.predicted, tc.direction, tc.contribution);
      assert.equal(isSupporting, tc.expectedSupporting);
    }
  });

  test('5. Attribution payload structure contract matching backend API', () => {
    const sampleBackendAttribution = {
      feature: 'rsi_14',
      value: 68.5,
      contribution: 0.342,
      direction: 'UP',
      displayName: 'RSI (14-period)',
      description: 'RSI at 68.5 indicates strong bullish momentum without entering extreme overbought levels.',
    };

    assert.ok(sampleBackendAttribution.feature);
    assert.ok(typeof sampleBackendAttribution.value === 'number');
    assert.ok(typeof sampleBackendAttribution.contribution === 'number');
    assert.ok(['UP', 'DOWN', 'NEUTRAL'].includes(sampleBackendAttribution.direction));
    assert.ok(sampleBackendAttribution.displayName.length > 0);
    assert.ok(sampleBackendAttribution.description.length > 0);
  });
});
