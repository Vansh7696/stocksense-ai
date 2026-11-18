/**
 * StockSense AI — Sentiment Intelligence Helper Utilities (Phase 5C.9)
 * Pure JavaScript utilities for formatting sentiment scores,
 * resolving alignment states, and styling news cards.
 */

/**
 * Returns visual badge variant and color mapping for a sentiment label.
 *
 * @param {string} label - 'BULLISH', 'BEARISH', or 'NEUTRAL'
 * @returns {Object}
 */
export function getSentimentMeta(label) {
  switch (label?.toUpperCase()) {
    case 'BULLISH':
      return {
        variant: 'bullish',
        text: 'BULLISH',
        textColor: 'text-emerald-400',
        bgAccent: 'bg-emerald-500/10 border-emerald-500/30',
        barColor: 'bg-emerald-500',
      };
    case 'BEARISH':
      return {
        variant: 'bearish',
        text: 'BEARISH',
        textColor: 'text-rose-400',
        bgAccent: 'bg-rose-500/10 border-rose-500/30',
        barColor: 'bg-rose-500',
      };
    case 'NEUTRAL':
    default:
      return {
        variant: 'neutral',
        text: 'NEUTRAL',
        textColor: 'text-slate-300',
        bgAccent: 'bg-slate-800/60 border-slate-700',
        barColor: 'bg-slate-500',
      };
  }
}

/**
 * Formats signed polarity score [-1.0, 1.0] as a percentage string (e.g. +65%).
 *
 * @param {number} polarity
 * @returns {string}
 */
export function formatPolarity(polarity) {
  if (polarity === undefined || polarity === null || !Number.isFinite(polarity)) return '0%';
  const sign = polarity > 0 ? '+' : '';
  return `${sign}${Math.round(polarity * 100)}%`;
}

/**
 * Resolves visual representation for multi-factor technical/sentiment alignment.
 *
 * @param {string} status - 'CONFIRMING', 'CONTRADICTING', or 'NEUTRAL_ALIGNMENT'
 * @returns {Object}
 */
export function getAlignmentMeta(status) {
  switch (status?.toUpperCase()) {
    case 'CONFIRMING':
      return {
        variant: 'success',
        text: 'CONFIRMING ALIGNMENT',
        description: 'Qualitative market news reinforces the quantitative technical forecast.',
        badgeVariant: 'bullish',
      };
    case 'CONTRADICTING':
      return {
        variant: 'warning',
        text: 'DIVERGENCE RISK',
        description: 'News sentiment conflicts with technical momentum, indicating potential volatility.',
        badgeVariant: 'bearish',
      };
    case 'NEUTRAL_ALIGNMENT':
    default:
      return {
        variant: 'info',
        text: 'NEUTRAL ALIGNMENT',
        description: 'News sentiment is neutral; technical indicators serve as primary signal.',
        badgeVariant: 'neutral',
      };
  }
}
