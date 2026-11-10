const WATCHLIST_STORAGE_KEY = 'stocksense:watchlist';
const RECENTLY_VIEWED_STORAGE_KEY = 'stocksense:recently_viewed';

// Seed default bluechips for quick preview if empty
const DEFAULT_INITIAL_WATCHLIST = [
  { symbol: 'RELIANCE', name: 'Reliance Industries Limited', exchange: 'NSE', isin: 'INE002A01018' },
  { symbol: 'TCS', name: 'Tata Consultancy Services Limited', exchange: 'NSE', isin: 'INE467B01029' },
  { symbol: 'INFY', name: 'Infosys Limited', exchange: 'NSE', isin: 'INE009A01021' },
  { symbol: 'HDFCBANK', name: 'HDFC Bank Limited', exchange: 'NSE', isin: 'INE040A01034' },
  { symbol: 'ICICIBANK', name: 'ICICI Bank Limited', exchange: 'NSE', isin: 'INE090A01021' },
];

export function getWatchlist() {
  try {
    const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(DEFAULT_INITIAL_WATCHLIST));
      return DEFAULT_INITIAL_WATCHLIST;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    // Self-healing fallback if stored data was not an array
    localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(DEFAULT_INITIAL_WATCHLIST));
    return DEFAULT_INITIAL_WATCHLIST;
  } catch {
    // Self-healing fallback if JSON was corrupted or Storage threw
    try {
      localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(DEFAULT_INITIAL_WATCHLIST));
    } catch {
      // Ignore in restricted environments
    }
    return DEFAULT_INITIAL_WATCHLIST;
  }
}

export function addToWatchlist(stock) {
  if (!stock || !stock.symbol) return getWatchlist();
  try {
    const current = getWatchlist();
    const exists = current.some(
      (item) => item.symbol.toUpperCase() === stock.symbol.toUpperCase() && item.exchange === (stock.exchange?.code || stock.exchange || 'NSE')
    );
    if (exists) return current;

    const newItem = {
      id: stock.id,
      symbol: stock.symbol.toUpperCase(),
      name: stock.companyName || stock.name || stock.symbol,
      exchange: stock.exchange?.code || stock.exchange || 'NSE',
      isin: stock.isin || null,
      instrumentType: stock.instrumentType || 'EQUITY',
      addedAt: new Date().toISOString(),
    };

    const updated = [newItem, ...current];
    localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return getWatchlist();
  }
}

export function removeFromWatchlist(symbolOrId) {
  try {
    const current = getWatchlist();
    const needle = String(symbolOrId).toUpperCase();
    const updated = current.filter(
      (item) => item.symbol.toUpperCase() !== needle && item.id !== symbolOrId
    );
    localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return getWatchlist();
  }
}

export function isStockInWatchlist(symbolOrId) {
  if (!symbolOrId) return false;
  const current = getWatchlist();
  const needle = String(symbolOrId).toUpperCase();
  return current.some((item) => item.symbol.toUpperCase() === needle || item.id === symbolOrId);
}

export function getRecentlyViewed() {
  try {
    const raw = localStorage.getItem(RECENTLY_VIEWED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    localStorage.setItem(RECENTLY_VIEWED_STORAGE_KEY, JSON.stringify([]));
    return [];
  } catch {
    try {
      localStorage.setItem(RECENTLY_VIEWED_STORAGE_KEY, JSON.stringify([]));
    } catch {
      // Ignore in restricted environments
    }
    return [];
  }
}

export function addRecentlyViewed(stock) {
  if (!stock || !stock.symbol) return getRecentlyViewed();
  try {
    const current = getRecentlyViewed();
    const needle = stock.symbol.toUpperCase();
    const filtered = current.filter((item) => item.symbol.toUpperCase() !== needle);

    const newItem = {
      id: stock.id,
      symbol: stock.symbol.toUpperCase(),
      name: stock.companyName || stock.name || stock.symbol,
      exchange: stock.exchange?.code || stock.exchange || 'NSE',
      instrumentType: stock.instrumentType || 'EQUITY',
      viewedAt: new Date().toISOString(),
    };

    const updated = [newItem, ...filtered].slice(0, 8); // Keep top 8 recent
    localStorage.setItem(RECENTLY_VIEWED_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return getRecentlyViewed();
  }
}
