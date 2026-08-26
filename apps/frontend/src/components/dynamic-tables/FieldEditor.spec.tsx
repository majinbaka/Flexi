import { describe, expect, it, vi } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  FieldDataType,
  type DynamicTableCatalogItemDto,
  type DynamicTableCatalogPageDto,
  type DynamicTableCatalogQueryDto,
  type DynamicTableDetailDto,
} from '@flexi/shared-types';
import i18n from '../../i18n';
import { FieldEditor } from './FieldEditor';

const table: DynamicTableDetailDto = {
  id: 'orders',
  name: 'Orders',
  slug: 'orders',
  description: null,
  createdAt: '2026-08-20T08:00:00.000Z',
  updatedAt: '2026-08-20T08:00:00.000Z',
  fields: [
    {
      id: 'field-status',
      tableId: 'orders',
      name: 'status',
      slug: 'status',
      dataType: FieldDataType.STRING,
      required: false,
      relationTargetTableId: null,
      config: null,
      createdAt: '2026-08-20T08:00:00.000Z',
      updatedAt: '2026-08-20T08:00:00.000Z',
    },
  ],
};

function catalogItem(index: number): DynamicTableCatalogItemDto {
  return {
    id: `table-${index}`,
    name: `Table ${index}`,
    slug: `table-${index}`,
    description: null,
    createdAt: '2026-08-20T08:00:00.000Z',
    updatedAt: '2026-08-20T08:00:00.000Z',
  };
}

/** A catalog of `total` tables served in pages of `pageSize`. */
function pagedCatalog(total: number, pageSize: number) {
  const items = Array.from({ length: total }, (_unused, index) =>
    catalogItem(index + 1),
  );
  return (
    query: DynamicTableCatalogQueryDto,
  ): Promise<DynamicTableCatalogPageDto> => {
    const page = query.page ?? 1;
    return Promise.resolve({
      items: items.slice((page - 1) * pageSize, page * pageSize),
      meta: { total, page, pageSize },
    });
  };
}

const emptyCatalog = () =>
  Promise.resolve({ items: [], meta: { total: 0, page: 1, pageSize: 20 } });

/** Stages a new RELATION field so the relation-target dropdown renders. */
function addRelationField() {
  fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
  const dataTypes = screen.getAllByLabelText('Data type');
  fireEvent.change(dataTypes[dataTypes.length - 1], {
    target: { value: FieldDataType.RELATION },
  });
}

describe('FieldEditor', () => {
  it('requires confirmation before sending a destructive type-change batch', async () => {
    await i18n.changeLanguage('en');
    const updateFields = vi.fn().mockResolvedValue({ jobId: 'ddl-1' });
    render(
      <FieldEditor
        table={table}
        fetchRelationTargets={emptyCatalog}
        updateFields={updateFields}
        getJob={() =>
          Promise.resolve({ jobId: 'ddl-1', status: 'completed', error: null })
        }
      />,
    );

    fireEvent.change(screen.getByLabelText('Data type'), {
      target: { value: FieldDataType.NUMBER },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save field changes' }));

    expect(updateFields).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Changing a field type can alter existing data/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));

    await waitFor(() =>
      expect(updateFields).toHaveBeenCalledWith(
        'orders',
        {
          edits: [
            {
              operation: 'modify',
              name: 'status',
              dataType: FieldDataType.NUMBER,
              required: false,
            },
          ],
        },
        expect.any(AbortSignal),
      ),
    );
  });

  it('locks the form while the type-change confirmation is pending', async () => {
    await i18n.changeLanguage('en');
    const updateFields = vi.fn().mockResolvedValue({ jobId: 'ddl-1' });
    render(
      <FieldEditor
        table={table}
        fetchRelationTargets={emptyCatalog}
        updateFields={updateFields}
        getJob={() =>
          Promise.resolve({ jobId: 'ddl-1', status: 'completed', error: null })
        }
      />,
    );

    fireEvent.change(screen.getByLabelText('Data type'), {
      target: { value: FieldDataType.NUMBER },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save field changes' }));

    // The request was snapshotted when the dialog opened, so nothing behind it
    // may still be edited into a draft the approved job would not carry.
    expect(screen.getByLabelText('Data type')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add field' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Save field changes' }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByLabelText('Data type')).toBeEnabled();
    expect(updateFields).not.toHaveBeenCalled();
  });

  it('offers relation targets from every catalog page, not just the first', async () => {
    await i18n.changeLanguage('en');
    const fetchRelationTargets = vi.fn(pagedCatalog(25, 20));
    render(
      <FieldEditor table={table} fetchRelationTargets={fetchRelationTargets} />,
    );

    await waitFor(() => expect(fetchRelationTargets).toHaveBeenCalledTimes(2));
    expect(fetchRelationTargets).toHaveBeenNthCalledWith(
      1,
      { page: 1 },
      expect.any(AbortSignal),
    );
    expect(fetchRelationTargets).toHaveBeenNthCalledWith(
      2,
      { page: 2, pageSize: 20 },
      expect.any(AbortSignal),
    );

    addRelationField();

    const select = screen.getByLabelText('Related table');
    expect(select).toBeEnabled();
    // `Table 25` only exists on the second catalog page.
    expect(
      within(select).getByRole('option', { name: 'Table 25' }),
    ).toBeInTheDocument();
    expect(within(select).getAllByRole('option')).toHaveLength(26);
  });

  it('reports a failed catalog load and retries it instead of offering an empty dropdown', async () => {
    await i18n.changeLanguage('en');
    const fetchRelationTargets = vi
      .fn()
      .mockRejectedValueOnce(new Error('catalog offline'))
      .mockImplementation(pagedCatalog(1, 20));
    render(
      <FieldEditor table={table} fetchRelationTargets={fetchRelationTargets} />,
    );

    addRelationField();

    expect(
      await screen.findByText(
        'The table list could not be loaded, so no relation target can be chosen.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Related table')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Related table')).toBeEnabled(),
    );
    expect(
      within(screen.getByLabelText('Related table')).getByRole('option', {
        name: 'Table 1',
      }),
    ).toBeInTheDocument();
  });
});
