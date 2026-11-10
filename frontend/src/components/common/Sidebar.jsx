import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  TrendingUp,
  Search,
  Sparkles,
  Filter,
  PieChart,
  Coins,
  History,
  Newspaper,
  BookmarkCheck,
  BotMessageSquare,
  Bell,
  Settings,
  X,
  ShieldCheck,
  Activity,
} from 'lucide-react';

const navItems = [
  { name: 'Dashboard', path: '/', icon: LayoutDashboard },
  { name: 'Market Overview', path: '/market-overview', icon: TrendingUp },
  { name: 'Stock Explorer', path: '/stocks', icon: Search },
  { name: 'AI Recommendations', path: '/recommendations', icon: Sparkles, badge: 'AI' },
  { name: 'Stock Screener', path: '/screener', icon: Filter },
  { name: 'Portfolio', path: '/portfolio', icon: PieChart },
  { name: 'Paper Trading', path: '/paper-trading', icon: Coins },
  { name: 'Backtesting', path: '/backtesting', icon: History },
  { name: 'News Intelligence', path: '/news', icon: Newspaper },
  { name: 'Watchlist', path: '/watchlist', icon: BookmarkCheck },
  { name: 'AI Assistant', path: '/assistant', icon: BotMessageSquare },
  { name: 'Alerts', path: '/alerts', icon: Bell },
  { name: 'Settings', path: '/settings', icon: Settings },
];

export default function Sidebar({ isOpen, onClose, providerStatus }) {
  const isUpstoxActive = providerStatus?.active === true;

  const sidebarContent = (
    <div className="flex flex-col h-full bg-fintech-card border-r border-fintech-border w-64 select-none">
      {/* Brand Header */}
      <div className="h-16 flex items-center justify-between px-5 border-b border-fintech-border">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-blue-600 flex items-center justify-center font-bold text-white shadow-sm shadow-blue-500/20 text-xs">
            SS
          </div>
          <div>
            <h1 className="font-bold text-sm tracking-tight text-white flex items-center gap-1.5">
              StockSense <span className="text-[10px] px-1.5 py-0.2 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30 font-mono">AI</span>
            </h1>
            <p className="text-[10px] text-fintech-muted font-mono">NSE / BSE Intelligence</p>
          </div>
        </div>

        {/* Close Button on Mobile */}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="lg:hidden p-1.5 text-slate-400 hover:text-white rounded-md hover:bg-fintech-surface"
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Navigation List */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
        <div className="px-3 pb-2 text-[10px] font-mono uppercase text-slate-500 font-semibold tracking-wider">
          Platform Menu
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              onClick={() => onClose && onClose()}
              className={({ isActive }) =>
                `flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors group ${
                  isActive
                    ? 'bg-blue-600/15 text-blue-400 border border-blue-500/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-fintech-surface/70 border border-transparent'
                }`
              }
            >
              <div className="flex items-center gap-2.5">
                <Icon className="w-4 h-4 shrink-0 transition-transform group-hover:scale-105" />
                <span className="truncate">{item.name}</span>
              </div>
              {item.badge && (
                <span className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-mono border border-blue-500/30">
                  {item.badge}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Footer System Status */}
      <div className="p-3.5 border-t border-fintech-border bg-fintech-surface/30">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                isUpstoxActive ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'
              }`}
            />
            <span className="font-mono text-[11px] text-slate-300">
              {isUpstoxActive ? 'UPSTOX V3 LIVE' : 'DATA STANDBY'}
            </span>
          </div>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
            Phase 1
          </span>
        </div>
        <p className="text-[10px] text-slate-500 font-mono mt-1 truncate">
          {isUpstoxActive ? 'Authentic Market Feeds' : 'OAuth Session Required'}
        </p>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Persistent Sidebar */}
      <aside className="hidden lg:flex shrink-0 h-screen sticky top-0 z-20">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer Backdrop & Slide-in Menu */}
      {isOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
            onClick={onClose}
            aria-hidden="true"
          />
          <div className="relative flex-1 flex flex-col max-w-xs w-full bg-fintech-card shadow-2xl z-50 animate-in slide-in-from-left duration-200">
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
}
