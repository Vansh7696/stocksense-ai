import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Search,
  Filter,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ExternalLink,
  Bookmark,
  BookmarkCheck,
  RefreshCw,
  X,
  Building2,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  Database,
  Layers,
} from 'lucide-react';
import { getStocks } from '../services/api';
import { addRecentlyViewed } from '../utils/watchlist';
import { useWatchlist } from '../context/WatchlistContext';
import {
  Card,
  Button,
  Badge,
  Input,
  TableRowSkeleton,
  EmptyState,
  ErrorState,
} from '../components/ui';

const ALLOWED_EXCHANGES = ['ALL', 'NSE', 'BSE'];
const ALLOWED_INSTRUMENT_TYPES = ['ALL', 'EQUITY', 'INDEX', 'FUTURES', 'OPTIONS', 'BOND'];
const ALLOWED_STATUSES = [
  { label: 'All Listing Statuses', value: 'ALL' },
  { label: 'Active Listing', value: 'true' },
  { label: 'Inactive Listing', value: 'false' },
];
const PAGE_SIZES = [10, 20, 50];

export default function StockExplorerPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // URL Query Parameters as initial state
  const initialSearch = searchParams.get('search') || searchParams.get('q') || '';
  const initialExchange = searchParams.get('exchange')?.toUpperCase() || 'ALL';
  const initialInstrumentType = searchParams.get('instrumentType')?.toUpperCase() || 'ALL';
  const initialStatus = searchParams.get('isActive') || 'ALL';
  const initialSortBy = searchParams.get('sortBy') || 'symbol';
  const initialSortOrder = searchParams.get('sortOrder') || 'asc';
  const initialPage = parseInt(searchParams.get('page') || '1', 10);
  const initialLimit = parseInt(searchParams.get('limit') || '20', 10);

  // Filter & Search states
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch);
  const [exchange, setExchange] = useState(initialExchange);
  const [instrumentType, setInstrumentType] = useState(initialInstrumentType);
  const [isActiveStatus, setIsActiveStatus] = useState(initialStatus);
  const [sortBy, setSortBy] = useState(initialSortBy);
  const [sortOrder, setSortOrder] = useState(initialSortOrder);
  const [page, setPage] = useState(isNaN(initialPage) || initialPage < 1 ? 1 : initialPage);
  const [limit, setLimit] = useState(PAGE_SIZES.includes(initialLimit) ? initialLimit : 20);

  // Data & Request states
  const [stocks, setStocks] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 20,
    totalRecords: 0,
    totalPages: 1,
    hasNextPage: false,
    hasPrevPage: false,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Watchlist state tracker via context
  const { isInWatchlist, toggleStock } = useWatchlist();

  // Debounce search input by 300ms
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Sync state back to URL query parameters
  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (exchange !== 'ALL') params.set('exchange', exchange);
    if (instrumentType !== 'ALL') params.set('instrumentType', instrumentType);
    if (isActiveStatus !== 'ALL') params.set('isActive', isActiveStatus);
    if (sortBy !== 'symbol') params.set('sortBy', sortBy);
    if (sortOrder !== 'asc') params.set('sortOrder', sortOrder);
    if (page > 1) params.set('page', String(page));
    if (limit !== 20) params.set('limit', String(limit));

    setSearchParams(params, { replace: true });
  }, [
    debouncedSearch,
    exchange,
    instrumentType,
    isActiveStatus,
    sortBy,
    sortOrder,
    page,
    limit,
    setSearchParams,
  ]);

  // Reset page to 1 whenever any filter or search changes
  const prevFiltersRef = useRef({ debouncedSearch, exchange, instrumentType, isActiveStatus, limit });
  useEffect(() => {
    const prev = prevFiltersRef.current;
    if (
      prev.debouncedSearch !== debouncedSearch ||
      prev.exchange !== exchange ||
      prev.instrumentType !== instrumentType ||
      prev.isActiveStatus !== isActiveStatus ||
      prev.limit !== limit
    ) {
      setPage(1);
      prevFiltersRef.current = { debouncedSearch, exchange, instrumentType, isActiveStatus, limit };
    }
  }, [debouncedSearch, exchange, instrumentType, isActiveStatus, limit]);

  // Fetch stocks from backend API
  const fetchStocksData = useCallback(async () => {
    setLoading(true);
    setError(null);

    const queryParams = {
      page,
      limit,
      sortBy,
      sortOrder,
    };

    if (debouncedSearch) {
      queryParams.search = debouncedSearch;
    }
    if (exchange && exchange !== 'ALL') {
      queryParams.exchange = exchange;
    }
    if (instrumentType && instrumentType !== 'ALL') {
      queryParams.instrumentType = instrumentType;
    }
    if (isActiveStatus && isActiveStatus !== 'ALL') {
      queryParams.isActive = isActiveStatus;
    }

    try {
      const response = await getStocks(queryParams);
      const stockList = response?.data?.stocks || [];
      const pag = response?.data?.pagination || {
        page,
        limit,
        totalRecords: stockList.length,
        totalPages: 1,
        hasNextPage: false,
        hasPrevPage: false,
      };

      setStocks(stockList);
      setPagination(pag);
    } catch (err) {
      setError(err.message || 'Failed to retrieve stocks catalogue');
      setStocks([]);
    } finally {
      setLoading(false);
    }
  }, [page, limit, debouncedSearch, exchange, instrumentType, isActiveStatus, sortBy, sortOrder]);

  useEffect(() => {
    fetchStocksData();
  }, [fetchStocksData]);

  // Toggle Column Sort
  const handleSortToggle = (field) => {
    if (sortBy === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortOrder('asc');
    }
  };

  // Toggle Watchlist Bookmark
  const handleToggleWatchlist = async (e, stock) => {
    e.stopPropagation();
    try {
      await toggleStock(stock);
    } catch (err) {
      console.warn('[Watchlist] Toggle failed:', err);
    }
  };

  // Handle Row Navigation to Stock Detail
  const handleRowClick = (stock) => {
    addRecentlyViewed(stock);
    const exchangeParam = stock.exchange?.code || 'NSE';
    navigate(`/stocks/${encodeURIComponent(stock.symbol)}?exchange=${exchangeParam}`);
  };

  // Clear All Filters
  const handleResetFilters = () => {
    setSearchInput('');
    setDebouncedSearch('');
    setExchange('ALL');
    setInstrumentType('ALL');
    setIsActiveStatus('ALL');
    setSortBy('symbol');
    setSortOrder('asc');
    setPage(1);
  };

  const isFilterActive =
    debouncedSearch.length > 0 ||
    exchange !== 'ALL' ||
    instrumentType !== 'ALL' ||
    isActiveStatus !== 'ALL' ||
    sortBy !== 'symbol' ||
    sortOrder !== 'asc';

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* ------------------------------------------------------------- */}
      {/* 1. Header & Title Section                                     */}
      {/* ------------------------------------------------------------- */}
      <div className="flex flex-col md:flex-row md:items-center justify-between pb-4 border-b border-fintech-border/80 gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
              <Building2 className="w-5 h-5 text-blue-400" />
              Stock Explorer
            </h1>
            <Badge variant="cyan" size="xs">
              NSE / BSE Catalog
            </Badge>
          </div>
          <p className="text-xs text-fintech-muted mt-1 max-w-xl leading-relaxed">
            Search, filter, and inspect verified Indian equities and indices registered in the platform database.
          </p>
        </div>

        {/* Total Count Pill & Refresh Button */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-fintech-surface border border-fintech-border text-xs font-mono">
            <span className="w-2 h-2 rounded-full bg-blue-400" />
            <span className="text-slate-300">
              {loading ? 'Counting...' : `${pagination.totalRecords.toLocaleString()} Instruments`}
            </span>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={fetchStocksData}
            loading={loading}
            icon={RefreshCw}
            title="Reload data"
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* ------------------------------------------------------------- */}
      {/* 2. Search & Filter Controls Bar                               */}
      {/* ------------------------------------------------------------- */}
      <Card padding="md">
        <div className="flex flex-col gap-4">
          {/* Top Row: Search Input */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <div className="relative flex-1">
              <Input
                type="text"
                placeholder="Search by symbol or company name (e.g. RELIANCE, TCS, Tata, HDFC)..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                icon={Search}
                trailingIcon={searchInput ? X : undefined}
                onTrailingIconClick={() => setSearchInput('')}
                mono
              />
            </div>

            {isFilterActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleResetFilters}
                icon={X}
                className="text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 shrink-0"
              >
                Reset Filters
              </Button>
            )}
          </div>

          {/* Bottom Row: Exchange Pills & Dropdown Selects */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-fintech-border/60">
            {/* Exchange Filter Pills */}
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-mono text-slate-400 mr-1 flex items-center gap-1">
                <Filter className="w-3 h-3 text-slate-500" /> Exchange:
              </span>
              {ALLOWED_EXCHANGES.map((ex) => {
                const isSelected = exchange === ex;
                return (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => setExchange(ex)}
                    className={`px-2.5 py-1 text-xs rounded-md font-mono font-medium transition-colors border ${
                      isSelected
                        ? 'bg-blue-600/20 text-blue-400 border-blue-500/40 shadow-sm'
                        : 'bg-fintech-surface text-slate-400 border-fintech-border hover:text-slate-200 hover:border-slate-700'
                    }`}
                  >
                    {ex === 'ALL' ? 'All Exchanges' : ex}
                  </button>
                );
              })}
            </div>

            {/* Dropdown Filters (Instrument Type, Status, Limit) */}
            <div className="flex flex-wrap items-center gap-2.5">
              {/* Instrument Type Select */}
              <div className="flex items-center gap-1.5">
                <label htmlFor="filter-instrument-type" className="text-[11px] font-mono text-slate-400 hidden sm:inline">
                  Type:
                </label>
                <select
                  id="filter-instrument-type"
                  value={instrumentType}
                  onChange={(e) => setInstrumentType(e.target.value)}
                  className="bg-fintech-surface border border-fintech-border rounded-lg text-xs text-slate-200 px-2.5 py-1.5 focus:outline-none focus:border-blue-500/70 font-mono"
                >
                  <option value="ALL">All Types</option>
                  <option value="EQUITY">Equities Only</option>
                  <option value="INDEX">Indices Only</option>
                  <option value="FUTURES">Futures</option>
                  <option value="OPTIONS">Options</option>
                  <option value="BOND">Bonds</option>
                </select>
              </div>

              {/* Listing Status Select */}
              <div className="flex items-center gap-1.5">
                <label htmlFor="filter-status" className="text-[11px] font-mono text-slate-400 hidden sm:inline">
                  Listing:
                </label>
                <select
                  id="filter-status"
                  value={isActiveStatus}
                  onChange={(e) => setIsActiveStatus(e.target.value)}
                  className="bg-fintech-surface border border-fintech-border rounded-lg text-xs text-slate-200 px-2.5 py-1.5 focus:outline-none focus:border-blue-500/70 font-mono"
                >
                  {ALLOWED_STATUSES.map((st) => (
                    <option key={st.value} value={st.value}>
                      {st.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Page Size Select */}
              <div className="flex items-center gap-1.5">
                <label htmlFor="filter-limit" className="text-[11px] font-mono text-slate-400 hidden sm:inline">
                  Rows:
                </label>
                <select
                  id="filter-limit"
                  value={limit}
                  onChange={(e) => setLimit(parseInt(e.target.value, 10))}
                  className="bg-fintech-surface border border-fintech-border rounded-lg text-xs text-slate-200 px-2 py-1.5 focus:outline-none focus:border-blue-500/70 font-mono"
                >
                  {PAGE_SIZES.map((sz) => (
                    <option key={sz} value={sz}>
                      {sz} / page
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* ------------------------------------------------------------- */}
      {/* 3. Stock Catalogue Table Section                              */}
      {/* ------------------------------------------------------------- */}
      {error ? (
        <ErrorState
          title="Unable to load stock catalogue"
          message={error}
          onRetry={fetchStocksData}
        />
      ) : (
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-fintech-border bg-fintech-surface/40 text-slate-400 font-mono text-[11px]">
                  {/* Symbol (Sortable) */}
                  <th
                    className="py-3 px-4 font-medium cursor-pointer hover:text-white transition-colors select-none"
                    onClick={() => handleSortToggle('symbol')}
                  >
                    <div className="flex items-center gap-1.5">
                      <span>SYMBOL</span>
                      {sortBy === 'symbol' ? (
                        sortOrder === 'asc' ? (
                          <ArrowUp className="w-3.5 h-3.5 text-blue-400" />
                        ) : (
                          <ArrowDown className="w-3.5 h-3.5 text-blue-400" />
                        )
                      ) : (
                        <ArrowUpDown className="w-3.5 h-3.5 text-slate-600" />
                      )}
                    </div>
                  </th>

                  {/* Company Name (Sortable) */}
                  <th
                    className="py-3 px-4 font-medium cursor-pointer hover:text-white transition-colors select-none"
                    onClick={() => handleSortToggle('companyName')}
                  >
                    <div className="flex items-center gap-1.5">
                      <span>COMPANY NAME</span>
                      {sortBy === 'companyName' ? (
                        sortOrder === 'asc' ? (
                          <ArrowUp className="w-3.5 h-3.5 text-blue-400" />
                        ) : (
                          <ArrowDown className="w-3.5 h-3.5 text-blue-400" />
                        )
                      ) : (
                        <ArrowUpDown className="w-3.5 h-3.5 text-slate-600" />
                      )}
                    </div>
                  </th>

                  {/* Exchange */}
                  <th className="py-3 px-3 font-medium">EXCHANGE</th>

                  {/* Instrument Type */}
                  <th className="py-3 px-3 font-medium">TYPE</th>

                  {/* Segment */}
                  <th className="py-3 px-3 font-medium">SEGMENT</th>

                  {/* ISIN */}
                  <th className="py-3 px-3 font-medium">ISIN</th>

                  {/* Listing Status */}
                  <th className="py-3 px-3 font-medium">LISTING STATUS</th>

                  {/* Actions */}
                  <th className="py-3 px-4 text-right font-medium">ACTIONS</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-fintech-border/40">
                {loading ? (
                  <>
                    <TableRowSkeleton columns={8} />
                    <TableRowSkeleton columns={8} />
                    <TableRowSkeleton columns={8} />
                    <TableRowSkeleton columns={8} />
                    <TableRowSkeleton columns={8} />
                    <TableRowSkeleton columns={8} />
                  </>
                ) : stocks.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-8">
                      <EmptyState
                        icon={Search}
                        title="No Matching Instruments Found"
                        description={
                          debouncedSearch
                            ? `No stocks found matching "${debouncedSearch}" with the active filters.`
                            : 'No instruments found for the selected exchange or criteria.'
                        }
                        actionLabel={isFilterActive ? 'Clear Filters' : undefined}
                        onAction={isFilterActive ? handleResetFilters : undefined}
                      />
                    </td>
                  </tr>
                ) : (
                  stocks.map((stock) => {
                    const isNse = stock.exchange?.code === 'NSE';
                    const isBookmarked = isInWatchlist(stock.id) || isInWatchlist(stock.symbol);

                    return (
                      <tr
                        key={stock.id || `${stock.symbol}-${stock.exchange?.code}`}
                        onClick={() => handleRowClick(stock)}
                        className="hover:bg-fintech-surface/40 transition-colors group cursor-pointer"
                      >
                        {/* Symbol */}
                        <td className="py-3 px-4">
                          <span className="font-mono font-bold text-white text-xs group-hover:text-blue-400 transition-colors">
                            {stock.symbol}
                          </span>
                        </td>

                        {/* Company Name */}
                        <td className="py-3 px-4">
                          <span className="text-slate-300 font-sans max-w-xs truncate block" title={stock.companyName}>
                            {stock.companyName}
                          </span>
                        </td>

                        {/* Exchange */}
                        <td className="py-3 px-3">
                          <Badge variant={isNse ? 'info' : 'purple'} size="xs">
                            {stock.exchange?.code || 'NSE'}
                          </Badge>
                        </td>

                        {/* Instrument Type */}
                        <td className="py-3 px-3">
                          <Badge
                            variant={stock.instrumentType === 'INDEX' ? 'warning' : 'neutral'}
                            size="xs"
                          >
                            {stock.instrumentType || 'EQUITY'}
                          </Badge>
                        </td>

                        {/* Segment */}
                        <td className="py-3 px-3 font-mono text-[11px] text-slate-400">
                          {stock.segment || '—'}
                        </td>

                        {/* ISIN */}
                        <td className="py-3 px-3 font-mono text-[11px] text-slate-400">
                          {stock.isin || '—'}
                        </td>

                        {/* Listing Status */}
                        <td
                          className="py-3 px-3"
                          title={`Listing Status: ${stock.isActive ? 'Active instrument listing on exchange' : 'Suspended or inactive listing'}`}
                        >
                          <Badge
                            variant={stock.isActive ? 'success' : 'danger'}
                            size="xs"
                            dot
                          >
                            {stock.isActive ? 'LISTED' : 'DELISTED'}
                          </Badge>
                        </td>

                        {/* Actions */}
                        <td className="py-3 px-4 text-right">
                          <div
                            className="inline-flex items-center gap-1.5"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {/* Watchlist Bookmark Button */}
                            <button
                              type="button"
                              onClick={(e) => handleToggleWatchlist(e, stock)}
                              className={`p-1.5 rounded transition-colors ${
                                isBookmarked
                                  ? 'text-emerald-400 hover:text-emerald-300 bg-emerald-500/10'
                                  : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
                              }`}
                              title={isBookmarked ? 'Remove from Watchlist' : 'Add to Watchlist'}
                            >
                              {isBookmarked ? (
                                <BookmarkCheck className="w-3.5 h-3.5" />
                              ) : (
                                <Bookmark className="w-3.5 h-3.5" />
                              )}
                            </button>

                            {/* View Detail Link */}
                            <button
                              type="button"
                              onClick={() => handleRowClick(stock)}
                              className="p-1.5 rounded text-slate-500 hover:text-blue-400 hover:bg-slate-800 transition-colors"
                              title="Inspect stock details"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* ----------------------------------------------------------- */}
          {/* 4. Pagination Controls Bar                                  */}
          {/* ----------------------------------------------------------- */}
          {!loading && stocks.length > 0 && (
            <div className="px-4 py-3 border-t border-fintech-border/80 bg-fintech-surface/20 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs font-mono text-slate-400">
              {/* Record Summary */}
              <div>
                Showing{' '}
                <span className="text-white font-medium">
                  {Math.min((pagination.page - 1) * pagination.limit + 1, pagination.totalRecords)}
                </span>{' '}
                to{' '}
                <span className="text-white font-medium">
                  {Math.min(pagination.page * pagination.limit, pagination.totalRecords)}
                </span>{' '}
                of <span className="text-white font-medium">{pagination.totalRecords.toLocaleString()}</span> instruments
              </div>

              {/* Prev / Page Indicator / Next */}
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="xs"
                  disabled={!pagination.hasPrevPage}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  icon={ChevronLeft}
                >
                  Prev
                </Button>

                <div className="px-2.5 py-1 text-slate-300 bg-fintech-card border border-fintech-border rounded text-[11px] font-mono">
                  Page {pagination.page} / {Math.max(1, pagination.totalPages)}
                </div>

                <Button
                  variant="outline"
                  size="xs"
                  disabled={!pagination.hasNextPage}
                  onClick={() => setPage((p) => p + 1)}
                  icon={ChevronRight}
                  iconPosition="right"
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
