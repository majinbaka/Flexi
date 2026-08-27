import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
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

/** Mirrors the router location so a test can assert on the URL. */
function LocationProbe() {
  const location = useLocation();

  return (
    <span data-testid="location">{location.pathname + location.search}</span>
  );
}

function currentLocation() {
  return screen.getByTestId('location').textContent;
}

function renderPage(
  children: ReactNode,
  user: AuthenticatedUserDto = reader,
  initialEntries: string[] = ['/dynamic-tables'],
) {
  const auth: AuthContextValue = {
    accessToken: 'test-access-token',
    currentUser: user,
    loading: false,
    login: async () => {},
    logout: async () => {},
    reloadSession: async () => {},
  };

  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthContext.Provider value={auth}>
        {children}
        <LocationProbe />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const catalogPage = {
  items: [
    {
      id: 'orders',
      name: 'Orders',
      slug: 'orders',
      description: null,
      createdAt: '2026-08-20T08:00:00.000Z',
      updatedAt: '2026-08-23T08:00:00.000Z',
    },
  ],
  meta: { total: 1, page: 1, pageSize: 20 },
};

const ordersDetail = { ...catalogPage.items[0], fields: [] };

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

  it('puts the opened table in the URL and drops it again on close', async () => {
    const fetchTable = vi.fn(() => Promise.resolve(ordersDetail));
    renderPage(
      <DynamicTablesPage
        fetchTables={() => Promise.resolve(catalogPage)}
        fetchTable={fetchTable}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));

    await waitFor(() =>
      expect(currentLocation()).toBe('/dynamic-tables?table=orders'),
    );
    expect(fetchTable).toHaveBeenCalledWith('orders', expect.any(AbortSignal));

    fireEvent.click(
      await screen.findByRole('button', { name: 'Close editor' }),
    );

    await waitFor(() => expect(currentLocation()).toBe('/dynamic-tables'));
  });

  it('opens the field editor from a deep link without any interaction', async () => {
    const fetchTable = vi.fn(() => Promise.resolve(ordersDetail));
    renderPage(
      <DynamicTablesPage
        fetchTables={() => Promise.resolve(catalogPage)}
        fetchTable={fetchTable}
      />,
      reader,
      ['/dynamic-tables?table=orders'],
    );

    await waitFor(() =>
      expect(fetchTable).toHaveBeenCalledWith(
        'orders',
        expect.any(AbortSignal),
      ),
    );
    expect(
      await screen.findByRole('button', { name: 'Close editor' }),
    ).toBeInTheDocument();
  });
});
