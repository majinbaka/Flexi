import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { AuthenticatedUserDto, AuthTokensDto } from '@flexi/shared-types';
import {
  apiGet,
  apiPost,
  getStoredRefreshToken,
  onAccessTokenRefreshed,
  onSessionExpire,
  refreshSession,
  setAccessToken as setApiClientAccessToken,
  setStoredRefreshToken,
} from '../lib/api-client';

export interface AuthContextValue {
  /** In-memory only -- never persisted, lost on reload (see spec Boundaries). */
  accessToken: string | null;
  currentUser: AuthenticatedUserDto | null;
  /** True until the boot-time silent refresh (if any) has settled. */
  loading: boolean;
  login: (email: string, password: string, tenantId?: string) => Promise<void>;
  logout: () => Promise<void>;
}

/**
 * Exported so tests and Storybook can supply a fabricated session without
 * running `AuthProvider`'s network bootstrap. Application code should use
 * `useAuth` rather than consuming this directly.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const AuthContext = createContext<AuthContextValue | undefined>(
  undefined,
);

/**
 * Holds the access token + current user as React state (so components
 * re-render on auth changes) while api-client owns the values used for
 * actual network calls. On mount, if a refresh token is stored, silently
 * refreshes before `loading` clears so ProtectedRoute never flashes the
 * login page for a returning session (see AC "stored refresh token ->
 * protected routes load without re-entering credentials").
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [accessToken, setAccessTokenState] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthenticatedUserDto | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const clearSession = () => {
    setApiClientAccessToken(null);
    setStoredRefreshToken(null);
    setAccessTokenState(null);
    setCurrentUser(null);
  };

  // Fired by api-client when a background refresh (triggered by a 401 on
  // some other call) fails, so React state clears even though the
  // failure didn't originate from an explicit login()/logout() call here.
  // The success counterpart keeps React's accessToken state in sync when
  // that same kind of background refresh succeeds instead -- otherwise a
  // mid-session rotation would only ever update api-client's internal
  // module state, leaving ProtectedRoute/consumers reading a stale token.
  useEffect(() => {
    onSessionExpire(clearSession);
    onAccessTokenRefreshed((token) => setAccessTokenState(token));
    return () => {
      onSessionExpire(null);
      onAccessTokenRefreshed(null);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      if (!getStoredRefreshToken()) {
        setLoading(false);
        return;
      }

      const newAccessToken = await refreshSession();
      if (cancelled) return;

      if (!newAccessToken) {
        setAccessTokenState(null);
        setCurrentUser(null);
        setLoading(false);
        return;
      }

      setApiClientAccessToken(newAccessToken);
      setAccessTokenState(newAccessToken);

      try {
        const user = await apiGet<AuthenticatedUserDto>('/auth/me');
        if (!cancelled) setCurrentUser(user);
      } catch {
        if (!cancelled) clearSession();
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  async function login(
    email: string,
    password: string,
    tenantId?: string,
  ): Promise<void> {
    const tokens = await apiPost<AuthTokensDto>(
      '/auth/login',
      { email, password },
      {
        headers: tenantId ? { 'x-tenant-id': tenantId } : {},
        skipAuth: true,
      },
    );

    setApiClientAccessToken(tokens.accessToken);
    setStoredRefreshToken(tokens.refreshToken);
    setAccessTokenState(tokens.accessToken);

    const user = await apiGet<AuthenticatedUserDto>('/auth/me');
    setCurrentUser(user);
  }

  async function logout(): Promise<void> {
    const refreshToken = getStoredRefreshToken();
    try {
      if (refreshToken) {
        await apiPost('/auth/logout', { refreshToken });
      }
    } catch {
      // Logout clears client state regardless of the request's outcome
      // (see spec Boundaries "Logout").
    } finally {
      clearSession();
    }
  }

  const value: AuthContextValue = {
    accessToken,
    currentUser,
    loading,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// This file exports both a component (AuthProvider) and a hook (useAuth) --
// the standard React context pattern, but one react-refresh's Vite plugin
// flags because it can't guarantee fast-refresh boundaries for the hook.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
