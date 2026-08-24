import type { Meta, StoryObj } from '@storybook/react-vite';
import type { TenantListItemDto, TenantListResponseDto } from '@flexi/shared-types';
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

const SAMPLE_ITEMS: TenantListItemDto[] = [
  {
    id: 'tenant-1',
    name: 'Acme Co',
    slug: 'acme-co',
    status: 'ACTIVE',
    plan: 'growth',
    createdAt: '2026-08-20T08:00:00.000Z',
    latestAttemptStatus: 'succeeded',
    actorName: 'Ops',
  },
  {
    id: 'tenant-2',
    name: 'Beta Inc',
    slug: 'beta-inc',
    status: 'PROVISIONING',
    plan: 'starter',
    createdAt: '2026-08-21T08:00:00.000Z',
    latestAttemptStatus: 'provisioning',
    actorName: 'Ops',
  },
  {
    id: 'tenant-3',
    name: 'No Attempt Co',
    slug: 'no-attempt-co',
    status: 'ACTIVE',
    plan: null,
    createdAt: '2026-08-22T08:00:00.000Z',
    latestAttemptStatus: null,
    actorName: null,
  },
];

function respond(response: TenantListResponseDto) {
  return () => Promise.resolve(response);
}

const permittedDecorator = withAppContext({
  route: '/tenants',
  user: MOCK_SYSTEM_USER_WITH_TENANT_ONBOARD,
});

export const PermittedSystemUser: Story = {
  args: {
    fetchTenants: respond({
      items: SAMPLE_ITEMS,
      meta: { total: SAMPLE_ITEMS.length, page: 1, pageSize: 20 },
    }),
  },
  decorators: [permittedDecorator],
};

export const Loading: Story = {
  args: {
    fetchTenants: () => new Promise(() => {}),
  },
  decorators: [permittedDecorator],
};

export const EmptyInventory: Story = {
  args: {
    fetchTenants: respond({
      items: [],
      meta: { total: 0, page: 1, pageSize: 20 },
    }),
  },
  decorators: [permittedDecorator],
};

export const NoFilterMatches: Story = {
  args: {
    fetchTenants: respond({
      items: [],
      meta: { total: 0, page: 1, pageSize: 20 },
    }),
  },
  decorators: [
    withAppContext({
      route: '/tenants',
      user: MOCK_SYSTEM_USER_WITH_TENANT_ONBOARD,
    }),
  ],
};

export const MultiPage: Story = {
  args: {
    fetchTenants: respond({
      items: SAMPLE_ITEMS,
      meta: { total: 45, page: 1, pageSize: 20 },
    }),
  },
  decorators: [permittedDecorator],
};

export const UnpermittedSystemUser: Story = {
  args: {
    fetchTenants: respond({
      items: SAMPLE_ITEMS,
      meta: { total: SAMPLE_ITEMS.length, page: 1, pageSize: 20 },
    }),
  },
  decorators: [
    withAppContext({
      route: '/tenants',
      user: MOCK_SYSTEM_USER_WITHOUT_TENANT_ONBOARD,
    }),
  ],
};

export const TenantUser: Story = {
  args: {
    fetchTenants: respond({
      items: [],
      meta: { total: 0, page: 1, pageSize: 20 },
    }),
  },
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
