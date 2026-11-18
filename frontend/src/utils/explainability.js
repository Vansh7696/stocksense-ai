/**
 * StockSense AI — Explainability & Attribution Helper Utilities
 * Pure JavaScript utilities for formatting technical indicator values,
 * normalizing feature attribution bars, and classifying directional support.
 */

/**
 * Formats raw technical indicator value with appropriate units and precision.
 *
 * @param {string} feature - Technical indicator key
 * @param {number} value - Raw indicator value
 * @returns {string} Formatted string with precision and unit
 */
export function formatFeatureValue(feature, value) {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';

  if (feature === 'rsi_14') return `${value.toFixed(1)}`;
  if (feature === 'relative_volume_20') return `${value.toFixed(2)}x`;
  if (
    feature.startsWith('return_') ||
    feature === 'atr_pct' ||
    feature === 'volatility_20d' ||
    feature.startsWith('price_to_') ||
    feature.startsWith('ma_spread_')
  ) {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${(value * 100).toFixed(2)}%`;
  }
  return value.toFixed(3);
}

/**
 * Computes normalized bar width percentages for an array of feature attributions.
 *
 * @param {Array<{ contribution: number }>} attributions
 * @returns {Array<number>} Bar width percentages bounded between 8% and 100%
 */
export function computeAttributionBarWidths(attributions = []) {
  if (!attributions || attributions.length === 0) return [];
  const maxAbsContrib = Math.max(
    ...attributions.map((a) => Math.abs(a.contribution || 0)),
    0.0001
  );
  return attributions.map((attr) => {
    const absVal = Math.abs(attr.contribution || 0);
    return Math.min(100, Math.max(8, (absVal / maxAbsContrib) * 100));
  });
}

/**
 * Classifies whether a feature attribution reinforces or opposes the forecast direction.
 *
 * @param {string} predictedLabel - 'UP', 'DOWN', or 'NEUTRAL'
 * @param {string} featureDirection - 'UP', 'DOWN', or 'NEUTRAL'
 * @param {number} contribution - Signed contribution score
 * @returns {boolean} True if feature reinforces predicted label
 */
export function isAttributionSupporting(predictedLabel, featureDirection, contribution = 0) {
  if (predictedLabel === 'UP') return featureDirection === 'UP' && contribution > 0;
  if (predictedLabel === 'DOWN') return featureDirection === 'DOWN' && contribution > 0;
  return contribution > 0;
}
