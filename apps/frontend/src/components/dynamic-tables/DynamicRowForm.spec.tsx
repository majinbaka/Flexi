import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  FieldDataType,
  type DynamicTableDetailDto,
  type DynamicTableRowPageDto,
  type DynamicTableRowQueryDto,
} from '@flexi/shared-types';
import i18n from '../../i18n';
import { DynamicRowForm } from './DynamicRowForm';

const table: DynamicTableDetailDto = {
  id: 'orders',
  name: 'Orders',
  slug: 'orders',
  description: null,
  createdAt: '2026-08-20T08:00:00.000Z',
  updatedAt: '2026-08-20T08:00:00.000Z',
  fields: [
    {
      id: 'active',
      tableId: 'orders',
      name: 'Active',
      slug: 'active',
      dataType: FieldDataType.BOOLEAN,
      required: false,
      config: null,
      relationTargetTableId: null,
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'amount',
      tableId: 'orders',
      name: 'Amount',
      slug: 'amount',
      dataType: FieldDataType.NUMBER,
      required: true,
      config: { min: 1 },
      relationTargetTableId: null,
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'metadata',
      tableId: 'orders',
      name: 'Metadata',
      slug: 'metadata',
      dataType: FieldDataType.JSON,
      required: false,
      config: null,
      relationTargetTableId: null,
      createdAt: '',
      updatedAt: '',
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
      createdAt: '',
      updatedAt: '',
    },
  ],
};

/** Serves `total` related rows in pages of `pageSize`. */
function pagedRows(total: number, pageSize: number) {
  const items = Array.from({ length: total }, (_unused, index) => ({
    id: index + 1,
    name: `Customer ${index + 1}`,
  }));
  return (
    _tableId: string,
    query: DynamicTableRowQueryDto,
  ): Promise<DynamicTableRowPageDto> => {
    const page = query.page ?? 1;
    return Promise.resolve({
      items: items.slice((page - 1) * pageSize, page * pageSize),
      meta: { total, page, pageSize },
    });
  };
}

describe('DynamicRowForm', () => {
  it('preserves false, zero, null and the selected relation id in its metadata-only payload', async () => {
    await i18n.changeLanguage('en');
    const createRow = vi.fn().mockResolvedValue({ id: 1 });
    render(
      <DynamicRowForm
        table={table}
        createRow={createRow}
        fetchRelationRows={() =>
          Promise.resolve({
            items: [{ id: 9, name: 'Ava' }],
            meta: { total: 1, page: 1, pageSize: 50 },
          })
        }
      />,
    );
    await screen.findByRole('option', { name: 'Ava (9)' });
    fireEvent.change(screen.getByLabelText('Amount *'), {
      target: { value: '0' },
    });
    fireEvent.change(screen.getByLabelText('Customer'), {
      target: { value: '9' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create row' }));
    expect(
      await screen.findByText('Enter a value of at least 1.'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Amount *'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create row' }));
    await waitFor(() =>
      expect(createRow).toHaveBeenCalledWith(
        'orders',
        { active: false, amount: 1, metadata: null, customer: 9 },
        expect.any(AbortSignal),
      ),
    );
  });

  it('rejects unsafe JSON before creating a row', async () => {
    await i18n.changeLanguage('en');
    const createRow = vi.fn();
    render(<DynamicRowForm table={table} createRow={createRow} />);
    fireEvent.change(screen.getByLabelText('Amount *'), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Metadata' }), {
      target: { value: '{bad' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create row' }));
    expect(
      await screen.findByText('Enter a valid JSON object or array.'),
    ).toBeInTheDocument();
    expect(createRow).not.toHaveBeenCalled();
  });

  it('offers related rows from every page of the target table', async () => {
    await i18n.changeLanguage('en');
    const fetchRelationRows = vi.fn(pagedRows(3, 2));
    render(
      <DynamicRowForm table={table} fetchRelationRows={fetchRelationRows} />,
    );

    // `Customer 3` only exists on the second page of the target table.
    expect(
      await screen.findByRole('option', { name: 'Customer 3 (3)' }),
    ).toBeInTheDocument();
    expect(fetchRelationRows).toHaveBeenNthCalledWith(
      1,
      'customers',
      { page: 1 },
      expect.any(AbortSignal),
    );
    expect(fetchRelationRows).toHaveBeenNthCalledWith(
      2,
      'customers',
      { page: 2, pageSize: 2 },
      expect.any(AbortSignal),
    );
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();

    // A re-render must not restart the walk: the loader identity is stable,
    // so editing the form does not re-request every relation page.
    fireEvent.change(screen.getByLabelText('Customer'), {
      target: { value: '3' },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Customer')).toHaveValue('3'),
    );
    expect(fetchRelationRows).toHaveBeenCalledTimes(2);
  });

  it('says so when the related rows are cut off by the page walk limit', async () => {
    await i18n.changeLanguage('en');
    const fetchRelationRows = vi.fn(pagedRows(11, 1));
    render(
      <DynamicRowForm table={table} fetchRelationRows={fetchRelationRows} />,
    );

    expect(
      await screen.findByText(
        'Showing the first 10 rows. Not every row of the related table is listed.',
      ),
    ).toBeInTheDocument();
    expect(fetchRelationRows).toHaveBeenCalledTimes(10);
  });
});
