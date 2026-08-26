import type { Meta, StoryObj } from '@storybook/react-vite';
import { FieldDataType, type DynamicTableDetailDto } from '@flexi/shared-types';
import { FieldEditor } from './FieldEditor';
import { withAppContext } from '../../stories/decorators';

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
      name: 'status',
      slug: 'status',
      dataType: FieldDataType.SELECT,
      required: true,
      relationTargetTableId: null,
      config: { options: ['draft', 'paid'] },
      createdAt: '2026-08-20T08:00:00.000Z',
      updatedAt: '2026-08-20T08:00:00.000Z',
    },
    {
      id: 'field-customer',
      tableId: 'orders',
      name: 'customer',
      slug: 'customer',
      dataType: FieldDataType.RELATION,
      required: false,
      relationTargetTableId: 'customers',
      config: null,
      createdAt: '2026-08-20T08:00:00.000Z',
      updatedAt: '2026-08-20T08:00:00.000Z',
    },
  ],
};

const meta: Meta<typeof FieldEditor> = {
  title: 'Components/DynamicTables/FieldEditor',
  component: FieldEditor,
  decorators: [
    withAppContext({ route: '/dynamic-tables' }),
    (Story) => (
      <div className="max-w-4xl bg-background p-lg md:p-xl">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof FieldEditor>;

const catalog = [
  {
    id: table.id,
    name: table.name,
    slug: table.slug,
    description: table.description,
    createdAt: table.createdAt,
    updatedAt: table.updatedAt,
  },
  {
    id: 'customers',
    name: 'Customers',
    slug: 'customers',
    description: null,
    createdAt: '2026-08-18T08:00:00.000Z',
    updatedAt: '2026-08-22T08:00:00.000Z',
  },
];

const args = {
  table,
  fetchRelationTargets: () =>
    Promise.resolve({
      items: catalog,
      meta: { total: catalog.length, page: 1, pageSize: 20 },
    }),
  updateFields: () => Promise.resolve({ jobId: 'ddl-field-edit-story' }),
  getJob: () =>
    Promise.resolve({
      jobId: 'ddl-field-edit-story',
      status: 'completed' as const,
      error: null,
    }),
};

export const Default: Story = { args };

export const ReadOnly: Story = {
  args: { ...args, readOnly: true },
};

export const Submitting: Story = {
  args: { ...args, updateFields: () => new Promise(() => {}) },
};

/** The relation-target dropdown when the table catalog cannot be read. */
export const RelationTargetsUnavailable: Story = {
  args: {
    ...args,
    fetchRelationTargets: () => Promise.reject(new Error('catalog offline')),
  },
};
