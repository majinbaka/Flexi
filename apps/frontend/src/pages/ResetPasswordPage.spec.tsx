import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AUTH_ERROR_CODES } from '@flexi/shared-types';
import { ApiError } from '../lib/api-client';
import i18n from '../i18n';
import { ResetPasswordPage } from './ResetPasswordPage';

const STRONG_PASSWORD = 'Str0ng!Passphrase';

function renderPage(
  route = '/reset-password?email=user%40example.com',
  resetPassword = vi.fn().mockResolvedValue({}),
) {
  render(
    <MemoryRouter initialEntries={[route]}>
      <ResetPasswordPage resetPassword={resetPassword} />
    </MemoryRouter>,
  );
  return resetPassword;
}

function fillForm({
  code = '123456',
  password = STRONG_PASSWORD,
  confirmation = password,
}: { code?: string; password?: string; confirmation?: string } = {}) {
  fireEvent.change(screen.getByLabelText('Reset code'), {
    target: { value: code },
  });
  fireEvent.change(screen.getByLabelText('New password'), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText('Confirm password'), {
    target: { value: confirmation },
  });
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
}

describe('ResetPasswordPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('prefills the address from the emailed link', () => {
    renderPage();

    expect(screen.getByLabelText('Email')).toHaveValue('user@example.com');
  });

  it('requires the code before submitting', () => {
    const resetPassword = renderPage();

    fillForm({ code: '' });
    submit();

    expect(screen.getByText('Reset code cannot be blank.')).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('requires the confirmation to match', () => {
    const resetPassword = renderPage();

    fillForm({ confirmation: 'something-else' });
    submit();

    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  /**
   * Checked locally with the same function the backend enforces, so every
   * unmet requirement is shown at once rather than one submit at a time.
   */
  it('lists every unmet password rule together, without calling the API', () => {
    const resetPassword = renderPage();

    fillForm({ password: 'short' });
    submit();

    expect(
      screen.getByText('Your password still needs to:'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('be at least 12 characters long'),
    ).toBeInTheDocument();
    expect(screen.getByText('include an uppercase letter')).toBeInTheDocument();
    expect(screen.getByText('include a digit')).toBeInTheDocument();
    expect(screen.getByText('include a special character')).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('submits the code and shows the success state', async () => {
    const resetPassword = renderPage();

    fillForm();
    submit();

    await waitFor(() => {
      expect(resetPassword).toHaveBeenCalledWith(
        {
          email: 'user@example.com',
          otp: '123456',
          newPassword: STRONG_PASSWORD,
        },
        undefined,
      );
    });
    expect(
      await screen.findByRole('heading', { name: 'Password reset' }),
    ).toBeInTheDocument();
  });

  it('passes the tenant id from the query string', async () => {
    const resetPassword = renderPage(
      '/reset-password?email=user%40example.com&tenantId=tenant_1',
    );

    fillForm();
    submit();

    await waitFor(() => {
      expect(resetPassword).toHaveBeenCalledWith(expect.anything(), 'tenant_1');
    });
  });

  /**
   * The server collapses wrong/expired/unknown/exhausted into one
   * INVALID_OTP, so the message shown must stay as uninformative as the
   * response -- and must come from the code, never from the server's text.
   */
  it('shows one opaque message for every INVALID_OTP cause', async () => {
    const resetPassword = vi
      .fn()
      .mockRejectedValue(
        new ApiError(
          AUTH_ERROR_CODES.INVALID_OTP,
          'The reset code is invalid or has expired.',
        ),
      );
    renderPage('/reset-password?email=user%40example.com', resetPassword);

    fillForm();
    submit();

    expect(
      await screen.findByText(/That code is not valid/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('The reset code is invalid or has expired.'),
    ).not.toBeInTheDocument();
  });

  /**
   * The backend sends the same violation codes the local check produces,
   * flattened into a comma-separated message by the error envelope, so they
   * render through the same translator.
   */
  it('renders server-reported policy violations through the same translator', async () => {
    const resetPassword = vi
      .fn()
      .mockRejectedValue(
        new ApiError(
          AUTH_ERROR_CODES.PASSWORD_POLICY_VIOLATION,
          'TOO_SHORT, MISSING_DIGIT',
        ),
      );
    renderPage('/reset-password?email=user%40example.com', resetPassword);

    // A locally-acceptable password, so only the server can reject it.
    fillForm();
    submit();

    expect(
      await screen.findByText('be at least 12 characters long'),
    ).toBeInTheDocument();
    expect(screen.getByText('include a digit')).toBeInTheDocument();
    expect(
      screen.queryByText('TOO_SHORT, MISSING_DIGIT'),
    ).not.toBeInTheDocument();
  });

  it('falls back to the generic message for an unexpected error', async () => {
    const resetPassword = vi
      .fn()
      .mockRejectedValue(new ApiError('INTERNAL_SERVER_ERROR', 'boom'));
    renderPage('/reset-password?email=user%40example.com', resetPassword);

    fillForm();
    submit();

    expect(
      await screen.findByText('Something went wrong. Please try again.'),
    ).toBeInTheDocument();
  });
});
