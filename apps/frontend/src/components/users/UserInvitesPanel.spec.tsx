import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UserInviteStatus, type UserInviteDto } from '@flexi/shared-types';
import i18n from '../../i18n';
import { ApiError } from '../../lib/api-client';
import { UserInvitesPanel } from './UserInvitesPanel';

function invite(overrides: Partial<UserInviteDto> = {}): UserInviteDto {
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
    ...overrides,
  };
}

function renderPanel(
  props: Partial<Parameters<typeof UserInvitesPanel>[0]> = {},
) {
  const fetchInvites = vi.fn(() => Promise.resolve([invite()]));

  render(<UserInvitesPanel canInvite fetchInvites={fetchInvites} {...props} />);

  return { fetchInvites };
}

describe('UserInvitesPanel', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders an empty state when nothing has been sent', async () => {
    renderPanel({ fetchInvites: () => Promise.resolve([]) });

    expect(
      await screen.findByText('No invitations have been sent yet.'),
    ).toBeInTheDocument();
  });

  it('retries a failed listing without rendering the raw error', async () => {
    const fetchInvites = vi
      .fn()
      .mockRejectedValueOnce(new Error('Internal invite details'))
      .mockResolvedValueOnce([]);

    renderPanel({ fetchInvites });

    expect(
      await screen.findByText('Invitations could not be loaded. Try again.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Internal invite details'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(fetchInvites).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText('No invitations have been sent yet.'),
    ).toBeInTheDocument();
  });

  it('offers resend and revoke only for a pending invite', async () => {
    renderPanel({
      fetchInvites: () =>
        Promise.resolve([
          invite(),
          invite({
            id: 'inv_2',
            email: 'ben@acme.test',
            status: UserInviteStatus.USED,
          }),
          invite({
            id: 'inv_3',
            email: 'cleo@acme.test',
            status: UserInviteStatus.REVOKED,
          }),
        ]),
    });

    await screen.findByText('ana@acme.test');
    // One pending row, so exactly one pair of action buttons.
    expect(screen.getAllByRole('button', { name: 'Resend' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
  });

  it('hides the actions entirely from a viewer who may not invite', async () => {
    renderPanel({ canInvite: false });

    await screen.findByText('ana@acme.test');
    expect(
      screen.queryByRole('button', { name: 'Resend' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Revoke' }),
    ).not.toBeInTheDocument();
  });

  it('re-reads the listing after a resend succeeds', async () => {
    const resend = vi.fn(() =>
      Promise.resolve({
        ...invite(),
        inviteToken: 'raw',
        acceptUrl: 'https://app.test/accept-invite?token=raw',
        emailDelivered: true,
      }),
    );
    const { fetchInvites } = renderPanel({ resend });

    fireEvent.click(await screen.findByRole('button', { name: 'Resend' }));

    await waitFor(() => expect(resend).toHaveBeenCalledWith('inv_1'));
    await waitFor(() => expect(fetchInvites).toHaveBeenCalledTimes(2));
  });

  it('re-reads the listing after a revoke succeeds', async () => {
    const revoke = vi.fn(() =>
      Promise.resolve(invite({ status: UserInviteStatus.REVOKED })),
    );
    const { fetchInvites } = renderPanel({ revoke });

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(revoke).toHaveBeenCalledWith('inv_1'));
    await waitFor(() => expect(fetchInvites).toHaveBeenCalledTimes(2));
  });

  it('renders a failed action from its code, not the server message', async () => {
    renderPanel({
      resend: () =>
        Promise.reject(
          new ApiError('INVITE_NOT_PENDING', 'invite inv_1 is already used'),
        ),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Resend' }));

    expect(
      await screen.findByText(
        'That invitation has already been used or revoked.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('invite inv_1 is already used'),
    ).not.toBeInTheDocument();
  });

  it('re-reads the listing when the caller bumps its reload key', async () => {
    const fetchInvites = vi.fn(() => Promise.resolve([invite()]));
    const { rerender } = render(
      <UserInvitesPanel canInvite reloadKey={0} fetchInvites={fetchInvites} />,
    );

    await waitFor(() => expect(fetchInvites).toHaveBeenCalledTimes(1));

    rerender(
      <UserInvitesPanel canInvite reloadKey={1} fetchInvites={fetchInvites} />,
    );

    await waitFor(() => expect(fetchInvites).toHaveBeenCalledTimes(2));
  });
});
