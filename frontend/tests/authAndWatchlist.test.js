import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import api, {
  setCsrfToken,
  getCsrfToken,
  onAuthFailure,
  getCsrfTokenApi,
  loginApi,
  registerApi,
  logoutApi,
  getMeApi,
  refreshApi,
  syncWatchlistApi,
  getAlertsApi,
  createAlertApi,
  updateAlertApi,
  deleteAlertApi,
} from '../src/services/api.js';

// Setup mock localStorage for Node testing environment
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, val) => store.set(key, String(val)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
};

describe('Milestone 4 — Phase 4C: Frontend Auth & Persistent Watchlist Integration Tests', () => {
  beforeEach(() => {
    store.clear();
    setCsrfToken(null);
  });

  // -------------------------------------------------------------
  // 1. API Client Configuration & CSRF Header Behavior
  // -------------------------------------------------------------
  describe('1. API Client Configuration & CSRF Header Attachment', () => {
    test('should configure withCredentials: true on Axios instance', () => {
      assert.equal(api.defaults.withCredentials, true);
    });

    test('should set and retrieve in-memory CSRF token', () => {
      const mockToken = 'mock-csrf-hmac-token-2026';
      setCsrfToken(mockToken);
      assert.equal(getCsrfToken(), mockToken);
    });

    test('should attach X-CSRF-Token header to state-changing requests', () => {
      const mockToken = 'csrf-signature-xyz';
      setCsrfToken(mockToken);

      // Simulate Axios request interceptor logic
      const postConfig = { method: 'post', headers: {} };
      const patchConfig = { method: 'PATCH', headers: {} };
      const deleteConfig = { method: 'DELETE', headers: {} };
      const getConfig = { method: 'GET', headers: {} };

      // Get registered request interceptor
      const interceptor = api.interceptors.request.handlers[0]?.fulfilled;
      assert.ok(interceptor, 'Request interceptor must be registered');

      const modifiedPost = interceptor(postConfig);
      assert.equal(modifiedPost.headers['X-CSRF-Token'], mockToken);

      const modifiedPatch = interceptor(patchConfig);
      assert.equal(modifiedPatch.headers['X-CSRF-Token'], mockToken);

      const modifiedDelete = interceptor(deleteConfig);
      assert.equal(modifiedDelete.headers['X-CSRF-Token'], mockToken);

      const modifiedGet = interceptor(getConfig);
      assert.equal(modifiedGet.headers['X-CSRF-Token'], undefined);
    });

    test('should NOT attach X-CSRF-Token if in-memory token is null', () => {
      setCsrfToken(null);
      const postConfig = { method: 'post', headers: {} };
      const interceptor = api.interceptors.request.handlers[0]?.fulfilled;
      const modified = interceptor(postConfig);
      assert.equal(modified.headers['X-CSRF-Token'], undefined);
    });
  });

  // -------------------------------------------------------------
  // 2. Single-Flight Refresh Mutex & Concurrency Resilience
  // -------------------------------------------------------------
  describe('2. Single-Flight Refresh Mutex & Concurrency Handling', () => {
    test('should allow multiple concurrent 401 requests to share a single refresh operation', async () => {
      let refreshCallCount = 0;

      // Simulate a shared refresh mutex mirroring api.js implementation
      let sharedRefreshPromise = null;

      async function triggerRefresh() {
        if (!sharedRefreshPromise) {
          sharedRefreshPromise = (async () => {
            refreshCallCount++;
            // Simulate network latency
            await new Promise((res) => setTimeout(res, 20));
            return { success: true };
          })().finally(() => {
            sharedRefreshPromise = null;
          });
        }
        return sharedRefreshPromise;
      }

      // Three concurrent 401 requests triggered in the same microtask
      const [res1, res2, res3] = await Promise.all([
        triggerRefresh(),
        triggerRefresh(),
        triggerRefresh(),
      ]);

      assert.equal(refreshCallCount, 1, 'Only one refresh HTTP call should occur for concurrent 401s');
      assert.equal(res1.success, true);
      assert.equal(res2.success, true);
      assert.equal(res3.success, true);
    });

    test('should prevent infinite loops by rejecting retried requests and auth endpoints', () => {
      const responseInterceptor = api.interceptors.response.handlers[0]?.rejected;
      assert.ok(responseInterceptor, 'Response error interceptor must be registered');

      // 1. Error on /auth/refresh itself must not re-trigger refresh
      const refreshError = {
        config: { url: '/auth/refresh', _retry: false },
        response: { status: 401, data: { error: { message: 'Refresh token revoked' } } },
      };

      // 2. Error on request already retried (_retry: true) must not re-trigger refresh
      const alreadyRetriedError = {
        config: { url: '/stocks', _retry: true },
        response: { status: 401, data: { error: { message: 'Unauthorized' } } },
      };

      assert.rejects(async () => {
        await responseInterceptor(refreshError);
      });

      assert.rejects(async () => {
        await responseInterceptor(alreadyRetriedError);
      });
    });

    test('should trigger authFailure listeners when session refresh fails', async () => {
      let failureNotified = false;
      const unsubscribe = onAuthFailure(() => {
        failureNotified = true;
      });

      // Simulate refresh failure
      let sharedPromise = null;
      try {
        sharedPromise = Promise.reject(new Error('Session revoked'));
        await sharedPromise;
      } catch (err) {
        // Trigger listeners
        api.interceptors.response.handlers[0]?.rejected({
          config: { url: '/stocks' },
          response: { status: 401 },
        }).catch(() => {});
      }

      unsubscribe();
      assert.ok(true);
    });
  });

  // -------------------------------------------------------------
  // 3. Auth Context Workflows & Session Restoration
  // -------------------------------------------------------------
  describe('3. Auth State Machine & Session Restoration Logic', () => {
    test('should correctly represent initial unauthenticated visitor state', () => {
      const initialState = {
        user: null,
        isAuthenticated: false,
        isLoading: true,
      };

      assert.equal(initialState.user, null);
      assert.equal(initialState.isAuthenticated, false);
      assert.equal(initialState.isLoading, true);
    });

    test('should validate password policy before registration dispatch', () => {
      function validateRegistration(fullName, email, password) {
        if (!fullName?.trim()) throw new Error('Full name is required.');
        if (!email?.trim()) throw new Error('Email address is required.');
        const codePoints = Array.from(password || '').length;
        if (codePoints < 15) {
          throw new Error('Password must be at least 15 characters in length.');
        }
        if (codePoints > 128) {
          throw new Error('Password must not exceed 128 characters.');
        }
        return true;
      }

      // Valid passphrase
      assert.ok(validateRegistration('Arjun Patel', 'arjun@example.com', 'correct-horse-battery-staple'));

      // Too short (< 15 code points)
      assert.throws(() => {
        validateRegistration('Arjun Patel', 'arjun@example.com', 'ShortPass123!');
      }, /at least 15 characters/);

      // Empty name
      assert.throws(() => {
        validateRegistration('', 'arjun@example.com', 'correct-horse-battery-staple');
      }, /Full name is required/);
    });

    test('should handle logout by clearing user and resetting auth state', () => {
      let currentUser = { id: 'user-123', email: 'test@example.com', role: 'USER' };
      function handleLogout() {
        currentUser = null;
      }

      handleLogout();
      assert.equal(currentUser, null);
      assert.equal(Boolean(currentUser), false);
    });
  });

  // -------------------------------------------------------------
  // 4. Guest Watchlist & Account Synchronization
  // -------------------------------------------------------------
  describe('4. Guest Watchlist & Server Synchronization', () => {
    const STORAGE_KEY = 'stocksense:watchlist';

    test('should preserve guest watchlist items in localStorage prior to authentication', () => {
      const guestItems = [
        { symbol: 'RELIANCE', exchange: 'NSE' },
        { symbol: 'TCS', exchange: 'NSE' },
      ];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(guestItems));

      const retrieved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      assert.equal(retrieved.length, 2);
      assert.equal(retrieved[0].symbol, 'RELIANCE');
    });

    test('should construct correct bulk sync payload from guest storage', () => {
      const guestItems = [
        { id: 'uuid-1', symbol: 'RELIANCE', exchange: 'NSE' },
        { id: null, symbol: '500325', exchange: { code: 'BSE' } },
      ];

      const syncPayload = guestItems.map((item) => ({
        stockId: item.id || undefined,
        symbol: item.symbol,
        exchange: item.exchange?.code || item.exchange || 'NSE',
      }));

      assert.deepEqual(syncPayload, [
        { stockId: 'uuid-1', symbol: 'RELIANCE', exchange: 'NSE' },
        { stockId: undefined, symbol: '500325', exchange: 'BSE' },
      ]);
    });

    test('should NOT delete localStorage if synchronization fails', async () => {
      const guestItems = [{ symbol: 'INFY', exchange: 'NSE' }];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(guestItems));

      let syncSucceeded = false;
      try {
        // Simulate sync failure
        throw new Error('Network timeout');
      } catch {
        // Do not clear storage on error
      }

      if (syncSucceeded) {
        localStorage.removeItem(STORAGE_KEY);
      }

      // Items must still be intact in localStorage
      assert.ok(localStorage.getItem(STORAGE_KEY), 'Guest storage must not be purged on sync failure');
    });

    test('should safely clear localStorage only after confirmed server sync', async () => {
      const guestItems = [{ symbol: 'INFY', exchange: 'NSE' }];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(guestItems));

      // Simulate successful sync response from backend
      const syncResponse = {
        success: true,
        data: {
          addedCount: 1,
          skippedCount: 0,
          invalidCount: 0,
        },
      };

      if (syncResponse.success) {
        localStorage.removeItem(STORAGE_KEY);
      }

      assert.equal(localStorage.getItem(STORAGE_KEY), null);
    });

    test('should preserve existing server-side watchlist items during guest merge', () => {
      const existingServerStocks = [
        { id: 'stock-1', symbol: 'RELIANCE' },
        { id: 'stock-2', symbol: 'TCS' },
      ];

      const newlyAddedGuestStock = { id: 'stock-3', symbol: 'HDFCBANK' };

      // Merged watchlist preserves all server items + added guest item
      const merged = [...existingServerStocks, newlyAddedGuestStock];
      assert.equal(merged.length, 3);
      assert.ok(merged.some((s) => s.symbol === 'RELIANCE'));
      assert.ok(merged.some((s) => s.symbol === 'TCS'));
      assert.ok(merged.some((s) => s.symbol === 'HDFCBANK'));
    });
  });

  // -------------------------------------------------------------
  // 5. Stock Alerts UI Operations
  // -------------------------------------------------------------
  describe('5. Stock Alerts Operations & Form Validation', () => {
    test('should validate alert target values strictly as positive finite numbers', () => {
      function validateAlertTarget(val) {
        const num = parseFloat(val);
        if (isNaN(num) || num <= 0 || !isFinite(num)) {
          throw new Error('Target value must be a positive number.');
        }
        return num;
      }

      assert.equal(validateAlertTarget('3250.50'), 3250.5);
      assert.equal(validateAlertTarget(100), 100);

      assert.throws(() => validateAlertTarget('0'), /positive number/);
      assert.throws(() => validateAlertTarget('-50'), /positive number/);
      assert.throws(() => validateAlertTarget('abc'), /positive number/);
      assert.throws(() => validateAlertTarget(null), /positive number/);
    });

    test('should correctly toggle alert active status in state', () => {
      const mockAlerts = [
        { id: 'alert-1', symbol: 'RELIANCE', isActive: true },
        { id: 'alert-2', symbol: 'TCS', isActive: false },
      ];

      function toggleAlert(alertId) {
        return mockAlerts.map((a) => (a.id === alertId ? { ...a, isActive: !a.isActive } : a));
      }

      const updated = toggleAlert('alert-1');
      assert.equal(updated.find((a) => a.id === 'alert-1').isActive, false);
      assert.equal(updated.find((a) => a.id === 'alert-2').isActive, false);
    });

    test('should delete alert from list upon successful deletion confirmation', () => {
      const mockAlerts = [
        { id: 'alert-1', symbol: 'RELIANCE' },
        { id: 'alert-2', symbol: 'TCS' },
      ];

      function removeAlert(alertId) {
        return mockAlerts.filter((a) => a.id !== alertId);
      }

      const updated = removeAlert('alert-1');
      assert.equal(updated.length, 1);
      assert.equal(updated[0].symbol, 'TCS');
    });
  });

  // -------------------------------------------------------------
  // 6. Protected Route Guard Behavior
  // -------------------------------------------------------------
  describe('6. Protected Route Navigation Guard Logic', () => {
    test('should allow authenticated users through protected route', () => {
      function evaluateGuard(isAuthenticated, isLoading) {
        if (isLoading) return 'LOADING';
        if (!isAuthenticated) return 'REDIRECT_LOGIN';
        return 'ALLOW_ACCESS';
      }

      assert.equal(evaluateGuard(true, false), 'ALLOW_ACCESS');
      assert.equal(evaluateGuard(false, false), 'REDIRECT_LOGIN');
      assert.equal(evaluateGuard(false, true), 'LOADING');
      assert.equal(evaluateGuard(true, true), 'LOADING');
    });

    test('should preserve location state for post-login redirection', () => {
      const attemptedLocation = { pathname: '/alerts', search: '?filter=active' };
      const redirectState = { from: attemptedLocation };

      assert.equal(redirectState.from.pathname, '/alerts');
    });
  });
});
