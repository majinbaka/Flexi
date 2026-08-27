import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TenantSettingsDto } from '@flexi/shared-types';
import i18n from '../i18n';
import { ApiError } from '../lib/api-client';
import { SelfRegistrationSettingsPage } from './SelfRegistrationSettingsPage';

function settings(
  overrides: Partial<TenantSettingsDto> = {},
): TenantSettingsDto {
  return {
    tenantId: 'tenant_acme',
    allowSelfRegistration: false,
    allowSystemImpersonation: false,
    allowedEmailDomains: [],
    defaultRoleId: null,
    defaultRoleName: null,
    requireApproval: true,
    configured: true,
    updatedAt: '2026-08-20T08:00:00.000Z',
    ...overrides,
  };
}

function renderPage(
  props: Partial<Parameters<typeof SelfRegistrationSettingsPage>[0]> = {},
) {
  const fetchSettings = vi.fn(() => Promise.resolve(settings()));
  const saveSettings = vi.fn((request) =>
    Promise.resolve(settings({ ...request, configured: true })),
  );

  render(
    <MemoryRouter initialEntries={['/users/settings']}>
      <SelfRegistrationSettingsPage
        fetchSettings={fetchSettings}
        saveSettings={saveSettings}
        {...props}
      />
    </MemoryRouter>,
  );

  return { fetchSettings, saveSettings };
}

describe('SelfRegistrationSettingsPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('retries a failed load without rendering the raw error', async () => {
    const fetchSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error('Internal settings details'))
      .mockResolvedValueOnce(settings());

    renderPage({ fetchSettings });

    expect(
      await screen.findByText(
        'The registration policy could not be loaded. Try again.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Internal settings details'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(fetchSettings).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByLabelText('Allowed email domains'),
    ).toBeInTheDocument();
  });

  it('fills the form from the loaded policy', async () => {
    renderPage({
      fetchSettings: () =>
        Promise.resolve(
          settings({
            allowSelfRegistration: true,
            requireApproval: false,
            allowedEmailDomains: ['acme.com', 'acme.co.uk'],
          }),
        ),
    });

    expect(
      await screen.findByRole('checkbox', { name: /Allow self-registration/ }),
    ).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: /Require administrator approval/ }),
    ).not.toBeChecked();
    expect(screen.getByLabelText('Allowed email domains')).toHaveValue(
      'acme.com, acme.co.uk',
    );
  });

  it('marks a tenant that has never written settings as not configured', async () => {
    renderPage({
      fetchSettings: () => Promise.resolve(settings({ configured: false })),
    });

    expect(await screen.findByText('Not configured')).toBeInTheDocument();
  });

  it('normalises the domain list before saving it', async () => {
    const { saveSettings } = renderPage();

    fireEvent.change(await screen.findByLabelText('Allowed email domains'), {
      target: { value: '@ACME.com, acme.com; partner.io\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith({
        allowSelfRegistration: false,
        requireApproval: true,
        // Lowercased, `@` stripped, and the duplicate collapsed.
        allowedEmailDomains: ['acme.com', 'partner.io'],
      }),
    );
    expect(await screen.findByText('Policy saved.')).toBeInTheDocument();
  });

  it('saves both toggles as the operator set them', async () => {
    const { saveSettings } = renderPage();

    fireEvent.click(
      await screen.findByRole('checkbox', { name: /Allow self-registration/ }),
    );
    fireEvent.click(
      screen.getByRole('checkbox', { name: /Require administrator approval/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          allowSelfRegistration: true,
          requireApproval: false,
        }),
      ),
    );
  });

  it('shows the default role read-only, with no control to change it', async () => {
    renderPage({
      fetchSettings: () =>
        Promise.resolve(
          settings({ defaultRoleId: 'role_member', defaultRoleName: 'Member' }),
        ),
    });

    expect(await screen.findByText('Member')).toBeInTheDocument();
    // No picker exists: nothing serves a list of roles to choose from.
    expect(screen.queryByLabelText('Default role')).not.toBeInTheDocument();
  });

  it('renders a save failure from its code, not the server message', async () => {
    renderPage({
      saveSettings: () =>
        Promise.reject(
          new ApiError(
            'VALIDATION_ERROR',
            'allowedEmailDomains must be domains',
          ),
        ),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Save policy' }));

    expect(
      await screen.findByText(
        'Some of the values sent were not accepted. Check the form and try again.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('allowedEmailDomains must be domains'),
    ).not.toBeInTheDocument();
  });

  it('renders in Vietnamese when the language is switched', async () => {
    await i18n.changeLanguage('vi');
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Lưu chính sách' }),
    ).toBeInTheDocument();
  });
});
