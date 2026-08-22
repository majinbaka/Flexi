import type { AuthTokensDto } from '@flexi/shared-types';

/**
 * Thin fetch wrapper around the backend's `{success,data,error}` envelope
 * (see apps/backend/src/common/response.interceptor.ts,
 * http-exception.filter.ts). Owns the in-memory access token and the
 * localStorage-persisted refresh token so both AuthContext (React-facing
 * state) and any plain module code can share one source of truth, and
 * implements the single-flight refresh-and-retry-once-on-401 policy from
 * spec-core-authentication-fe.md.
 *
 * AuthContext is still the source of truth for *rendering* (it mirrors
 * these values into React state via login()/logout()/bootstrap), but the
 * actual token values live here so a fetch triggered outside of a React
 * event (e.g. a background retry) always sees the current token
 * synchronously, without needing a ref/closure dance through context.
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string;
if (!API_BASE_URL) {
  throw new Error('VITE_API_BASE_URL is not configured');
}

const REFRESH_TOKEN_STORAGE_KEY = 'flexi_refresh_token';

// Endpoints that must never trigger the refresh-and-retry flow on 401 --
// a 401 from any of these IS the auth failure, not a symptom of an
// expired access token. `/auth/logout` in particular must fail immediately
// on 401 (best-effort revoke only) rather than rotate a fresh refresh
// token that then never gets explicitly revoked.
const NO_REFRESH_PATHS = new Set([
  '/auth/login',
  '/auth/refresh',
  '/auth/logout',
]);

export class ApiError extends Error {
  code: string;
  existingAttemptId?: string;

  constructor(code: string, message: string, existingAttemptId?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.existingAttemptId = existingAttemptId;
  }
}

/** Stable code for rate-limited auth requests -- callers can branch on this without matching translated message text. */
export const RATE_LIMITED_ERROR_CODE = 'RATE_LIMITED';

// The two endpoints ThrottlerGuard actually rate-limits (see
// apps/backend/src/modules/auth/auth.controller.ts). Deliberately a subset
// of NO_REFRESH_PATHS, not the full set -- /auth/logout is best-effort and
// isn't a brute-force target, so its 429s (if any) fall through to generic
// error handling instead of this dedicated messaging.
const RATE_LIMITED_PATHS = new Set(['/auth/login', '/auth/refresh']);

interface ApiSuccessEnvelope<T> {
  success: true;
  data: T;
  error: null;
}

interface ApiErrorEnvelope {
  success: false;
  data: null;
  error: { code: string; message: string; existingAttemptId?: string };
}

type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Skip attaching Authorization even if an access token is set (login/refresh). */
  skipAuth?: boolean;
}

let accessToken: string | null = null;
let refreshInFlight: Promise<string | null> | null = null;
let onSessionExpired: (() => void) | null = null;
let onAccessTokenRefreshedHandler: ((token: string) => void) | null = null;

/** Called by AuthContext whenever its own access-token state changes. */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

// localStorage can throw on access in some browser configurations (e.g.
// certain private-browsing modes) -- a throw here must never bubble past
// this module: on read, treat it as "no token"; on write, treat it as a
// no-op. See findings in the step-04 review.
export function getStoredRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredRefreshToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
    }
  } catch {
    // no-op -- see comment above.
  }
}

/**
 * Registered once by AuthProvider. Fired when a background refresh (401
 * on some other call) fails, so React state gets cleared even though the
 * failure didn't originate from an explicit AuthContext.login()/logout()
 * call.
 */
export function onSessionExpire(handler: (() => void) | null): void {
  onSessionExpired = handler;
}

/**
 * Registered once by AuthProvider. Fired when a background refresh (401
 * on some other call, not the boot-time one) succeeds, so AuthContext's
 * React `accessToken` state -- what ProtectedRoute and other consumers
 * read -- stays in sync with the module-level token this file actually
 * uses for outgoing requests after a mid-session rotation.
 */
export function onAccessTokenRefreshed(
  handler: ((token: string) => void) | null,
): void {
  onAccessTokenRefreshedHandler = handler;
}

async function rawRequest<T>(
  path: string,
  options: RequestOptions,
): Promise<{ status: number; envelope: ApiEnvelope<T> }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (!options.skipAuth && accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  const envelope = (await response.json()) as ApiEnvelope<T>;
  return { status: response.status, envelope };
}

/**
 * Performs the actual `POST /auth/refresh` call and, on success, updates
 * both the in-memory access token and the stored refresh token (rotated
 * by the backend). Single-flighted via `refreshInFlight` so concurrent
 * 401s -- or a 401 arriving while the boot-time silent refresh is still
 * running -- share one refresh instead of racing separate rotations.
 */
function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const refreshToken = getStoredRefreshToken();
      if (!refreshToken) {
        return null;
      }
      try {
        const { status, envelope } = await rawRequest<AuthTokensDto>(
          '/auth/refresh',
          {
            method: 'POST',
            body: { refreshToken },
            skipAuth: true,
          },
        );
        if (status !== 200 || !envelope.success) {
          return null;
        }
        accessToken = envelope.data.accessToken;
        setStoredRefreshToken(envelope.data.refreshToken);
        onAccessTokenRefreshedHandler?.(envelope.data.accessToken);
        return envelope.data.accessToken;
      } catch {
        return null;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Exposed so AuthContext's boot-time silent refresh reuses this exact, single-flighted logic. */
export function refreshSession(): Promise<string | null> {
  return refreshAccessToken();
}

function handleSessionExpired(): void {
  accessToken = null;
  setStoredRefreshToken(null);
  onSessionExpired?.();
}

/**
 * Wraps rawRequest so every rejection out of request()/apiGet/apiPost is
 * guaranteed to be an ApiError -- a network failure (offline, CORS, a
 * non-JSON error body) would otherwise throw a raw TypeError/SyntaxError
 * instead of the promised ApiError shape.
 */
async function safeRawRequest<T>(
  path: string,
  options: RequestOptions,
): Promise<{ status: number; envelope: ApiEnvelope<T> }> {
  try {
    return await rawRequest<T>(path, options);
  } catch (err) {
    throw new ApiError(
      'NETWORK_ERROR',
      err instanceof Error ? err.message : 'Network request failed',
    );
  }
}

/**
 * Core request function. Unwraps the envelope, throws ApiError on
 * failure, and -- for any endpoint other than login/refresh/logout --
 * retries exactly once after a successful token refresh on 401.
 */
async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { status, envelope } = await safeRawRequest<T>(path, options);

  if (envelope.success) {
    return envelope.data;
  }

  if (status === 429 && RATE_LIMITED_PATHS.has(path)) {
    throw new ApiError(RATE_LIMITED_ERROR_CODE, envelope.error.message);
  }

  const canRetry = status === 401 && !NO_REFRESH_PATHS.has(path);
  if (canRetry) {
    const newAccessToken = await refreshAccessToken();
    if (newAccessToken) {
      const retry = await safeRawRequest<T>(path, options);
      if (retry.envelope.success) {
        return retry.envelope.data;
      }
      if (retry.status === 401) {
        handleSessionExpired();
      }
      throw new ApiError(
        retry.envelope.error.code,
        retry.envelope.error.message,
        retry.envelope.error.existingAttemptId,
      );
    }
    handleSessionExpired();
  }

  throw new ApiError(
    envelope.error.code,
    envelope.error.message,
    envelope.error.existingAttemptId,
  );
}

export function apiGet<T>(
  path: string,
  options: Omit<RequestOptions, 'method' | 'body'> = {},
): Promise<T> {
  return request<T>(path, { ...options, method: 'GET' });
}

export function apiPost<T>(
  path: string,
  body?: unknown,
  options: Omit<RequestOptions, 'method' | 'body'> = {},
): Promise<T> {
  return request<T>(path, { ...options, method: 'POST', body });
}
