import React, { useState } from 'react';
import {
  Activity,
  Layers,
  Zap,
  TrendingUp,
  TrendingDown,
  Compass,
  ArrowUpRight,
  ArrowDownRight,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Info,
  Clock,
  Sparkles,
} from 'lucide-react';
import { Card, Badge, Skeleton } from '../ui';
import {
  getStanceMeta,
  calculateGaugePercentage,
  formatScore,
  formatDistance,
  getPatternTypeMeta,
} from '../../utils/patterns';

/**
 * Format Indian Rupee currency
 */
function formatCurrency(val) {
  if (val === undefined || val === null || isNaN(val)) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
}

/**
 * Interactive Technical Pattern Recognition, S/R Zones & Breakout Signals Card
 */
export default function TechnicalPatternsCard({
  patternData,
  loading = false,
  error = null,
  symbol = '',
  selectedExchange = 'NSE',
  onRetry = null,
}) {
  const [activeTab, setActiveTab] = useState('patterns'); // 'patterns' | 'sr' | 'signals'

  if (loading) {
    return (
      <Card className="p-6 bg-fintech-surface/70 border-fintech-border/70 space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-6 w-24" />
        </div>
        <Skeleton className="h-16 w-full rounded-lg" />
        <div className="grid grid-cols-3 gap-3">
          <Skeleton className="h-28 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="p-6 bg-fintech-surface/70 border-fintech-border/70">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-rose-400 font-mono text-sm font-semibold">
            <AlertTriangle className="w-4 h-4" />
            <span>Technical Pattern Engine Error</span>
          </div>
          {onRetry && (
            <button
              onClick={onRetry}
              className="text-xs font-mono text-blue-400 hover:text-blue-300 underline"
            >
              Retry
            </button>
          )}
        </div>
        <p className="text-xs text-slate-400 font-mono mt-2">{error.message || 'Failed to analyze technical patterns.'}</p>
      </Card>
    );
  }

  if (!patternData) {
    return null;
  }

  const {
    stance = 'NEUTRAL',
    technical_score = 0.0,
    summary = 'No technical pattern summary available.',
    patterns = [],
    support_resistance = [],
    signals = [],
    indicators = {},
    total_candles_analyzed = 0,
    meta = {},
  } = patternData;

  const stanceMeta = getStanceMeta(stance);
  const gaugePct = calculateGaugePercentage(technical_score);

  const supports = support_resistance.filter((l) => l.level_type === 'SUPPORT');
  const resistances = support_resistance.filter((l) => l.level_type === 'RESISTANCE');

  return (
    <Card className="p-6 bg-gradient-to-br from-fintech-surface via-fintech-card to-fintech-surface border-fintech-border/80 shadow-xl space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400">
            <Compass className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold font-mono tracking-tight text-white uppercase">
                Technical Pattern & Breakout Intelligence
              </h3>
              <Badge variant="neutral" size="sm">
                1D
              </Badge>
            </div>
            <p className="text-[11px] font-mono text-slate-400">
              Japanese candlestick structures, local extrema S/R zones & momentum breakouts
            </p>
          </div>
        </div>

        {/* Stance Badge */}
        <div className="flex items-center gap-2">
          <span
            className={`px-3 py-1 rounded-md text-xs font-mono font-bold border flex items-center gap-1.5 ${stanceMeta.bg} ${stanceMeta.color}`}
          >
            <span className={`w-2 h-2 rounded-full ${stanceMeta.dotColor} animate-pulse`} />
            <span>{stanceMeta.label}</span>
            <span className="text-[10px] opacity-75 font-normal">({formatScore(technical_score)})</span>
          </span>
        </div>
      </div>

      {/* Technical Score Gauge Bar */}
      <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800/80 space-y-2.5">
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="text-rose-400 flex items-center gap-1">
            <TrendingDown className="w-3.5 h-3.5" /> Bearish (-1.0)
          </span>
          <span className="text-slate-400 font-semibold">
            Score: <strong className={stanceMeta.color}>{formatScore(technical_score)}</strong>
          </span>
          <span className="text-emerald-400 flex items-center gap-1">
            Bullish (+1.0) <TrendingUp className="w-3.5 h-3.5" />
          </span>
        </div>

        {/* Visual Track */}
        <div className="relative h-2.5 w-full bg-slate-800 rounded-full overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-rose-500 via-amber-400 to-emerald-500 opacity-80" />
          {/* Needle indicator */}
          <div
            className="absolute top-0 bottom-0 w-1.5 bg-white shadow-lg transition-all duration-500 rounded-full"
            style={{ left: `calc(${gaugePct}% - 3px)` }}
          />
        </div>

        {/* Executive Analytical Commentary */}
        <p className="text-xs font-mono text-slate-300 leading-relaxed pt-1">
          {summary}
        </p>
      </div>

      {/* Tab Navigation */}
      <div className="flex items-center gap-2 border-b border-slate-800/80 pb-2">
        <button
          onClick={() => setActiveTab('patterns')}
          className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-1.5 ${
            activeTab === 'patterns'
              ? 'bg-blue-600/20 text-blue-300 border border-blue-500/40'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>Candlestick Patterns ({patterns.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('sr')}
          className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-1.5 ${
            activeTab === 'sr'
              ? 'bg-blue-600/20 text-blue-300 border border-blue-500/40'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Layers className="w-3.5 h-3.5" />
          <span>Support & Resistance ({support_resistance.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('signals')}
          className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-1.5 ${
            activeTab === 'signals'
              ? 'bg-blue-600/20 text-blue-300 border border-blue-500/40'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Zap className="w-3.5 h-3.5" />
          <span>Breakout Triggers ({signals.length})</span>
        </button>
      </div>

      {/* Tab Content 1: Candlestick Patterns */}
      {activeTab === 'patterns' && (
        <div className="space-y-2.5">
          {patterns.length === 0 ? (
            <div className="p-4 rounded-lg bg-slate-900/40 text-center text-xs font-mono text-slate-400">
              No prominent classical candlestick patterns detected on recent candles.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {patterns.map((p, idx) => {
                const meta = getPatternTypeMeta(p.pattern_type);
                return (
                  <div
                    key={`pat-${idx}`}
                    className="p-3 rounded-xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 transition-all space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold text-xs text-white flex items-center gap-1.5">
                        {p.pattern_type === 'BULLISH' && (
                          <ArrowUpRight className="w-3.5 h-3.5 text-emerald-400" />
                        )}
                        {p.pattern_type === 'BEARISH' && (
                          <ArrowDownRight className="w-3.5 h-3.5 text-rose-400" />
                        )}
                        {p.name}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold border ${meta.badgeBg}`}
                      >
                        {p.pattern_type} ({Math.round(p.confidence * 100)}%)
                      </span>
                    </div>

                    <p className="text-[11px] font-mono text-slate-400 leading-snug">
                      {p.description}
                    </p>

                    <div className="flex items-center justify-between text-[10px] font-mono text-slate-500 pt-1 border-t border-slate-800/50">
                      <span>Ref Price: {formatCurrency(p.price)}</span>
                      <span>Bar: {p.timestamp ? new Date(p.timestamp).toLocaleDateString('en-IN') : `Bar #${p.bar_index}`}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab Content 2: Support & Resistance Zones */}
      {activeTab === 'sr' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Closest Support Levels */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-mono font-semibold text-emerald-400">
              <TrendingUp className="w-3.5 h-3.5" />
              <span>Key Support Zones (Below Close)</span>
            </div>
            {supports.length === 0 ? (
              <div className="p-3 rounded-lg bg-slate-900/40 text-[11px] font-mono text-slate-500">
                No major clustered support levels detected below current price.
              </div>
            ) : (
              supports.map((s, idx) => (
                <div
                  key={`sup-${idx}`}
                  className="p-3 rounded-lg bg-slate-900/60 border border-emerald-500/20 flex items-center justify-between text-xs font-mono"
                >
                  <div>
                    <div className="font-bold text-white">{formatCurrency(s.price)}</div>
                    <div className="text-[10px] text-slate-400">
                      Cluster: {formatCurrency(s.range_min)} – {formatCurrency(s.range_max)}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-emerald-400 font-semibold">{formatDistance(s.distance_pct)}</span>
                    <div className="text-[10px] text-slate-400">{s.touch_count} tests ({Math.round(s.strength * 100)}% str)</div>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Closest Resistance Levels */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-mono font-semibold text-rose-400">
              <TrendingDown className="w-3.5 h-3.5" />
              <span>Key Resistance Zones (Above Close)</span>
            </div>
            {resistances.length === 0 ? (
              <div className="p-3 rounded-lg bg-slate-900/40 text-[11px] font-mono text-slate-500">
                No major clustered resistance levels detected above current price.
              </div>
            ) : (
              resistances.map((r, idx) => (
                <div
                  key={`res-${idx}`}
                  className="p-3 rounded-lg bg-slate-900/60 border border-rose-500/20 flex items-center justify-between text-xs font-mono"
                >
                  <div>
                    <div className="font-bold text-white">{formatCurrency(r.price)}</div>
                    <div className="text-[10px] text-slate-400">
                      Cluster: {formatCurrency(r.range_min)} – {formatCurrency(r.range_max)}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-rose-400 font-semibold">{formatDistance(r.distance_pct)}</span>
                    <div className="text-[10px] text-slate-400">{r.touch_count} tests ({Math.round(r.strength * 100)}% str)</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Tab Content 3: Breakout Triggers */}
      {activeTab === 'signals' && (
        <div className="space-y-2.5">
          {signals.length === 0 ? (
            <div className="p-4 rounded-lg bg-slate-900/40 text-center text-xs font-mono text-slate-400">
              No active Donchian breakout, RSI divergence, or MACD crossover signals triggered on current bar.
            </div>
          ) : (
            <div className="space-y-2">
              {signals.map((sig, idx) => {
                const isBullish = sig.bias === 'BULLISH';
                return (
                  <div
                    key={`sig-${idx}`}
                    className={`p-3 rounded-xl bg-slate-900/60 border ${
                      isBullish ? 'border-emerald-500/30' : 'border-rose-500/30'
                    } flex items-start justify-between gap-3`}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-mono font-bold text-xs ${
                            isBullish ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {sig.label}
                        </span>
                        <Badge
                          variant={sig.severity === 'STRONG' ? 'warning' : 'neutral'}
                          size="sm"
                        >
                          {sig.severity}
                        </Badge>
                      </div>
                      <p className="text-xs font-mono text-slate-300 leading-snug">
                        {sig.description}
                      </p>
                    </div>
                    <span className="text-[10px] font-mono text-slate-500 shrink-0">
                      {sig.indicator}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Technical Indicators Snapshot Strip */}
      <div className="pt-3 border-t border-slate-800/80">
        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-wider mb-2">
          Technical Momentum & Dynamic Band Snapshot
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs font-mono">
          <div className="p-2 rounded bg-slate-900/40 border border-slate-800/60">
            <div className="text-slate-500 text-[10px]">RSI (14)</div>
            <div className="text-white font-semibold mt-0.5">
              {indicators.rsi !== null && indicators.rsi !== undefined ? indicators.rsi.toFixed(1) : '—'}
            </div>
          </div>

          <div className="p-2 rounded bg-slate-900/40 border border-slate-800/60">
            <div className="text-slate-500 text-[10px]">MACD HIST</div>
            <div
              className={`font-semibold mt-0.5 ${
                indicators.macd_histogram > 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {indicators.macd_histogram !== null && indicators.macd_histogram !== undefined
                ? indicators.macd_histogram.toFixed(2)
                : '—'}
            </div>
          </div>

          <div className="p-2 rounded bg-slate-900/40 border border-slate-800/60">
            <div className="text-slate-500 text-[10px]">SMA (20)</div>
            <div className="text-white font-semibold mt-0.5">
              {indicators.sma_20 ? formatCurrency(indicators.sma_20) : '—'}
            </div>
          </div>

          <div className="p-2 rounded bg-slate-900/40 border border-slate-800/60">
            <div className="text-slate-500 text-[10px]">SMA (50)</div>
            <div className="text-white font-semibold mt-0.5">
              {indicators.sma_50 ? formatCurrency(indicators.sma_50) : '—'}
            </div>
          </div>

          <div className="p-2 rounded bg-slate-900/40 border border-slate-800/60">
            <div className="text-slate-500 text-[10px]">DONCHIAN HIGH</div>
            <div className="text-white font-semibold mt-0.5">
              {indicators.donchian_high_20 ? formatCurrency(indicators.donchian_high_20) : '—'}
            </div>
          </div>

          <div className="p-2 rounded bg-slate-900/40 border border-slate-800/60">
            <div className="text-slate-500 text-[10px]">RVOL (20)</div>
            <div
              className={`font-semibold mt-0.5 ${
                indicators.rvol_20 >= 1.5 ? 'text-emerald-400' : 'text-white'
              }`}
            >
              {indicators.rvol_20 !== null && indicators.rvol_20 !== undefined
                ? `${indicators.rvol_20.toFixed(2)}x`
                : '—'}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
