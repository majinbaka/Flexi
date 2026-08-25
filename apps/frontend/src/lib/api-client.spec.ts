import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  apiGet,
  getStoredRefreshToken,
  onAccessTokenRefreshed,
  onSessionExpire,
  setAccessToken,
  setStoredRefreshToken,
} from './api-client';

const API_BASE_URL = 'http://localhost:3000/api';

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function success(data: unknown) {
  return new Response(JSON.stringify({ success: true, data, error: null }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function failure(status: number, code = 'UNAUTHORIZED', message = 'Denied') {
  return new Response(
    JSON.stringify({ success: false, data: null, error: { code, message } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('api-client authentication recovery', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorage());
    setAccessToken(null);
    setStoredRefreshToken(null);
    onSessionExpire(null);
    onAccessTokenRefreshed(null);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('single-flights refresh and retries each concurrent 401 request once', async () => {
    setAccessToken('expired-access-token');
    setStoredRefreshToken('refresh-token');
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `${API_BASE_URL}/auth/refresh`) {
        return success({
          accessToken: 'new-access-token',
          refreshToken: 'rotated-refresh-token',
          expiresIn: 900,
        });
      }
      if (
        (init?.headers as Record<string, string>).Authorization ===
        'Bearer expired-access-token'
      ) {
        return failure(401);
      }
      return success({ url });
    });

    const [first, second] = await Promise.all([
      apiGet<{ url: string }>('/things/one'),
      apiGet<{ url: string }>('/things/two'),
    ]);

    expect(first.url).toBe(`${API_BASE_URL}/things/one`);
    expect(second.url).toBe(`${API_BASE_URL}/things/two`);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/auth/refresh'),
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/things/')),
    ).toHaveLength(4);
    expect(getStoredRefreshToken()).toBe('rotated-refresh-token');
  });

  it('retries a request only once after a successful refresh', async () => {
    setAccessToken('expired-access-token');
    setStoredRefreshToken('refresh-token');
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(failure(401, 'EXPIRED', 'Access token expired'))
      .mockResolvedValueOnce(
        success({
          accessToken: 'new-access-token',
          refreshToken: 'rotated-refresh-token',
          expiresIn: 900,
        }),
      )
      .mockResolvedValueOnce(failure(401, 'STILL_DENIED', 'Still denied'));

    await expect(apiGet('/things/one')).rejects.toMatchObject({
      code: 'STILL_DENIED',
      message: 'Still denied',
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('clears the session when refresh fails', async () => {
    const onExpired = vi.fn();
    onSessionExpire(onExpired);
    setAccessToken('expired-access-token');
    setStoredRefreshToken('refresh-token');
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(failure(401, 'EXPIRED', 'Access token expired'))
      .mockResolvedValueOnce(
        failure(401, 'INVALID_REFRESH', 'Refresh expired'),
      );

    await expect(apiGet('/things/one')).rejects.toMatchObject({
      code: 'EXPIRED',
    });

    expect(onExpired).toHaveBeenCalledOnce();
    expect(getStoredRefreshToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'network failures',
      () => Promise.reject(new TypeError('Failed to fetch')),
    ],
    [
      'non-JSON responses',
      () =>
        Promise.resolve(
          new Response('<html>upstream error</html>', { status: 502 }),
        ),
    ],
  ])('normalizes %s into an ApiError', async (_caseName, response) => {
    vi.mocked(fetch).mockImplementation(response as typeof fetch);

    await expect(apiGet('/things/one')).rejects.toBeInstanceOf(ApiError);
    await expect(apiGet('/things/two')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });
});
