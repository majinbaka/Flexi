import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../lib/api-client';
import i18n from '../i18n';
import { SetupAccountPage } from './SetupAccountPage';

function renderPage(
  route = '/setup-account?token=one-time-token',
  redeemSetupToken = vi.fn().mockResolvedValue({ status: 'completed' }),
) {
  render(
    <MemoryRouter initialEntries={[route]}>
      <SetupAccountPage redeemSetupToken={redeemSetupToken} />
    </MemoryRouter>,
  );
  return redeemSetupToken;
}

describe('SetupAccountPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('requires a password and matching confirmation before redeeming', () => {
    const redeemSetupToken = renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));

    expect(screen.getByText('Password cannot be blank.')).toBeInTheDocument();
    expect(redeemSetupToken).not.toHaveBeenCalled();
  });

  it('sends the URL token only in the redemption request and shows success', async () => {
    const redeemSetupToken = renderPage();
    const passwordInputs = screen.getAllByLabelText('Password');

    fireEvent.change(passwordInputs[0], { target: { value: 'a password' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'a password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));

    await waitFor(() => {
      expect(redeemSetupToken).toHaveBeenCalledWith({
        token: 'one-time-token',
        password: 'a password',
      });
    });
    expect(
      screen.getByRole('heading', { name: 'Account ready' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('one-time-token')).not.toBeInTheDocument();
  });

  it('uses the same opaque state for an invalid or expired setup token', async () => {
    const redeemSetupToken = vi
      .fn()
      .mockRejectedValue(
        new ApiError('INVALID_SETUP_TOKEN', 'Invalid setup token'),
      );
    renderPage('/setup-account?token=one-time-token', redeemSetupToken);
    const passwordInputs = screen.getAllByLabelText('Password');

    fireEvent.change(passwordInputs[0], { target: { value: 'a password' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'a password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));

    expect(
      await screen.findByRole('heading', { name: 'Setup link unavailable' }),
    ).toBeInTheDocument();
  });
});
