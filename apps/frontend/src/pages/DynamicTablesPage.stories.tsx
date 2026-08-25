import type { Meta, StoryObj } from '@storybook/react-vite';
import type { DynamicTableCatalogPageDto } from '@flexi/shared-types';
import { DynamicTablesPage } from './DynamicTablesPage';
import { MOCK_USER, withAppContext } from '../stories/decorators';

const meta: Meta<typeof DynamicTablesPage> = {
  title: 'Pages/DynamicTablesPage',
  component: DynamicTablesPage,
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

type Story = StoryObj<typeof DynamicTablesPage>;

const catalog: DynamicTableCatalogPageDto = {
  items: [
    {
      id: 'orders',
      name: 'Orders',
      slug: 'orders',
      description: 'Customer orders and fulfillment status.',
      createdAt: '2026-08-20T08:00:00.000Z',
      updatedAt: '2026-08-23T11:30:00.000Z',
    },
    {
      id: 'products',
      name: 'Products',
      slug: 'products',
      description: null,
      createdAt: '2026-08-18T08:00:00.000Z',
      updatedAt: '2026-08-21T15:45:00.000Z',
    },
  ],
  meta: { total: 2, page: 1, pageSize: 20 },
};

function respond(response: DynamicTableCatalogPageDto) {
  return () => Promise.resolve(response);
}

const permittedDecorator = withAppContext({
  route: '/dynamic-tables',
  user: MOCK_USER,
});

export const Catalog: Story = {
  args: { fetchTables: respond(catalog) },
  decorators: [permittedDecorator],
};

export const Loading: Story = {
  args: { fetchTables: () => new Promise(() => {}) },
  decorators: [permittedDecorator],
};

export const Empty: Story = {
  args: {
    fetchTables: respond({
      items: [],
      meta: { total: 0, page: 1, pageSize: 20 },
    }),
  },
  decorators: [permittedDecorator],
};

export const ErrorWithRetry: Story = {
  args: { fetchTables: () => Promise.reject(new Error('Offline')) },
  decorators: [permittedDecorator],
};

export const ReadOnly: Story = {
  args: { fetchTables: respond(catalog) },
  decorators: [
    withAppContext({
      route: '/dynamic-tables',
      user: { ...MOCK_USER, permissions: ['dynamic-tables.tables.read'] },
    }),
  ],
};

export const MobileCatalog: Story = {
  ...Catalog,
  globals: { viewport: { value: 'mobile' } },
};
