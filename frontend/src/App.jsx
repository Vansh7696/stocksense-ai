import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { WatchlistProvider } from './context/WatchlistContext';
import DashboardLayout from './layouts/DashboardLayout';
import DashboardPage from './pages/DashboardPage';
import StockExplorerPage from './pages/StockExplorerPage';
import StockDetailPage from './pages/StockDetailPage';
import WatchlistPage from './pages/WatchlistPage';
import AlertsPage from './pages/AlertsPage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import NotFoundPage from './pages/NotFoundPage';
import ProtectedRoute from './components/auth/ProtectedRoute';

function PlaceholderPage({ title, description }) {
  return (
    <div className="p-8 max-w-4xl mx-auto rounded-xl bg-fintech-card border border-fintech-border text-center space-y-4">
      <div className="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center mx-auto text-xl font-bold">
        SS
      </div>
      <h2 className="text-xl font-bold text-white tracking-tight">{title}</h2>
      <p className="text-sm text-fintech-muted max-w-lg mx-auto leading-relaxed">
        {description}
      </p>
      <div className="pt-2">
        <span className="text-xs px-3 py-1 rounded-full bg-fintech-surface border border-fintech-border font-mono text-slate-400">
          Scheduled for Phase Implementation
        </span>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <WatchlistProvider>
          <Routes>
            <Route path="/" element={<DashboardLayout />}>
              <Route index element={<DashboardPage />} />
              <Route path="login" element={<LoginPage />} />
              <Route path="register" element={<RegisterPage />} />
              <Route
                path="market-overview"
                element={
                  <PlaceholderPage
                    title="Market Overview & Breadth"
                    description="Comprehensive sector heatmaps, advance/decline ratios, and market breadth indicators across Indian equities."
                  />
                }
              />
              <Route path="stocks" element={<StockExplorerPage />} />
              <Route path="stocks/:id" element={<StockDetailPage />} />
              <Route path="watchlist" element={<WatchlistPage />} />
              <Route
                path="alerts"
                element={
                  <ProtectedRoute>
                    <AlertsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="recommendations"
                element={
                  <PlaceholderPage
                    title="AI Explainable Recommendations"
                    description="Machine-learned BUY / HOLD / SELL signals powered by XGBoost, FinBERT sentiment, and TreeSHAP factor attributions."
                  />
                }
              />
              <Route
                path="screener"
                element={
                  <PlaceholderPage
                    title="Quantitative Stock Screener"
                    description="Filter Indian equities across technical indicators (RSI, MACD, Bollinger Bands) and fundamental metrics."
                  />
                }
              />
              <Route
                path="portfolio"
                element={
                  <PlaceholderPage
                    title="Portfolio Analytics"
                    description="Real-time P&L tracking, asset allocation breakdown, Sharpe ratio, and drawdown analysis."
                  />
                }
              />
              <Route
                path="paper-trading"
                element={
                  <PlaceholderPage
                    title="Virtual Paper Trading"
                    description="Risk-free trade simulation with real-time Indian market quotes, order execution, and performance tracking."
                  />
                }
              />
              <Route
                path="backtesting"
                element={
                  <PlaceholderPage
                    title="Strategy Backtesting Engine"
                    description="Walk-forward backtesting with transaction slippage, brokerage fee accounting, and drawdown reporting."
                  />
                }
              />
              <Route
                path="news"
                element={
                  <PlaceholderPage
                    title="Financial News & FinBERT Sentiment"
                    description="Real-time Indian financial news sentiment scoring powered by fine-tuned Transformer models."
                  />
                }
              />
              <Route
                path="assistant"
                element={
                  <PlaceholderPage
                    title="AI Financial Research Assistant"
                    description="Interactive conversational intelligence for company filings, quarterly earnings, and technical levels."
                  />
                }
              />
              <Route
                path="settings"
                element={
                  <PlaceholderPage
                    title="Platform Settings & API Configurations"
                    description="Manage Upstox API V3 credentials, broker integrations, notifications, and security."
                  />
                }
              />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </WatchlistProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
