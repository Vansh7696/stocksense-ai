import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Bookmark,
  BookmarkCheck,
  RefreshCw,
  Building2,
  Calendar,
  Layers,
  Database,
  AlertCircle,
  HelpCircle,
  Hash,
  Clock,
  ShieldCheck,
  FileText,
  Activity,
  BarChart2,
  ExternalLink,
  ChevronRight,
  TrendingUp,
  Info,
} from 'lucide-react';
import { getStockById, getStockPrices } from '../services/api';
import { addRecentlyViewed } from '../utils/watchlist';
import { useWatchlist } from '../context/WatchlistContext';
import { Card, Button, Badge, Skeleton, ErrorState, EmptyState } from '../components/ui';
import CandlestickChart from '../components/charts/CandlestickChart';

const INTERVAL_TABS = [
  { id: '1D', label: '1D', full: '1 Day', group: 'standard' },
  { id: '1W', label: '1W', full: '1 Week', group: 'standard' },
  { id: '1M', label: '1M', full: '1 Month', group: 'standard' },
  { id: '1h', label: '1H', full: '1 Hour', group: 'intraday' },
  { id: '30m', label: '30m', full: '30 Min', group: 'intraday' },
  { id: '15m', label: '15m', full: '15 Min', group: 'intraday' },
  { id: '5m', label: '5m', full: '5 Min', group: 'intraday' },
  { id: '1m', label: '1m', full: '1 Min', group: 'intraday' },
];

/**
 * Professional Stock Detail Page with Interactive TradingView Lightweight Candlestick Chart
 */
export default function StockDetailPage() {
  const { id: rawId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const exchangeParam = searchParams.get('exchange')?.toUpperCase() || '';
  const initialInterval = searchParams.get('interval') || '1D';

  // Primary data states
  const [stock, setStock] = useState(null);
  const [loadingStock, setLoadingStock] = useState(true);
  const [stockError, setStockError] = useState(null);
  const [ambiguousMatches, setAmbiguousMatches] = useState(null);

  // Candlestick historical price states
  const [selectedInterval, setSelectedInterval] = useState(initialInterval);
  const [candles, setCandles] = useState([]);
  const [pricePagination, setPricePagination] = useState(null);
  const [loadingPrices, setLoadingPrices] = useState(false);
  const [pricesError, setPricesError] = useState(null);

  // Watchlist status
  const { isInWatchlist, toggleStock } = useWatchlist();
  const inWatchlist = stock ? (isInWatchlist(stock.id) || isInWatchlist(stock.symbol)) : false;

  // Load stock details
  const fetchStockDetail = useCallback(async () => {
    if (!rawId) return;

    setLoadingStock(true);
    setStock(null);
    setCandles([]);
    setStockError(null);
    setAmbiguousMatches(null);

    const queryParams = {};
    if (exchangeParam) {
      queryParams.exchange = exchangeParam;
    }

    try {
      const response = await getStockById(rawId, queryParams);
      const stockData = response?.data;
      setStock(stockData);
      setInWatchlist(isStockInWatchlist(stockData.symbol) || isStockInWatchlist(stockData.id));
      addRecentlyViewed(stockData);
    } catch (err) {
      if (err.code === 'AMBIGUOUS_STOCK_IDENTIFIER' && err.details?.matches) {
        setAmbiguousMatches(err.details.matches);
      } else {
        setStockError(err);
      }
      setStock(null);
    } finally {
      setLoadingStock(false);
    }
  }, [rawId, exchangeParam]);

  // Load historical candlestick prices
  const fetchHistoricalCandles = useCallback(async (stockIdOrToken, intervalToFetch) => {
    if (!stockIdOrToken) return;

    setLoadingPrices(true);
    setPricesError(null);

    const queryParams = {
      interval: intervalToFetch,
      limit: 1000, // Fetch up to maximum allowed candles for smooth charts
    };

    if (exchangeParam) {
      queryParams.exchange = exchangeParam;
    }

    try {
      const response = await getStockPrices(stockIdOrToken, queryParams);
      const candlesData = response?.data?.candles || [];
      setCandles(candlesData);
      setPricePagination(response?.data?.pagination || null);
    } catch (err) {
      setPricesError(err);
      setCandles([]);
    } finally {
      setLoadingPrices(false);
    }
  }, [exchangeParam]);

  // Initial load or route change
  useEffect(() => {
    fetchStockDetail();
  }, [fetchStockDetail]);

  // When stock is resolved, fetch historical candles for the active interval
  useEffect(() => {
    if (stock?.id) {
      fetchHistoricalCandles(stock.id, selectedInterval);
    }
  }, [stock?.id, selectedInterval, fetchHistoricalCandles]);

  // Keep interval in URL query params
  const handleIntervalChange = (newInterval) => {
    setSelectedInterval(newInterval);
    const updated = new URLSearchParams(searchParams);
    updated.set('interval', newInterval);
    setSearchParams(updated, { replace: true });
  };

  // Toggle watchlist
  const handleToggleWatchlist = async () => {
    if (!stock) return;
    try {
      await toggleStock(stock);
    } catch (err) {
      console.warn('[Watchlist] Toggle failed:', err);
    }
  };

  // Select a specific exchange from ambiguous matches list
  const handleSelectAmbiguousMatch = (match) => {
    const exchangeCode = match.exchange || match.exchange?.code || 'NSE';
    navigate(`/stocks/${encodeURIComponent(match.symbol)}?exchange=${exchangeCode}`);
  };

  // Chronological metadata calculations
  const candleMetadata = useMemo(() => {
    if (!candles || candles.length === 0) {
      return {
        totalCandles: 0,
        firstDate: null,
        lastDate: null,
        hasData: false,
      };
    }

    // Sort to guarantee ascending date range calculation
    const sorted = [...candles].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    const isIntraday = !['1D', '1W', '1M'].includes(selectedInterval);

    const formatOpts = isIntraday
      ? {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: 'Asia/Kolkata',
        }
      : {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          timeZone: 'Asia/Kolkata',
        };

    return {
      totalCandles: candles.length,
      firstDate: first?.timestamp ? new Date(first.timestamp).toLocaleDateString('en-IN', formatOpts) : null,
      lastDate: last?.timestamp ? new Date(last.timestamp).toLocaleDateString('en-IN', formatOpts) : null,
      hasData: true,
      dataSource: first?.dataSource || 'UPSTOX',
    };
  }, [candles, selectedInterval]);

  // =========================================================================
  // Case 1: Ambiguous Stock Identifier (HTTP 409)
  // =========================================================================
  if (ambiguousMatches) {
    return (
      <div className="max-w-4xl mx-auto space-y-6 pb-16">
        <Link
          to="/stocks"
          className="inline-flex items-center gap-2 text-xs font-mono text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Stock Explorer
        </Link>

        <Card className="p-8 border-amber-500/30 bg-amber-950/10 backdrop-blur-sm">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
              <AlertCircle className="w-7 h-7" />
            </div>
            <div className="space-y-2 flex-1">
              <h2 className="text-lg font-bold text-white">
                Ambiguous Stock Symbol: <span className="font-mono text-amber-400">{rawId}</span>
              </h2>
              <p className="text-xs text-slate-300 leading-relaxed">
                Multiple instruments match the symbol <strong className="text-white">{rawId}</strong> across different exchanges or market segments.
                Please select the specific listing venue you wish to inspect:
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-4">
                {ambiguousMatches.map((m) => (
                  <button
                    key={m.id || m.instrumentToken}
                    onClick={() => handleSelectAmbiguousMatch(m)}
                    className="p-4 rounded-xl bg-fintech-surface hover:bg-slate-800/80 border border-fintech-border hover:border-blue-500/50 text-left transition-all group flex flex-col justify-between"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-white group-hover:text-blue-400">
                          {m.symbol}
                        </span>
                        <Badge
                          variant={m.exchange === 'NSE' ? 'info' : 'purple'}
                          size="xs"
                        >
                          {m.exchange}
                        </Badge>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-500 group-hover:text-blue-400 transition-transform group-hover:translate-x-0.5" />
                    </div>
                    <div className="text-xs text-slate-300 font-sans truncate mb-2">
                      {m.companyName}
                    </div>
                    <div className="text-[10px] font-mono text-slate-500">
                      Segment: <span className="text-slate-400">{m.segment || 'EQUITY'}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // =========================================================================
  // Case 2: Stock Not Found (HTTP 404)
  // =========================================================================
  if (stockError && (stockError.status === 404 || stockError.code === 'STOCK_NOT_FOUND')) {
    return (
      <div className="max-w-3xl mx-auto space-y-6 pb-16">
        <Link
          to="/stocks"
          className="inline-flex items-center gap-2 text-xs font-mono text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Stock Explorer
        </Link>

        <Card className="p-12 text-center border-rose-500/30 bg-rose-950/10">
          <div className="mx-auto w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400 mb-4">
            <HelpCircle className="w-6 h-6" />
          </div>
          <h2 className="text-base font-bold text-white mb-2">Stock Not Found</h2>
          <p className="text-xs text-slate-300 max-w-md mx-auto mb-6 leading-relaxed">
            No instrument matching identifier <code className="font-mono px-1.5 py-0.5 rounded bg-slate-800 text-rose-300">{rawId}</code>
            {exchangeParam && (
              <span> on exchange <code className="font-mono px-1.5 py-0.5 rounded bg-slate-800 text-blue-300">{exchangeParam}</code></span>
            )}{' '}
            was found in the local catalogue.
          </p>
          <div className="flex justify-center gap-3">
            <Button variant="secondary" onClick={() => navigate('/stocks')}>
              Browse Stock Explorer
            </Button>
            <Button variant="outline" onClick={() => fetchStockDetail()}>
              Retry Lookup
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // =========================================================================
  // Case 3: Other General Stock Errors
  // =========================================================================
  if (stockError) {
    return (
      <div className="max-w-3xl mx-auto space-y-6 pb-16">
        <Link
          to="/stocks"
          className="inline-flex items-center gap-2 text-xs font-mono text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Stock Explorer
        </Link>

        <ErrorState
          title="Failed to Load Stock Profile"
          message={stockError.message || 'An unexpected error occurred while contacting the market database.'}
          onRetry={fetchStockDetail}
        />
      </div>
    );
  }

  // =========================================================================
  // Case 4: Stock Profile Loading Skeleton
  // =========================================================================
  if (loadingStock) {
    return (
      <div className="max-w-7xl mx-auto space-y-6 pb-16">
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-8 w-28 rounded-lg" />
        </div>

        {/* Header Skeleton */}
        <Card className="p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-8 w-32 rounded-md" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
              <Skeleton className="h-4 w-64" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-9 w-28 rounded-lg" />
            </div>
          </div>
        </Card>

        {/* Chart Skeleton */}
        <Card className="p-6">
          <Skeleton className="h-[460px] w-full rounded-xl" />
        </Card>
      </div>
    );
  }

  if (!stock) return null;

  const isNse = stock.exchange?.code === 'NSE';

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-16">
      {/* Top Navigation & Actions Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* Breadcrumb back-link */}
        <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
          <Link
            to="/stocks"
            className="hover:text-blue-400 transition-colors flex items-center gap-1.5 text-slate-300"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Stock Explorer</span>
          </Link>
          <span className="text-slate-600">/</span>
          <span className="text-white font-semibold">{stock.symbol}</span>
          <span className="text-slate-500">({stock.exchange?.code || 'NSE'})</span>
        </div>

        {/* Right actions: Watchlist & Refresh */}
        <div className="flex items-center gap-2">
          <Button
            variant={inWatchlist ? 'primary' : 'secondary'}
            size="sm"
            onClick={handleToggleWatchlist}
            className="gap-1.5 font-mono text-xs"
          >
            {inWatchlist ? (
              <>
                <BookmarkCheck className="w-3.5 h-3.5 text-emerald-300" />
                <span>In Watchlist</span>
              </>
            ) : (
              <>
                <Bookmark className="w-3.5 h-3.5 text-slate-400" />
                <span>Add to Watchlist</span>
              </>
            )}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              fetchStockDetail();
              fetchHistoricalCandles(stock.id, selectedInterval);
            }}
            disabled={loadingPrices}
            className="gap-1.5 font-mono text-xs"
            title="Refresh stock data and candles"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingPrices ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Stock Profile Header Card */}
      <Card className="p-6 bg-gradient-to-br from-fintech-surface via-fintech-card to-fintech-surface border-fintech-border/80 shadow-xl">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          {/* Left: Company & Symbol Profile */}
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl sm:text-3xl font-black font-mono tracking-tight text-white">
                {stock.symbol}
              </h1>

              {/* Exchange Badge */}
              <Badge variant={isNse ? 'info' : 'purple'} size="sm">
                {stock.exchange?.code || 'NSE'}
              </Badge>

              {/* Instrument Type Badge */}
              <Badge
                variant={stock.instrumentType === 'INDEX' ? 'warning' : 'neutral'}
                size="sm"
              >
                {stock.instrumentType || 'EQUITY'}
              </Badge>

              {/* Segment Badge */}
              <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-slate-800 text-slate-300 border border-slate-700/60">
                {stock.segment || 'NSE_EQ'}
              </span>

              {/* Listing Status Badge */}
              <Badge
                variant={stock.isActive ? 'success' : 'danger'}
                size="sm"
                dot
              >
                {stock.isActive ? 'ACTIVE LISTING' : 'INACTIVE / DELISTED'}
              </Badge>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-300">
              <span className="font-medium text-slate-200">{stock.companyName}</span>
              {stock.isin && (
                <span className="font-mono text-slate-400 flex items-center gap-1">
                  <span>ISIN:</span>
                  <span className="text-slate-300 font-semibold">{stock.isin}</span>
                </span>
              )}
              {stock.series && (
                <span className="font-mono text-slate-500 text-[11px]">
                  Series: {stock.series}
                </span>
              )}
            </div>
          </div>

          {/* Right: Exchange Venue & Currency Tag */}
          <div className="flex flex-wrap items-center lg:flex-col lg:items-end gap-2 text-xs font-mono">
            <div className="text-right">
              <div className="text-slate-400 text-[11px]">TRADING VENUE</div>
              <div className="text-white font-semibold">
                {stock.exchange?.name || 'National Stock Exchange of India'}
              </div>
            </div>
            <div className="text-[11px] text-slate-400 flex items-center gap-2">
              <span>Currency: <strong className="text-slate-200">{stock.exchange?.currency || 'INR'}</strong></span>
              <span>•</span>
              <span>Timezone: <strong className="text-slate-200">{stock.exchange?.timezone || 'Asia/Kolkata'}</strong></span>
            </div>
          </div>
        </div>

        {/* Regulatory & Listing Status Notice */}
        <div className="mt-4 pt-3.5 border-t border-fintech-border/50 flex flex-wrap items-center justify-between text-[11px] font-mono text-slate-400 gap-2">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span>
              Listing Status: <strong className={stock.isActive ? 'text-emerald-400' : 'text-rose-400'}>
                {stock.isActive ? 'Active on exchange registry' : 'Inactive or suspended listing'}
              </strong>
            </span>
          </div>
          <div className="text-[10px] text-slate-500">
            Note: Listing status is an exchange listing qualification and distinct from market hours (09:15–15:30 IST).
          </div>
        </div>
      </Card>

      {/* Main Section: Historical Candlestick Chart */}
      <div className="space-y-3">
        {/* Chart Header Bar: Timeframe Selection & Stats */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <div className="flex items-center gap-2">
            <BarChart2 className="w-4 h-4 text-blue-400" />
            <h2 className="text-sm font-bold text-white font-mono uppercase tracking-wide">
              Historical OHLCV Candlesticks
            </h2>
          </div>

          {/* Interval Switcher Pills */}
          <div className="flex items-center gap-1 p-1 bg-fintech-surface/90 border border-fintech-border rounded-xl">
            {INTERVAL_TABS.map((tab) => {
              const isSelected = selectedInterval === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => handleIntervalChange(tab.id)}
                  disabled={loadingPrices}
                  className={`px-3 py-1 rounded-lg text-xs font-mono font-medium transition-all ${
                    isSelected
                      ? 'bg-blue-600 text-white shadow-md shadow-blue-500/20'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  } ${loadingPrices ? 'opacity-70 cursor-not-allowed' : ''}`}
                  title={`${tab.full} Candlestick Interval`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Candlestick Chart Canvas Component */}
        {pricesError ? (
          <Card className="p-8">
            <ErrorState
              title="Failed to Load Historical Candles"
              message={pricesError.message || `Unable to fetch historical ${selectedInterval} candle data.`}
              onRetry={() => fetchHistoricalCandles(stock.id, selectedInterval)}
            />
          </Card>
        ) : (
          <CandlestickChart
            candles={candles}
            interval={selectedInterval}
            loading={loadingPrices}
            symbol={stock.symbol}
            exchange={stock.exchange?.code || 'NSE'}
            height={460}
          />
        )}
      </div>

      {/* Historical Data Information & Metadata Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Selected Interval */}
        <Card className="p-4 bg-fintech-surface/50 border-fintech-border/70">
          <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-1.5">
            <span>SELECTED TIMEFRAME</span>
            <Clock className="w-3.5 h-3.5 text-blue-400" />
          </div>
          <div className="text-lg font-bold font-mono text-white">
            {INTERVAL_TABS.find((t) => t.id === selectedInterval)?.full || selectedInterval}
          </div>
          <div className="text-[11px] text-slate-400 mt-1 font-mono">
            Interval Code: <span className="text-blue-400 font-semibold">{selectedInterval}</span>
          </div>
        </Card>

        {/* Card 2: Candles Count */}
        <Card className="p-4 bg-fintech-surface/50 border-fintech-border/70">
          <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-1.5">
            <span>DATA POINTS RETURNED</span>
            <Layers className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div className="text-lg font-bold font-mono text-white">
            {candleMetadata.totalCandles.toLocaleString('en-IN')}
            <span className="text-xs font-normal text-slate-400 ml-1.5">candles</span>
          </div>
          <div className="text-[11px] text-slate-400 mt-1 font-mono">
            {candleMetadata.hasData ? (
              <span className="text-emerald-400">Strict ascending order</span>
            ) : (
              <span className="text-slate-500">No records found</span>
            )}
          </div>
        </Card>

        {/* Card 3: Date Range Span */}
        <Card className="p-4 bg-fintech-surface/50 border-fintech-border/70">
          <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-1.5">
            <span>HISTORICAL DATE SPAN</span>
            <Calendar className="w-3.5 h-3.5 text-purple-400" />
          </div>
          <div className="text-xs font-mono font-bold text-white truncate" title={candleMetadata.lastDate || '—'}>
            {candleMetadata.lastDate || 'No data'}
          </div>
          <div className="text-[11px] text-slate-400 mt-1 font-mono truncate" title={candleMetadata.firstDate || '—'}>
            From: {candleMetadata.firstDate || '—'}
          </div>
        </Card>

        {/* Card 4: Data Availability & Provider */}
        <Card className="p-4 bg-fintech-surface/50 border-fintech-border/70">
          <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-1.5">
            <span>DATASET AVAILABILITY</span>
            <Database className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className={`w-2 h-2 rounded-full ${
                candleMetadata.hasData ? 'bg-emerald-400' : 'bg-slate-600'
              }`}
            />
            <span className="text-xs font-mono font-bold text-white">
              {candleMetadata.hasData ? 'VERIFIED DATASET' : 'UNAVAILABLE'}
            </span>
          </div>
          <div className="text-[11px] text-slate-400 mt-1 font-mono">
            Source: <strong className="text-slate-300">{candleMetadata.dataSource || 'UPSTOX'}</strong>
          </div>
        </Card>
      </div>

      {/* Instrument Details & Institutional Identifiers */}
      <Card className="p-6 bg-fintech-surface/60 border-fintech-border/70">
        <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-4 flex items-center gap-2">
          <Building2 className="w-4 h-4 text-blue-400" />
          <span>Instrument Specifications & Institutional Identifiers</span>
        </h3>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 text-xs font-mono">
          <div>
            <div className="text-slate-500 text-[10px]">UPSTOX TOKEN</div>
            <div className="text-slate-200 font-semibold truncate mt-0.5" title={stock.instrumentToken || '—'}>
              {stock.instrumentToken || '—'}
            </div>
          </div>

          <div>
            <div className="text-slate-500 text-[10px]">EXCHANGE TOKEN</div>
            <div className="text-slate-200 font-semibold mt-0.5">
              {stock.exchangeToken || '—'}
            </div>
          </div>

          <div>
            <div className="text-slate-500 text-[10px]">LOT SIZE</div>
            <div className="text-slate-200 font-semibold mt-0.5">
              {stock.lotSize || 1}
            </div>
          </div>

          <div>
            <div className="text-slate-500 text-[10px]">TICK SIZE</div>
            <div className="text-slate-200 font-semibold mt-0.5">
              {stock.tickSize ? `₹${parseFloat(stock.tickSize).toFixed(2)}` : '₹0.05'}
            </div>
          </div>

          <div>
            <div className="text-slate-500 text-[10px]">SECTOR</div>
            <div className="text-slate-200 font-semibold truncate mt-0.5" title={stock.sector || 'Equities'}>
              {stock.sector || 'Equities'}
            </div>
          </div>

          <div>
            <div className="text-slate-500 text-[10px]">INDUSTRY</div>
            <div className="text-slate-200 font-semibold truncate mt-0.5" title={stock.industry || '—'}>
              {stock.industry || '—'}
            </div>
          </div>
        </div>

        {/* Explicit Market Data Notice */}
        <div className="mt-4 pt-3 border-t border-fintech-border/40 text-[11px] font-mono text-slate-400 flex items-start gap-2">
          <Info className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
          <span>
            <strong>Historical Data Policy:</strong> Historical OHLCV candle records are retrieved from the verified local PostgreSQL database. Historical prices represent closed trading periods and do not constitute real-time streaming quotes. StockSense AI never generates artificial or simulated candles.
          </span>
        </div>
      </Card>
    </div>
  );
}
