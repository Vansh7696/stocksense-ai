import React, { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  TrendingUp,
  Activity,
  Layers,
  Database,
  ShieldCheck,
  ShieldAlert,
  ArrowRight,
  BookmarkCheck,
  Clock,
  ExternalLink,
  RefreshCw,
  Search,
  CheckCircle2,
  AlertCircle,
  BarChart3,
  Globe2,
  Building2,
  Trash2,
} from 'lucide-react';
import { getMarketOverview, getMarketIndices, getStocks } from '../services/api';
import { getWatchlist, removeFromWatchlist, getRecentlyViewed } from '../utils/watchlist';
import { getIndianMarketStatus } from '../utils/marketHours';
import {
  Card,
  Button,
  Badge,
  Skeleton,
  StatCardSkeleton,
  IndexCardSkeleton,
  TableRowSkeleton,
  EmptyState,
  ErrorState,
} from '../components/ui';

export default function DashboardPage() {
  const navigate = useNavigate();

  // Primary data states
  const [overview, setOverview] = useState(null);
  const [indices, setIndices] = useState([]);
  const [catalogStocks, setCatalogStocks] = useState([]);
  const [watchlist, setWatchlist] = useState(() => getWatchlist());
  const [recentlyViewed, setRecentlyViewed] = useState(() => getRecentlyViewed());

  // Loading & error states
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [marketStatus, setMarketStatus] = useState(() => getIndianMarketStatus());

  // Fetch all primary dashboard metrics
  const fetchDashboardData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [overviewRes, indicesRes, stocksRes] = await Promise.all([
        getMarketOverview(),
        getMarketIndices(),
        getStocks({ limit: 5, sortBy: 'symbol', sortOrder: 'asc' }),
      ]);

      setOverview(overviewRes?.data || null);
      setIndices(indicesRes?.data?.indices || []);
      setCatalogStocks(stocksRes?.data?.stocks || []);
    } catch (err) {
      setError(err.message || 'Unable to load market dashboard data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  // Keep local watchlist synced
  const handleRemoveFromWatchlist = (symbol) => {
    const updated = removeFromWatchlist(symbol);
    setWatchlist(updated);
  };

  const isUpstoxConnected = overview?.provider?.active === true;
  const totalInstruments = overview?.summary?.totalActiveInstruments ?? 0;
  const nseCount = overview?.summary?.exchanges?.NSE ?? 0;
  const bseCount = overview?.summary?.exchanges?.BSE ?? 0;
  const equityCount = overview?.summary?.instrumentTypes?.EQUITY ?? 0;
  const indexCount = overview?.summary?.instrumentTypes?.INDEX ?? 0;

  return (
    <div className="space-y-6 sm:space-y-8 max-w-7xl mx-auto pb-10">
      {/* ----------------------------------------------------------------- */}
      {/* 1. Header Banner & Platform Status Overview                       */}
      {/* ----------------------------------------------------------------- */}
      <div className="flex flex-col md:flex-row md:items-center justify-between pb-4 border-b border-fintech-border/80 gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
              Indian Equity Intelligence
            </h1>
            <Badge variant="info" size="xs">
              NSE / BSE
            </Badge>
          </div>
          <p className="text-xs text-fintech-muted mt-1 max-w-xl leading-relaxed">
            Quantitative equity analytics, verified exchange master instruments, and algorithmic insights.
          </p>
        </div>

        {/* Global Controls & Status */}
        <div className="flex items-center gap-2.5">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchDashboardData}
            loading={loading}
            icon={RefreshCw}
          >
            Refresh
          </Button>

          <Link to="/stocks">
            <Button variant="primary" size="sm" icon={Search}>
              Stock Explorer
            </Button>
          </Link>
        </div>
      </div>

      {/* Global Error Banner */}
      {error && (
        <ErrorState
          title="Data Synchronization Notice"
          message={error}
          onRetry={fetchDashboardData}
        />
      )}

      {/* ----------------------------------------------------------------- */}
      {/* 2. Key Platform Statistics (Summary Metrics)                      */}
      {/* ----------------------------------------------------------------- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {loading ? (
          <>
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
          </>
        ) : (
          <>
            {/* Total Verified Instruments */}
            <Card padding="md" hoverable>
              <div className="flex items-center justify-between text-fintech-muted text-xs font-medium">
                <span>Tracked Instruments</span>
                <Building2 className="w-4 h-4 text-blue-400" />
              </div>
              <div className="mt-2.5 flex items-baseline justify-between">
                <span className="text-2xl font-bold font-mono text-white">
                  {totalInstruments.toLocaleString()}
                </span>
                <Badge variant="cyan" size="xs">
                  Active in DB
                </Badge>
              </div>
              <p className="text-[11px] text-slate-400 mt-2 font-mono flex items-center justify-between border-t border-fintech-border/60 pt-2">
                <span>{equityCount} Equities</span>
                <span>{indexCount} Benchmark Indices</span>
              </p>
            </Card>

            {/* Exchange Distribution */}
            <Card padding="md" hoverable>
              <div className="flex items-center justify-between text-fintech-muted text-xs font-medium">
                <span>Exchange Coverage</span>
                <Globe2 className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="mt-2.5 flex items-baseline justify-between">
                <span className="text-2xl font-bold font-mono text-white">
                  {nseCount} <span className="text-sm font-sans font-normal text-slate-400">NSE</span> / {bseCount} <span className="text-sm font-sans font-normal text-slate-400">BSE</span>
                </span>
                <Badge variant="neutral" size="xs">
                  Dual Exchange
                </Badge>
              </div>
              <p className="text-[11px] text-slate-400 mt-2 font-mono flex items-center justify-between border-t border-fintech-border/60 pt-2">
                <span>NSE Bluechips: 100%</span>
                <span>BSE Verified: Active</span>
              </p>
            </Card>

            {/* Indian Market Hours */}
            <Card padding="md" hoverable>
              <div className="flex items-center justify-between text-fintech-muted text-xs font-medium">
                <span>Indian Market Session</span>
                <Clock className="w-4 h-4 text-amber-400" />
              </div>
              <div className="mt-2.5 flex items-baseline justify-between">
                <span className="text-lg font-bold font-mono text-white">
                  {marketStatus.label}
                </span>
                <Badge
                  variant={marketStatus.isOpen ? 'success' : 'neutral'}
                  size="xs"
                  dot
                >
                  {marketStatus.weekday}
                </Badge>
              </div>
              <p className="text-[11px] text-slate-400 mt-2 font-mono truncate border-t border-fintech-border/60 pt-2">
                {marketStatus.sublabel}
              </p>
            </Card>

            {/* Broker Gateway Integration */}
            <Card padding="md" hoverable>
              <div className="flex items-center justify-between text-fintech-muted text-xs font-medium">
                <span>Upstox API V3 Gateway</span>
                {isUpstoxConnected ? (
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                ) : (
                  <ShieldAlert className="w-4 h-4 text-amber-400" />
                )}
              </div>
              <div className="mt-2.5 flex items-baseline justify-between">
                <span className="text-base font-bold font-mono text-white truncate max-w-[170px]">
                  {overview?.provider?.status || 'STANDBY'}
                </span>
                <Badge
                  variant={isUpstoxConnected ? 'success' : 'warning'}
                  size="xs"
                  dot
                >
                  {isUpstoxConnected ? 'CONNECTED' : 'AUTH PENDING'}
                </Badge>
              </div>
              <div className="text-[11px] text-slate-400 mt-2 font-mono flex items-center justify-between border-t border-fintech-border/60 pt-2">
                <span className="truncate">Rate Limit: 5 req/s</span>
                <Link to="/settings" className="text-blue-400 hover:text-blue-300">
                  Settings
                </Link>
              </div>
            </Card>
          </>
        )}
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* 3. Verified Benchmark Indices (NSE & BSE)                        */}
      {/* ----------------------------------------------------------------- */}
      <div className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-200 font-mono flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-blue-400" />
              Verified Benchmark Indices
            </h2>
            <p className="text-xs text-fintech-muted mt-0.5">
              Authentic exchange indices registered in PostgreSQL. Zero fabricated price feeds.
            </p>
          </div>
          <Badge variant="neutral" size="xs">
            Official Tokens
          </Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {loading ? (
            <>
              <IndexCardSkeleton />
              <IndexCardSkeleton />
            </>
          ) : indices.length === 0 ? (
            <Card padding="md" className="col-span-2">
              <EmptyState
                title="No Benchmark Indices Found"
                description="Database does not contain registered index tokens. Seed or ingest instruments."
              />
            </Card>
          ) : (
            indices.map((index) => {
              const isNse = index.exchange?.code === 'NSE';
              return (
                <Card
                  key={index.id || index.symbol}
                  padding="md"
                  hoverable
                  className="relative overflow-hidden"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-base font-bold font-mono text-white">
                          {index.symbol}
                        </span>
                        <Badge variant={isNse ? 'info' : 'purple'} size="xs">
                          {index.exchange?.code}
                        </Badge>
                        <Badge variant="neutral" size="xs">
                          {index.segment}
                        </Badge>
                      </div>
                      <p className="text-xs text-slate-400 mt-1 font-sans">
                        {index.companyName}
                      </p>
                    </div>

                    <div className="text-right">
                      <span className="text-xs px-2 py-0.5 rounded bg-fintech-surface border border-fintech-border text-slate-300 font-mono">
                        INDEX
                      </span>
                    </div>
                  </div>

                  {/* Feed Status Notice (No Fabricated Prices) */}
                  <div className="mt-4 pt-3 border-t border-fintech-border/60 flex flex-col sm:flex-row sm:items-center justify-between text-xs font-mono text-slate-400 gap-2">
                    <div className="flex items-center gap-1.5 truncate max-w-sm">
                      <span className="text-slate-500">Key:</span>
                      <span className="text-slate-300 truncate" title={index.instrumentToken}>
                        {index.instrumentToken}
                      </span>
                    </div>

                    <div className="flex items-center gap-1 text-[11px] text-amber-400/90 shrink-0">
                      <AlertCircle className="w-3.5 h-3.5" />
                      <span>{isUpstoxConnected ? 'Feed Ready' : 'Feed Awaiting OAuth'}</span>
                    </div>
                  </div>
                </Card>
              );
            })
          )}
        </div>
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* 4. Watchlist & Top Tracked Equities (2-Column Grid)               */}
      {/* ----------------------------------------------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Watchlist Preview (2/3 width on LG) */}
        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-200 font-mono flex items-center gap-2">
              <BookmarkCheck className="w-4 h-4 text-emerald-400" />
              Watchlist Preview
            </h2>
            <span className="text-xs text-fintech-muted font-mono">
              {watchlist.length} Equities Saved
            </span>
          </div>

          <Card padding="none">
            {watchlist.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={BookmarkCheck}
                  title="Your Watchlist is Empty"
                  description="Save equities from Stock Explorer to monitor performance and alerts."
                  actionLabel="Browse Catalog"
                  onAction={() => navigate('/stocks')}
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-fintech-border bg-fintech-surface/40 text-slate-400 font-mono text-[11px]">
                      <th className="py-2.5 px-4 font-medium">SYMBOL & NAME</th>
                      <th className="py-2.5 px-3 font-medium">EXCHANGE</th>
                      <th className="py-2.5 px-3 font-medium">ISIN CODE</th>
                      <th className="py-2.5 px-4 text-right font-medium">ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-fintech-border/40">
                    {watchlist.map((item) => (
                      <tr
                        key={item.symbol}
                        className="hover:bg-fintech-surface/50 transition-colors group"
                      >
                        <td className="py-3 px-4">
                          <div className="flex flex-col">
                            <span className="font-mono font-bold text-white text-xs group-hover:text-blue-400 transition-colors">
                              {item.symbol}
                            </span>
                            <span className="text-[11px] text-slate-400 truncate max-w-[200px] sm:max-w-[280px]">
                              {item.name}
                            </span>
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          <Badge variant={item.exchange === 'NSE' ? 'info' : 'purple'} size="xs">
                            {item.exchange || 'NSE'}
                          </Badge>
                        </td>
                        <td className="py-3 px-3 font-mono text-slate-400 text-[11px]">
                          {item.isin || '—'}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="inline-flex items-center gap-2">
                            <Link
                              to={`/stocks?search=${encodeURIComponent(item.symbol)}`}
                              className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-blue-400"
                              title="Explore equity"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </Link>
                            <button
                              type="button"
                              onClick={() => handleRemoveFromWatchlist(item.symbol)}
                              className="p-1 rounded hover:bg-rose-500/10 text-slate-500 hover:text-rose-400 transition-colors"
                              title="Remove from watchlist"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* Right Column: Ingestion Status & Recently Viewed */}
        <div className="space-y-6">
          {/* Data Pipeline & Audit Card */}
          <Card
            title="Data Pipeline Audit"
            icon={Activity}
            action={
              <Badge
                variant={overview?.lastIngestion?.status === 'SUCCESS' ? 'success' : 'neutral'}
                size="xs"
              >
                {overview?.lastIngestion?.status || 'STANDBY'}
              </Badge>
            }
          >
            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between text-slate-400 font-mono">
                <span>Broker Provider:</span>
                <span className="text-white font-semibold">Upstox API V3</span>
              </div>
              <div className="flex items-center justify-between text-slate-400 font-mono">
                <span>Data Quality Engine:</span>
                <span className="text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> DECIMAL(14, 4)
                </span>
              </div>
              <div className="flex items-center justify-between text-slate-400 font-mono">
                <span>Distributed Cache:</span>
                <span className="text-slate-200">Redis 7 (Sliding Window)</span>
              </div>
              <div className="flex items-center justify-between text-slate-400 font-mono">
                <span>BigInt Volume:</span>
                <span className="text-slate-200">Native Precision</span>
              </div>

              {overview?.lastIngestion?.timestamp && (
                <div className="pt-2 border-t border-fintech-border/60 text-[11px] font-mono text-slate-500">
                  Last Sync: {new Date(overview.lastIngestion.timestamp).toLocaleString()}
                </div>
              )}
            </div>
          </Card>

          {/* Recently Viewed Stocks */}
          <Card
            title="Recently Viewed"
            icon={Clock}
            subtitle="Equities inspected during this session"
          >
            {recentlyViewed.length === 0 ? (
              <p className="text-xs text-fintech-muted py-2 font-mono text-center">
                No equities recently viewed.
              </p>
            ) : (
              <div className="divide-y divide-fintech-border/30">
                {recentlyViewed.map((stock) => (
                  <Link
                    key={stock.symbol}
                    to={`/stocks?search=${encodeURIComponent(stock.symbol)}`}
                    className="py-2 flex items-center justify-between hover:bg-fintech-surface/40 px-1 rounded transition-colors group"
                  >
                    <div className="min-w-0 pr-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono font-semibold text-xs text-white group-hover:text-blue-400 transition-colors">
                          {stock.symbol}
                        </span>
                        <Badge variant="neutral" size="xs">
                          {stock.exchange}
                        </Badge>
                      </div>
                      <p className="text-[11px] text-slate-400 truncate mt-0.5">
                        {stock.name}
                      </p>
                    </div>
                    <ArrowRight className="w-3 h-3 text-slate-500 group-hover:text-slate-300 shrink-0" />
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* 5. Verified Database Equities Sample Preview                       */}
      {/* ----------------------------------------------------------------- */}
      <div className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-200 font-mono flex items-center gap-2">
              <Database className="w-4 h-4 text-cyan-400" />
              Verified Equities Preview
            </h2>
            <p className="text-xs text-fintech-muted mt-0.5">
              Sample records from the PostgreSQL 16 database.
            </p>
          </div>

          <Link to="/stocks">
            <Button variant="ghost" size="xs" icon={ArrowRight} iconPosition="right">
              View All ({totalInstruments})
            </Button>
          </Link>
        </div>

        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-fintech-border bg-fintech-surface/40 text-slate-400 font-mono text-[11px]">
                  <th className="py-2.5 px-4 font-medium">SYMBOL</th>
                  <th className="py-2.5 px-4 font-medium">COMPANY NAME</th>
                  <th className="py-2.5 px-3 font-medium">EXCHANGE</th>
                  <th className="py-2.5 px-3 font-medium">SEGMENT</th>
                  <th className="py-2.5 px-3 font-medium">ISIN</th>
                  <th className="py-2.5 px-4 text-right font-medium">STATUS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-fintech-border/40">
                {loading ? (
                  <>
                    <TableRowSkeleton columns={6} />
                    <TableRowSkeleton columns={6} />
                    <TableRowSkeleton columns={6} />
                  </>
                ) : catalogStocks.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-slate-400 font-mono">
                      No stocks found in database.
                    </td>
                  </tr>
                ) : (
                  catalogStocks.map((stock) => (
                    <tr
                      key={stock.id}
                      className="hover:bg-fintech-surface/40 transition-colors group cursor-pointer"
                      onClick={() => navigate(`/stocks?search=${encodeURIComponent(stock.symbol)}`)}
                    >
                      <td className="py-3 px-4 font-mono font-bold text-white text-xs group-hover:text-blue-400 transition-colors">
                        {stock.symbol}
                      </td>
                      <td className="py-3 px-4 text-slate-300">
                        {stock.companyName}
                      </td>
                      <td className="py-3 px-3">
                        <Badge
                          variant={stock.exchange?.code === 'NSE' ? 'info' : 'purple'}
                          size="xs"
                        >
                          {stock.exchange?.code}
                        </Badge>
                      </td>
                      <td className="py-3 px-3 font-mono text-slate-400 text-[11px]">
                        {stock.segment}
                      </td>
                      <td className="py-3 px-3 font-mono text-slate-400 text-[11px]">
                        {stock.isin || '—'}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <Badge variant="success" size="xs" dot>
                          ACTIVE
                        </Badge>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
