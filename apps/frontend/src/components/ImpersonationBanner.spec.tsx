import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ActorType, type AuthenticatedUserDto } from '@flexi/shared-types';
import i18n from '../i18n';
import { AuthContext, type AuthContextValue } from '../auth/AuthContext';
import { ApiError } from '../lib/api-client';
import { ImpersonationBanner } from './ImpersonationBanner';

const ordinaryUser: AuthenticatedUserDto = {
  authAccountId: 'auth_ana',
  actorType: ActorType.TENANT,
  tenantId: 'tenant_acme',
  tenantUserId: 'usr_ana',
  email: 'ana@acme.test',
  name: 'Ana Nguyen',
  roles: ['Member'],
  permissions: [],
};

const impersonatedUser: AuthenticatedUserDto = {
  ...ordinaryUser,
  impersonatedBy: 'sys_support',
  impersonationSessionId: 'imp_1',
};

/** Mirrors the router location so a test can assert where exiting lands. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function renderBanner(
  currentUser: AuthenticatedUserDto | null,
  props: Partial<Parameters<typeof ImpersonationBanner>[0]> = {},
) {
  const logout = vi.fn(() => Promise.resolve());
  const endSession = vi.fn(() => Promise.resolve());
  const auth: AuthContextValue = {
    accessToken: 'impersonation-access-token',
    currentUser,
    loading: false,
    login: async () => {},
    logout,
    reloadSession: async () => {},
  };

  render(
    <MemoryRouter initialEntries={['/users']}>
      <AuthContext.Provider value={auth}>
        <ImpersonationBanner endSession={endSession} {...props} />
        <LocationProbe />
      </AuthContext.Provider>
    </MemoryRouter>,
  );

  return { logout, endSession };
}

describe('ImpersonationBanner', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders nothing for an ordinary session', () => {
    renderBanner(ordinaryUser);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders nothing when there is no session at all', () => {
    renderBanner(null);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names the impersonated account whenever the token carries the flag', () => {
    renderBanner(impersonatedUser);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'You are impersonating ana@acme.test. Every action is recorded.',
    );
  });

  it('offers no way to dismiss it -- only to exit', () => {
    renderBanner(impersonatedUser);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName('Exit impersonation');
  });

  it('revokes the session server-side, then clears the local one', async () => {
    const { endSession, logout } = renderBanner(impersonatedUser);

    fireEvent.click(screen.getByRole('button', { name: 'Exit impersonation' }));

    await waitFor(() => expect(endSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/admin/login'),
    );
  });

  it('still clears the local session when the revoke call fails', async () => {
    const { logout } = renderBanner(impersonatedUser, {
      endSession: () =>
        Promise.reject(new ApiError('NETWORK_ERROR', 'connection reset')),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Exit impersonation' }));

    // Leaving the operator inside somebody else's identity because a
    // revoke failed would be worse than the failed revoke itself.
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/admin/login'),
    );
  });

  it('renders in Vietnamese when the language is switched', async () => {
    await i18n.changeLanguage('vi');
    renderBanner(impersonatedUser);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Bạn đang mạo danh ana@acme.test. Mọi thao tác đều được ghi lại.',
    );
    expect(
      screen.getByRole('button', { name: 'Thoát mạo danh' }),
    ).toBeInTheDocument();
  });
});
