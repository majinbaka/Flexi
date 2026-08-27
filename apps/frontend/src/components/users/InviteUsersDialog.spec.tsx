import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  MAX_INVITES_PER_BATCH,
  UserInviteStatus,
  type CreatedUserInviteDto,
  type InviteUsersResponseDto,
} from '@flexi/shared-types';
import i18n from '../../i18n';
import { ApiError } from '../../lib/api-client';
import { InviteUsersDialog } from './InviteUsersDialog';

function invite(
  overrides: Partial<CreatedUserInviteDto> = {},
): CreatedUserInviteDto {
  return {
    id: 'inv_1',
    tenantId: 'tenant_acme',
    email: 'ana@acme.test',
    roleId: null,
    roleName: null,
    tenantUserId: 'usr_1',
    status: UserInviteStatus.PENDING,
    expiresAt: '2026-09-01T08:00:00.000Z',
    usedAt: null,
    revokedAt: null,
    invitedById: 'usr_admin',
    createdAt: '2026-08-27T08:00:00.000Z',
    inviteToken: 'raw-token',
    acceptUrl: 'https://app.test/accept-invite?token=raw-token',
    emailDelivered: true,
    ...overrides,
  };
}

function response(
  invites: CreatedUserInviteDto[],
  seatUsage: InviteUsersResponseDto['seatUsage'] = {
    usedSeats: 4,
    maxUsers: 25,
    remainingSeats: 21,
    unlimited: false,
  },
): InviteUsersResponseDto {
  return { invites, seatUsage };
}

function renderDialog(
  props: Partial<Parameters<typeof InviteUsersDialog>[0]> = {},
) {
  const onClose = vi.fn();
  const onInvited = vi.fn();
  const submitInvites = vi.fn(() => Promise.resolve(response([invite()])));

  render(
    <InviteUsersDialog
      onClose={onClose}
      onInvited={onInvited}
      submitInvites={submitInvites}
      {...props}
    />,
  );

  return { onClose, onInvited, submitInvites };
}

function typeEmails(value: string) {
  fireEvent.change(screen.getByLabelText('Email addresses'), {
    target: { value },
  });
}

describe('InviteUsersDialog', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('keeps submit disabled until at least one address is entered', () => {
    renderDialog();

    expect(
      screen.getByRole('button', { name: 'Send invitations' }),
    ).toBeDisabled();

    typeEmails('ana@acme.test');

    expect(
      screen.getByRole('button', { name: 'Send invitations' }),
    ).toBeEnabled();
  });

  it('splits commas, semicolons and newlines and collapses duplicates', async () => {
    const { submitInvites } = renderDialog();

    typeEmails('ana@acme.test, ben@acme.test; ana@acme.test\ncleo@acme.test');

    expect(
      screen.getByText('3 address(es) ready to invite.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send invitations' }));

    await waitFor(() =>
      expect(submitInvites).toHaveBeenCalledWith({
        emails: ['ana@acme.test', 'ben@acme.test', 'cleo@acme.test'],
      }),
    );
  });

  it('refuses to submit a malformed address and names it', () => {
    renderDialog();

    typeEmails('ana@acme.test, not-an-email');

    expect(
      screen.getByText('These are not valid email addresses: not-an-email'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Send invitations' }),
    ).toBeDisabled();
  });

  it('refuses a batch larger than the shared cap', () => {
    renderDialog();

    typeEmails(
      Array.from(
        { length: MAX_INVITES_PER_BATCH + 1 },
        (_, index) => `user${index}@acme.test`,
      ).join(', '),
    );

    expect(
      screen.getByText(
        `A single batch can carry at most ${MAX_INVITES_PER_BATCH} addresses.`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Send invitations' }),
    ).toBeDisabled();
  });

  it('reports seat usage from the response once the batch is sent', async () => {
    const { onInvited } = renderDialog();

    typeEmails('ana@acme.test');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitations' }));

    expect(
      await screen.findByText('1 invitation(s) sent.'),
    ).toBeInTheDocument();
    expect(screen.getByText('4 of 25 seats used, 21 left')).toBeInTheDocument();
    expect(onInvited).toHaveBeenCalledTimes(1);
  });

  it('says seats are unlimited when the tenant has no cap', async () => {
    renderDialog({
      submitInvites: () =>
        Promise.resolve(
          response([invite()], {
            usedSeats: 7,
            maxUsers: -1,
            remainingSeats: null,
            unlimited: true,
          }),
        ),
    });

    typeEmails('ana@acme.test');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitations' }));

    expect(
      await screen.findByText('7 seats used, no limit'),
    ).toBeInTheDocument();
  });

  it('warns when an invitation email could not be delivered', async () => {
    renderDialog({
      submitInvites: () =>
        Promise.resolve(response([invite({ emailDelivered: false })])),
    });

    typeEmails('ana@acme.test');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitations' }));

    expect(
      await screen.findByText(
        'At least one invitation email could not be delivered. The invitations exist and can be resent.',
      ),
    ).toBeInTheDocument();
  });

  it('renders a quota refusal from its code, never the server message', async () => {
    renderDialog({
      submitInvites: () =>
        Promise.reject(
          new ApiError('QUOTA_EXCEEDED', 'tenant acme is at 25/25 seats'),
        ),
    });

    typeEmails('ana@acme.test');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitations' }));

    expect(
      await screen.findByText('This tenant has no free seats left.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('tenant acme is at 25/25 seats'),
    ).not.toBeInTheDocument();
  });

  it('renders a duplicate-address refusal from its code', async () => {
    renderDialog({
      submitInvites: () =>
        Promise.reject(
          new ApiError('EMAIL_ALREADY_EXISTS', 'ana@acme.test is taken'),
        ),
    });

    typeEmails('ana@acme.test');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitations' }));

    expect(
      await screen.findByText(
        'A user with that email already exists in this tenant.',
      ),
    ).toBeInTheDocument();
  });
});
