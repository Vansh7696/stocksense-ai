import React, { useState } from 'react';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Clock,
  Cpu,
  ShieldCheck,
  Check,
  Copy,
  ChevronDown,
  ChevronUp,
  Info,
} from 'lucide-react';
import { Card, Badge } from '../ui';
import ProbabilityBar from './ProbabilityBar';

/**
 * Maps horizon number to standard visual accents and title badges.
 */
function getHorizonHeader(horizon) {
  switch (Number(horizon)) {
    case 1:
      return {
        tag: 'T+1 Session',
        title: '1-Day Forecast',
        subtitle: 'Next Session Close',
        badgeVariant: 'cyan',
      };
    case 3:
      return {
        tag: 'T+3 Sessions',
        title: '3-Day Forecast',
        subtitle: 'Multi-Session Trend',
        badgeVariant: 'purple',
      };
    case 5:
      return {
        tag: 'T+5 Sessions',
        title: '5-Day Forecast',
        subtitle: '5 Trading Sessions',
        badgeVariant: 'info',
      };
    default:
      return {
        tag: `T+${horizon}`,
        title: `${horizon}-Day Forecast`,
        subtitle: `${horizon} Trading Days`,
        badgeVariant: 'neutral',
      };
  }
}

/**
 * Returns visual styling for predicted class labels.
 */
function getDirectionMeta(label) {
  switch (label) {
    case 'UP':
      return {
        text: 'BULLISH (UP)',
        badgeVariant: 'bullish',
        cardBorder: 'border-emerald-500/40 hover:border-emerald-500/60',
        glowColor: 'shadow-emerald-500/10',
        textColor: 'text-emerald-400',
        bgAccent: 'bg-emerald-500/10',
        Icon: TrendingUp,
      };
    case 'DOWN':
      return {
        text: 'BEARISH (DOWN)',
        badgeVariant: 'bearish',
        cardBorder: 'border-rose-500/40 hover:border-rose-500/60',
        glowColor: 'shadow-rose-500/10',
        textColor: 'text-rose-400',
        bgAccent: 'bg-rose-500/10',
        Icon: TrendingDown,
      };
    case 'NEUTRAL':
    default:
      return {
        text: 'NEUTRAL (CONSOLIDATION)',
        badgeVariant: 'neutral',
        cardBorder: 'border-slate-700 hover:border-slate-600',
        glowColor: 'shadow-slate-500/5',
        textColor: 'text-slate-300',
        bgAccent: 'bg-slate-800/60',
        Icon: Minus,
      };
  }
}

/**
 * HorizonPredictionCard Component
 * Displays a single horizon directional forecast with full probabilistic breakdown,
 * threshold definition, execution timing, and model provenance.
 */
export default function HorizonPredictionCard({ prediction }) {
  const [copiedSha, setCopiedSha] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  if (!prediction) return null;

  const {
    horizon = 1,
    horizonLabel,
    predictedLabel = 'NEUTRAL',
    confidence = 0,
    probabilities = { DOWN: 0, NEUTRAL: 0, UP: 0 },
    targetThresholdPct = 0.5,
    targetDefinition,
    entryTiming = 'Next Session Open (O[t+1])',
    exitTiming = `Target Session Close (C[t+${horizon}])`,
    model = {},
    executionTimeMs = 0,
  } = prediction;

  const header = getHorizonHeader(horizon);
  const dir = getDirectionMeta(predictedLabel);
  const DirectionIcon = dir.Icon;

  const confidencePct = (confidence * 100).toFixed(1);
  const thresholdPctFormatted = Number(targetThresholdPct).toFixed(1);

  // Compute expected directional return text
  let expectedMovementText = '';
  if (predictedLabel === 'UP') {
    expectedMovementText = `Return > +${thresholdPctFormatted}%`;
  } else if (predictedLabel === 'DOWN') {
    expectedMovementText = `Return < -${thresholdPctFormatted}%`;
  } else {
    expectedMovementText = `Return within [ -${thresholdPctFormatted}%, +${thresholdPctFormatted}% ]`;
  }

  // Handle copying artifact SHA-256
  const handleCopySha = (e) => {
    e.stopPropagation();
    if (model.artifactSha256) {
      navigator.clipboard?.writeText(model.artifactSha256);
      setCopiedSha(true);
      setTimeout(() => setCopiedSha(false), 2000);
    }
  };

  const truncatedSha = model.artifactSha256
    ? `${model.artifactSha256.slice(0, 8)}...${model.artifactSha256.slice(-6)}`
    : '—';

  return (
    <Card
      className={`p-5 flex flex-col justify-between transition-all duration-300 shadow-lg ${dir.cardBorder} ${dir.glowColor} bg-gradient-to-b from-fintech-surface via-fintech-card to-fintech-surface`}
    >
      <div className="space-y-4">
        {/* Card Header: Horizon Tag & Title */}
        <div className="flex items-start justify-between gap-2 border-b border-fintech-border/60 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <Badge variant={header.badgeVariant} size="xs" mono>
                {header.tag}
              </Badge>
              <span className="text-[11px] font-mono text-slate-400">
                {header.subtitle}
              </span>
            </div>
            <h3 className="text-base font-bold text-white mt-1 font-mono tracking-tight">
              {header.title}
            </h3>
          </div>

          {/* Model Family Badge */}
          <div className="text-right">
            <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 block">
              CHAMPION
            </span>
            <span className="text-xs font-mono font-semibold text-slate-300">
              {model.modelId?.split('_')?.[0]?.toUpperCase() || 'ML'}
            </span>
          </div>
        </div>

        {/* Primary Direction & Confidence Callout */}
        <div className={`p-4 rounded-xl border ${dir.cardBorder} ${dir.bgAccent} flex items-center justify-between`}>
          <div className="space-y-1">
            <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 block">
              PREDICTED DIRECTION
            </span>
            <div className="flex items-center gap-2">
              <DirectionIcon className={`w-5 h-5 ${dir.textColor}`} />
              <span className={`text-base font-black font-mono tracking-tight ${dir.textColor}`}>
                {dir.text}
              </span>
            </div>
          </div>

          <div className="text-right space-y-0.5">
            <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 block">
              CONFIDENCE
            </span>
            <div className="text-lg font-black font-mono text-white">
              {confidencePct}%
            </div>
          </div>
        </div>

        {/* Expected Movement & Threshold */}
        <div className="p-3 rounded-lg bg-slate-900/60 border border-fintech-border/70 space-y-1.5 text-xs font-mono">
          <div className="flex items-center justify-between text-slate-400 text-[11px]">
            <span>EXPECTED MOVEMENT</span>
            <span className="text-slate-300 font-semibold">{expectedMovementText}</span>
          </div>
          <div className="flex items-center justify-between text-slate-500 text-[10px]">
            <span>TARGET THRESHOLD</span>
            <span className="text-slate-400 font-mono">±{thresholdPctFormatted}%</span>
          </div>
          {targetDefinition && (
            <div className="text-[10px] text-slate-400/90 pt-1 border-t border-slate-800/80 leading-relaxed font-sans">
              {targetDefinition}
            </div>
          )}
        </div>

        {/* Probability Distribution Visualization */}
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
            <span>PROBABILITY DISTRIBUTION</span>
            <span className="text-slate-500 text-[10px]">3-Class Softmax</span>
          </div>
          <ProbabilityBar
            probabilities={probabilities}
            predictedLabel={predictedLabel}
          />
        </div>

        {/* Execution Timing Window */}
        <div className="pt-2 border-t border-fintech-border/50 text-[11px] font-mono space-y-1">
          <div className="flex items-center justify-between text-slate-400">
            <span className="flex items-center gap-1.5 text-slate-400">
              <Clock className="w-3.5 h-3.5 text-blue-400" />
              <span>Entry:</span>
            </span>
            <span className="text-slate-200 font-medium">{entryTiming}</span>
          </div>
          <div className="flex items-center justify-between text-slate-400">
            <span className="flex items-center gap-1.5 text-slate-400">
              <Clock className="w-3.5 h-3.5 text-purple-400" />
              <span>Exit:</span>
            </span>
            <span className="text-slate-200 font-medium">{exitTiming}</span>
          </div>
        </div>
      </div>

      {/* Card Footer: Model Provenance Details */}
      <div className="mt-4 pt-3 border-t border-fintech-border/70">
        <button
          type="button"
          onClick={() => setShowDetails((prev) => !prev)}
          className="w-full flex items-center justify-between text-[11px] font-mono text-slate-400 hover:text-white transition-colors"
        >
          <span className="flex items-center gap-1.5">
            <Cpu className="w-3.5 h-3.5 text-cyan-400" />
            <span>Model Provenance & Latency</span>
          </span>
          {showDetails ? (
            <ChevronUp className="w-3.5 h-3.5 text-slate-500" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
          )}
        </button>

        {showDetails && (
          <div className="mt-3 p-3 rounded-lg bg-slate-900/90 border border-fintech-border space-y-2 text-[10px] font-mono text-slate-400 animate-fadeIn">
            <div className="flex justify-between items-center">
              <span className="text-slate-500">MODEL ID:</span>
              <span className="text-slate-200 font-bold">{model.modelId || '—'}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-500">ALGORITHM:</span>
              <span className="text-slate-300 truncate max-w-[180px]" title={model.algorithm}>
                {model.algorithm || '—'}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-500">FEATURE SCHEMA:</span>
              <span className="text-cyan-400">{model.featureSchemaVersion || 'v1'}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-500">SHA-256:</span>
              <div className="flex items-center gap-1">
                <span className="text-slate-300 font-mono" title={model.artifactSha256}>
                  {truncatedSha}
                </span>
                {model.artifactSha256 && (
                  <button
                    type="button"
                    onClick={handleCopySha}
                    className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
                    title="Copy full artifact SHA-256 digest"
                  >
                    {copiedSha ? (
                      <Check className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                  </button>
                )}
              </div>
            </div>
            <div className="flex justify-between items-center pt-1 border-t border-slate-800">
              <span className="text-slate-500">INFERENCE TIME:</span>
              <span className="text-emerald-400 font-semibold">{executionTimeMs.toFixed(2)} ms</span>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
