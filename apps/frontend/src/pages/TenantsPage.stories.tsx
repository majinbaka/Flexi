import type { Meta, StoryObj } from '@storybook/react-vite';
import { TenantsPage } from './TenantsPage';
import {
  MOCK_SYSTEM_USER_WITHOUT_TENANT_ONBOARD,
  MOCK_SYSTEM_USER_WITH_TENANT_ONBOARD,
  MOCK_USER,
  withAppContext,
} from '../stories/decorators';

const meta: Meta<typeof TenantsPage> = {
  title: 'Pages/TenantsPage',
  component: TenantsPage,
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

type Story = StoryObj<typeof TenantsPage>;

export const PermittedSystemUser: Story = {
  decorators: [
    withAppContext({
      route: '/tenants',
      user: MOCK_SYSTEM_USER_WITH_TENANT_ONBOARD,
    }),
  ],
};

export const UnpermittedSystemUser: Story = {
  decorators: [
    withAppContext({
      route: '/tenants',
      user: MOCK_SYSTEM_USER_WITHOUT_TENANT_ONBOARD,
    }),
  ],
};

export const TenantUser: Story = {
  decorators: [
    withAppContext({
      route: '/tenants',
      user: MOCK_USER,
    }),
  ],
};

export const MobilePermitted: Story = {
  ...PermittedSystemUser,
  globals: { viewport: { value: 'mobile' } },
};
