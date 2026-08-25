import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  FieldDataType,
  type DynamicTableDetailDto,
  type DynamicTableRowPageDto,
} from '@flexi/shared-types';
import { DynamicTableRowsPage } from './DynamicTableRowsPage';
import { MOCK_USER, withAppContext } from '../stories/decorators';

const table: DynamicTableDetailDto = {
  id: 'orders',
  name: 'Orders',
  slug: 'orders',
  description: 'Customer orders.',
  createdAt: '2026-08-20T08:00:00.000Z',
  updatedAt: '2026-08-23T11:30:00.000Z',
  fields: [
    {
      id: 'field-status',
      tableId: 'orders',
      name: 'Status',
      slug: 'status',
      dataType: FieldDataType.SELECT,
      required: true,
      config: { options: ['pending', 'shipped'] },
      relationTargetTableId: null,
      createdAt: '2026-08-20T08:00:00.000Z',
      updatedAt: '2026-08-20T08:00:00.000Z',
    },
    {
      id: 'field-total',
      tableId: 'orders',
      name: 'Total',
      slug: 'total',
      dataType: FieldDataType.NUMBER,
      required: true,
      config: null,
      relationTargetTableId: null,
      createdAt: '2026-08-20T08:00:00.000Z',
      updatedAt: '2026-08-20T08:00:00.000Z',
    },
    {
      id: 'field-customer',
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

const rows: DynamicTableRowPageDto = {
  items: [
    {
      id: 101,
      status: 'pending',
      total: 55,
      customer: { id: 12, name: 'Ava Nguyen' },
    },
    { id: 102, status: 'shipped', total: 89, customer: null },
  ],
  meta: { total: 2, page: 1, pageSize: 20 },
};

const meta: Meta<typeof DynamicTableRowsPage> = {
  title: 'Pages/DynamicTableRowsPage',
  component: DynamicTableRowsPage,
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
type Story = StoryObj<typeof DynamicTableRowsPage>;
const decorator = withAppContext({
  route: '/dynamic-tables/orders/rows',
  user: {
    ...MOCK_USER,
    permissions: [
      ...MOCK_USER.permissions,
      'dynamic-tables.rows.read',
      'dynamic-tables.rows.update',
      'dynamic-tables.rows.delete',
    ],
  },
});
const args = {
  fetchTable: () => Promise.resolve(table),
  fetchRows: () => Promise.resolve(rows),
  updateRow: () => Promise.resolve(rows.items[0]),
  deleteRow: () => Promise.resolve(),
};

export const Browse: Story = { args, decorators: [decorator] };
export const Loading: Story = {
  args: { ...args, fetchRows: () => new Promise(() => {}) },
  decorators: [decorator],
};
export const Empty: Story = {
  args: {
    ...args,
    fetchRows: () =>
      Promise.resolve({ items: [], meta: { total: 0, page: 1, pageSize: 20 } }),
  },
  decorators: [decorator],
};
export const LoadError: Story = {
  args: { ...args, fetchRows: () => Promise.reject(new Error('Offline')) },
  decorators: [decorator],
};
export const ReadOnly: Story = {
  args,
  decorators: [
    withAppContext({
      route: '/dynamic-tables/orders/rows',
      user: {
        ...MOCK_USER,
        permissions: ['dynamic-tables.tables.read', 'dynamic-tables.rows.read'],
      },
    }),
  ],
};
