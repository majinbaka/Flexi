import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  TENANT_SETTINGS_MANAGE_PERMISSION,
  TENANT_USER_INVITE_PERMISSION,
  TENANT_USER_MANAGE_PERMISSION,
  TENANT_USER_READ_PERMISSION,
  TenantUserStatus,
  UserInviteStatus,
  type UserInviteDto,
  type UserListResponseDto,
  type UserSummaryDto,
} from '@flexi/shared-types';
import { ActorType } from '@flexi/shared-types';
import { UsersPage } from './UsersPage';
import { MOCK_USER, withAppContext } from '../stories/decorators';

const meta: Meta<typeof UsersPage> = {
  title: 'Pages/UsersPage',
  component: UsersPage,
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

type Story = StoryObj<typeof UsersPage>;

function user(overrides: Partial<UserSummaryDto> = {}): UserSummaryDto {
  return {
    id: 'usr_ana',
    actorType: ActorType.TENANT,
    tenantId: 'acme',
    authAccountId: 'auth_ana',
    email: 'ana.nguyen@acme.example',
    fullName: 'Ana Nguyen',
    status: TenantUserStatus.ACTIVE,
    isActive: true,
    roles: [{ id: 'role_admin', name: 'Tenant Admin' }],
    createdAt: '2026-07-01T08:00:00.000Z',
    updatedAt: '2026-08-20T08:00:00.000Z',
    ...overrides,
  };
}

const directory: UserListResponseDto = {
  items: [
    user(),
    user({
      id: 'usr_ben',
      email: 'ben.tran@acme.example',
      fullName: 'Ben Tran',
      status: TenantUserStatus.PENDING_APPROVAL,
      isActive: false,
      roles: [],
    }),
    user({
      id: 'usr_cleo',
      email: 'cleo.pham@acme.example',
      fullName: 'Cleo Pham',
      status: TenantUserStatus.LOCKED,
      isActive: false,
      roles: [{ id: 'role_member', name: 'Member' }],
    }),
    user({
      id: 'usr_dee',
      email: 'dee.vo@acme.example',
      fullName: null,
      status: TenantUserStatus.PENDING_INVITE,
      isActive: false,
      roles: [],
    }),
  ],
  meta: { total: 4, page: 1, pageSize: 20 },
};

const invites: UserInviteDto[] = [
  {
    id: 'inv_dee',
    tenantId: 'acme',
    email: 'dee.vo@acme.example',
    roleId: null,
    roleName: null,
    tenantUserId: 'usr_dee',
    status: UserInviteStatus.PENDING,
    expiresAt: '2026-08-30T08:00:00.000Z',
    usedAt: null,
    revokedAt: null,
    invitedById: 'usr_ana',
    createdAt: '2026-08-27T08:00:00.000Z',
  },
  {
    id: 'inv_old',
    tenantId: 'acme',
    email: 'former@acme.example',
    roleId: null,
    roleName: null,
    tenantUserId: null,
    status: UserInviteStatus.EXPIRED,
    expiresAt: '2026-08-01T08:00:00.000Z',
    usedAt: null,
    revokedAt: null,
    invitedById: 'usr_ana',
    createdAt: '2026-07-28T08:00:00.000Z',
  },
];

const ADMIN = {
  ...MOCK_USER,
  permissions: [
    TENANT_USER_READ_PERMISSION,
    TENANT_USER_MANAGE_PERMISSION,
    TENANT_USER_INVITE_PERMISSION,
    TENANT_SETTINGS_MANAGE_PERMISSION,
  ],
};

const adminDecorator = withAppContext({ route: '/users', user: ADMIN });

const settled = (response: UserListResponseDto) => () =>
  Promise.resolve(response);

export const Directory: Story = {
  args: {
    fetchUsers: settled(directory),
    invitesPanelProps: { fetchInvites: () => Promise.resolve(invites) },
  },
  decorators: [adminDecorator],
};

export const Loading: Story = {
  args: {
    fetchUsers: () => new Promise(() => {}),
    invitesPanelProps: { fetchInvites: () => new Promise(() => {}) },
  },
  decorators: [adminDecorator],
};

export const Empty: Story = {
  args: {
    fetchUsers: settled({
      items: [],
      meta: { total: 0, page: 1, pageSize: 20 },
    }),
    invitesPanelProps: { fetchInvites: () => Promise.resolve([]) },
  },
  decorators: [adminDecorator],
};

export const ErrorWithRetry: Story = {
  args: {
    fetchUsers: () => Promise.reject(new Error('Offline')),
    invitesPanelProps: {
      fetchInvites: () => Promise.reject(new Error('Offline')),
    },
  },
  decorators: [adminDecorator],
};

/**
 * `tenant.user.read` alone: the directory is visible, every action and the
 * invitations panel are not.
 */
export const ReadOnly: Story = {
  args: {
    fetchUsers: settled(directory),
    invitesPanelProps: { fetchInvites: () => Promise.resolve(invites) },
  },
  decorators: [
    withAppContext({
      route: '/users',
      user: { ...MOCK_USER, permissions: [TENANT_USER_READ_PERMISSION] },
    }),
  ],
};

export const MobileDirectory: Story = {
  ...Directory,
  globals: { viewport: { value: 'mobile' } },
};
