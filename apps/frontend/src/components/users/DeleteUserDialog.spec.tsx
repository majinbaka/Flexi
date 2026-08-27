import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  ActorType,
  TenantUserStatus,
  type UserSummaryDto,
} from '@flexi/shared-types';
import i18n from '../../i18n';
import { ApiError } from '../../lib/api-client';
import { DeleteUserDialog } from './DeleteUserDialog';

function user(overrides: Partial<UserSummaryDto> = {}): UserSummaryDto {
  return {
    id: 'usr_1',
    actorType: ActorType.TENANT,
    tenantId: 'tenant_acme',
    authAccountId: 'auth_1',
    email: 'ana@acme.test',
    fullName: 'Ana Nguyen',
    status: TenantUserStatus.ACTIVE,
    isActive: true,
    roles: [],
    createdAt: '2026-08-01T08:00:00.000Z',
    updatedAt: '2026-08-20T08:00:00.000Z',
    ...overrides,
  };
}

const candidates = [
  user({ id: 'usr_1' }),
  user({ id: 'usr_2', email: 'ben@acme.test', fullName: 'Ben Tran' }),
  user({ id: 'usr_3', email: 'cleo@acme.test', fullName: null }),
];

function renderDialog(
  props: Partial<Parameters<typeof DeleteUserDialog>[0]> = {},
) {
  const onClose = vi.fn();
  const onDeleted = vi.fn();
  const removeUser = vi.fn(() =>
    Promise.resolve({
      userId: 'usr_1',
      mode: 'soft' as const,
      revokedSessionCount: 2,
      transferredRecordCount: 0,
    }),
  );
  const fetchCandidates = vi.fn(() =>
    Promise.resolve({
      items: candidates,
      meta: { total: candidates.length, page: 1, pageSize: 100 },
    }),
  );

  render(
    <DeleteUserDialog
      user={user()}
      onClose={onClose}
      onDeleted={onDeleted}
      removeUser={removeUser}
      fetchCandidates={fetchCandidates}
      {...props}
    />,
  );

  return { onClose, onDeleted, removeUser, fetchCandidates };
}

function chooseHardDelete() {
  fireEvent.click(screen.getByRole('radio', { name: /Hard delete/ }));
}

describe('DeleteUserDialog', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('deletes softly by default and does not load transfer targets', async () => {
    const { removeUser, onDeleted, fetchCandidates } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(removeUser).toHaveBeenCalledWith('usr_1', {
        mode: 'soft',
        transferToUserId: undefined,
      }),
    );
    expect(fetchCandidates).not.toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it('loads active members as transfer targets, excluding the user being deleted', async () => {
    const { fetchCandidates } = renderDialog();

    chooseHardDelete();

    await waitFor(() =>
      expect(fetchCandidates).toHaveBeenCalledWith(
        { status: TenantUserStatus.ACTIVE, pageSize: 100 },
        { signal: expect.any(AbortSignal) },
      ),
    );

    const select = await screen.findByLabelText('Transfer owned data to');
    expect(
      screen.getByRole('option', { name: 'Ben Tran (ben@acme.test)' }),
    ).toBeInTheDocument();
    // No full name falls back to the address alone.
    expect(
      screen.getByRole('option', { name: 'cleo@acme.test' }),
    ).toBeInTheDocument();
    // The user being deleted is never offered as their own transfer target.
    expect(
      screen.queryByRole('option', { name: /ana@acme\.test/ }),
    ).not.toBeInTheDocument();
    expect(select).toBeInTheDocument();
  });

  it('sends the chosen transfer target with a hard delete', async () => {
    const { removeUser } = renderDialog();

    chooseHardDelete();
    fireEvent.change(await screen.findByLabelText('Transfer owned data to'), {
      target: { value: 'usr_2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(removeUser).toHaveBeenCalledWith('usr_1', {
        mode: 'hard',
        transferToUserId: 'usr_2',
      }),
    );
  });

  it('omits the target when the operator chooses not to transfer', async () => {
    const { removeUser } = renderDialog();

    chooseHardDelete();
    await screen.findByLabelText('Transfer owned data to');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(removeUser).toHaveBeenCalledWith('usr_1', {
        mode: 'hard',
        transferToUserId: undefined,
      }),
    );
  });

  it('says so when no other active user could receive the data', async () => {
    renderDialog({
      fetchCandidates: () =>
        Promise.resolve({
          items: [user({ id: 'usr_1' })],
          meta: { total: 1, page: 1, pageSize: 100 },
        }),
    });

    chooseHardDelete();

    expect(
      await screen.findByText(
        'No other active user is available to receive the data.',
      ),
    ).toBeInTheDocument();
  });

  it('reports a failed candidate load without blocking the dialog', async () => {
    renderDialog({
      fetchCandidates: () => Promise.reject(new Error('offline')),
    });

    chooseHardDelete();

    expect(
      await screen.findByText('Transfer targets could not be loaded.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('offline')).not.toBeInTheDocument();
  });

  it('renders an invalid target from its code, not the server message', async () => {
    const { onDeleted } = renderDialog({
      removeUser: () =>
        Promise.reject(
          new ApiError('INVALID_TARGET_USER', 'target usr_9 is not active'),
        ),
    });

    chooseHardDelete();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(
      await screen.findByText('That transfer target cannot receive the data.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('target usr_9 is not active'),
    ).not.toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('renders a self-deletion refusal from its code', async () => {
    renderDialog({
      removeUser: () =>
        Promise.reject(new ApiError('CANNOT_DELETE_SELF', 'nope')),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(
      await screen.findByText('You cannot delete your own account.'),
    ).toBeInTheDocument();
  });
});
