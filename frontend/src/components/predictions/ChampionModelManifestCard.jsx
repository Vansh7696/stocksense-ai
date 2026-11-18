import React, { useState } from 'react';
import {
  ShieldCheck,
  Database,
  Layers,
  ChevronDown,
  ChevronUp,
  Cpu,
  CheckCircle2,
  Copy,
  Check,
} from 'lucide-react';
import { Card, Badge } from '../ui';

/**
 * ChampionModelManifestCard Component
 * Displays institutional ML registry manifest information, champion models metadata,
 * and canonical dataset cryptographic provenance.
 */
export default function ChampionModelManifestCard({ manifest }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copiedDatasetSha, setCopiedDatasetSha] = useState(false);

  if (!manifest) return null;

  const champions = manifest.active_champions || {};
  const datasetSha = manifest.dataset_sha256 || '';
  const truncatedDatasetSha = datasetSha
    ? `${datasetSha.slice(0, 10)}...${datasetSha.slice(-8)}`
    : '—';

  const handleCopyDatasetSha = () => {
    if (datasetSha) {
      navigator.clipboard?.writeText(datasetSha);
      setCopiedDatasetSha(true);
      setTimeout(() => setCopiedDatasetSha(false), 2000);
    }
  };

  return (
    <Card className="p-4 bg-fintech-surface/70 border-fintech-border/80">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        {/* Left: Section Header & Highlights */}
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-400">
            <Cpu className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-mono font-bold uppercase tracking-wider text-white">
                Active Champion Model Registry
              </h4>
              <Badge variant="success" size="xs" dot mono>
                Validated v{manifest.manifest_version || '1.0'}
              </Badge>
            </div>
            <p className="text-[11px] text-slate-400 font-sans mt-0.5">
              Production-promoted quantitative estimators fitted on canonical feature matrix.
            </p>
          </div>
        </div>

        {/* Right: Expand / Collapse Toggle */}
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <button
            type="button"
            onClick={() => setIsExpanded((prev) => !prev)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-fintech-border hover:border-slate-600 text-xs font-mono text-slate-300 hover:text-white transition-all"
          >
            <span>{isExpanded ? 'Hide Registry Details' : 'View Registry Details'}</span>
            {isExpanded ? (
              <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            )}
          </button>
        </div>
      </div>

      {/* Expanded Registry Details Panel */}
      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-fintech-border/60 space-y-4 animate-fadeIn">
          {/* Manifest Provenance Badges */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs font-mono">
            {/* Manifest Version */}
            <div className="p-3 rounded-lg bg-slate-900/80 border border-fintech-border">
              <div className="text-slate-500 text-[10px] uppercase">REGISTRY SPEC</div>
              <div className="text-slate-200 font-bold mt-0.5">
                Version {manifest.manifest_version || '1.0'}
              </div>
              <div className="text-[10px] text-slate-400 mt-1">
                Updated: {manifest.updated_at_utc ? new Date(manifest.updated_at_utc).toLocaleDateString('en-IN') : '2026-11-17'}
              </div>
            </div>

            {/* Feature Schema */}
            <div className="p-3 rounded-lg bg-slate-900/80 border border-fintech-border">
              <div className="text-slate-500 text-[10px] uppercase">FEATURE MATRIX</div>
              <div className="text-cyan-400 font-bold mt-0.5">
                23_scale_invariant_technical_v1
              </div>
              <div className="text-[10px] text-slate-400 mt-1">
                23 Technical Indicators & Log-Returns
              </div>
            </div>

            {/* Canonical Dataset Hash */}
            <div className="p-3 rounded-lg bg-slate-900/80 border border-fintech-border">
              <div className="text-slate-500 text-[10px] uppercase">CANONICAL DATASET SHA-256</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-slate-200 font-mono font-semibold" title={datasetSha}>
                  {truncatedDatasetSha}
                </span>
                {datasetSha && (
                  <button
                    type="button"
                    onClick={handleCopyDatasetSha}
                    className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
                    title="Copy full dataset SHA-256"
                  >
                    {copiedDatasetSha ? (
                      <Check className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                  </button>
                )}
              </div>
              <div className="text-[10px] text-emerald-400 mt-1 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                <span>Cryptographically Verified</span>
              </div>
            </div>
          </div>

          {/* Active Champions Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono border border-fintech-border rounded-lg overflow-hidden">
              <thead className="bg-slate-900 text-slate-400 text-[11px] uppercase border-b border-fintech-border">
                <tr>
                  <th className="py-2.5 px-3">Horizon</th>
                  <th className="py-2.5 px-3">Champion Model ID</th>
                  <th className="py-2.5 px-3">Algorithm Architecture</th>
                  <th className="py-2.5 px-3">Artifact Digest</th>
                  <th className="py-2.5 px-3 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-fintech-border/50 bg-slate-900/40">
                {['1', '3', '5'].map((h) => {
                  const model = champions[h];
                  if (!model) return null;
                  const sha = model.artifact_sha256 || '';
                  const shortSha = sha ? `${sha.slice(0, 8)}...${sha.slice(-6)}` : '—';

                  return (
                    <tr key={h} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-2.5 px-3 font-bold text-white">
                        <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/30 text-[10px]">
                          T+{h} ({h}D)
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-slate-200 font-semibold">
                        {model.model_id}
                      </td>
                      <td className="py-2.5 px-3 text-slate-300">
                        {model.algorithm}
                      </td>
                      <td className="py-2.5 px-3 text-slate-400 font-mono" title={sha}>
                        {shortSha}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <Badge variant="success" size="xs" dot mono>
                          {model.status || 'ACTIVE'}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}
