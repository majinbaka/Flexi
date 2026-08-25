import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  ActorType,
  DYNAMIC_TABLES_TABLES_CREATE_PERMISSION,
  DYNAMIC_TABLES_TABLES_READ_PERMISSION,
  type AuthenticatedUserDto,
} from '@flexi/shared-types';
import type { ReactNode } from 'react';
import i18n from '../i18n';
import { AuthContext, type AuthContextValue } from '../auth/AuthContext';
import { DynamicTablesPage } from './DynamicTablesPage';

const reader: AuthenticatedUserDto = {
  authAccountId: 'auth_table_reader',
  actorType: ActorType.TENANT,
  tenantId: 'tenant_acme',
  tenantUserId: 'tenant_user',
  email: 'reader@acme.test',
  name: 'Table Reader',
  roles: ['Member'],
  permissions: [DYNAMIC_TABLES_TABLES_READ_PERMISSION],
};

function renderPage(children: ReactNode, user: AuthenticatedUserDto = reader) {
  const auth: AuthContextValue = {
    accessToken: 'test-access-token',
    currentUser: user,
    loading: false,
    login: async () => {},
    logout: async () => {},
  };

  return render(
    <MemoryRouter>
      <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('DynamicTablesPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders an empty catalog and does not show the create action to a reader', async () => {
    renderPage(
      <DynamicTablesPage
        fetchTables={() =>
          Promise.resolve({
            items: [],
            meta: { total: 0, page: 1, pageSize: 20 },
          })
        }
      />,
    );

    expect(
      await screen.findByText('No dynamic tables have been created yet.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create table' }),
    ).not.toBeInTheDocument();
  });

  it('shows the create action only to a user with the create permission', async () => {
    renderPage(
      <DynamicTablesPage
        fetchTables={() =>
          Promise.resolve({
            items: [],
            meta: { total: 0, page: 1, pageSize: 20 },
          })
        }
      />,
      {
        ...reader,
        permissions: [
          ...reader.permissions,
          DYNAMIC_TABLES_TABLES_CREATE_PERMISSION,
        ],
      },
    );

    expect(
      await screen.findByRole('button', { name: 'Create table' }),
    ).toBeInTheDocument();
  });

  it('retries a failed catalog request without rendering its raw error', async () => {
    const fetchTables = vi
      .fn()
      .mockRejectedValueOnce(new Error('Internal metadata details'))
      .mockResolvedValueOnce({
        items: [],
        meta: { total: 0, page: 1, pageSize: 20 },
      });
    renderPage(<DynamicTablesPage fetchTables={fetchTables} />);

    expect(
      await screen.findByText('Dynamic Tables could not be loaded. Try again.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Internal metadata details'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(fetchTables).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText('No dynamic tables have been created yet.'),
    ).toBeInTheDocument();
  });

  it('requests the next catalog page and aborts the previous request', async () => {
    const signals: AbortSignal[] = [];
    const fetchTables = vi.fn((query, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return Promise.resolve({
        items: [
          {
            id: `table-${query.page}`,
            name: 'Orders',
            slug: 'orders',
            description: null,
            createdAt: '2026-08-20T08:00:00.000Z',
            updatedAt: '2026-08-23T08:00:00.000Z',
          },
        ],
        meta: { total: 40, page: query.page ?? 1, pageSize: 20 },
      });
    });
    renderPage(<DynamicTablesPage fetchTables={fetchTables} />);

    await screen.findByText('Orders');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() =>
      expect(fetchTables).toHaveBeenLastCalledWith(
        { page: 2, pageSize: 20 },
        expect.any(AbortSignal),
      ),
    );
    expect(signals[0]?.aborted).toBe(true);
  });
});
