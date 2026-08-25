import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  ActorType,
  FieldDataType,
  type AuthenticatedUserDto,
  type DynamicTableDetailDto,
} from '@flexi/shared-types';
import { AuthContext, type AuthContextValue } from '../auth/AuthContext';
import { DynamicTableRowsPage } from './DynamicTableRowsPage';
import i18n from '../i18n';

const user: AuthenticatedUserDto = {
  authAccountId: 'auth-1',
  actorType: ActorType.TENANT,
  tenantId: 'tenant-1',
  tenantUserId: 'user-1',
  email: 'user@flexi.test',
  name: 'User',
  roles: ['Member'],
  permissions: [
    'dynamic-tables.tables.read',
    'dynamic-tables.rows.read',
    'dynamic-tables.rows.update',
    'dynamic-tables.rows.delete',
  ],
};
const auth: AuthContextValue = {
  accessToken: 'token',
  currentUser: user,
  loading: false,
  login: async () => {},
  logout: async () => {},
};
const table: DynamicTableDetailDto = {
  id: 'orders',
  name: 'Orders',
  slug: 'orders',
  description: null,
  createdAt: '2026-08-20T08:00:00.000Z',
  updatedAt: '2026-08-20T08:00:00.000Z',
  fields: [
    {
      id: 'status',
      tableId: 'orders',
      name: 'Status',
      slug: 'status',
      dataType: FieldDataType.STRING,
      required: true,
      config: null,
      relationTargetTableId: null,
      createdAt: '2026-08-20T08:00:00.000Z',
      updatedAt: '2026-08-20T08:00:00.000Z',
    },
    {
      id: 'customer',
      tableId: 'orders',
      name: 'Customer',
      slug: 'customer',
      dataType: FieldDataType.RELATION,
      required: false,
      config: null,
      relationTargetTableId: 'customers',
      createdAt: '2026-08-20T08:00:00.000Z',
      updatedAt: '2026-08-20T08:00:00.000Z',
    },
  ],
};

function renderPage(
  props: Partial<React.ComponentProps<typeof DynamicTableRowsPage>> = {},
) {
  return render(
    <MemoryRouter initialEntries={['/dynamic-tables/orders/rows']}>
      <AuthContext.Provider value={auth}>
        <Routes>
          <Route
            path="/dynamic-tables/:tableId/rows"
            element={
              <DynamicTableRowsPage
                fetchTable={() => Promise.resolve(table)}
                fetchRows={() =>
                  Promise.resolve({
                    items: [
                      {
                        id: 1,
                        status: 'pending',
                        customer: { id: 20, name: 'Ava' },
                      },
                    ],
                    meta: { total: 1, page: 1, pageSize: 20 },
                  })
                }
                {...props}
              />
            }
          />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('DynamicTableRowsPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders metadata columns, a safe relation label, and only the server page', async () => {
    renderPage();
    expect(await screen.findByText('Rows: Orders')).toBeInTheDocument();
    expect(screen.getByText('Ava (20)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('confirms and deletes a row, then refreshes its page', async () => {
    const deleteRow = vi.fn().mockResolvedValue(undefined);
    const fetchRows = vi.fn().mockResolvedValue({
      items: [{ id: 1, status: 'pending' }],
      meta: { total: 1, page: 1, pageSize: 20 },
    });
    vi.stubGlobal('confirm', () => true);
    renderPage({ deleteRow, fetchRows });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await vi.waitFor(() =>
      expect(deleteRow).toHaveBeenCalledWith('orders', '1'),
    );
    await vi.waitFor(() => expect(fetchRows).toHaveBeenCalledTimes(2));
    vi.unstubAllGlobals();
  });
});
