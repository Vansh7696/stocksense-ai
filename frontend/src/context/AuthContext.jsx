import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  getCsrfTokenApi,
  getMeApi,
  loginApi,
  registerApi,
  logoutApi,
  refreshApi,
  setCsrfToken,
  onAuthFailure,
} from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [csrfTokenState, setCsrfTokenState] = useState(null);

  /**
   * Fetch and persist CSRF token in memory.
   */
  const fetchCsrfToken = useCallback(async () => {
    try {
      const response = await getCsrfTokenApi();
      const token = response?.data?.csrfToken;
      if (token) {
        setCsrfToken(token);
        setCsrfTokenState(token);
        return token;
      }
    } catch (err) {
      console.warn('[Auth] CSRF token fetch failed:', err?.message || err);
    }
    return null;
  }, []);

  /**
   * Restore user session on application initialization.
   */
  const restoreSession = useCallback(async () => {
    try {
      // 1. Ensure CSRF token is available
      await fetchCsrfToken();

      // 2. Attempt to fetch current user
      const response = await getMeApi();
      if (response?.data?.user) {
        setUser(response.data.user);
        return response.data.user;
      }
    } catch {
      // 3. If access token is expired, attempt session refresh
      try {
        await refreshApi();
        const meResponse = await getMeApi();
        if (meResponse?.data?.user) {
          setUser(meResponse.data.user);
          return meResponse.data.user;
        }
      } catch {
        // Unauthenticated visitor (expected for guest users)
        setUser(null);
      }
    } finally {
      setIsLoading(false);
    }
    return null;
  }, [fetchCsrfToken]);

  useEffect(() => {
    restoreSession();

    // Listen for global auth failure events (e.g. revoked refresh token)
    const unsubscribe = onAuthFailure(() => {
      setUser(null);
    });

    return () => unsubscribe();
  }, [restoreSession]);

  /**
   * Authenticate user with credentials.
   */
  const login = useCallback(
    async ({ email, password }) => {
      // Ensure CSRF token is present before state-mutating login
      await fetchCsrfToken();
      const response = await loginApi({ email, password });
      const authenticatedUser = response?.data?.user;
      if (authenticatedUser) {
        setUser(authenticatedUser);
      }
      return authenticatedUser;
    },
    [fetchCsrfToken]
  );

  /**
   * Register new user account.
   */
  const register = useCallback(
    async ({ fullName, email, password }) => {
      await fetchCsrfToken();
      const response = await registerApi({ fullName, email, password });
      const registeredUser = response?.data?.user;
      if (registeredUser) {
        setUser(registeredUser);
      }
      return registeredUser;
    },
    [fetchCsrfToken]
  );

  /**
   * Terminate active user session.
   */
  const logout = useCallback(async () => {
    try {
      await logoutApi();
    } catch {
      // Best-effort logout; clear client state even if network fails
    } finally {
      setUser(null);
      await fetchCsrfToken();
    }
  }, [fetchCsrfToken]);

  const value = {
    user,
    isAuthenticated: Boolean(user),
    isLoading,
    csrfToken: csrfTokenState,
    login,
    register,
    logout,
    restoreSession,
    fetchCsrfToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export default AuthContext;
