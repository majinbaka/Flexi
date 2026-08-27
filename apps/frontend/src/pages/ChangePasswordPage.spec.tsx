import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AuthenticatedUserDto } from '@flexi/shared-types';
import { AuthContext, type AuthContextValue } from '../auth/AuthContext';
import { ApiError } from '../lib/api-client';
import i18n from '../i18n';
import { ChangePasswordPage } from './ChangePasswordPage';

const STRONG_PASSWORD = 'Str0ng!Passphrase';

const user: AuthenticatedUserDto = {
  authAccountId: 'auth_1',
  actorType: 'tenant' as AuthenticatedUserDto['actorType'],
  tenantId: 'tenant_1',
  tenantUserId: 'tu_1',
  email: 'user@example.com',
  name: 'User',
  roles: ['Member'],
  permissions: [],
};

function renderPage({
  mustChangePassword = false,
  changePassword = vi.fn().mockResolvedValue({}),
  reloadSession = vi.fn().mockResolvedValue(undefined),
}: {
  mustChangePassword?: boolean;
  changePassword?: ReturnType<typeof vi.fn>;
  reloadSession?: ReturnType<typeof vi.fn>;
} = {}) {
  const auth: AuthContextValue = {
    accessToken: 'test-access-token',
    currentUser: { ...user, mustChangePassword },
    loading: false,
    login: async () => {},
    logout: async () => {},
    reloadSession,
  };

  render(
    <MemoryRouter initialEntries={['/change-password']}>
      <AuthContext.Provider value={auth}>
        <ChangePasswordPage changePassword={changePassword} />
      </AuthContext.Provider>
    </MemoryRouter>,
  );

  return { changePassword, reloadSession };
}

function fillForm({
  current = 'current-password',
  password = STRONG_PASSWORD,
  confirmation = password,
}: { current?: string; password?: string; confirmation?: string } = {}) {
  fireEvent.change(screen.getByLabelText('Current password'), {
    target: { value: current },
  });
  fireEvent.change(screen.getByLabelText('New password'), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText('Confirm password'), {
    target: { value: confirmation },
  });
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
}

describe('ChangePasswordPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('explains itself when the account is under a force-reset', () => {
    renderPage({ mustChangePassword: true });

    expect(
      screen.getByText(/An administrator reset your password/i),
    ).toBeInTheDocument();
  });

  it('reads as an ordinary change when no reset was forced', () => {
    renderPage();

    expect(
      screen.getByText('Choose a new password for your account.'),
    ).toBeInTheDocument();
  });

  it('requires the current password', () => {
    const { changePassword } = renderPage();

    fillForm({ current: '' });
    submit();

    expect(screen.getByText('Password cannot be blank.')).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('lists every unmet password rule without calling the API', () => {
    const { changePassword } = renderPage();

    fillForm({ password: 'short' });
    submit();

    expect(
      screen.getByText('be at least 12 characters long'),
    ).toBeInTheDocument();
    expect(screen.getByText('include a special character')).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  /**
   * `mustChangePassword` on `GET /api/auth/me` is read off the access
   * token, so the cleared flag only reaches the client once the token has
   * been rotated -- hence reloading the session rather than re-fetching
   * `me`.
   */
  it('reloads the session after a successful change', async () => {
    const { changePassword, reloadSession } = renderPage({
      mustChangePassword: true,
    });

    fillForm();
    submit();

    await waitFor(() => {
      expect(changePassword).toHaveBeenCalledWith({
        currentPassword: 'current-password',
        newPassword: STRONG_PASSWORD,
      });
    });
    await waitFor(() => expect(reloadSession).toHaveBeenCalledTimes(1));
  });

  it('reports a wrong current password against that field', async () => {
    const changePassword = vi
      .fn()
      .mockRejectedValue(
        new ApiError('INVALID_CREDENTIALS', 'Invalid email or password'),
      );
    renderPage({ changePassword });

    fillForm();
    submit();

    expect(
      await screen.findByText('That is not your current password.'),
    ).toBeInTheDocument();
    // Never the raw server text.
    expect(
      screen.queryByText('Invalid email or password'),
    ).not.toBeInTheDocument();
  });

  it('falls back to the generic message for an unexpected error', async () => {
    const changePassword = vi
      .fn()
      .mockRejectedValue(new ApiError('INTERNAL_SERVER_ERROR', 'boom'));
    renderPage({ changePassword });

    fillForm();
    submit();

    expect(
      await screen.findByText('Something went wrong. Please try again.'),
    ).toBeInTheDocument();
  });
});
