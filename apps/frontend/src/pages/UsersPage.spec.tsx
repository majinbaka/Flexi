import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import {
  ActorType,
  TENANT_SETTINGS_MANAGE_PERMISSION,
  TENANT_USER_INVITE_PERMISSION,
  TENANT_USER_MANAGE_PERMISSION,
  TENANT_USER_READ_PERMISSION,
  TenantUserStatus,
  type AuthenticatedUserDto,
  type UserListResponseDto,
  type UserSummaryDto,
} from '@flexi/shared-types';
import type { ReactNode } from 'react';
import i18n from '../i18n';
import { AuthContext, type AuthContextValue } from '../auth/AuthContext';
import { ApiError } from '../lib/api-client';
import { UsersPage } from './UsersPage';

const reader: AuthenticatedUserDto = {
  authAccountId: 'auth_user_reader',
  actorType: ActorType.TENANT,
  tenantId: 'tenant_acme',
  tenantUserId: 'tenant_user_reader',
  email: 'reader@acme.test',
  name: 'User Reader',
  roles: ['Member'],
  permissions: [TENANT_USER_READ_PERMISSION],
};

const admin: AuthenticatedUserDto = {
  ...reader,
  authAccountId: 'auth_user_admin',
  tenantUserId: 'tenant_user_admin',
  email: 'admin@acme.test',
  permissions: [
    TENANT_USER_READ_PERMISSION,
    TENANT_USER_MANAGE_PERMISSION,
    TENANT_USER_INVITE_PERMISSION,
    TENANT_SETTINGS_MANAGE_PERMISSION,
  ],
};

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
    roles: [{ id: 'role_member', name: 'Member' }],
    createdAt: '2026-08-01T08:00:00.000Z',
    updatedAt: '2026-08-20T08:00:00.000Z',
    ...overrides,
  };
}

function page(
  items: UserSummaryDto[],
  total = items.length,
): UserListResponseDto {
  return { items, meta: { total, page: 1, pageSize: 20 } };
}

/** Mirrors the router location so a test can assert on navigation. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function renderPage(
  children: ReactNode,
  currentUser: AuthenticatedUserDto = admin,
) {
  const auth: AuthContextValue = {
    accessToken: 'test-access-token',
    currentUser,
    loading: false,
    login: async () => {},
    logout: async () => {},
    reloadSession: async () => {},
  };

  return render(
    <MemoryRouter initialEntries={['/users']}>
      <AuthContext.Provider value={auth}>
        {children}
        <LocationProbe />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

/** Keeps the invites panel out of the way of assertions about the list. */
const noInvites = { fetchInvites: () => Promise.resolve([]) };

describe('UsersPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders an empty directory and hides every action from a reader', async () => {
    renderPage(
      <UsersPage
        fetchUsers={() => Promise.resolve(page([]))}
        invitesPanelProps={noInvites}
      />,
      reader,
    );

    expect(
      await screen.findByText('No users match these filters.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Invite users' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Registration policy' }),
    ).not.toBeInTheDocument();
  });

  it('shows a status badge for each user', async () => {
    renderPage(
      <UsersPage
        fetchUsers={() =>
          Promise.resolve(
            page([
              user(),
              user({
                id: 'usr_2',
                email: 'ben@acme.test',
                fullName: null,
                status: TenantUserStatus.LOCKED,
                roles: [],
              }),
            ]),
          )
        }
        invitesPanelProps={noInvites}
      />,
      // As a reader: no invites panel, so `table` is unambiguously the
      // directory, and no action buttons to compete with the badges.
      reader,
    );

    expect(await screen.findByText('Ana Nguyen')).toBeInTheDocument();

    // Scoped to the table: the status filter renders an <option> with the
    // same label for every status, so an unscoped query matches twice.
    const table = within(screen.getByRole('table'));
    expect(table.getByText('Active')).toBeInTheDocument();
    expect(table.getByText('Locked')).toBeInTheDocument();
    // A row with no name and no roles gets a placeholder for both.
    expect(table.getByText('Not set')).toBeInTheDocument();
    expect(table.getByText('None')).toBeInTheDocument();
  });

  it('retries a failed listing without rendering the raw error', async () => {
    const fetchUsers = vi
      .fn()
      .mockRejectedValueOnce(new Error('Internal directory details'))
      .mockResolvedValueOnce(page([]));

    renderPage(
      <UsersPage fetchUsers={fetchUsers} invitesPanelProps={noInvites} />,
    );

    expect(
      await screen.findByText('Users could not be loaded. Try again.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Internal directory details'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(fetchUsers).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText('No users match these filters.'),
    ).toBeInTheDocument();
  });

  it('sends the status filter and resets to the first page', async () => {
    const fetchUsers = vi.fn(() => Promise.resolve(page([user()], 40)));

    renderPage(
      <UsersPage fetchUsers={fetchUsers} invitesPanelProps={noInvites} />,
    );

    await screen.findByText('Ana Nguyen');
    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: TenantUserStatus.PENDING_APPROVAL },
    });

    await waitFor(() =>
      expect(fetchUsers).toHaveBeenLastCalledWith(
        {
          status: TenantUserStatus.PENDING_APPROVAL,
          keyword: undefined,
          page: 1,
          pageSize: 20,
        },
        { signal: expect.any(AbortSignal) },
      ),
    );
  });

  it('applies the keyword only when the filter bar is submitted', async () => {
    const fetchUsers = vi.fn(() => Promise.resolve(page([user()])));

    renderPage(
      <UsersPage fetchUsers={fetchUsers} invitesPanelProps={noInvites} />,
    );

    await screen.findByText('Ana Nguyen');
    const callsBeforeTyping = fetchUsers.mock.calls.length;

    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: 'ana' },
    });
    expect(fetchUsers).toHaveBeenCalledTimes(callsBeforeTyping);

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(fetchUsers).toHaveBeenLastCalledWith(
        expect.objectContaining({ keyword: 'ana' }),
        { signal: expect.any(AbortSignal) },
      ),
    );
  });

  it('requests the next page and aborts the previous request', async () => {
    const signals: AbortSignal[] = [];
    const fetchUsers = vi.fn((query, options?: { signal?: AbortSignal }) => {
      if (options?.signal) signals.push(options.signal);
      return Promise.resolve({
        items: [user()],
        meta: { total: 40, page: query.page ?? 1, pageSize: 20 },
      });
    });

    renderPage(
      <UsersPage fetchUsers={fetchUsers} invitesPanelProps={noInvites} />,
    );

    await screen.findByText('Ana Nguyen');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() =>
      expect(fetchUsers).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2 }),
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(signals[0]?.aborted).toBe(true);
  });

  it('offers approve only for a pending user and refreshes after it succeeds', async () => {
    const approve = vi.fn(() =>
      Promise.resolve({
        user: {
          ...user({ status: TenantUserStatus.ACTIVE }),
          mustChangePassword: false,
        },
        revokedSessionCount: 0,
      }),
    );
    const fetchUsers = vi
      .fn()
      .mockResolvedValueOnce(
        page([user({ status: TenantUserStatus.PENDING_APPROVAL })]),
      )
      .mockResolvedValue(page([user({ status: TenantUserStatus.ACTIVE })]));

    renderPage(
      <UsersPage
        fetchUsers={fetchUsers}
        approve={approve}
        invitesPanelProps={noInvites}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(approve).toHaveBeenCalledWith('usr_1'));
    await waitFor(() => expect(fetchUsers).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole('button', { name: 'Lock' }),
    ).toBeInTheDocument();
  });

  it('offers unlock, not lock, for a locked user', async () => {
    renderPage(
      <UsersPage
        fetchUsers={() =>
          Promise.resolve(page([user({ status: TenantUserStatus.LOCKED })]))
        }
        invitesPanelProps={noInvites}
      />,
    );

    expect(
      await screen.findByRole('button', { name: 'Unlock' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Lock' }),
    ).not.toBeInTheDocument();
  });

  it('renders a failed action from its error code, not the server message', async () => {
    const lock = vi.fn(() =>
      Promise.reject(
        new ApiError('CANNOT_LOCK_SELF', 'An admin may not lock themselves'),
      ),
    );

    renderPage(
      <UsersPage
        fetchUsers={() => Promise.resolve(page([user()]))}
        lock={lock}
        invitesPanelProps={noInvites}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Lock' }));

    expect(
      await screen.findByText('You cannot lock your own account.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('An admin may not lock themselves'),
    ).not.toBeInTheDocument();
  });

  it('reports an unmapped error code generically rather than echoing the server', async () => {
    const lock = vi.fn(() =>
      Promise.reject(new ApiError('SOME_FUTURE_CODE', 'Raw backend prose')),
    );

    renderPage(
      <UsersPage
        fetchUsers={() => Promise.resolve(page([user()]))}
        lock={lock}
        invitesPanelProps={noInvites}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Lock' }));

    expect(
      await screen.findByText('Something went wrong. Try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Raw backend prose')).not.toBeInTheDocument();
  });

  it('navigates to the registration policy screen', async () => {
    renderPage(
      <UsersPage
        fetchUsers={() => Promise.resolve(page([]))}
        invitesPanelProps={noInvites}
      />,
    );

    fireEvent.click(
      await screen.findByRole('button', { name: 'Registration policy' }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/users/settings',
      ),
    );
  });

  it('shows the invites panel only to a user who may invite', async () => {
    const { unmount } = renderPage(
      <UsersPage
        fetchUsers={() => Promise.resolve(page([]))}
        invitesPanelProps={noInvites}
      />,
      reader,
    );

    await screen.findByText('No users match these filters.');
    expect(
      screen.queryByText('Outstanding invitations'),
    ).not.toBeInTheDocument();
    unmount();

    renderPage(
      <UsersPage
        fetchUsers={() => Promise.resolve(page([]))}
        invitesPanelProps={noInvites}
      />,
      admin,
    );

    expect(
      await screen.findByText('Outstanding invitations'),
    ).toBeInTheDocument();
  });

  it('renders every label in Vietnamese when the language is switched', async () => {
    await i18n.changeLanguage('vi');

    renderPage(
      <UsersPage
        fetchUsers={() => Promise.resolve(page([]))}
        invitesPanelProps={noInvites}
      />,
    );

    expect(
      await screen.findByText('Không có người dùng nào khớp bộ lọc.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Mời người dùng' }),
    ).toBeInTheDocument();
  });
});
