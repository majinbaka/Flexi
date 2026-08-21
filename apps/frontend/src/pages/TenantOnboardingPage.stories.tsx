import type { Meta, StoryObj } from '@storybook/react-vite';
import { TenantOnboardingPage } from './TenantOnboardingPage';
import {
  MOCK_SYSTEM_USER_WITHOUT_TENANT_ONBOARD,
  MOCK_SYSTEM_USER_WITH_TENANT_ONBOARD,
  MOCK_USER,
  withAppContext,
} from '../stories/decorators';

const meta: Meta<typeof TenantOnboardingPage> = {
  title: 'Pages/TenantOnboardingPage',
  component: TenantOnboardingPage,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-background p-lg md:p-xl">
        <div className="flex flex-col gap-lg">
          <Story />
        </div>
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof TenantOnboardingPage>;

export const PermittedSystemUser: Story = {
  decorators: [
    withAppContext({
      route: '/tenants/onboard',
      user: MOCK_SYSTEM_USER_WITH_TENANT_ONBOARD,
    }),
  ],
};

export const InteractivePreflight: Story = {
  args: {
    preflightDelayMs: 0,
    checkSlugAvailability: async (slug) => ({
      slug,
      available: slug !== 'taken-slug',
      reason: slug === 'taken-slug' ? 'already_in_use' : 'available',
    }),
  },
  decorators: [
    withAppContext({
      route: '/tenants/onboard',
      user: MOCK_SYSTEM_USER_WITH_TENANT_ONBOARD,
    }),
  ],
};

export const UnpermittedSystemUser: Story = {
  decorators: [
    withAppContext({
      route: '/tenants/onboard',
      user: MOCK_SYSTEM_USER_WITHOUT_TENANT_ONBOARD,
    }),
  ],
};

export const TenantUser: Story = {
  decorators: [
    withAppContext({
      route: '/tenants/onboard',
      user: MOCK_USER,
    }),
  ],
};

export const MobileDenied: Story = {
  ...TenantUser,
  globals: { viewport: { value: 'mobile' } },
};
