import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FieldDataType, type DynamicTableDetailDto } from '@flexi/shared-types';
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

describe('FieldEditor', () => {
  it('requires confirmation before sending a destructive type-change batch', async () => {
    await i18n.changeLanguage('en');
    const updateFields = vi.fn().mockResolvedValue({ jobId: 'ddl-1' });
    render(
      <FieldEditor
        table={table}
        relationTargets={[]}
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
});
