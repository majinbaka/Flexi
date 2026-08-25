import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FieldDataType } from '@flexi/shared-types';
import i18n from '../../i18n';
import { TableBuilderForm } from './TableBuilderForm';

describe('TableBuilderForm', () => {
  it('does not allow RELATION while creating an initial table schema', async () => {
    await i18n.changeLanguage('en');
    render(<TableBuilderForm />);

    const dataType = screen.getByLabelText('Data type') as HTMLSelectElement;
    expect(
      Array.from(dataType.options, (option) => option.value),
    ).not.toContain(FieldDataType.RELATION);
  });

  it('validates required metadata and JSON config before enqueuing a job', async () => {
    await i18n.changeLanguage('en');
    const createTable = vi.fn();
    render(<TableBuilderForm createTable={createTable} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create table' }));

    expect(await screen.findByText('Enter a table name.')).toBeInTheDocument();
    expect(await screen.findByText('Enter a field name.')).toBeInTheDocument();
    expect(createTable).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Table name'), {
      target: { value: 'Orders' },
    });
    fireEvent.change(screen.getByLabelText('Field name'), {
      target: { value: 'status' },
    });
    fireEvent.change(screen.getByLabelText('Validation config (JSON)'), {
      target: { value: 'not-json' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create table' }));

    expect(
      await screen.findByText('Config must be a JSON object.'),
    ).toBeInTheDocument();
    expect(createTable).not.toHaveBeenCalled();
  });

  it('polls a queued job to completion and returns the catalog to its caller', async () => {
    await i18n.changeLanguage('en');
    const createTable = vi.fn().mockResolvedValue({ jobId: 'ddl-1' });
    const getJob = vi
      .fn()
      .mockResolvedValueOnce({
        jobId: 'ddl-1',
        status: 'pending',
        error: null,
      })
      .mockResolvedValueOnce({
        jobId: 'ddl-1',
        status: 'completed',
        error: null,
      });
    const onCompleted = vi.fn();
    render(
      <TableBuilderForm
        createTable={createTable}
        getJob={getJob}
        onCompleted={onCompleted}
        pollIntervalMs={0}
      />,
    );

    fireEvent.change(screen.getByLabelText('Table name'), {
      target: { value: 'Orders' },
    });
    fireEvent.change(screen.getByLabelText('Field name'), {
      target: { value: 'status' },
    });
    fireEvent.change(screen.getByLabelText('Validation config (JSON)'), {
      target: { value: '{"minLength": 1}' },
    });
    fireEvent.change(screen.getByLabelText('Data type'), {
      target: { value: FieldDataType.SELECT },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create table' }));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());
    expect(createTable).toHaveBeenCalledWith(
      {
        name: 'Orders',
        fields: [
          {
            name: 'status',
            dataType: FieldDataType.SELECT,
            config: { minLength: 1 },
          },
        ],
      },
      expect.any(AbortSignal),
    );
    expect(getJob).toHaveBeenCalledTimes(2);
  });
});
