import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TenantUserStatus } from '@flexi/shared-types';
import i18n from '../i18n';
import { ApiError } from '../lib/api-client';
import { AcceptInvitePage } from './AcceptInvitePage';

const VALID_PASSWORD = 'Str0ng-Passw0rd!';

function renderPage(
  props: Partial<Parameters<typeof AcceptInvitePage>[0]> = {},
  route = '/accept-invite?token=raw-token',
) {
  const redeem = vi.fn(() =>
    Promise.resolve({
      tenantId: 'tenant_acme',
      userId: 'usr_1',
      email: 'ana@acme.test',
      status: TenantUserStatus.ACTIVE,
    }),
  );

  render(
    <MemoryRouter initialEntries={[route]}>
      <AcceptInvitePage redeem={redeem} {...props} />
    </MemoryRouter>,
  );

  return { redeem };
}

function fillForm({
  fullName = 'Ana Nguyen',
  password = VALID_PASSWORD,
  confirmPassword = VALID_PASSWORD,
} = {}) {
  fireEvent.change(screen.getByLabelText('Full name'), {
    target: { value: fullName },
  });
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText('Confirm password'), {
    target: { value: confirmPassword },
  });
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Create my account' }));
}

describe('AcceptInvitePage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('refuses to render the form without a token in the URL', () => {
    renderPage({}, '/accept-invite');

    expect(
      screen.getByText('This invitation cannot be used'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
  });

  it('sends the token from the URL and never puts it on screen', async () => {
    const { redeem } = renderPage();

    fillForm();
    submit();

    await waitFor(() =>
      expect(redeem).toHaveBeenCalledWith({
        token: 'raw-token',
        fullName: 'Ana Nguyen',
        password: VALID_PASSWORD,
        confirmPassword: VALID_PASSWORD,
      }),
    );
    expect(
      await screen.findByText('Your account is ready'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/raw-token/)).not.toBeInTheDocument();
  });

  it('requires a full name before calling the API', () => {
    const { redeem } = renderPage();

    fillForm({ fullName: '  ' });
    submit();

    expect(screen.getByText('Enter your full name.')).toBeInTheDocument();
    expect(redeem).not.toHaveBeenCalled();
  });

  it('requires the two passwords to match before calling the API', () => {
    const { redeem } = renderPage();

    fillForm({ confirmPassword: 'something-else' });
    submit();

    expect(
      screen.getByText('The two passwords do not match.'),
    ).toBeInTheDocument();
    expect(redeem).not.toHaveBeenCalled();
  });

  it('shows the one unusable-invitation answer for an expired token', async () => {
    renderPage({
      redeem: () =>
        Promise.reject(
          new ApiError('INVITE_TOKEN_EXPIRED', 'token hash not found'),
        ),
    });

    fillForm();
    submit();

    expect(
      await screen.findByText('This invitation cannot be used'),
    ).toBeInTheDocument();
    expect(screen.queryByText('token hash not found')).not.toBeInTheDocument();
  });

  it('renders the server password-policy violations through the shared translator', async () => {
    renderPage({
      redeem: () =>
        Promise.reject(
          new ApiError(
            'PASSWORD_POLICY_VIOLATION',
            'TOO_SHORT,MISSING_UPPERCASE',
          ),
        ),
    });

    fillForm();
    submit();

    expect(
      await screen.findByText(/at least 12 characters/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/uppercase/i, { selector: 'li' }),
    ).toBeInTheDocument();
    // The raw code list is never shown.
    expect(screen.queryByText('TOO_SHORT,MISSING_UPPERCASE')).toBeNull();
  });

  it('falls back to the generic message for any other failure', async () => {
    renderPage({
      redeem: () => Promise.reject(new ApiError('SOMETHING_ELSE', 'raw prose')),
    });

    fillForm();
    submit();

    expect(
      await screen.findByText('Something went wrong. Try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('raw prose')).not.toBeInTheDocument();
  });

  it('renders in Vietnamese when the language is switched', async () => {
    await i18n.changeLanguage('vi');
    renderPage();

    expect(screen.getByText('Nhận lời mời')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Tạo tài khoản' }),
    ).toBeInTheDocument();
  });
});
