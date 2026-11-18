import React, { useState } from 'react';
import {
  Sparkles,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  HelpCircle,
  Cpu,
  Layers,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Card, Badge } from '../ui';
import {
  formatFeatureValue,
  computeAttributionBarWidths,
  isAttributionSupporting,
} from '../../utils/explainability';

export { formatFeatureValue, computeAttributionBarWidths, isAttributionSupporting };

/**
 * FeatureAttributionCard Component
 * Displays mathematical feature attribution decomposition (Tree SHAP / Tree Path Impurity).
 * Explains which technical indicators drove the prediction and in what direction.
 */
export default function FeatureAttributionCard({
  attributions = [],
  horizon = 1,
  predictedLabel = 'UP',
  modelAlgorithm = 'XGBoost',
  className = '',
}) {
  const [expandedIndex, setExpandedIndex] = useState(null);

  if (!attributions || attributions.length === 0) {
    return null;
  }

  // Determine max absolute contribution for bar normalization
  const maxAbsContrib = Math.max(
    ...attributions.map((a) => Math.abs(a.contribution || 0)),
    0.0001
  );

  const toggleExpand = (idx) => {
    setExpandedIndex((prev) => (prev === idx ? null : idx));
  };

  const isBullish = predictedLabel === 'UP';
  const isBearish = predictedLabel === 'DOWN';

  return (
    <Card
      className={`p-5 bg-gradient-to-b from-fintech-surface via-fintech-card to-fintech-surface border border-fintech-border shadow-md ${className}`}
    >
      <div className="space-y-4">
        {/* Header: Title and Model Methodology */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-fintech-border/70 pb-3">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold font-mono text-white tracking-tight">
                Decision Transparency & Feature Attribution
              </h3>
              <p className="text-[11px] font-mono text-slate-400">
                Top technical indicators driving the T+{horizon} forecast
              </p>
            </div>
          </div>

          <Badge variant="cyan" size="xs" mono>
            <Cpu className="w-3 h-3 mr-1 inline" />
            {modelAlgorithm.includes('XGBoost')
              ? 'Tree SHAP Attribution'
              : modelAlgorithm.includes('Forest')
              ? 'Tree Path Impurity'
              : 'Weight Attribution'}
          </Badge>
        </div>

        {/* Feature Attribution List */}
        <div className="space-y-3 pt-1">
          {attributions.map((attr, idx) => {
            const contrib = attr.contribution || 0;
            const isPositive = contrib > 0;
            const absContrib = Math.abs(contrib);
            const barWidthPct = Math.min(100, Math.max(8, (absContrib / maxAbsContrib) * 100));
            const formattedVal = formatFeatureValue(attr.feature, attr.value);
            const isExpanded = expandedIndex === idx;

            // Visual styles based on positive reinforcement vs opposing friction
            const isSupporting =
              (isBullish && attr.direction === 'UP') ||
              (isBearish && attr.direction === 'DOWN') ||
              (!isBullish && !isBearish && isPositive);

            const barColor = isSupporting
              ? 'bg-gradient-to-r from-emerald-600 to-emerald-400'
              : 'bg-gradient-to-r from-rose-600 to-rose-400';

            const scoreColor = isSupporting ? 'text-emerald-400' : 'text-rose-400';
            const badgeVariant = isSupporting ? 'bullish' : 'bearish';

            return (
              <div
                key={attr.feature || idx}
                className="p-3 rounded-xl bg-slate-900/60 border border-fintech-border/80 hover:border-slate-700 transition-all cursor-pointer"
                onClick={() => toggleExpand(idx)}
              >
                <div className="flex items-center justify-between gap-3 text-xs font-mono">
                  {/* Indicator Name and Observed Value */}
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] text-slate-500 font-bold shrink-0">
                      #{idx + 1}
                    </span>
                    <span className="text-slate-200 font-semibold truncate">
                      {attr.displayName || attr.display_name || attr.feature}
                    </span>
                    <Badge variant="neutral" size="xs" mono className="shrink-0 text-[10px] py-0">
                      val: {formattedVal}
                    </Badge>
                  </div>

                  {/* Contribution Score and Direction Badge */}
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={badgeVariant} size="xs" mono className="text-[10px]">
                      {isSupporting ? (
                        <ArrowUpRight className="w-3 h-3 mr-0.5 inline" />
                      ) : (
                        <ArrowDownRight className="w-3 h-3 mr-0.5 inline" />
                      )}
                      {isSupporting ? 'SUPPORTS' : 'OPPOSES'}
                    </Badge>

                    <span className={`font-mono font-bold ${scoreColor}`}>
                      {contrib >= 0 ? `+${contrib.toFixed(3)}` : contrib.toFixed(3)}
                    </span>

                    {isExpanded ? (
                      <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                    )}
                  </div>
                </div>

                {/* Relative Contribution Bar */}
                <div className="mt-2 w-full bg-slate-800/80 rounded-full h-1.5 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${barColor}`}
                    style={{ width: `${barWidthPct}%` }}
                  />
                </div>

                {/* Expandable Contextual Interpretation */}
                {isExpanded && (
                  <div className="mt-2.5 pt-2 border-t border-slate-800/80 text-[11px] font-sans text-slate-300 leading-relaxed animate-fadeIn">
                    <p>{attr.description || 'Feature contribution calculated from decision path splits.'}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer Guidance */}
        <div className="pt-2 border-t border-fintech-border/50 text-[10px] font-mono text-slate-500 flex items-center justify-between">
          <span>Click any feature for market interpretation</span>
          <span className="text-slate-400">Green = Reinforces Forecast • Red = Opposing Drag</span>
        </div>
      </div>
    </Card>
  );
}
