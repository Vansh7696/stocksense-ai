import React, { useState } from 'react';
import {
  Newspaper,
  TrendingUp,
  TrendingDown,
  Minus,
  Sparkles,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import { Card, Badge, Button } from '../ui';
import {
  getSentimentMeta,
  formatPolarity,
  getAlignmentMeta,
} from '../../utils/sentiment';

/**
 * SentimentIntelligenceCard Component
 * Renders real-time financial news sentiment, polarity scores,
 * and multi-factor quantitative + qualitative probability fusion.
 */
export default function SentimentIntelligenceCard({
  sentimentData,
  loading = false,
  error = null,
  onRefresh = null,
  className = '',
}) {
  const [showAllHeadlines, setShowAllHeadlines] = useState(false);

  if (loading) {
    return (
      <Card className={`p-5 bg-fintech-surface border border-fintech-border/80 animate-pulse ${className}`}>
        <div className="h-4 w-48 bg-slate-800 rounded mb-4" />
        <div className="h-16 w-full bg-slate-800/60 rounded mb-4" />
        <div className="h-24 w-full bg-slate-800/40 rounded" />
      </Card>
    );
  }

  if (error || !sentimentData) {
    return null;
  }

  const {
    symbol,
    overallPolarity = 0,
    overallLabel = 'NEUTRAL',
    confidence = 0.5,
    sampleCount = 0,
    ratios = { bullish: 0, bearish: 0, neutral: 1 },
    headlines = [],
    fusion = null,
  } = sentimentData;

  const sentimentMeta = getSentimentMeta(overallLabel);
  const alignmentMeta = fusion ? getAlignmentMeta(fusion.alignment) : null;

  // Convert polarity from [-1.0, 1.0] to a [0, 100]% position on the slider
  const sliderPositionPct = Math.min(100, Math.max(0, ((overallPolarity + 1.0) / 2.0) * 100));

  const displayedHeadlines = showAllHeadlines ? headlines : headlines.slice(0, 3);

  return (
    <Card
      className={`p-5 bg-gradient-to-b from-fintech-surface via-fintech-card to-fintech-surface border border-fintech-border shadow-md ${className}`}
    >
      <div className="space-y-4">
        {/* Header: Title and Overall Badge */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-fintech-border/70 pb-3">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-400">
              <Newspaper className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold font-mono text-white tracking-tight">
                Market News Sentiment & Intelligence
              </h3>
              <p className="text-[11px] font-mono text-slate-400">
                NLP polarity analysis for {symbol} ({sampleCount} disclosures analyzed)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Badge variant={sentimentMeta.variant} size="sm" mono>
              {overallLabel} ({formatPolarity(overallPolarity)})
            </Badge>
          </div>
        </div>

        {/* Polarity Spectrum Bar */}
        <div className="p-4 rounded-xl bg-slate-900/60 border border-fintech-border space-y-2">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-rose-400 flex items-center gap-1">
              <TrendingDown className="w-3 h-3" /> Bearish (-100%)
            </span>
            <span className="text-slate-400">Neutral (0%)</span>
            <span className="text-emerald-400 flex items-center gap-1">
              Bullish (+100%) <TrendingUp className="w-3 h-3" />
            </span>
          </div>

          {/* Spectrum Bar with Pip */}
          <div className="relative h-2.5 w-full rounded-full bg-gradient-to-r from-rose-500 via-slate-600 to-emerald-500 overflow-hidden">
            <div
              className="absolute top-0 bottom-0 w-2.5 bg-white shadow-lg rounded-full -ml-1 border border-slate-900"
              style={{ left: `${sliderPositionPct}%` }}
              title={`Polarity: ${overallPolarity.toFixed(3)}`}
            />
          </div>

          {/* Distribution Ratios */}
          <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 pt-1">
            <span>Bullish: {(ratios.bullish * 100).toFixed(0)}%</span>
            <span>Neutral: {(ratios.neutral * 100).toFixed(0)}%</span>
            <span>Bearish: {(ratios.bearish * 100).toFixed(0)}%</span>
          </div>
        </div>

        {/* Multi-Factor Fusion Section */}
        {fusion && (
          <div className="p-3.5 rounded-xl bg-slate-900/90 border border-fintech-border/80 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                <span className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                  Multi-Factor Technical + News Fusion
                </span>
              </div>
              <Badge variant={alignmentMeta.badgeVariant} size="xs" mono>
                {alignmentMeta.text}
              </Badge>
            </div>

            <p className="text-[11px] font-sans text-slate-300 leading-relaxed">
              {fusion.alignmentDescription || alignmentMeta.description}
            </p>

            {/* Fused Probabilities Comparison */}
            <div className="grid grid-cols-3 gap-2 pt-1 text-center font-mono text-[11px]">
              <div className="p-1.5 rounded bg-slate-800/80 border border-slate-700/60">
                <span className="text-[10px] text-slate-400 block">DOWN</span>
                <span className="font-bold text-rose-400">
                  {((fusion.fusedProbabilities?.DOWN || 0) * 100).toFixed(1)}%
                </span>
              </div>
              <div className="p-1.5 rounded bg-slate-800/80 border border-slate-700/60">
                <span className="text-[10px] text-slate-400 block">NEUTRAL</span>
                <span className="font-bold text-slate-300">
                  {((fusion.fusedProbabilities?.NEUTRAL || 0) * 100).toFixed(1)}%
                </span>
              </div>
              <div className="p-1.5 rounded bg-slate-800/80 border border-slate-700/60">
                <span className="text-[10px] text-slate-400 block">UP</span>
                <span className="font-bold text-emerald-400">
                  {((fusion.fusedProbabilities?.UP || 0) * 100).toFixed(1)}%
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Scored News Headlines Feed */}
        {headlines.length > 0 && (
          <div className="space-y-2.5 pt-1">
            <div className="flex items-center justify-between text-xs font-mono text-slate-400">
              <span>SCORED CORPORATE HEADLINES</span>
              <span className="text-[10px] text-slate-500">
                Showing {displayedHeadlines.length} of {headlines.length}
              </span>
            </div>

            <div className="space-y-2">
              {displayedHeadlines.map((h, idx) => {
                const meta = getSentimentMeta(h.label);
                const publishedDate = h.publishedAt
                  ? new Date(h.publishedAt).toLocaleDateString('en-IN', {
                      month: 'short',
                      day: 'numeric',
                    })
                  : 'Recent';

                return (
                  <div
                    key={h.id || idx}
                    className="p-3 rounded-xl bg-slate-900/60 border border-fintech-border/70 hover:border-slate-700 transition-all space-y-1.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-medium text-slate-200 leading-snug">
                        {h.title}
                      </p>
                      <Badge variant={meta.variant} size="xs" mono className="shrink-0 text-[10px]">
                        {formatPolarity(h.polarity)}
                      </Badge>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-slate-500">
                      <span>
                        {h.source} • {publishedDate}
                      </span>
                      {h.keyDrivers && h.keyDrivers.length > 0 && (
                        <div className="flex items-center gap-1">
                          {h.keyDrivers.slice(0, 3).map((d, dIdx) => (
                            <span
                              key={dIdx}
                              className="px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 border border-slate-700/50"
                            >
                              {d}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {headlines.length > 3 && (
              <button
                type="button"
                onClick={() => setShowAllHeadlines((prev) => !prev)}
                className="w-full py-1 text-center text-xs font-mono text-cyan-400 hover:text-cyan-300 transition-colors flex items-center justify-center gap-1"
              >
                <span>{showAllHeadlines ? 'Show Less Headlines' : `View All ${headlines.length} Headlines`}</span>
                {showAllHeadlines ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
