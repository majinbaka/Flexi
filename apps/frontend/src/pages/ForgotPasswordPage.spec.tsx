import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PASSWORD_RESET_OTP_COOLDOWN_SECONDS } from '@flexi/shared-types';
import { ApiError, RATE_LIMITED_ERROR_CODE } from '../lib/api-client';
import i18n from '../i18n';
import { ForgotPasswordPage } from './ForgotPasswordPage';

function renderPage(
  route = '/forgot-password',
  requestPasswordReset = vi.fn().mockResolvedValue({}),
) {
  render(
    <MemoryRouter initialEntries={[route]}>
      <ForgotPasswordPage requestPasswordReset={requestPasswordReset} />
    </MemoryRouter>,
  );
  return requestPasswordReset;
}

async function submitWith(email: string, requestPasswordReset = vi.fn()) {
  requestPasswordReset.mockResolvedValue({});
  renderPage('/forgot-password', requestPasswordReset);

  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: email },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send code' }));

  return requestPasswordReset;
}

describe('ForgotPasswordPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('requires an email before submitting', () => {
    const requestPasswordReset = renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));

    expect(screen.getByText('Email cannot be blank.')).toBeInTheDocument();
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it('trims the address and omits the tenant header when no tenant is given', async () => {
    const requestPasswordReset = await submitWith('  user@example.com  ');

    await waitFor(() => {
      expect(requestPasswordReset).toHaveBeenCalledWith(
        { email: 'user@example.com' },
        undefined,
      );
    });
  });

  it('passes the tenant id through when one is supplied', async () => {
    const requestPasswordReset = vi.fn().mockResolvedValue({});
    renderPage('/forgot-password?tenantId=tenant_1', requestPasswordReset);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'user@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));

    await waitFor(() => {
      expect(requestPasswordReset).toHaveBeenCalledWith(
        { email: 'user@example.com' },
        'tenant_1',
      );
    });
  });

  /**
   * The endpoint answers 200 whether or not the address has an account, so
   * the screen must say the same thing either way -- otherwise the copy
   * would leak exactly what the response refuses to.
   */
  it('shows a confirmation that does not reveal whether the account exists', async () => {
    await submitWith('user@example.com');

    const confirmation = await screen.findByText(
      /If that address has an account/i,
    );
    expect(confirmation).toBeInTheDocument();
    expect(screen.queryByText(/no account/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();
  });

  it('counts down the resend cooldown and disables the button meanwhile', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const requestPasswordReset = vi.fn().mockResolvedValue({});
      renderPage('/forgot-password', requestPasswordReset);

      fireEvent.change(screen.getByLabelText('Email'), {
        target: { value: 'user@example.com' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send code' }));

      const resendButton = await screen.findByRole('button', {
        name: `Send another code in ${PASSWORD_RESET_OTP_COOLDOWN_SECONDS}s`,
      });
      expect(resendButton).toBeDisabled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(
        screen.getByRole('button', {
          name: `Send another code in ${PASSWORD_RESET_OTP_COOLDOWN_SECONDS - 1}s`,
        }),
      ).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a rate-limited request with a translated message', async () => {
    const requestPasswordReset = vi
      .fn()
      .mockRejectedValue(
        new ApiError(RATE_LIMITED_ERROR_CODE, 'ThrottlerException'),
      );
    renderPage('/forgot-password', requestPasswordReset);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'user@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));

    expect(
      await screen.findByText(
        'Too many attempts. Please wait a moment and try again.',
      ),
    ).toBeInTheDocument();
    // Never the raw server text.
    expect(screen.queryByText('ThrottlerException')).not.toBeInTheDocument();
  });

  it('prefills the address from the query string', () => {
    renderPage('/forgot-password?email=prefilled%40example.com');

    expect(screen.getByLabelText('Email')).toHaveValue('prefilled@example.com');
  });
});
