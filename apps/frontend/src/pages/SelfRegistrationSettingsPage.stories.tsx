import type { Meta, StoryObj } from '@storybook/react-vite';
import type { TenantSettingsDto } from '@flexi/shared-types';
import { SelfRegistrationSettingsPage } from './SelfRegistrationSettingsPage';
import { ApiError } from '../lib/api-client';
import { MOCK_USER, withAppContext } from '../stories/decorators';

function settings(
  overrides: Partial<TenantSettingsDto> = {},
): TenantSettingsDto {
  return {
    tenantId: 'acme',
    allowSelfRegistration: true,
    allowSystemImpersonation: false,
    allowedEmailDomains: ['acme.example'],
    defaultRoleId: 'role_member',
    defaultRoleName: 'Member',
    requireApproval: true,
    configured: true,
    updatedAt: '2026-08-20T08:00:00.000Z',
    ...overrides,
  };
}

const meta: Meta<typeof SelfRegistrationSettingsPage> = {
  title: 'Pages/SelfRegistrationSettingsPage',
  component: SelfRegistrationSettingsPage,
  parameters: { layout: 'fullscreen' },
  args: {
    fetchSettings: () => Promise.resolve(settings()),
    saveSettings: (request) =>
      Promise.resolve(settings({ ...request, configured: true })),
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-background p-lg md:p-xl">
        <div className="flex flex-col gap-lg">
          <Story />
        </div>
      </div>
    ),
    withAppContext({ route: '/users/settings', user: MOCK_USER }),
  ],
};

export default meta;

type Story = StoryObj<typeof SelfRegistrationSettingsPage>;

export const Configured: Story = {};

/** No `tenant_settings` row yet: what is shown are the platform defaults. */
export const NotConfigured: Story = {
  args: {
    fetchSettings: () =>
      Promise.resolve(
        settings({
          configured: false,
          allowSelfRegistration: false,
          allowedEmailDomains: [],
          defaultRoleId: null,
          defaultRoleName: null,
          updatedAt: null,
        }),
      ),
  },
};

export const Loading: Story = {
  args: { fetchSettings: () => new Promise(() => {}) },
};

export const LoadFailed: Story = {
  args: { fetchSettings: () => Promise.reject(new Error('Offline')) },
};

export const SaveRejected: Story = {
  args: {
    saveSettings: () =>
      Promise.reject(new ApiError('VALIDATION_ERROR', 'bad domains')),
  },
};

export const MobileConfigured: Story = {
  ...Configured,
  globals: { viewport: { value: 'mobile' } },
};
