import axios from 'axios';

let inMemoryCsrfToken = null;
let refreshPromise = null;
const authFailureListeners = new Set();

export function setCsrfToken(token) {
  inMemoryCsrfToken = token;
}

export function getCsrfToken() {
  return inMemoryCsrfToken;
}

export function onAuthFailure(callback) {
  authFailureListeners.add(callback);
  return () => authFailureListeners.delete(callback);
}

function notifyAuthFailure(error) {
  authFailureListeners.forEach((cb) => {
    try {
      cb(error);
    } catch (e) {
      console.error('Error in auth failure listener:', e);
    }
  });
}

const api = axios.create({
  baseURL: (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) || '/api',
  timeout: 15000,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor: attach in-memory CSRF token to state-changing requests
api.interceptors.request.use((config) => {
  const method = config.method?.toLowerCase();
  if (['post', 'put', 'patch', 'delete'].includes(method) && inMemoryCsrfToken) {
    config.headers['X-CSRF-Token'] = inMemoryCsrfToken;
  }
  return config;
});

// Response interceptor: single-flight refresh mutex and error normalization
api.interceptors.response.use(
  (response) => response.data,
  async (error) => {
    const originalRequest = error.config;
    const status = error.response?.status;
    const url = originalRequest?.url || '';

    // Bypass refresh logic for auth-specific endpoints to prevent recursion loops
    const isAuthEndpoint =
      url.includes('/auth/login') ||
      url.includes('/auth/register') ||
      url.includes('/auth/refresh') ||
      url.includes('/auth/csrf');

    if (status === 401 && !originalRequest?._retry && !isAuthEndpoint) {
      originalRequest._retry = true;

      try {
        if (!refreshPromise) {
          // Single-flight refresh invocation
          refreshPromise = api.post('/auth/refresh').finally(() => {
            refreshPromise = null;
          });
        }
        await refreshPromise;
        return api(originalRequest);
      } catch (refreshErr) {
        notifyAuthFailure(refreshErr);
        const formatted = {
          message: error.response?.data?.error?.message || 'Session expired. Please log in again.',
          code: error.response?.data?.error?.code || 'UNAUTHORIZED',
          status: 401,
          details: error.response?.data?.error?.details || null,
        };
        return Promise.reject(formatted);
      }
    }

    const formattedError = {
      message: error.response?.data?.error?.message || error.message || 'An unexpected error occurred',
      code: error.response?.data?.error?.code || 'NETWORK_ERROR',
      status: error.response?.status || 500,
      details: error.response?.data?.error?.details || null,
    };
    return Promise.reject(formattedError);
  }
);

// -------------------------------------------------------------
// Authentication Endpoints
// -------------------------------------------------------------

export async function getCsrfTokenApi() {
  return api.get('/auth/csrf');
}

export async function loginApi(credentials) {
  return api.post('/auth/login', credentials);
}

export async function registerApi(data) {
  return api.post('/auth/register', data);
}

export async function logoutApi() {
  return api.post('/auth/logout');
}

export async function getMeApi() {
  return api.get('/auth/me');
}

export async function refreshApi() {
  return api.post('/auth/refresh');
}

// -------------------------------------------------------------
// Watchlist Endpoints (Phase 4B API)
// -------------------------------------------------------------

export async function getWatchlistsApi() {
  return api.get('/watchlists');
}

export async function getWatchlistByIdApi(id) {
  return api.get(`/watchlists/${encodeURIComponent(id)}`);
}

export async function createWatchlistApi(data) {
  return api.post('/watchlists', data);
}

export async function renameWatchlistApi(id, data) {
  return api.put(`/watchlists/${encodeURIComponent(id)}`, data);
}

export async function deleteWatchlistApi(id) {
  return api.delete(`/watchlists/${encodeURIComponent(id)}`);
}

export async function addStockToWatchlistApi(watchlistId, data) {
  return api.post(`/watchlists/${encodeURIComponent(watchlistId)}/items`, data);
}

export async function removeStockFromWatchlistApi(watchlistId, stockId) {
  return api.delete(`/watchlists/${encodeURIComponent(watchlistId)}/items/${encodeURIComponent(stockId)}`);
}

export async function syncWatchlistApi(items) {
  return api.post('/watchlists/sync', { items });
}

// -------------------------------------------------------------
// Stock Alerts Endpoints (Phase 4B API)
// -------------------------------------------------------------

export async function getAlertsApi() {
  return api.get('/alerts');
}

export async function getAlertByIdApi(id) {
  return api.get(`/alerts/${encodeURIComponent(id)}`);
}

export async function createAlertApi(data) {
  return api.post('/alerts', data);
}

export async function updateAlertApi(id, data) {
  return api.patch(`/alerts/${encodeURIComponent(id)}`, data);
}

export async function deleteAlertApi(id) {
  return api.delete(`/alerts/${encodeURIComponent(id)}`);
}

// -------------------------------------------------------------
// Market Data & Stock Catalogue Endpoints
// -------------------------------------------------------------

/**
 * Fetch paginated stock catalogue with optional filters and sorting.
 */
export async function getStocks(params = {}) {
  return api.get('/stocks', { params });
}

/**
 * Fast typeahead search for stock symbols and company names.
 */
export async function searchStocks(query, limit = 10) {
  return api.get('/stocks/search', { params: { q: query, limit } });
}

/**
 * Retrieve comprehensive stock detail by UUID, instrumentToken, or symbol.
 */
export async function getStockById(id, params = {}) {
  return api.get(`/stocks/${encodeURIComponent(id)}`, { params });
}

/**
 * Retrieve historical OHLCV candlestick data for a stock.
 */
export async function getStockPrices(id, params = {}) {
  return api.get(`/stocks/${encodeURIComponent(id)}/prices`, { params });
}

/**
 * Fetch platform market overview aggregate with verified statistics and Upstox provider status.
 */
export async function getMarketOverview() {
  return api.get('/market/overview');
}

/**
 * Fetch list of verified indices in the database (e.g. NIFTY 50, SENSEX).
 */
export async function getMarketIndices() {
  return api.get('/market/indices');
}

export default api;
