import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FieldDataType,
  type DynamicTableDetailDto,
  type DynamicTableRowDto,
  type DynamicTableRowPageDto,
  type DynamicTableRowQueryDto,
} from '@flexi/shared-types';
import { Button, Card, Input, Select } from '../ui';
import {
  createDynamicTableRow,
  listDynamicTableRows,
  updateDynamicTableRow,
} from '../../lib/dynamic-tables-api';
import { ApiError } from '../../lib/api-client';

/**
 * Upper bound on row pages walked per relation target. It bounds the request
 * fan-out for a large target table; the dropdown says so when it truncates
 * instead of silently dropping rows.
 */
const MAX_RELATION_ROW_PAGES = 10;

type FieldValue = string | boolean;
type FieldErrors = Record<string, string>;

/** Rows offered for one relation target, plus whether the walk was cut off. */
interface RelationOptions {
  items: DynamicTableRowDto[];
  truncated: boolean;
}

export type FetchRelationRows = (
  tableId: string,
  query: DynamicTableRowQueryDto,
  signal?: AbortSignal,
) => Promise<DynamicTableRowPageDto>;

export interface DynamicRowFormProps {
  table: DynamicTableDetailDto;
  /** Omit `row` to create a record; pass one to edit it. */
  row?: DynamicTableRowDto;
  createRow?: (
    tableId: string,
    payload: DynamicTableRowDto,
    signal?: AbortSignal,
  ) => Promise<DynamicTableRowDto>;
  updateRow?: (
    tableId: string,
    rowId: string,
    payload: DynamicTableRowDto,
    signal?: AbortSignal,
  ) => Promise<DynamicTableRowDto>;
  /**
   * Loads one page of a relation target's rows. The form walks every page
   * itself, so a target table larger than one page still offers all of its
   * rows as options.
   */
  fetchRelationRows?: FetchRelationRows;
  onCompleted?: (row: DynamicTableRowDto) => void;
  onCancel?: () => void;
}

function idOf(row: DynamicTableRowDto): string {
  return typeof row.id === 'string' || typeof row.id === 'number'
    ? String(row.id)
    : '';
}

function initialValues(
  table: DynamicTableDetailDto,
  row?: DynamicTableRowDto,
): Record<string, FieldValue> {
  return Object.fromEntries(
    table.fields.map((field) => {
      const value = row?.[field.slug];
      if (field.dataType === FieldDataType.BOOLEAN) {
        return [field.slug, value === true];
      }
      if (field.dataType === FieldDataType.JSON) {
        return [
          field.slug,
          value === null || value === undefined
            ? ''
            : JSON.stringify(value, null, 2),
        ];
      }
      if (field.dataType === FieldDataType.DATE && typeof value === 'string') {
        return [field.slug, value.slice(0, 10)];
      }
      if (
        field.dataType === FieldDataType.DATETIME &&
        typeof value === 'string'
      ) {
        const date = new Date(value);
        if (!Number.isNaN(date.valueOf())) {
          const local = new Date(
            date.getTime() - date.getTimezoneOffset() * 60_000,
          );
          return [field.slug, local.toISOString().slice(0, 16)];
        }
      }
      if (
        field.dataType === FieldDataType.RELATION &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        return [
          field.slug,
          String((value as Record<string, unknown>).id ?? ''),
        ];
      }
      return [
        field.slug,
        value === null || value === undefined ? '' : String(value),
      ];
    }),
  );
}

function relationLabel(row: DynamicTableRowDto): string {
  const id = idOf(row);
  const label = Object.entries(row).find(
    ([key, value]) =>
      key !== 'id' && (typeof value === 'string' || typeof value === 'number'),
  )?.[1];
  return label === undefined ? id : `${String(label)} (${id})`;
}

function stringOptions(config: Record<string, unknown> | null): string[] {
  const source = config?.enum ?? config?.options;
  return Array.isArray(source)
    ? source.filter((value): value is string => typeof value === 'string')
    : [];
}

function configNumber(
  config: Record<string, unknown> | null,
  key: 'min' | 'max',
): number | undefined {
  const value = config?.[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function serverErrors(error: unknown, fields: readonly string[]): FieldErrors {
  if (!(error instanceof ApiError)) return {};
  return fields.reduce<FieldErrors>((result, slug) => {
    const match = error.message.match(
      new RegExp(
        `(?:^|,\\s*)${slug.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}:\\s*([^,]+)`,
      ),
    );
    if (match?.[1]) result[slug] = match[1];
    return result;
  }, {});
}

function errorCode(error: unknown): string {
  return error instanceof ApiError && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : 'REQUEST_FAILED';
}

function defaultFetchRelationRows(
  tableId: string,
  query: DynamicTableRowQueryDto,
  signal?: AbortSignal,
): Promise<DynamicTableRowPageDto> {
  return listDynamicTableRows(tableId, query, { signal });
}

/**
 * Reads every row of one relation target. As with the table catalog, the
 * first request omits `pageSize` so the server applies its own guardrail, and
 * the size it reports back is reused for the remaining pages.
 */
async function loadRelationRows(
  fetchPage: FetchRelationRows,
  tableId: string,
  signal: AbortSignal,
): Promise<RelationOptions> {
  const first = await fetchPage(tableId, { page: 1 }, signal);
  const pageSize = first.meta.pageSize;
  const totalPages = pageSize > 0 ? Math.ceil(first.meta.total / pageSize) : 1;
  const lastPage = Math.min(Math.max(totalPages, 1), MAX_RELATION_ROW_PAGES);
  const rest = await Promise.all(
    Array.from({ length: lastPage - 1 }, (_unused, index) =>
      fetchPage(tableId, { page: index + 2, pageSize }, signal),
    ),
  );

  return {
    items: [first, ...rest].flatMap((page) => page.items),
    truncated: totalPages > lastPage,
  };
}

/**
 * Builds a safe row-mutation payload from table metadata. Values never use
 * field labels as keys, so a stale or injected form control cannot be sent.
 */
export function DynamicRowForm({
  table,
  row,
  createRow = (tableId, payload, signal) =>
    createDynamicTableRow(tableId, payload, { signal }),
  updateRow = (tableId, rowId, payload, signal) =>
    updateDynamicTableRow(tableId, rowId, payload, { signal }),
  fetchRelationRows = defaultFetchRelationRows,
  onCompleted,
  onCancel,
}: DynamicRowFormProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState(() => initialValues(table, row));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [relationRows, setRelationRows] = useState<
    Record<string, RelationOptions>
  >({});
  const [relationLoadFailed, setRelationLoadFailed] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const isEditing = row !== undefined;
  const rowId = row ? idOf(row) : '';

  useEffect(() => {
    const targets = [
      ...new Set(
        table.fields
          .filter((field) => field.dataType === FieldDataType.RELATION)
          .map((field) => field.relationTargetTableId)
          .filter((target): target is string => target !== null),
      ),
    ];
    if (targets.length === 0) {
      return;
    }

    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    Promise.all(
      targets.map((target) =>
        loadRelationRows(fetchRelationRows, target, controller.signal),
      ),
    )
      .then((options) => {
        if (controller.signal.aborted) return;
        setRelationLoadFailed(false);
        setRelationRows(
          Object.fromEntries(
            targets.map((target, index) => [target, options[index]]),
          ),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setRelationLoadFailed(true);
      });
    return () => controller.abort();
  }, [fetchRelationRows, table.fields]);

  const setValue = (slug: string, value: FieldValue) => {
    setValues((current) => ({ ...current, [slug]: value }));
    setErrors((current) => {
      const remaining = { ...current };
      delete remaining[slug];
      return remaining;
    });
  };

  const buildPayload = (): DynamicTableRowDto | null => {
    const nextErrors: FieldErrors = {};
    const payload: DynamicTableRowDto = {};

    for (const field of table.fields) {
      const value = values[field.slug];
      const isEmpty = value === '' || value === undefined || value === null;
      if (field.required && isEmpty) {
        nextErrors[field.slug] = t('dynamicTables.rows.form.errors.required');
        continue;
      }
      if (field.dataType === FieldDataType.BOOLEAN) {
        payload[field.slug] = value === true;
        continue;
      }
      if (isEmpty) {
        payload[field.slug] = null;
        continue;
      }

      const text = String(value);
      if (field.dataType === FieldDataType.NUMBER) {
        const number = Number(text);
        const min = configNumber(field.config, 'min');
        const max = configNumber(field.config, 'max');
        if (!Number.isFinite(number))
          nextErrors[field.slug] = t('dynamicTables.rows.form.errors.number');
        else if (min !== undefined && number < min)
          nextErrors[field.slug] = t('dynamicTables.rows.form.errors.min', {
            min,
          });
        else if (max !== undefined && number > max)
          nextErrors[field.slug] = t('dynamicTables.rows.form.errors.max', {
            max,
          });
        else payload[field.slug] = number;
        continue;
      }
      if (field.dataType === FieldDataType.JSON) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed === null || typeof parsed !== 'object')
            throw new Error('not an object');
          payload[field.slug] = parsed;
        } catch {
          nextErrors[field.slug] = t('dynamicTables.rows.form.errors.json');
        }
        continue;
      }
      if (field.dataType === FieldDataType.RELATION) {
        const id = Number(text);
        if (!Number.isInteger(id))
          nextErrors[field.slug] = t('dynamicTables.rows.form.errors.relation');
        else payload[field.slug] = id;
        continue;
      }
      if (field.dataType === FieldDataType.DATETIME) {
        const date = new Date(text);
        if (Number.isNaN(date.valueOf()))
          nextErrors[field.slug] = t('dynamicTables.rows.form.errors.dateTime');
        else payload[field.slug] = date.toISOString();
        continue;
      }
      if (
        field.dataType === FieldDataType.DATE &&
        Number.isNaN(Date.parse(text))
      ) {
        nextErrors[field.slug] = t('dynamicTables.rows.form.errors.date');
        continue;
      }
      const options = stringOptions(field.config);
      if (options.length > 0 && !options.includes(text)) {
        nextErrors[field.slug] = t('dynamicTables.rows.form.errors.enum');
        continue;
      }
      payload[field.slug] = text;
    }
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0 ? payload : null;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || (isEditing && !rowId)) return;
    const payload = buildPayload();
    if (!payload) return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setSaving(true);
    setSubmissionError(null);
    try {
      const saved = isEditing
        ? await updateRow(table.id, rowId, payload, controller.signal)
        : await createRow(table.id, payload, controller.signal);
      if (!controller.signal.aborted) onCompleted?.(saved);
    } catch (error) {
      if (!controller.signal.aborted) {
        const mapped = serverErrors(
          error,
          table.fields.map((field) => field.slug),
        );
        setErrors(mapped);
        setSubmissionError(
          t('dynamicTables.rows.form.errors.save', { code: errorCode(error) }),
        );
      }
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  };

  return (
    <Card>
      <form className="flex flex-col gap-md" onSubmit={submit} noValidate>
        <div>
          <h2 className="font-heading-sm text-heading-sm text-on-surface">
            {isEditing
              ? t('dynamicTables.rows.form.editTitle', { id: rowId })
              : t('dynamicTables.rows.form.createTitle')}
          </h2>
          <p className="text-body-sm text-on-surface-variant">
            {t('dynamicTables.rows.form.description')}
          </p>
        </div>
        <div className="grid gap-md md:grid-cols-2">
          {table.fields.map((field) => {
            const value = values[field.slug];
            const label = field.required ? `${field.name} *` : field.name;
            const options = stringOptions(field.config);
            if (field.dataType === FieldDataType.BOOLEAN)
              return (
                <label
                  key={field.id}
                  className="flex items-center gap-sm text-body-sm text-on-surface"
                >
                  <input
                    type="checkbox"
                    checked={value === true}
                    disabled={saving}
                    onChange={(event) =>
                      setValue(field.slug, event.target.checked)
                    }
                  />
                  {label}
                </label>
              );
            if (field.dataType === FieldDataType.RELATION) {
              const targetId = field.relationTargetTableId;
              const options = targetId ? relationRows[targetId] : undefined;
              const rows = options?.items ?? [];
              return (
                <div className="grid gap-xs" key={field.id}>
                  <Select
                    label={label}
                    value={String(value)}
                    disabled={saving || relationLoadFailed}
                    error={errors[field.slug]}
                    onChange={(event) =>
                      setValue(field.slug, event.target.value)
                    }
                  >
                    <option value="">
                      {t('dynamicTables.rows.form.empty')}
                    </option>
                    {rows.map((relation) => (
                      <option key={idOf(relation)} value={idOf(relation)}>
                        {relationLabel(relation)}
                      </option>
                    ))}
                  </Select>
                  {options?.truncated && (
                    <p
                      role="status"
                      className="text-body-sm text-on-surface-variant"
                    >
                      {t('dynamicTables.rows.form.relationTruncated', {
                        count: rows.length,
                      })}
                    </p>
                  )}
                </div>
              );
            }
            if (field.dataType === FieldDataType.SELECT && options.length > 0)
              return (
                <Select
                  key={field.id}
                  label={label}
                  value={String(value)}
                  disabled={saving}
                  error={errors[field.slug]}
                  onChange={(event) => setValue(field.slug, event.target.value)}
                >
                  <option value="">{t('dynamicTables.rows.form.empty')}</option>
                  {options.map((option) => (
                    <option key={option} value={option}>
                      {option}
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
                    disabled={saving}
                    aria-label={label}
                    aria-invalid={errors[field.slug] ? true : undefined}
                    onChange={(event) =>
                      setValue(field.slug, event.target.value)
                    }
                  />
                  {errors[field.slug] && (
                    <span className="text-body-sm normal-case text-error">
                      {errors[field.slug]}
                    </span>
                  )}
                </label>
              );
            return (
              <Input
                key={field.id}
                label={
                  field.dataType === FieldDataType.DATETIME
                    ? `${label} (${t('dynamicTables.rows.form.localTime')})`
                    : label
                }
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
                disabled={saving}
                error={errors[field.slug]}
                onChange={(event) => setValue(field.slug, event.target.value)}
              />
            );
          })}
        </div>
        {relationLoadFailed && (
          <p role="alert" className="text-body-sm text-error">
            {t('dynamicTables.rows.form.errors.relationLoad')}
          </p>
        )}
        {submissionError && (
          <p role="alert" className="text-body-sm text-error">
            {submissionError}
          </p>
        )}
        <div className="flex justify-end gap-sm">
          {onCancel && (
            <Button variant="secondary" onClick={onCancel} disabled={saving}>
              {t('dynamicTables.rows.actions.cancel')}
            </Button>
          )}
          <Button type="submit" disabled={saving}>
            {saving
              ? t('dynamicTables.rows.actions.saving')
              : isEditing
                ? t('dynamicTables.rows.actions.save')
                : t('dynamicTables.rows.actions.create')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
