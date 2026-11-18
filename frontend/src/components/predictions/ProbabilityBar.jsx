import React from 'react';

/**
 * ProbabilityBar Component
 * Renders a segmented horizontal distribution bar representing probabilities for DOWN, NEUTRAL, and UP.
 *
 * @param {Object} props
 * @param {Object} props.probabilities Map with keys DOWN, NEUTRAL, UP (each a float 0.0 to 1.0)
 * @param {string} props.predictedLabel The winner class ('DOWN', 'NEUTRAL', 'UP')
 * @param {string} [props.className] Additional CSS class
 */
export default function ProbabilityBar({
  probabilities = { DOWN: 0, NEUTRAL: 0, UP: 0 },
  predictedLabel = 'NEUTRAL',
  className = '',
}) {
  const downPct = Math.max(0, Math.min(100, (probabilities?.DOWN ?? 0) * 100));
  const neutralPct = Math.max(0, Math.min(100, (probabilities?.NEUTRAL ?? 0) * 100));
  const upPct = Math.max(0, Math.min(100, (probabilities?.UP ?? 0) * 100));

  // Ensure total sum handles rounding or normalization
  const total = downPct + neutralPct + upPct;
  const normDown = total > 0 ? (downPct / total) * 100 : 33.33;
  const normNeutral = total > 0 ? (neutralPct / total) * 100 : 33.33;
  const normUp = total > 0 ? (upPct / total) * 100 : 33.33;

  return (
    <div className={`space-y-2 ${className}`}>
      {/* Visual Segmented Distribution Bar */}
      <div
        className="w-full h-3 rounded-full bg-slate-900 border border-slate-700/60 overflow-hidden flex"
        role="progressbar"
        aria-label="Directional Probability Distribution"
      >
        {/* DOWN Segment (Rose) */}
        {normDown > 0 && (
          <div
            style={{ width: `${normDown.toFixed(2)}%` }}
            className={`h-full bg-gradient-to-r from-rose-600 to-rose-500 transition-all duration-500 ${
              predictedLabel === 'DOWN' ? 'ring-1 ring-inset ring-rose-300' : 'opacity-85'
            }`}
            title={`DOWN: ${downPct.toFixed(1)}%`}
          />
        )}

        {/* NEUTRAL Segment (Slate) */}
        {normNeutral > 0 && (
          <div
            style={{ width: `${normNeutral.toFixed(2)}%` }}
            className={`h-full bg-gradient-to-r from-slate-600 to-slate-500 transition-all duration-500 ${
              predictedLabel === 'NEUTRAL' ? 'ring-1 ring-inset ring-slate-300' : 'opacity-85'
            }`}
            title={`NEUTRAL: ${neutralPct.toFixed(1)}%`}
          />
        )}

        {/* UP Segment (Emerald) */}
        {normUp > 0 && (
          <div
            style={{ width: `${normUp.toFixed(2)}%` }}
            className={`h-full bg-gradient-to-r from-emerald-600 to-emerald-500 transition-all duration-500 ${
              predictedLabel === 'UP' ? 'ring-1 ring-inset ring-emerald-300' : 'opacity-85'
            }`}
            title={`UP: ${upPct.toFixed(1)}%`}
          />
        )}
      </div>

      {/* Numeric Breakdown Labels */}
      <div className="grid grid-cols-3 gap-1 text-[11px] font-mono">
        {/* DOWN */}
        <div
          className={`px-2 py-1 rounded-md border transition-all text-center ${
            predictedLabel === 'DOWN'
              ? 'bg-rose-500/15 border-rose-500/40 text-rose-300 font-bold shadow-sm shadow-rose-950'
              : 'bg-slate-900/60 border-slate-800 text-slate-400'
          }`}
        >
          <div className="text-[9px] uppercase tracking-wider text-rose-400/80">DOWN</div>
          <div className="text-xs">{downPct.toFixed(1)}%</div>
        </div>

        {/* NEUTRAL */}
        <div
          className={`px-2 py-1 rounded-md border transition-all text-center ${
            predictedLabel === 'NEUTRAL'
              ? 'bg-slate-700/30 border-slate-600 text-slate-200 font-bold shadow-sm shadow-slate-950'
              : 'bg-slate-900/60 border-slate-800 text-slate-400'
          }`}
        >
          <div className="text-[9px] uppercase tracking-wider text-slate-400">NEUTRAL</div>
          <div className="text-xs">{neutralPct.toFixed(1)}%</div>
        </div>

        {/* UP */}
        <div
          className={`px-2 py-1 rounded-md border transition-all text-center ${
            predictedLabel === 'UP'
              ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 font-bold shadow-sm shadow-emerald-950'
              : 'bg-slate-900/60 border-slate-800 text-slate-400'
          }`}
        >
          <div className="text-[9px] uppercase tracking-wider text-emerald-400/80">UP</div>
          <div className="text-xs">{upPct.toFixed(1)}%</div>
        </div>
      </div>
    </div>
  );
}
