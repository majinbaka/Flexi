import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  DYNAMIC_TABLES_ROWS_CREATE_PERMISSION,
  DYNAMIC_TABLES_ROWS_DELETE_PERMISSION,
  DYNAMIC_TABLES_ROWS_UPDATE_PERMISSION,
  FieldDataType,
  type DynamicTableDetailDto,
  type DynamicTableFieldDefinitionDto,
  type DynamicTableRowDto,
  type DynamicTableRowPageDto,
  type DynamicTableRowQueryDto,
} from '@flexi/shared-types';
import { useAuth } from '../auth/AuthContext';
import { DynamicRowForm } from '../components/dynamic-tables/DynamicRowForm';
import {
  Button,
  Card,
  PageHeader,
  Table,
  type TableColumn,
} from '../components/ui';
import {
  createDynamicTableRow,
  deleteDynamicTableRow,
  getDynamicTable,
  listDynamicTableRows,
  updateDynamicTableRow,
} from '../lib/dynamic-tables-api';

const PAGE_SIZE = 20;

type LoadState<T> =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: T };

export interface DynamicTableRowsPageProps {
  fetchTable?: (
    tableId: string,
    signal?: AbortSignal,
  ) => Promise<DynamicTableDetailDto>;
  fetchRows?: (
    tableId: string,
    query: DynamicTableRowQueryDto,
    signal?: AbortSignal,
  ) => Promise<DynamicTableRowPageDto>;
  createRow?: (
    tableId: string,
    payload: DynamicTableRowDto,
    signal?: AbortSignal,
  ) => Promise<DynamicTableRowDto>;
  deleteRow?: (
    tableId: string,
    rowId: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  updateRow?: (
    tableId: string,
    rowId: string,
    payload: DynamicTableRowDto,
    signal?: AbortSignal,
  ) => Promise<DynamicTableRowDto>;
}

function rowId(row: DynamicTableRowDto): string {
  return typeof row.id === 'string' || typeof row.id === 'number'
    ? String(row.id)
    : '';
}

function formatRelation(value: Record<string, unknown>): string {
  const id = value.id;
  const label = Object.entries(value).find(
    ([key, entry]) =>
      key !== 'id' && (typeof entry === 'string' || typeof entry === 'number'),
  )?.[1];
  return label === undefined
    ? String(id ?? '—')
    : `${String(label)} (${String(id ?? '—')})`;
}

function cellValue(
  value: unknown,
  field: DynamicTableFieldDefinitionDto,
): string {
  if (value === null || value === undefined) return '—';
  if (field.dataType === FieldDataType.JSON) return 'JSON';
  if (
    field.dataType === FieldDataType.RELATION &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return formatRelation(value as Record<string, unknown>);
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return String(value);
  return '—';
}

function rowsColumns(
  fields: readonly DynamicTableFieldDefinitionDto[],
  t: (key: string) => string,
  onView: (row: DynamicTableRowDto) => void,
  onEdit: (row: DynamicTableRowDto) => void,
  onDelete: (row: DynamicTableRowDto) => void,
  canEdit: boolean,
  canDelete: boolean,
): TableColumn<DynamicTableRowDto>[] {
  return [
    {
      id: 'id',
      header: t('dynamicTables.rows.columns.id'),
      cell: (row) => (
        <span className="font-code-sm text-code-sm">{rowId(row)}</span>
      ),
    },
    ...fields.map((field) => ({
      id: field.slug,
      header: field.name,
      cell: (row: DynamicTableRowDto) => cellValue(row[field.slug], field),
    })),
    {
      id: 'actions',
      header: t('dynamicTables.rows.columns.actions'),
      align: 'right' as const,
      cell: (row) => (
        <div className="flex justify-end gap-xs">
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onView(row);
            }}
          >
            {t('dynamicTables.rows.actions.view')}
          </Button>
          {canEdit && (
            <Button
              variant="secondary"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                onEdit(row);
              }}
            >
              {t('dynamicTables.rows.actions.edit')}
            </Button>
          )}
          {canDelete && (
            <Button
              variant="danger"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(row);
              }}
            >
              {t('dynamicTables.rows.actions.delete')}
            </Button>
          )}
        </div>
      ),
    },
  ];
}

function RowEditor({
  table,
  row,
  onCancel,
  onSaved,
  updateRow,
  fetchRelationRows,
}: {
  table: DynamicTableDetailDto;
  row: DynamicTableRowDto;
  onCancel: () => void;
  onSaved: () => void;
  updateRow: DynamicTableRowsPageProps['updateRow'];
  fetchRelationRows: NonNullable<DynamicTableRowsPageProps['fetchRows']>;
}) {
  return (
    <DynamicRowForm
      table={table}
      row={row}
      updateRow={updateRow}
      fetchRelationRows={fetchRelationRows}
      onCancel={onCancel}
      onCompleted={onSaved}
    />
  );

  /* Legacy inline editor retained temporarily while the extracted form
   * handles the live render path.
  const { t } = useTranslation();
  const [values, setValues] = useState(() => initialValues(table, row));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = rowId(row);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload: DynamicTableRowDto = {};
    try {
      for (const field of table.fields) {
        const value = values[field.slug];
        if (field.dataType === FieldDataType.BOOLEAN)
          payload[field.slug] = value === true;
        else if (field.dataType === FieldDataType.NUMBER)
          payload[field.slug] = value === '' ? null : Number(value);
        else if (field.dataType === FieldDataType.JSON)
          payload[field.slug] = value === '' ? null : JSON.parse(String(value));
        else if (field.dataType === FieldDataType.DATETIME)
          payload[field.slug] =
            value === '' ? null : new Date(String(value)).toISOString();
        else payload[field.slug] = value === '' ? null : value;
      }
    } catch {
      setError(t('dynamicTables.rows.errors.invalidJson'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateRow?.(table.id, id, payload);
      onSaved();
    } catch (requestError) {
      setError(
        t('dynamicTables.rows.errors.save', { code: errorCode(requestError) }),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <form className="flex flex-col gap-md" onSubmit={submit}>
        <div>
          <h2 className="font-heading-sm text-heading-sm text-on-surface">
            {t('dynamicTables.rows.editor.title', { id })}
          </h2>
          <p className="text-body-sm text-on-surface-variant">
            {t('dynamicTables.rows.editor.description')}
          </p>
        </div>
        <div className="grid gap-md md:grid-cols-2">
          {table.fields.map((field) => {
            const value = values[field.slug];
            const label =
              field.dataType === FieldDataType.DATETIME
                ? `${field.name} (${t('dynamicTables.rows.editor.localTime')})`
                : field.name;
            if (field.dataType === FieldDataType.BOOLEAN)
              return (
                <label
                  key={field.id}
                  className="flex items-center gap-sm text-body-sm text-on-surface"
                >
                  <input
                    type="checkbox"
                    checked={value === true}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [field.slug]: event.target.checked,
                      }))
                    }
                  />
                  {label}
                </label>
              );
            if (
              field.dataType === FieldDataType.SELECT &&
              Array.isArray(field.config?.options)
            )
              return (
                <Select
                  key={field.id}
                  label={label}
                  value={String(value)}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.slug]: event.target.value,
                    }))
                  }
                >
                  <option value="">
                    {t('dynamicTables.rows.editor.empty')}
                  </option>
                  {field.config.options
                    .filter(
                      (option): option is string | number =>
                        typeof option === 'string' ||
                        typeof option === 'number',
                    )
                    .map((option) => (
                      <option key={String(option)} value={String(option)}>
                        {String(option)}
                      </option>
                    ))}
                </Select>
              );
            if (field.dataType === FieldDataType.JSON)
              return (
                <label
                  key={field.id}
                  className="flex flex-col gap-xs text-label-caps font-label-caps uppercase tracking-wider text-on-surface-variant"
                >
                  {label}
                  <textarea
                    className="min-h-28 rounded border border-outline-variant bg-surface-container-lowest p-3 font-code-sm text-code-sm text-on-surface"
                    value={String(value)}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [field.slug]: event.target.value,
                      }))
                    }
                  />
                </label>
              );
            return (
              <Input
                key={field.id}
                label={label}
                type={
                  field.dataType === FieldDataType.NUMBER
                    ? 'number'
                    : field.dataType === FieldDataType.DATE
                      ? 'date'
                      : field.dataType === FieldDataType.DATETIME
                        ? 'datetime-local'
                        : field.dataType === FieldDataType.EMAIL
                          ? 'email'
                          : field.dataType === FieldDataType.URL
                            ? 'url'
                            : 'text'
                }
                value={String(value)}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [field.slug]: event.target.value,
                  }))
                }
              />
            );
          })}
        </div>
        {error && (
          <p role="alert" className="text-body-sm text-error">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-sm">
          <Button variant="secondary" onClick={onCancel}>
            {t('dynamicTables.rows.actions.cancel')}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving
              ? t('dynamicTables.rows.actions.saving')
              : t('dynamicTables.rows.actions.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
  */
}

/*
 * The API-backed defaults are module-level so their identity is stable across
 * renders: they are effect dependencies here and in `DynamicRowForm`, and a
 * fresh closure per render would restart those fetches on every commit.
 */
function defaultFetchTable(
  tableId: string,
  signal?: AbortSignal,
): Promise<DynamicTableDetailDto> {
  return getDynamicTable(tableId, { signal });
}

function defaultFetchRows(
  tableId: string,
  query: DynamicTableRowQueryDto,
  signal?: AbortSignal,
): Promise<DynamicTableRowPageDto> {
  return listDynamicTableRows(tableId, query, { signal });
}

function defaultDeleteRow(
  tableId: string,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  return deleteDynamicTableRow(tableId, id, { signal });
}

function defaultCreateRow(
  tableId: string,
  payload: DynamicTableRowDto,
  signal?: AbortSignal,
): Promise<DynamicTableRowDto> {
  return createDynamicTableRow(tableId, payload, { signal });
}

function defaultUpdateRow(
  tableId: string,
  id: string,
  payload: DynamicTableRowDto,
  signal?: AbortSignal,
): Promise<DynamicTableRowDto> {
  return updateDynamicTableRow(tableId, id, payload, { signal });
}

export function DynamicTableRowsPage({
  fetchTable = defaultFetchTable,
  fetchRows = defaultFetchRows,
  deleteRow = defaultDeleteRow,
  createRow = defaultCreateRow,
  updateRow = defaultUpdateRow,
}: DynamicTableRowsPageProps = {}) {
  const { tableId = '' } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [tableState, setTableState] = useState<
    LoadState<DynamicTableDetailDto>
  >({ status: 'loading' });
  const [rowsState, setRowsState] = useState<LoadState<DynamicTableRowPageDto>>(
    { status: 'loading' },
  );
  const [selected, setSelected] = useState<DynamicTableRowDto | null>(null);
  const [editing, setEditing] = useState<DynamicTableRowDto | null>(null);
  const [creating, setCreating] = useState(false);
  const rowsRequest = useRef(0);
  const canEdit = Boolean(
    currentUser?.permissions.includes(DYNAMIC_TABLES_ROWS_UPDATE_PERMISSION),
  );
  const canCreate = Boolean(
    currentUser?.permissions.includes(DYNAMIC_TABLES_ROWS_CREATE_PERMISSION),
  );
  const canDelete = Boolean(
    currentUser?.permissions.includes(DYNAMIC_TABLES_ROWS_DELETE_PERMISSION),
  );
  useEffect(() => {
    const controller = new AbortController();
    Promise.resolve().then(() => {
      if (!controller.signal.aborted) setTableState({ status: 'loading' });
    });
    fetchTable(tableId, controller.signal)
      .then(
        (value) =>
          !controller.signal.aborted &&
          setTableState({ status: 'ready', value }),
      )
      .catch(
        () => !controller.signal.aborted && setTableState({ status: 'error' }),
      );
    return () => controller.abort();
  }, [fetchTable, tableId]);
  useEffect(() => {
    const id = rowsRequest.current + 1;
    rowsRequest.current = id;
    const controller = new AbortController();
    Promise.resolve().then(() => {
      if (!controller.signal.aborted) setRowsState({ status: 'loading' });
    });
    fetchRows(tableId, { page, pageSize: PAGE_SIZE }, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && rowsRequest.current === id)
          setRowsState({ status: 'ready', value });
      })
      .catch(() => {
        if (!controller.signal.aborted && rowsRequest.current === id)
          setRowsState({ status: 'error' });
      });
    return () => controller.abort();
  }, [fetchRows, page, refresh, tableId]);
  const remove = useCallback(
    async (row: DynamicTableRowDto) => {
      const id = rowId(row);
      if (
        !id ||
        !window.confirm(t('dynamicTables.rows.deleteConfirmation', { id }))
      )
        return;
      try {
        await deleteRow(tableId, id);
        setSelected(null);
        setRefresh((value) => value + 1);
      } catch {
        setRowsState({ status: 'error' });
      }
    },
    [deleteRow, t, tableId],
  );
  const table = tableState.status === 'ready' ? tableState.value : null;
  const rowPage = rowsState.status === 'ready' ? rowsState.value : null;
  const columns = useMemo(
    () =>
      rowsColumns(
        table?.fields ?? [],
        t,
        setSelected,
        setEditing,
        remove,
        canEdit,
        canDelete,
      ),
    [canDelete, canEdit, remove, table?.fields, t],
  );
  const totalPages = Math.max(
    1,
    Math.ceil(
      (rowPage?.meta.total ?? 0) / (rowPage?.meta.pageSize ?? PAGE_SIZE),
    ),
  );
  return (
    <>
      <PageHeader
        title={
          table
            ? t('dynamicTables.rows.title', { table: table.name })
            : t('dynamicTables.rows.loadingTitle')
        }
        description={t('dynamicTables.rows.description')}
        actions={
          <div className="flex gap-sm">
            <Button
              variant="secondary"
              onClick={() => navigate('/dynamic-tables')}
            >
              {t('dynamicTables.rows.actions.back')}
            </Button>
            {canCreate && (
              <Button
                onClick={() => {
                  setCreating(true);
                  setEditing(null);
                  setSelected(null);
                }}
              >
                {t('dynamicTables.rows.actions.create')}
              </Button>
            )}
          </div>
        }
      />
      {tableState.status === 'error' ? (
        <Card role="alert">
          <p>{t('dynamicTables.rows.tableLoadError')}</p>
        </Card>
      ) : tableState.status === 'loading' ? (
        <Card role="status">{t('dynamicTables.rows.loading')}</Card>
      ) : (
        <>
          {creating && tableState.status === 'ready' && (
            <DynamicRowForm
              key={`create-${tableState.value.id}`}
              table={tableState.value}
              createRow={createRow}
              fetchRelationRows={fetchRows}
              onCancel={() => setCreating(false)}
              onCompleted={() => {
                setCreating(false);
                setRefresh((value) => value + 1);
              }}
            />
          )}
          {editing && tableState.status === 'ready' && (
            <RowEditor
              key={`edit-${rowId(editing)}`}
              table={tableState.value}
              row={editing}
              updateRow={updateRow}
              fetchRelationRows={fetchRows}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                setRefresh((value) => value + 1);
              }}
            />
          )}
          {selected && tableState.status === 'ready' && (
            <Card className="flex flex-col gap-md">
              <div className="flex items-center justify-between">
                <h2 className="font-heading-sm text-heading-sm text-on-surface">
                  {t('dynamicTables.rows.detail.title', {
                    id: rowId(selected),
                  })}
                </h2>
                <Button variant="ghost" onClick={() => setSelected(null)}>
                  {t('dynamicTables.rows.actions.close')}
                </Button>
              </div>
              <dl className="grid gap-sm md:grid-cols-2">
                {tableState.value.fields.map((field) => (
                  <div key={field.id}>
                    <dt className="text-label-caps font-label-caps uppercase text-on-surface-variant">
                      {field.name}
                    </dt>
                    <dd className="text-body-sm text-on-surface">
                      {cellValue(selected[field.slug], field)}
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}
          {rowsState.status === 'error' ? (
            <Card role="alert" className="flex flex-col items-start gap-md">
              <p>{t('dynamicTables.rows.loadError')}</p>
              <Button onClick={() => setRefresh((value) => value + 1)}>
                {t('dynamicTables.actions.retry')}
              </Button>
            </Card>
          ) : (
            <Table
              columns={columns}
              rows={rowPage?.items ?? []}
              rowKey={rowId}
              onRowClick={setSelected}
              emptyMessage={t('dynamicTables.rows.empty')}
              isLoading={rowsState.status === 'loading'}
            />
          )}
          {rowPage && rowPage.meta.total > 0 && (
            <nav
              className="flex items-center justify-between gap-sm"
              aria-label={t('dynamicTables.rows.pagination.label')}
            >
              <p className="text-body-sm text-on-surface-variant">
                {t('dynamicTables.rows.pagination.pageOfTotal', {
                  page: rowPage.meta.page,
                  totalPages,
                })}
              </p>
              <div className="flex gap-sm">
                <Button
                  variant="secondary"
                  disabled={rowPage.meta.page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  {t('dynamicTables.rows.pagination.previous')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={rowPage.meta.page >= totalPages}
                  onClick={() =>
                    setPage((value) => Math.min(totalPages, value + 1))
                  }
                >
                  {t('dynamicTables.rows.pagination.next')}
                </Button>
              </div>
            </nav>
          )}
        </>
      )}
    </>
  );
}
