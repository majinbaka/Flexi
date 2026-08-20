import type { Meta, StoryObj } from '@storybook/react-vite';
import { Table, type TableColumn } from './Table';
import { Badge } from './Badge';
import { Button } from './Button';

interface TableRow {
  id: string;
  name: string;
  slug: string;
  fields: number;
  status: 'active' | 'draft' | 'archived';
}

const ROWS: TableRow[] = [
  { id: '1', name: 'Customers', slug: 'customers', fields: 12, status: 'active' },
  { id: '2', name: 'Invoices', slug: 'invoices', fields: 18, status: 'active' },
  { id: '3', name: 'Suppliers', slug: 'suppliers', fields: 9, status: 'draft' },
  { id: '4', name: 'Legacy contacts', slug: 'legacy_contacts', fields: 6, status: 'archived' },
];

const STATUS_TONE = {
  active: 'success',
  draft: 'neutral',
  archived: 'danger',
} as const;

const COLUMNS: TableColumn<TableRow>[] = [
  {
    id: 'name',
    header: 'Table',
    width: 'w-1/3',
    cell: (row) => (
      <div className="flex flex-col">
        <span className="font-medium text-on-surface">{row.name}</span>
        <span className="font-code-sm text-code-sm text-on-surface-variant">
          {row.slug}
        </span>
      </div>
    ),
  },
  {
    id: 'fields',
    header: 'Fields',
    align: 'right',
    cell: (row) => row.fields,
  },
  {
    id: 'status',
    header: 'Status',
    cell: (row) => <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>,
  },
  {
    id: 'actions',
    header: <span className="sr-only">Actions</span>,
    align: 'right',
    cell: () => (
      <Button variant="ghost" size="sm" icon="more_vert" aria-label="Row actions" />
    ),
  },
];

/**
 * `Table` is the generic data grid: uppercase header on a raised surface,
 * hairline dividers, hover feedback per row. Columns are described by an
 * array of `TableColumn` objects rather than JSX children, so a `cell`
 * renderer can return any node -- badges and buttons included.
 */
const meta: Meta<typeof Table<TableRow>> = {
  title: 'UI/Table',
  component: Table,
  parameters: { layout: 'padded' },
  args: {
    columns: COLUMNS,
    rows: ROWS,
    rowKey: (row: TableRow) => row.id,
  },
  decorators: [
    (Story) => (
      <div className="w-[52rem] max-w-full">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof Table<TableRow>>;

export const Default: Story = {};

/** With `onRowClick` the rows take a pointer cursor and become clickable. */
export const ClickableRows: Story = {
  args: {
    onRowClick: (row: TableRow) => window.alert(`Open ${row.name}`),
  },
};

export const Empty: Story = {
  args: {
    rows: [],
    emptyMessage: 'No tables yet. Create one to get started.',
  },
};

/**
 * The table scrolls inside its own container instead of widening the page --
 * this story is narrower than the columns need, to show that behaviour.
 */
export const HorizontalScroll: Story = {
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
};
