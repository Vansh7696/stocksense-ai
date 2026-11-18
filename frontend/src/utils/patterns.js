/**
 * StockSense AI — Technical Pattern & Breakout Utility Functions
 * Pure mathematical formatting and metadata helpers.
 */

/**
 * Returns UI metadata for a technical stance.
 *
 * @param {string} stance - STRONG_BULLISH | BULLISH | NEUTRAL | BEARISH | STRONG_BEARISH
 * @returns {Object}
 */
export function getStanceMeta(stance) {
  switch (stance) {
    case 'STRONG_BULLISH':
      return {
        label: 'Strong Bullish',
        color: 'text-emerald-400',
        badgeVariant: 'success',
        bg: 'bg-emerald-500/10 border-emerald-500/30',
        dotColor: 'bg-emerald-400',
        glow: 'shadow-emerald-500/10',
      };
    case 'BULLISH':
      return {
        label: 'Bullish',
        color: 'text-emerald-300',
        badgeVariant: 'success',
        bg: 'bg-emerald-500/10 border-emerald-500/20',
        dotColor: 'bg-emerald-400',
        glow: 'shadow-emerald-500/10',
      };
    case 'STRONG_BEARISH':
      return {
        label: 'Strong Bearish',
        color: 'text-rose-400',
        badgeVariant: 'danger',
        bg: 'bg-rose-500/10 border-rose-500/30',
        dotColor: 'bg-rose-400',
        glow: 'shadow-rose-500/10',
      };
    case 'BEARISH':
      return {
        label: 'Bearish',
        color: 'text-rose-300',
        badgeVariant: 'danger',
        bg: 'bg-rose-500/10 border-rose-500/20',
        dotColor: 'bg-rose-400',
        glow: 'shadow-rose-500/10',
      };
    case 'NEUTRAL':
    default:
      return {
        label: 'Neutral / Range-Bound',
        color: 'text-slate-300',
        badgeVariant: 'neutral',
        bg: 'bg-slate-700/30 border-slate-600/30',
        dotColor: 'bg-slate-400',
        glow: 'shadow-slate-500/10',
      };
  }
}

/**
 * Maps technical score (-1.0 to +1.0) to 0-100% position on gauge.
 *
 * @param {number} score
 * @returns {number}
 */
export function calculateGaugePercentage(score) {
  if (typeof score !== 'number' || isNaN(score)) return 50.0;
  const clamped = Math.max(-1.0, Math.min(1.0, score));
  return Math.round(((clamped + 1.0) / 2.0) * 1000) / 10;
}

/**
 * Format signed technical score.
 *
 * @param {number} score
 * @returns {string}
 */
export function formatScore(score) {
  if (typeof score !== 'number' || isNaN(score)) return '0.00';
  const prefix = score > 0 ? '+' : '';
  return `${prefix}${score.toFixed(2)}`;
}

/**
 * Format signed distance percentage.
 *
 * @param {number} dist
 * @returns {string}
 */
export function formatDistance(dist) {
  if (typeof dist !== 'number' || isNaN(dist)) return '0.0%';
  const prefix = dist > 0 ? '+' : '';
  return `${prefix}${dist.toFixed(2)}%`;
}

/**
 * Returns styling for pattern badge based on BULLISH/BEARISH/NEUTRAL.
 *
 * @param {string} patternType
 * @returns {Object}
 */
export function getPatternTypeMeta(patternType) {
  switch (patternType) {
    case 'BULLISH':
      return {
        badgeVariant: 'success',
        textColor: 'text-emerald-400',
        badgeBg: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
      };
    case 'BEARISH':
      return {
        badgeVariant: 'danger',
        textColor: 'text-rose-400',
        badgeBg: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
      };
    case 'NEUTRAL':
    default:
      return {
        badgeVariant: 'neutral',
        textColor: 'text-slate-300',
        badgeBg: 'bg-slate-700/30 text-slate-300 border-slate-600/30',
      };
  }
}
