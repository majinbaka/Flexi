import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ActorType, type AuthenticatedUserDto } from '@flexi/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
import {
  getStoredRefreshToken,
  onAccessTokenRefreshed,
  onSessionExpire,
  setAccessToken,
  setStoredRefreshToken,
} from '../lib/api-client';

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

const tenantUser: AuthenticatedUserDto = {
  authAccountId: 'account-1',
  actorType: ActorType.TENANT,
  tenantId: 'tenant-1',
  tenantUserId: 'tenant-user-1',
  email: 'tenant@example.com',
  name: 'Tenant User',
  roles: ['Admin'],
  permissions: ['tables.read'],
};

const systemUser: AuthenticatedUserDto = {
  authAccountId: 'account-2',
  actorType: ActorType.SYSTEM,
  systemUserId: 'system-user-1',
  email: 'admin@example.com',
  name: 'System Admin',
  roles: ['Admin'],
  permissions: ['tenants.read'],
};

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

function AuthProbe() {
  const { accessToken, currentUser, loading, login, logout } = useAuth();
  return (
    <>
      <output data-testid="loading">{String(loading)}</output>
      <output data-testid="token">{accessToken ?? 'none'}</output>
      <output data-testid="user">{currentUser?.email ?? 'none'}</output>
      <button onClick={() => void login('user@example.com', 'password')}>
        system login
      </button>
      <button
        onClick={() => void login('user@example.com', 'password', 'tenant-1')}
      >
        tenant login
      </button>
      <button onClick={() => void logout()}>logout</button>
    </>
  );
}

function renderAuth() {
  return render(
    <AuthProvider>
      <AuthProbe />
    </AuthProvider>,
  );
}

describe('AuthProvider', () => {
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

  it('bootstraps a session from the stored refresh token', async () => {
    setStoredRefreshToken('stored-refresh-token');
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        success({
          accessToken: 'boot-access-token',
          refreshToken: 'rotated-refresh-token',
          expiresIn: 900,
        }),
      )
      .mockResolvedValueOnce(success(tenantUser));

    renderAuth();

    await waitFor(() =>
      expect(screen.getByTestId('loading')).toHaveTextContent('false'),
    );
    expect(screen.getByTestId('token')).toHaveTextContent('boot-access-token');
    expect(screen.getByTestId('user')).toHaveTextContent('tenant@example.com');
    expect(vi.mocked(fetch).mock.calls[1]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer boot-access-token' },
    });
    expect(getStoredRefreshToken()).toBe('rotated-refresh-token');
  });

  it.each([
    ['system', undefined, systemUser],
    ['tenant', 'tenant-1', tenantUser],
  ])(
    'logs in a %s actor and loads the matching user',
    async (_actor, tenantId, user) => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          success({
            accessToken: `${_actor}-access-token`,
            refreshToken: `${_actor}-refresh-token`,
            expiresIn: 900,
          }),
        )
        .mockResolvedValueOnce(success(user));
      renderAuth();

      await waitFor(() =>
        expect(screen.getByTestId('loading')).toHaveTextContent('false'),
      );
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: `${_actor} login` }),
        );
      });

      expect(screen.getByTestId('token')).toHaveTextContent(
        `${_actor}-access-token`,
      );
      expect(screen.getByTestId('user')).toHaveTextContent(user.email);
      expect(vi.mocked(fetch).mock.calls[0]).toEqual(
        expect.arrayContaining([
          `${API_BASE_URL}/auth/login`,
          expect.objectContaining({
            headers: expect.objectContaining(
              tenantId ? { 'x-tenant-id': tenantId } : {},
            ),
          }),
        ]),
      );
    },
  );

  it('clears local state even when logout is rejected', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        success({
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresIn: 900,
        }),
      )
      .mockResolvedValueOnce(success(systemUser))
      .mockResolvedValueOnce(failure(500, 'LOGOUT_FAILED', 'Logout failed'));
    renderAuth();

    await waitFor(() =>
      expect(screen.getByTestId('loading')).toHaveTextContent('false'),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'system login' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'logout' }));
    });

    expect(screen.getByTestId('token')).toHaveTextContent('none');
    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(getStoredRefreshToken()).toBeNull();
  });
});
