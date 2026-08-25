import type { Meta, StoryObj } from '@storybook/react-vite';
import { FieldDataType, type DynamicTableDetailDto } from '@flexi/shared-types';
import { DynamicRowForm } from './DynamicRowForm';
import { withAppContext } from '../../stories/decorators';

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
      dataType: FieldDataType.SELECT,
      required: true,
      config: { enum: ['draft', 'paid'] },
      relationTargetTableId: null,
      createdAt: '2026-08-20T08:00:00.000Z',
      updatedAt: '2026-08-20T08:00:00.000Z',
    },
    {
      id: 'total',
      tableId: 'orders',
      name: 'Total',
      slug: 'total',
      dataType: FieldDataType.NUMBER,
      required: true,
      config: { min: 0 },
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

const meta: Meta<typeof DynamicRowForm> = {
  title: 'Components/DynamicTables/DynamicRowForm',
  component: DynamicRowForm,
  decorators: [
    withAppContext({ route: '/dynamic-tables/orders/rows' }),
    (Story) => (
      <div className="max-w-4xl bg-background p-lg md:p-xl">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof DynamicRowForm>;

const args = {
  table,
  fetchRelationRows: () =>
    Promise.resolve({
      items: [{ id: 4, name: 'Ava Nguyen' }],
      meta: { total: 1, page: 1, pageSize: 50 },
    }),
  createRow: (_tableId: string, payload: Record<string, unknown>) =>
    Promise.resolve({ id: 1, ...payload }),
};

export const Create: Story = { args };
export const Edit: Story = {
  args: {
    ...args,
    row: {
      id: 1,
      status: 'paid',
      total: 125,
      customer: { id: 4, name: 'Ava Nguyen' },
    },
    updateRow: (
      _tableId: string,
      _rowId: string,
      payload: Record<string, unknown>,
    ) => Promise.resolve({ id: 1, ...payload }),
  },
};
export const Saving: Story = {
  args: { ...args, createRow: () => new Promise(() => {}) },
};
