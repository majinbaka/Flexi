import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  ActorType,
  TenantUserStatus,
  type UserSummaryDto,
} from '@flexi/shared-types';
import { DeleteUserDialog } from './DeleteUserDialog';
import { ApiError } from '../../lib/api-client';
import { withAppContext } from '../../stories/decorators';

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
    roles: [],
    createdAt: '2026-07-01T08:00:00.000Z',
    updatedAt: '2026-08-20T08:00:00.000Z',
    ...overrides,
  };
}

const candidates = {
  items: [
    user({
      id: 'usr_ben',
      email: 'ben.tran@acme.example',
      fullName: 'Ben Tran',
    }),
    user({
      id: 'usr_cleo',
      email: 'cleo.pham@acme.example',
      fullName: 'Cleo Pham',
    }),
  ],
  meta: { total: 2, page: 1, pageSize: 100 },
};

const meta: Meta<typeof DeleteUserDialog> = {
  title: 'Users/DeleteUserDialog',
  component: DeleteUserDialog,
  parameters: { layout: 'fullscreen' },
  args: {
    user: user(),
    onClose: () => {},
    onDeleted: () => {},
    removeUser: () =>
      Promise.resolve({
        userId: 'usr_ana',
        mode: 'soft' as const,
        revokedSessionCount: 2,
        transferredRecordCount: 0,
      }),
    fetchCandidates: () => Promise.resolve(candidates),
  },
  decorators: [withAppContext({ route: '/users' })],
};

export default meta;

type Story = StoryObj<typeof DeleteUserDialog>;

/**
 * The dialog as it opens: soft delete, which needs no transfer target.
 *
 * The deletion mode is internal state, so the transfer-target stories
 * below all start here too -- choose "Hard delete" in the story to see the
 * candidate list each one injects.
 */
export const SoftDelete: Story = {};

/** Choosing "Hard delete" lists the active members who may receive the data. */
export const HardDeleteWithTargets: Story = {};

export const TransferTargetsLoading: Story = {
  args: { fetchCandidates: () => new Promise(() => {}) },
};

export const TransferTargetsFailed: Story = {
  args: { fetchCandidates: () => Promise.reject(new Error('Offline')) },
};

/** The only other member is the user being deleted, so nobody can receive. */
export const NoTransferTargetAvailable: Story = {
  args: {
    fetchCandidates: () =>
      Promise.resolve({
        items: [user()],
        meta: { total: 1, page: 1, pageSize: 100 },
      }),
  },
};

export const RefusedInvalidTarget: Story = {
  args: {
    removeUser: () =>
      Promise.reject(new ApiError('INVALID_TARGET_USER', 'not active')),
  },
};

export const RefusedSelfDeletion: Story = {
  args: {
    removeUser: () =>
      Promise.reject(new ApiError('CANNOT_DELETE_SELF', 'self')),
  },
};
