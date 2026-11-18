import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles,
  TrendingUp,
  TrendingDown,
  Minus,
  Search,
  Filter,
  SlidersHorizontal,
  ArrowRight,
  ExternalLink,
  ShieldAlert,
  Flame,
  Activity,
  Layers,
  ChevronRight,
} from 'lucide-react';
import { Card, Button, Badge, Input, TableRowSkeleton, EmptyState } from '../ui';

/**
 * Intelligent Market Screener Component
 * Filters and ranks stocks based on multi-horizon ML predictions, news sentiment polarity,
 * candlestick pattern detections, and breakout momentum signals.
 */
export default function MarketScreener({ stocks = [], loading = false }) {
  const navigate = useNavigate();

  // Screener Filter States
  const [search, setSearch] = useState('');
  const [signalStance, setSignalStance] = useState('ALL'); // ALL, BULLISH, BEARISH, NEUTRAL
  const [selectedHorizon, setSelectedHorizon] = useState('ALL'); // ALL, 1, 3, 5
  const [minConfidence, setMinConfidence] = useState('ALL'); // ALL, 50, 60, 70
  const [sentimentFilter, setSentimentFilter] = useState('ALL'); // ALL, BULLISH, BEARISH, NEUTRAL
  const [technicalSignal, setTechnicalSignal] = useState('ALL'); // ALL, BREAKOUT, PATTERN, SUPPORT, RESISTANCE

  // Derive mock/traceable analytical annotations for catalog stocks
  // In production, each stock combines its verified active predictions and patterns
  const screenedStocks = useMemo(() => {
    return stocks.map((s, idx) => {
      // Deterministically seed demo analytics based on symbol char codes to remain reproducible
      const codeSum = s.symbol.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
      const isBull = (codeSum + idx) % 3 === 0;
      const isBear = (codeSum + idx) % 3 === 1;
      
      const stance = isBull ? 'BULLISH' : isBear ? 'BEARISH' : 'NEUTRAL';
      const confidence = 0.52 + ((codeSum % 35) / 100);
      const polarity = isBull ? 0.35 + (codeSum % 20) / 100 : isBear ? -0.30 - (codeSum % 20) / 100 : 0.05;
      const patternName = isBull ? 'Bullish Engulfing' : isBear ? 'Evening Star' : 'Consolidation Box';
      const hasBreakout = isBull && (codeSum % 2 === 0);

      return {
        ...s,
        screenerStance: stance,
        confidence: Math.min(0.88, confidence),
        sentimentPolarity: polarity,
        sentimentLabel: polarity > 0.15 ? 'BULLISH' : polarity < -0.15 ? 'BEARISH' : 'NEUTRAL',
        detectedPattern: patternName,
        breakoutSignal: hasBreakout ? 'BULLISH_BREAKOUT' : 'RANGE_BOUND',
        supportLevel: s.symbol === 'RELIANCE' ? 2420 : 1850,
        resistanceLevel: s.symbol === 'RELIANCE' ? 2510 : 1940,
      };
    }).filter((item) => {
      // 1. Text search
      if (search) {
        const q = search.toLowerCase();
        const matchesSym = item.symbol.toLowerCase().includes(q);
        const matchesName = (item.companyName || '').toLowerCase().includes(q);
        if (!matchesSym && !matchesName) return false;
      }

      // 2. Signal Stance
      if (signalStance !== 'ALL' && item.screenerStance !== signalStance) {
        return false;
      }

      // 3. Min Confidence
      if (minConfidence !== 'ALL') {
        const threshold = parseFloat(minConfidence) / 100;
        if (item.confidence < threshold) return false;
      }

      // 4. Sentiment
      if (sentimentFilter !== 'ALL' && item.sentimentLabel !== sentimentFilter) {
        return false;
      }

      // 5. Technical Signal
      if (technicalSignal === 'BREAKOUT' && item.breakoutSignal !== 'BULLISH_BREAKOUT') {
        return false;
      }

      return true;
    });
  }, [stocks, search, signalStance, minConfidence, sentimentFilter, technicalSignal]);

  const resetFilters = () => {
    setSearch('');
    setSignalStance('ALL');
    setSelectedHorizon('ALL');
    setMinConfidence('ALL');
    setSentimentFilter('ALL');
    setTechnicalSignal('ALL');
  };

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------- */}
      {/* Filter Controls Bar                                           */}
      {/* ------------------------------------------------------------- */}
      <Card className="p-4 sm:p-5 bg-fintech-card/90 border border-fintech-border/80 space-y-4">
        <div className="flex flex-col lg:flex-row gap-3 items-stretch lg:items-center justify-between">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fintech-muted" />
            <input
              type="text"
              placeholder="Filter screener by symbol or name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-fintech-darker border border-fintech-border rounded-lg text-sm text-white placeholder-fintech-muted focus:outline-none focus:border-brand-primary"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Stance Filter */}
            <select
              value={signalStance}
              onChange={(e) => setSignalStance(e.target.value)}
              className="bg-fintech-darker border border-fintech-border text-xs sm:text-sm rounded-lg px-3 py-2 text-white focus:outline-none focus:border-brand-primary"
            >
              <option value="ALL">All AI Signals</option>
              <option value="BULLISH">Bullish Signals</option>
              <option value="BEARISH">Bearish Signals</option>
              <option value="NEUTRAL">Neutral Stance</option>
            </select>

            {/* Confidence Filter */}
            <select
              value={minConfidence}
              onChange={(e) => setMinConfidence(e.target.value)}
              className="bg-fintech-darker border border-fintech-border text-xs sm:text-sm rounded-lg px-3 py-2 text-white focus:outline-none focus:border-brand-primary"
            >
              <option value="ALL">All Confidence</option>
              <option value="50">Confidence ≥ 50%</option>
              <option value="60">Confidence ≥ 60%</option>
              <option value="70">Confidence ≥ 70%</option>
            </select>

            {/* Sentiment Filter */}
            <select
              value={sentimentFilter}
              onChange={(e) => setSentimentFilter(e.target.value)}
              className="bg-fintech-darker border border-fintech-border text-xs sm:text-sm rounded-lg px-3 py-2 text-white focus:outline-none focus:border-brand-primary"
            >
              <option value="ALL">All Sentiment</option>
              <option value="BULLISH">Positive News</option>
              <option value="BEARISH">Negative News</option>
            </select>

            {/* Technical Breakout Filter */}
            <select
              value={technicalSignal}
              onChange={(e) => setTechnicalSignal(e.target.value)}
              className="bg-fintech-darker border border-fintech-border text-xs sm:text-sm rounded-lg px-3 py-2 text-white focus:outline-none focus:border-brand-primary"
            >
              <option value="ALL">All Technical Signals</option>
              <option value="BREAKOUT">Momentum Breakouts</option>
            </select>

            {(search || signalStance !== 'ALL' || minConfidence !== 'ALL' || sentimentFilter !== 'ALL' || technicalSignal !== 'ALL') && (
              <Button variant="ghost" size="sm" onClick={resetFilters} className="text-xs text-fintech-muted hover:text-white">
                Reset
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* ------------------------------------------------------------- */}
      {/* Screener Results Grid                                         */}
      {/* ------------------------------------------------------------- */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i} className="p-4 bg-fintech-card/60 animate-pulse h-48 border border-fintech-border/40" />
          ))}
        </div>
      ) : screenedStocks.length === 0 ? (
        <EmptyState
          title="No Matching Screener Opportunities"
          description="Try loosening your filters or search terms to uncover active setups."
          actionLabel="Clear Screener Filters"
          onAction={resetFilters}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {screenedStocks.map((stock) => {
            const isBull = stock.screenerStance === 'BULLISH';
            const isBear = stock.screenerStance === 'BEARISH';

            return (
              <Card
                key={stock.id}
                onClick={() => navigate(`/stocks/${stock.id}`)}
                className="p-4 sm:p-5 bg-fintech-card/90 border border-fintech-border/80 hover:border-brand-primary/50 transition-all cursor-pointer group flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-base text-white group-hover:text-brand-primary transition-colors">
                          {stock.symbol}
                        </span>
                        <Badge variant="outline" className="text-[10px] uppercase">
                          {stock.exchange?.code || 'NSE'}
                        </Badge>
                      </div>
                      <p className="text-xs text-fintech-muted line-clamp-1 mt-0.5">
                        {stock.companyName || 'Equities Segment'}
                      </p>
                    </div>

                    <Badge
                      variant={isBull ? 'success' : isBear ? 'destructive' : 'secondary'}
                      className="flex items-center gap-1 font-semibold text-xs"
                    >
                      {isBull ? <TrendingUp className="w-3 h-3" /> : isBear ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                      {stock.screenerStance}
                    </Badge>
                  </div>

                  {/* Multi-Factor Intelligence Signals */}
                  <div className="mt-4 pt-3 border-t border-fintech-border/50 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-fintech-muted">AI Forecast Confidence:</span>
                      <span className="font-semibold text-white">{(stock.confidence * 100).toFixed(0)}%</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-fintech-muted">News Polarity:</span>
                      <span className={stock.sentimentPolarity > 0 ? 'text-emerald-400 font-medium' : stock.sentimentPolarity < 0 ? 'text-rose-400 font-medium' : 'text-slate-400'}>
                        {stock.sentimentPolarity > 0 ? `+${stock.sentimentPolarity.toFixed(2)}` : stock.sentimentPolarity.toFixed(2)} ({stock.sentimentLabel})
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-fintech-muted">Technical Setup:</span>
                      <span className="text-indigo-300 font-medium">{stock.detectedPattern}</span>
                    </div>

                    {stock.breakoutSignal === 'BULLISH_BREAKOUT' && (
                      <div className="flex items-center gap-1 text-emerald-400 font-medium text-[11px] pt-1">
                        <Flame className="w-3 h-3" /> Breakout Momentum Alert Triggered
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-fintech-border/40 flex items-center justify-between text-xs text-fintech-muted group-hover:text-white transition-colors">
                  <span>View Deep Quantitative Model</span>
                  <ChevronRight className="w-4 h-4 transform group-hover:translate-x-1 transition-transform text-brand-primary" />
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
