import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  UserInviteStatus,
  type CreatedUserInviteDto,
  type InviteUsersResponseDto,
  type TenantSeatUsageDto,
} from '@flexi/shared-types';
import { InviteUsersDialog } from './InviteUsersDialog';
import { ApiError } from '../../lib/api-client';
import { withAppContext } from '../../stories/decorators';

const meta: Meta<typeof InviteUsersDialog> = {
  title: 'Users/InviteUsersDialog',
  component: InviteUsersDialog,
  parameters: { layout: 'fullscreen' },
  args: { onClose: () => {}, onInvited: () => {} },
  decorators: [withAppContext({ route: '/users' })],
};

export default meta;

type Story = StoryObj<typeof InviteUsersDialog>;

function invite(
  overrides: Partial<CreatedUserInviteDto> = {},
): CreatedUserInviteDto {
  return {
    id: 'inv_1',
    tenantId: 'acme',
    email: 'ana.nguyen@acme.example',
    roleId: null,
    roleName: null,
    tenantUserId: 'usr_ana',
    status: UserInviteStatus.PENDING,
    expiresAt: '2026-08-30T08:00:00.000Z',
    usedAt: null,
    revokedAt: null,
    invitedById: 'usr_admin',
    createdAt: '2026-08-27T08:00:00.000Z',
    inviteToken: 'storybook-token',
    acceptUrl: 'https://app.example/accept-invite?token=storybook-token',
    emailDelivered: true,
    ...overrides,
  };
}

function response(
  invites: CreatedUserInviteDto[],
  seatUsage: TenantSeatUsageDto,
): InviteUsersResponseDto {
  return { invites, seatUsage };
}

const BOUNDED_SEATS: TenantSeatUsageDto = {
  usedSeats: 6,
  maxUsers: 25,
  remainingSeats: 19,
  unlimited: false,
};

/** The blank form, before anything is typed. */
export const Empty: Story = {
  args: { submitInvites: () => new Promise(() => {}) },
};

/**
 * The result state: the only place seat usage is readable, because it
 * arrives on the invite response rather than from an endpoint of its own.
 */
export const Sent: Story = {
  args: {
    submitInvites: () =>
      Promise.resolve(
        response(
          [invite(), invite({ id: 'inv_2', email: 'ben.tran@acme.example' })],
          BOUNDED_SEATS,
        ),
      ),
  },
};

export const SentToUnlimitedTenant: Story = {
  args: {
    submitInvites: () =>
      Promise.resolve(
        response([invite()], {
          usedSeats: 142,
          maxUsers: -1,
          remainingSeats: null,
          unlimited: true,
        }),
      ),
  },
};

/** The invitations exist, but at least one email did not go out. */
export const SentWithUndeliveredEmail: Story = {
  args: {
    submitInvites: () =>
      Promise.resolve(
        response([invite({ emailDelivered: false })], BOUNDED_SEATS),
      ),
  },
};

export const QuotaExceeded: Story = {
  args: {
    submitInvites: () =>
      Promise.reject(new ApiError('QUOTA_EXCEEDED', 'seats exhausted')),
  },
};

export const EmailAlreadyExists: Story = {
  args: {
    submitInvites: () =>
      Promise.reject(new ApiError('EMAIL_ALREADY_EXISTS', 'already a member')),
  },
};
