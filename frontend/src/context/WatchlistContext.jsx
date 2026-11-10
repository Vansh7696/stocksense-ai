import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from './AuthContext';
import {
  getWatchlistsApi,
  addStockToWatchlistApi,
  removeStockFromWatchlistApi,
  syncWatchlistApi,
} from '../services/api';
import {
  getWatchlist as getGuestWatchlist,
  addToWatchlist as addGuestWatchlist,
  removeFromWatchlist as removeGuestWatchlist,
  isStockInWatchlist as isGuestStockInWatchlist,
} from '../utils/watchlist';

const WatchlistContext = createContext(null);

export function WatchlistProvider({ children }) {
  const { user, isAuthenticated } = useAuth();
  const [watchlists, setWatchlists] = useState([]);
  const [activeWatchlist, setActiveWatchlist] = useState(null);
  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);

  const prevAuthRef = useRef(isAuthenticated);

  /**
   * Fetch authenticated user's watchlists from PostgreSQL.
   */
  const fetchServerWatchlists = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await getWatchlistsApi();
      const list = response?.data?.watchlists || [];
      setWatchlists(list);

      // Select default watchlist as active
      const defaultWl = list.find((w) => w.isDefault) || list[0] || null;
      setActiveWatchlist(defaultWl);

      if (defaultWl?.items) {
        setItems(defaultWl.items.map((i) => i.stock));
      } else {
        setItems([]);
      }
      return list;
    } catch (err) {
      console.warn('[Watchlist] Failed to fetch server watchlists:', err?.message || err);
      return [];
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Load guest watchlist from browser localStorage.
   */
  const loadGuestItems = useCallback(() => {
    const guestItems = getGuestWatchlist();
    setItems(guestItems);
    setActiveWatchlist({
      id: 'guest-local',
      name: 'Local Watchlist',
      isDefault: true,
      itemCount: guestItems.length,
      items: guestItems,
    });
  }, []);

  /**
   * Synchronize guest localStorage items to user's PostgreSQL default watchlist upon login.
   */
  const synchronizeGuestWatchlist = useCallback(async () => {
    const rawLocal = localStorage.getItem('stocksense:watchlist');
    if (!rawLocal) {
      await fetchServerWatchlists();
      return;
    }

    let localItems = [];
    try {
      localItems = JSON.parse(rawLocal);
    } catch {
      localItems = [];
    }

    if (!Array.isArray(localItems) || localItems.length === 0) {
      await fetchServerWatchlists();
      return;
    }

    // Format guest items for sync payload
    const syncPayload = localItems.map((item) => ({
      stockId: item.id || undefined,
      symbol: item.symbol,
      exchange: item.exchange?.code || item.exchange || 'NSE',
    }));

    try {
      setIsLoading(true);
      const res = await syncWatchlistApi(syncPayload);
      if (res?.data?.success) {
        // Confirmation received: safe to clear guest storage without data loss
        localStorage.removeItem('stocksense:watchlist');
        setSyncStatus({
          addedCount: res.data.addedCount,
          skippedCount: res.data.skippedCount,
          invalidCount: res.data.invalidCount,
        });
      }
    } catch (err) {
      console.warn('[Watchlist] Guest sync error:', err?.message || err);
    } finally {
      await fetchServerWatchlists();
    }
  }, [fetchServerWatchlists]);

  // Handle auth transitions (login / logout)
  useEffect(() => {
    const wasAuth = prevAuthRef.current;
    prevAuthRef.current = isAuthenticated;

    if (isAuthenticated) {
      // Transition from guest to logged-in -> run sync
      if (!wasAuth) {
        synchronizeGuestWatchlist();
      } else {
        fetchServerWatchlists();
      }
    } else {
      // Logged out -> revert to guest localStorage items
      setWatchlists([]);
      setSyncStatus(null);
      loadGuestItems();
    }
  }, [isAuthenticated, synchronizeGuestWatchlist, fetchServerWatchlists, loadGuestItems]);

  /**
   * Check if a stock is in the current active watchlist.
   */
  const isInWatchlist = useCallback(
    (symbolOrId) => {
      if (!symbolOrId) return false;
      const needle = String(symbolOrId).toUpperCase();
      return items.some(
        (stock) => stock?.symbol?.toUpperCase() === needle || stock?.id === symbolOrId
      );
    },
    [items]
  );

  /**
   * Add stock to active watchlist (PostgreSQL if authenticated, localStorage if guest).
   */
  const addStock = useCallback(
    async (stock) => {
      if (!stock) return;

      if (!isAuthenticated) {
        const updated = addGuestWatchlist(stock);
        setItems(updated);
        return;
      }

      if (!activeWatchlist?.id) {
        await fetchServerWatchlists();
      }

      const targetWatchlistId = activeWatchlist?.id;
      if (!targetWatchlistId) return;

      try {
        await addStockToWatchlistApi(targetWatchlistId, {
          stockId: stock.id,
          symbol: stock.symbol,
          exchange: stock.exchange?.code || stock.exchange || 'NSE',
        });
        await fetchServerWatchlists();
      } catch (err) {
        // Re-throw so caller can display ambiguous error or duplicate warning
        throw err;
      }
    },
    [isAuthenticated, activeWatchlist, fetchServerWatchlists]
  );

  /**
   * Remove stock from active watchlist (PostgreSQL if authenticated, localStorage if guest).
   */
  const removeStock = useCallback(
    async (stockIdOrSymbol) => {
      if (!stockIdOrSymbol) return;

      if (!isAuthenticated) {
        const updated = removeGuestWatchlist(stockIdOrSymbol);
        setItems(updated);
        return;
      }

      // Find stock ID from current items if symbol passed
      const targetStock = items.find(
        (s) =>
          s.id === stockIdOrSymbol ||
          s.symbol?.toUpperCase() === String(stockIdOrSymbol).toUpperCase()
      );
      const stockId = targetStock?.id || stockIdOrSymbol;

      if (!activeWatchlist?.id || !stockId) return;

      try {
        await removeStockFromWatchlistApi(activeWatchlist.id, stockId);
        await fetchServerWatchlists();
      } catch (err) {
        console.warn('[Watchlist] Remove failed:', err?.message || err);
        throw err;
      }
    },
    [isAuthenticated, activeWatchlist, items, fetchServerWatchlists]
  );

  /**
   * Toggle stock in watchlist.
   */
  const toggleStock = useCallback(
    async (stock) => {
      if (!stock) return false;
      const alreadyIn = isInWatchlist(stock.id) || isInWatchlist(stock.symbol);
      if (alreadyIn) {
        await removeStock(stock.id || stock.symbol);
        return false;
      } else {
        await addStock(stock);
        return true;
      }
    },
    [isInWatchlist, removeStock, addStock]
  );

  const value = {
    watchlists,
    activeWatchlist,
    items,
    isLoading,
    syncStatus,
    isInWatchlist,
    addStock,
    removeStock,
    toggleStock,
    refreshWatchlists: fetchServerWatchlists,
  };

  return <WatchlistContext.Provider value={value}>{children}</WatchlistContext.Provider>;
}

export function useWatchlist() {
  const context = useContext(WatchlistContext);
  if (!context) {
    throw new Error('useWatchlist must be used within a WatchlistProvider');
  }
  return context;
}

export default WatchlistContext;
