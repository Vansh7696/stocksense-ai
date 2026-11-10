import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useWatchlist } from '../context/WatchlistContext';
import {
  Bookmark,
  BookmarkCheck,
  ExternalLink,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Database,
  HardDrive,
  ArrowRight,
  TrendingUp,
} from 'lucide-react';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';

export default function WatchlistPage() {
  const { isAuthenticated, user } = useAuth();
  const { items, activeWatchlist, removeStock, isLoading, syncStatus } = useWatchlist();
  const navigate = useNavigate();

  const handleRowClick = (stock) => {
    const exchange = stock.exchange || stock.exchange?.code || 'NSE';
    navigate(`/stocks/${encodeURIComponent(stock.symbol)}?exchange=${exchange}`);
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* ------------------------------------------------------------- */}
      {/* Header & Title Section                                         */}
      {/* ------------------------------------------------------------- */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-fintech-border/80 gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
              <BookmarkCheck className="w-6 h-6 text-blue-400" />
              <span>{activeWatchlist?.name || 'Watchlist'}</span>
            </h1>
            <Badge variant="blue" size="sm" dot>
              {isAuthenticated ? 'POSTGRESQL SYNCED' : 'LOCAL GUEST STORAGE'}
            </Badge>
          </div>
          <p className="text-xs text-slate-400 mt-1 font-mono">
            {isAuthenticated
              ? `Persistent institutional watchlist for ${user?.email}`
              : 'Local browser watchlist. Sign in to synchronize across devices.'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate('/stocks')}
            className="flex items-center gap-1.5 font-mono text-xs"
          >
            <TrendingUp className="w-3.5 h-3.5" />
            <span>Explore Stocks</span>
          </Button>
        </div>
      </div>

      {/* ------------------------------------------------------------- */}
      {/* Guest Storage / Sync Status Banners                            */}
      {/* ------------------------------------------------------------- */}
      {!isAuthenticated && (
        <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <HardDrive className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-white">
                Guest Mode Active — Storing in Local Browser Storage
              </p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Sign in or register to automatically migrate your saved equities to PostgreSQL.
              </p>
            </div>
          </div>
          <Link
            to="/login"
            className="shrink-0 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-mono font-medium flex items-center gap-1.5 shadow-sm transition-colors"
          >
            <span>Sign In to Sync</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      )}

      {syncStatus && (
        <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-3 text-emerald-400 text-xs font-mono">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>
            Watchlist synchronized: {syncStatus.addedCount} items added from guest storage
            {syncStatus.skippedCount > 0 && `, ${syncStatus.skippedCount} duplicates skipped`}.
          </span>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* Watchlist Items Table                                         */}
      {/* ------------------------------------------------------------- */}
      <div className="bg-fintech-card border border-fintech-border rounded-xl shadow-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-fintech-border/80 flex items-center justify-between bg-fintech-surface/40">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-semibold text-slate-200">
              SAVED EQUITIES ({items.length})
            </span>
          </div>
          <div className="flex items-center gap-1 text-[11px] text-slate-400 font-mono">
            {isAuthenticated ? (
              <>
                <Database className="w-3.5 h-3.5 text-emerald-400" />
                <span>Cloud PostgreSQL Storage</span>
              </>
            ) : (
              <>
                <HardDrive className="w-3.5 h-3.5 text-blue-400" />
                <span>Browser LocalStorage</span>
              </>
            )}
          </div>
        </div>

        {items.length === 0 ? (
          <div className="py-16 text-center space-y-4">
            <div className="w-12 h-12 rounded-xl bg-slate-800/80 border border-slate-700/60 flex items-center justify-center mx-auto text-slate-500">
              <Bookmark className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">Your watchlist is empty</p>
              <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto font-mono">
                Bookmark Indian stocks from Stock Explorer or Stock Detail pages to track them here.
              </p>
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => navigate('/stocks')}
              className="inline-flex items-center gap-2 font-mono text-xs"
            >
              <span>Explore Indian Equities</span>
              <ArrowRight className="w-4 h-4" />
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-fintech-border/60 text-[11px] font-mono text-slate-400 uppercase tracking-wider bg-fintech-surface/20">
                  <th className="py-3 px-4 sm:px-6">Symbol</th>
                  <th className="py-3 px-4">Company Name</th>
                  <th className="py-3 px-4 text-center">Exchange</th>
                  <th className="py-3 px-4 text-center">Segment</th>
                  <th className="py-3 px-4">ISIN</th>
                  <th className="py-3 px-4 sm:px-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-fintech-border/40 text-xs font-mono">
                {items.map((stock) => {
                  const ex = stock.exchange || stock.exchange?.code || 'NSE';
                  return (
                    <tr
                      key={stock.id || stock.symbol}
                      onClick={() => handleRowClick(stock)}
                      className="hover:bg-fintech-surface/60 transition-colors cursor-pointer group"
                    >
                      <td className="py-3.5 px-4 sm:px-6 font-semibold text-white group-hover:text-blue-400 transition-colors">
                        <div className="flex items-center gap-2">
                          <span>{stock.symbol}</span>
                          <ExternalLink className="w-3.5 h-3.5 text-slate-600 group-hover:text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-slate-300 font-sans truncate max-w-xs">
                        {stock.companyName || stock.name || stock.symbol}
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-300 border border-slate-700">
                          {ex}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-center text-slate-400">
                        {stock.segment || 'EQ'}
                      </td>
                      <td className="py-3.5 px-4 text-slate-500 text-[11px]">
                        {stock.isin || '—'}
                      </td>
                      <td className="py-3.5 px-4 sm:px-6 text-right" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => removeStock(stock.id || stock.symbol)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                          title="Remove from watchlist"
                          aria-label={`Remove ${stock.symbol} from watchlist`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
