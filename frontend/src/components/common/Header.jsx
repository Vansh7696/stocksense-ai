import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Menu,
  Clock,
  Radio,
  ExternalLink,
  X,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  ChevronDown,
  BookmarkCheck,
  Bell,
  LogOut,
  User,
} from 'lucide-react';
import { searchStocks } from '../../services/api';
import { getIndianMarketStatus } from '../../utils/marketHours';
import { useAuth } from '../../context/AuthContext';
import Badge from '../ui/Badge';

export default function Header({ onOpenMobileNav, providerStatus }) {
  const navigate = useNavigate();
  const { user, isAuthenticated, logout } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [marketStatus, setMarketStatus] = useState(() => getIndianMarketStatus());

  const searchContainerRef = useRef(null);
  const searchInputRef = useRef(null);
  const userMenuRef = useRef(null);

  // Update market session timer every 30 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      setMarketStatus(getIndianMarketStatus());
    }, 30000);
    return () => clearInterval(timer);
  }, []);

  // Keyboard shortcut listener for Cmd+K / Ctrl+K
  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
        setIsSearchOpen(true);
      }
      if (e.key === 'Escape') {
        setIsSearchOpen(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Handle click outside search container and user menu
  useEffect(() => {
    function handleClickOutside(e) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target)) {
        setIsSearchOpen(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setIsUserMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced typeahead search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const response = await searchStocks(searchQuery.trim(), 6);
        const matches = response?.data?.results || [];
        setSearchResults(matches);
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const isUpstoxActive = providerStatus?.active === true;

  return (
    <header className="h-16 border-b border-fintech-border bg-fintech-card/90 backdrop-blur-md px-4 sm:px-6 flex items-center justify-between sticky top-0 z-30">
      {/* Left: Mobile Nav Toggle & Market Session Status */}
      <div className="flex items-center gap-3 sm:gap-4">
        <button
          type="button"
          onClick={onOpenMobileNav}
          className="lg:hidden p-2 rounded-lg text-slate-400 hover:text-white hover:bg-fintech-surface focus:outline-none"
          aria-label="Open mobile navigation"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* Real-time Indian Market Hours Badge */}
        <div className="flex items-center gap-2">
          <div
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono border ${
              marketStatus.isOpen
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : 'bg-slate-800/80 text-slate-300 border-slate-700/60'
            }`}
            title={marketStatus.sublabel}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                marketStatus.isOpen ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'
              }`}
            />
            <span className="font-semibold">{marketStatus.label}</span>
            <span className="hidden sm:inline text-slate-500">|</span>
            <span className="hidden sm:inline text-slate-400">{marketStatus.timeString}</span>
          </div>

          {/* Upstox Gateway Health Pill */}
          <div className="hidden md:flex items-center">
            {isUpstoxActive ? (
              <Badge variant="success" size="sm" dot>
                UPSTOX API: ACTIVE
              </Badge>
            ) : (
              <Badge variant="warning" size="sm" dot>
                BROKER: AUTH PENDING
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Center & Right: Typeahead Search & Profile */}
      <div className="flex items-center gap-3">
        {/* Global Stock Search Container */}
        <div ref={searchContainerRef} className="relative w-48 sm:w-64 md:w-80">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setIsSearchOpen(true);
              }}
              onFocus={() => setIsSearchOpen(true)}
              placeholder="Search symbol / company..."
              className="w-full bg-fintech-surface border border-fintech-border rounded-lg pl-8 pr-8 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/30 font-mono transition-all"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            ) : (
              <kbd className="hidden sm:inline-block absolute right-2.5 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-[10px] bg-fintech-card border border-fintech-border rounded text-slate-400 font-mono">
                ⌘K
              </kbd>
            )}
          </div>

          {/* Instant Search Results Dropdown */}
          {isSearchOpen && searchQuery.trim().length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1.5 bg-fintech-card border border-fintech-border rounded-xl shadow-2xl shadow-black/60 overflow-hidden z-50 max-h-80 overflow-y-auto">
              <div className="px-3 py-2 border-b border-fintech-border/60 flex items-center justify-between text-[11px] text-slate-400 font-mono">
                <span>EQUITY SEARCH RESULTS</span>
                {isSearching && <Loader2 className="w-3 h-3 animate-spin text-blue-400" />}
              </div>

              {searchResults.length === 0 && !isSearching ? (
                <div className="p-4 text-center text-xs text-fintech-muted font-mono">
                  No matching equities for &quot;{searchQuery}&quot;
                </div>
              ) : (
                <div className="py-1 divide-y divide-fintech-border/30">
                  {searchResults.map((item) => (
                    <button
                      key={item.id || item.symbol}
                      type="button"
                      onClick={() => {
                        setIsSearchOpen(false);
                        setSearchQuery('');
                        const exCode = item.exchange?.code || item.exchange || 'NSE';
                        navigate(`/stocks/${encodeURIComponent(item.symbol)}?exchange=${exCode}`);
                      }}
                      className="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-fintech-surface text-left transition-colors group"
                    >
                      <div className="min-w-0 pr-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-semibold text-xs text-white group-hover:text-blue-400 transition-colors">
                            {item.symbol}
                          </span>
                          <span className="text-[10px] px-1 py-0.2 rounded bg-slate-800 text-slate-300 font-mono border border-slate-700">
                            {item.exchange?.code || item.exchange || 'NSE'}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400 truncate mt-0.5">
                          {item.companyName || item.name}
                        </p>
                      </div>
                      <ExternalLink className="w-3.5 h-3.5 text-slate-500 group-hover:text-slate-300 shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* User Profile / Auth Actions */}
        <div className="flex items-center gap-2 pl-2 border-l border-fintech-border">
          {isAuthenticated ? (
            <div ref={userMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setIsUserMenuOpen((prev) => !prev)}
                className="flex items-center gap-2 p-1 rounded-lg hover:bg-fintech-surface transition-colors"
                aria-label="User account menu"
              >
                <div
                  className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center font-mono text-xs font-semibold text-blue-400"
                  title={user?.email || 'User Account'}
                >
                  {user?.fullName
                    ? user.fullName
                        .split(' ')
                        .map((n) => n[0])
                        .join('')
                        .toUpperCase()
                        .slice(0, 2)
                    : 'SS'}
                </div>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 hidden sm:block" />
              </button>

              {isUserMenuOpen && (
                <div className="absolute right-0 top-full mt-2 w-56 bg-fintech-card border border-fintech-border rounded-xl shadow-2xl shadow-black/80 py-2 z-50 divide-y divide-fintech-border/40 font-sans">
                  <div className="px-3.5 py-2">
                    <p className="text-xs font-semibold text-white truncate">
                      {user?.fullName || 'Analyst'}
                    </p>
                    <p className="text-[11px] text-slate-400 font-mono truncate">{user?.email}</p>
                    <div className="pt-1.5 flex items-center gap-1.5">
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-mono border border-blue-500/30">
                        {user?.role || 'USER'}
                      </span>
                      <span className="text-[10px] text-emerald-400 font-mono">● Active Session</span>
                    </div>
                  </div>

                  <div className="py-1">
                    <button
                      type="button"
                      onClick={() => {
                        setIsUserMenuOpen(false);
                        navigate('/watchlist');
                      }}
                      className="w-full px-3.5 py-2 flex items-center gap-2.5 text-xs text-slate-300 hover:text-white hover:bg-fintech-surface transition-colors text-left"
                    >
                      <BookmarkCheck className="w-4 h-4 text-slate-400" />
                      <span>Persistent Watchlist</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsUserMenuOpen(false);
                        navigate('/alerts');
                      }}
                      className="w-full px-3.5 py-2 flex items-center gap-2.5 text-xs text-slate-300 hover:text-white hover:bg-fintech-surface transition-colors text-left"
                    >
                      <Bell className="w-4 h-4 text-slate-400" />
                      <span>Stock Price Alerts</span>
                    </button>
                  </div>

                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={async () => {
                        setIsUserMenuOpen(false);
                        await logout();
                        navigate('/');
                      }}
                      className="w-full px-3.5 py-2 flex items-center gap-2.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors text-left"
                    >
                      <LogOut className="w-4 h-4 text-red-400" />
                      <span>Sign Out</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-300 hover:text-white hover:bg-fintech-surface transition-colors font-mono"
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => navigate('/register')}
                className="hidden sm:inline-flex px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors shadow-sm shadow-blue-500/20 font-mono"
              >
                Register
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
