import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FieldDataType,
  type DynamicTableCatalogItemDto,
  type DynamicTableCatalogPageDto,
  type DynamicTableCatalogQueryDto,
  type DynamicTableDdlJobAcceptedDto,
  type DynamicTableDdlJobDto,
  type DynamicTableDetailDto,
} from '@flexi/shared-types';
import { Button, Card, Input, Select } from '../ui';
import {
  getDynamicTableJob,
  listDynamicTables,
  updateDynamicTableFields,
  type DynamicTableFieldEditRequest,
  type UpdateDynamicTableFieldsRequest,
} from '../../lib/dynamic-tables-api';
import { ApiError } from '../../lib/api-client';

const NON_RELATION_FIELD_TYPES = Object.values(FieldDataType).filter(
  (dataType) => dataType !== FieldDataType.RELATION,
);
const MAX_POLL_ATTEMPTS = 30;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_JOB_ERROR_LENGTH = 300;
/**
 * Upper bound on catalog pages walked to build the relation-target list. It
 * exists so a tenant with an unexpectedly large catalog cannot turn opening
 * this editor into an unbounded request fan-out; the dropdown says so when it
 * truncates instead of silently dropping tables.
 */
const MAX_RELATION_TARGET_PAGES = 25;

interface ExistingFieldDraft {
  id: string;
  name: string;
  dataType: FieldDataType;
  required: boolean;
  config: string;
  relationTargetTableId: string | null;
  removed: boolean;
}

interface NewFieldDraft {
  id: number;
  name: string;
  dataType: FieldDataType;
  required: boolean;
  config: string;
  relatedTableId: string;
}

type FormErrors = Record<string, string>;

type SubmissionState =
  | { status: 'idle' }
  | { status: 'confirming'; request: UpdateDynamicTableFieldsRequest }
  | { status: 'submitting' }
  | { status: 'polling'; jobId: string; attempt: number }
  /**
   * `detail` carries the failure reason the backend recorded on the DDL job.
   * Only the code is guaranteed: a request that never reached a job, or a job
   * that failed without a message, leaves it undefined.
   */
  | { status: 'error'; code: string; detail?: string };

/** Catalog entries a RELATION field may point at, loaded by this editor. */
type RelationTargetsState =
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'ready';
      items: readonly DynamicTableCatalogItemDto[];
      truncated: boolean;
    };

export type FetchRelationTargets = (
  query: DynamicTableCatalogQueryDto,
  signal?: AbortSignal,
) => Promise<DynamicTableCatalogPageDto>;

export interface FieldEditorProps {
  table: DynamicTableDetailDto;
  /**
   * Loads one catalog page. The editor walks every page itself: reusing the
   * caller's current catalog page would offer only the tables that happen to
   * be on screen as relation targets.
   */
  fetchRelationTargets?: FetchRelationTargets;
  readOnly?: boolean;
  updateFields?: (
    tableId: string,
    request: UpdateDynamicTableFieldsRequest,
    signal?: AbortSignal,
  ) => Promise<DynamicTableDdlJobAcceptedDto>;
  getJob?: (
    jobId: string,
    signal?: AbortSignal,
  ) => Promise<DynamicTableDdlJobDto>;
  onCompleted?: () => void;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

function fieldConfig(config: Record<string, unknown> | null): string {
  return config ? JSON.stringify(config) : '';
}

function createExistingDrafts(
  table: DynamicTableDetailDto,
): ExistingFieldDraft[] {
  return table.fields.map((field) => ({
    id: field.id,
    name: field.name,
    dataType: field.dataType,
    required: field.required,
    config: fieldConfig(field.config),
    relationTargetTableId: field.relationTargetTableId,
    removed: false,
  }));
}

function newField(id: number): NewFieldDraft {
  return {
    id,
    name: '',
    dataType: FieldDataType.STRING,
    required: false,
    config: '',
    relatedTableId: '',
  };
}

function errorCode(error: unknown): string {
  return error instanceof ApiError && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : 'REQUEST_FAILED';
}

/**
 * The reason a DDL job recorded for its failure, ready to render. It is a raw
 * driver/worker message rather than a curated string, so it is collapsed to a
 * single line and capped -- a multi-line Postgres error would otherwise push
 * the form off screen.
 */
function jobErrorDetail(error: string | null): string | undefined {
  const detail = (error ?? '').replace(/\s+/g, ' ').trim();
  if (!detail) return undefined;
  return detail.length > MAX_JOB_ERROR_LENGTH
    ? `${detail.slice(0, MAX_JOB_ERROR_LENGTH).trimEnd()}…`
    : detail;
}

function parseConfig(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('invalid config');
  }
  return parsed as Record<string, unknown>;
}

function defaultFetchRelationTargets(
  query: DynamicTableCatalogQueryDto,
  signal?: AbortSignal,
): Promise<DynamicTableCatalogPageDto> {
  return listDynamicTables(query, { signal });
}

/**
 * Reads the whole tenant catalog so every table is offered as a relation
 * target. The first request deliberately omits `pageSize`: the catalog
 * rejects any page size above a server-configured guardrail, so the size the
 * server reports back is the only one guaranteed to be accepted for the
 * remaining pages.
 */
async function loadRelationTargets(
  fetchPage: FetchRelationTargets,
  signal: AbortSignal,
): Promise<Extract<RelationTargetsState, { status: 'ready' }>> {
  const first = await fetchPage({ page: 1 }, signal);
  const pageSize = first.meta.pageSize;
  const totalPages = pageSize > 0 ? Math.ceil(first.meta.total / pageSize) : 1;
  const lastPage = Math.min(Math.max(totalPages, 1), MAX_RELATION_TARGET_PAGES);
  const rest = await Promise.all(
    Array.from({ length: lastPage - 1 }, (_unused, index) =>
      fetchPage({ page: index + 2, pageSize }, signal),
    ),
  );

  return {
    status: 'ready',
    items: [first, ...rest].flatMap((page) => page.items),
    truncated: totalPages > lastPage,
  };
}

/**
 * Stages a field-edit batch against a table detail response. Draft values are
 * intentionally local: field metadata is not updated optimistically and is
 * refreshed by the owner only after the asynchronous DDL job completes.
 */
export function FieldEditor({
  table,
  fetchRelationTargets = defaultFetchRelationTargets,
  readOnly = false,
  updateFields = (tableId, request, signal) =>
    updateDynamicTableFields(tableId, request, { signal }),
  getJob = (jobId, signal) => getDynamicTableJob(jobId, { signal }),
  onCompleted,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPollAttempts = MAX_POLL_ATTEMPTS,
}: FieldEditorProps) {
  const { t } = useTranslation();
  const [existingFields, setExistingFields] = useState<ExistingFieldDraft[]>(
    () => createExistingDrafts(table),
  );
  const [newFields, setNewFields] = useState<NewFieldDraft[]>([]);
  const [nextFieldId, setNextFieldId] = useState(1);
  const [errors, setErrors] = useState<FormErrors>({});
  const [removeCandidate, setRemoveCandidate] = useState<string | null>(null);
  const [submission, setSubmission] = useState<SubmissionState>({
    status: 'idle',
  });
  const [relationTargets, setRelationTargets] = useState<RelationTargetsState>({
    status: 'loading',
  });
  const [relationTargetsReloadKey, setRelationTargetsReloadKey] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  // A draft batch belongs to exactly one `table` response, so a new one --
  // a different table, or the same table refetched once its DDL job settled
  // -- invalidates it. Resetting while rendering rather than from an effect
  // drops the stale drafts before they are ever committed, so React does not
  // paint them and immediately re-render (react-hooks/set-state-in-effect).
  // See https://react.dev/reference/react/useState#storing-information-from-previous-renders.
  const [draftedTable, setDraftedTable] = useState(table);
  if (draftedTable !== table) {
    setDraftedTable(table);
    setExistingFields(createExistingDrafts(table));
    setNewFields([]);
    setErrors({});
    setRemoveCandidate(null);
    setSubmission({ status: 'idle' });
  }

  useEffect(
    () => () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  // The catalog is read once per editor, not per relation draft: the option
  // list is the same for every RELATION field being added here. `loading` is
  // the initial state and is re-armed by the retry handler, so this effect
  // never has to announce work it is about to start
  // (react-hooks/set-state-in-effect).
  useEffect(() => {
    const controller = new AbortController();
    loadRelationTargets(fetchRelationTargets, controller.signal)
      .then((state) => {
        if (!controller.signal.aborted) setRelationTargets(state);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRelationTargets({ status: 'error' });
      });
    return () => controller.abort();
  }, [fetchRelationTargets, relationTargetsReloadKey]);

  const reloadRelationTargets = () => {
    setRelationTargets({ status: 'loading' });
    setRelationTargetsReloadKey((current) => current + 1);
  };

  const originalFields = useMemo(
    () => new Map(table.fields.map((field) => [field.id, field])),
    [table.fields],
  );
  const isBusy =
    submission.status === 'submitting' || submission.status === 'polling';
  // The request handed to the confirmation dialog is a snapshot of the drafts
  // taken at submit time, so the form has to stop accepting edits until the
  // dialog is answered -- otherwise later edits are silently dropped from the
  // DDL job the user ends up approving.
  const isLocked = isBusy || submission.status === 'confirming';

  const updateExisting = (id: string, changes: Partial<ExistingFieldDraft>) => {
    setExistingFields((current) =>
      current.map((field) =>
        field.id === id ? { ...field, ...changes } : field,
      ),
    );
  };
  const updateNew = (id: number, changes: Partial<NewFieldDraft>) => {
    setNewFields((current) =>
      current.map((field) =>
        field.id === id ? { ...field, ...changes } : field,
      ),
    );
  };

  const buildRequest = (): UpdateDynamicTableFieldsRequest | null => {
    const nextErrors: FormErrors = {};
    const edits: DynamicTableFieldEditRequest[] = [];
    const allNames = new Set<string>();

    for (const field of existingFields) {
      const original = originalFields.get(field.id);
      if (!original) continue;
      if (field.removed) {
        edits.push({ operation: 'remove', name: original.name });
        continue;
      }
      allNames.add(original.name.toLowerCase());
      if (original.dataType === FieldDataType.RELATION) continue;

      let config: Record<string, unknown> | undefined;
      try {
        config = parseConfig(field.config);
      } catch {
        nextErrors[`existing-${field.id}-config`] = t(
          'dynamicTables.fieldEditor.errors.config',
        );
      }
      if (
        original.dataType !== field.dataType ||
        original.required !== field.required ||
        fieldConfig(original.config) !== field.config
      ) {
        edits.push({
          operation: 'modify',
          name: original.name,
          dataType: field.dataType,
          required: field.required,
          ...(config ? { config } : {}),
        });
      }
    }

    for (const field of newFields) {
      const name = field.name.trim();
      if (!name) {
        nextErrors[`new-${field.id}-name`] = t(
          'dynamicTables.fieldEditor.errors.fieldName',
        );
      } else if (allNames.has(name.toLowerCase())) {
        nextErrors[`new-${field.id}-name`] = t(
          'dynamicTables.fieldEditor.errors.duplicateField',
        );
      } else {
        allNames.add(name.toLowerCase());
      }
      let config: Record<string, unknown> | undefined;
      try {
        config = parseConfig(field.config);
      } catch {
        nextErrors[`new-${field.id}-config`] = t(
          'dynamicTables.fieldEditor.errors.config',
        );
      }
      if (field.dataType === FieldDataType.RELATION && !field.relatedTableId) {
        nextErrors[`new-${field.id}-relation`] = t(
          'dynamicTables.fieldEditor.errors.relationTarget',
        );
      }
      edits.push({
        operation: 'add',
        name,
        dataType: field.dataType,
        required: field.required,
        ...(config ? { config } : {}),
        ...(field.dataType === FieldDataType.RELATION
          ? { relatedTableId: field.relatedTableId }
          : {}),
      });
    }

    if (edits.length === 0) {
      nextErrors.form = t('dynamicTables.fieldEditor.errors.noChanges');
    }
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0 ? { edits } : null;
  };

  const pollJob = async (jobId: string, controller: AbortController) => {
    const limit = Math.max(1, Math.floor(maxPollAttempts));
    for (let attempt = 1; attempt <= limit; attempt += 1) {
      if (!mountedRef.current || controller.signal.aborted) return;
      try {
        const job = await getJob(jobId, controller.signal);
        if (!mountedRef.current || controller.signal.aborted) return;
        if (job.status === 'completed') {
          inFlightRef.current = false;
          onCompleted?.();
          return;
        }
        if (job.status === 'failed') {
          inFlightRef.current = false;
          setSubmission({
            status: 'error',
            code: 'DDL_JOB_FAILED',
            detail: jobErrorDetail(job.error),
          });
          return;
        }
        setSubmission({ status: 'polling', jobId, attempt });
      } catch (error) {
        if (!controller.signal.aborted && mountedRef.current) {
          inFlightRef.current = false;
          setSubmission({ status: 'error', code: errorCode(error) });
        }
        return;
      }
      if (attempt < limit) {
        await new Promise<void>((resolve) => {
          timerRef.current = setTimeout(resolve, Math.max(0, pollIntervalMs));
        });
      }
    }
    if (mountedRef.current && !controller.signal.aborted) {
      inFlightRef.current = false;
      setSubmission({ status: 'error', code: 'POLLING_TIMEOUT' });
    }
  };

  const sendRequest = async (request: UpdateDynamicTableFieldsRequest) => {
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    inFlightRef.current = true;
    setSubmission({ status: 'submitting' });
    try {
      const accepted = await updateFields(table.id, request, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setSubmission({ status: 'polling', jobId: accepted.jobId, attempt: 0 });
      await pollJob(accepted.jobId, controller);
    } catch (error) {
      if (!controller.signal.aborted && mountedRef.current) {
        inFlightRef.current = false;
        setSubmission({ status: 'error', code: errorCode(error) });
      }
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (readOnly || inFlightRef.current) return;
    const request = buildRequest();
    if (!request) return;
    const hasTypeChange = existingFields.some((field) => {
      const original = originalFields.get(field.id);
      return !field.removed && original?.dataType !== field.dataType;
    });
    // This dialog renders outside the fieldset, so it would stay live -- and
    // able to mutate the drafts -- behind the confirmation dialog.
    setRemoveCandidate(null);
    if (hasTypeChange) {
      setSubmission({ status: 'confirming', request });
      return;
    }
    void sendRequest(request);
  };

  // A table cannot relate to itself through this editor.
  const relationTargetOptions =
    relationTargets.status === 'ready'
      ? relationTargets.items.filter((candidate) => candidate.id !== table.id)
      : [];

  return (
    <Card>
      <form className="grid gap-lg" onSubmit={submit} noValidate>
        <div>
          <h2 className="font-headline-sm text-headline-sm text-on-surface">
            {t('dynamicTables.fieldEditor.title', { table: table.name })}
          </h2>
          <p className="mt-xs text-body-sm text-on-surface-variant">
            {t('dynamicTables.fieldEditor.description')}
          </p>
        </div>

        <fieldset className="grid gap-md" disabled={isLocked || readOnly}>
          <legend className="font-label-caps text-label-caps uppercase tracking-wider text-on-surface-variant">
            {t('dynamicTables.fieldEditor.existingFields')}
          </legend>
          {existingFields.map((field) => {
            const isRelation = field.dataType === FieldDataType.RELATION;
            return (
              <div
                className="grid gap-sm rounded border border-outline-variant bg-surface-container-low p-md md:grid-cols-[minmax(0,1fr)_11rem_auto]"
                key={field.id}
              >
                <Input
                  label={t('dynamicTables.fieldEditor.fields.fieldName')}
                  value={field.name}
                  disabled
                />
                {isRelation ? (
                  <Input
                    label={t('dynamicTables.fieldEditor.fields.dataType')}
                    value={t('dynamicTables.fieldEditor.dataTypes.RELATION')}
                    disabled
                  />
                ) : (
                  <Select
                    label={t('dynamicTables.fieldEditor.fields.dataType')}
                    value={field.dataType}
                    onChange={(event) =>
                      updateExisting(field.id, {
                        dataType: event.target.value as FieldDataType,
                      })
                    }
                  >
                    {NON_RELATION_FIELD_TYPES.map((dataType) => (
                      <option key={dataType} value={dataType}>
                        {t(`dynamicTables.fieldEditor.dataTypes.${dataType}`)}
                      </option>
                    ))}
                  </Select>
                )}
                <Button
                  className="self-end"
                  variant="danger"
                  size="sm"
                  icon="delete"
                  aria-label={t(
                    'dynamicTables.fieldEditor.actions.removeField',
                    { name: field.name },
                  )}
                  disabled={field.removed}
                  onClick={() => setRemoveCandidate(field.id)}
                />
                {field.removed ? (
                  <p className="text-body-sm text-error md:col-span-3">
                    {t('dynamicTables.fieldEditor.removed')}
                  </p>
                ) : isRelation ? (
                  <p className="text-body-sm text-on-surface-variant md:col-span-3">
                    {t('dynamicTables.fieldEditor.relationLocked')}
                  </p>
                ) : (
                  <>
                    <label className="flex items-center gap-xs text-body-sm text-on-surface md:col-span-1">
                      <input
                        type="checkbox"
                        checked={field.required}
                        onChange={(event) =>
                          updateExisting(field.id, {
                            required: event.target.checked,
                          })
                        }
                      />
                      {t('dynamicTables.fieldEditor.fields.required')}
                    </label>
                    <div className="md:col-span-2">
                      <Input
                        label={t('dynamicTables.fieldEditor.fields.config')}
                        value={field.config}
                        error={errors[`existing-${field.id}-config`]}
                        onChange={(event) =>
                          updateExisting(field.id, {
                            config: event.target.value,
                          })
                        }
                      />
                    </div>
                  </>
                )}
              </div>
            );
          })}

          {newFields.map((field) => (
            <div
              className="grid gap-sm rounded border border-primary/30 bg-surface-container-low p-md md:grid-cols-[minmax(0,1fr)_11rem_auto_auto]"
              key={field.id}
            >
              <Input
                label={t('dynamicTables.fieldEditor.fields.fieldName')}
                value={field.name}
                error={errors[`new-${field.id}-name`]}
                onChange={(event) =>
                  updateNew(field.id, { name: event.target.value })
                }
              />
              <Select
                label={t('dynamicTables.fieldEditor.fields.dataType')}
                value={field.dataType}
                onChange={(event) =>
                  updateNew(field.id, {
                    dataType: event.target.value as FieldDataType,
                    relatedTableId:
                      event.target.value === FieldDataType.RELATION
                        ? field.relatedTableId
                        : '',
                  })
                }
              >
                {Object.values(FieldDataType).map((dataType) => (
                  <option key={dataType} value={dataType}>
                    {t(`dynamicTables.fieldEditor.dataTypes.${dataType}`)}
                  </option>
                ))}
              </Select>
              <label className="flex items-center gap-xs self-end pb-2 text-body-sm text-on-surface">
                <input
                  type="checkbox"
                  checked={field.required}
                  onChange={(event) =>
                    updateNew(field.id, { required: event.target.checked })
                  }
                />
                {t('dynamicTables.fieldEditor.fields.required')}
              </label>
              <Button
                className="self-end"
                variant="ghost"
                size="sm"
                icon="delete"
                aria-label={t(
                  'dynamicTables.fieldEditor.actions.discardNewField',
                  { number: field.id },
                )}
                onClick={() =>
                  setNewFields((current) =>
                    current.filter((candidate) => candidate.id !== field.id),
                  )
                }
              />
              {field.dataType === FieldDataType.RELATION && (
                <div className="grid gap-xs md:col-span-4">
                  <Select
                    label={t('dynamicTables.fieldEditor.fields.relationTarget')}
                    value={field.relatedTableId}
                    error={errors[`new-${field.id}-relation`]}
                    disabled={relationTargets.status !== 'ready'}
                    onChange={(event) =>
                      updateNew(field.id, {
                        relatedTableId: event.target.value,
                      })
                    }
                  >
                    <option value="">
                      {t(
                        'dynamicTables.fieldEditor.fields.relationTargetPlaceholder',
                      )}
                    </option>
                    {relationTargetOptions.map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.name}
                      </option>
                    ))}
                  </Select>
                  {relationTargets.status === 'loading' && (
                    <p
                      role="status"
                      className="text-body-sm text-on-surface-variant"
                    >
                      {t('dynamicTables.fieldEditor.relationTargets.loading')}
                    </p>
                  )}
                  {relationTargets.status === 'error' && (
                    <div className="flex flex-wrap items-center gap-sm">
                      <p role="alert" className="text-body-sm text-error">
                        {t('dynamicTables.fieldEditor.relationTargets.error')}
                      </p>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="refresh"
                        onClick={reloadRelationTargets}
                      >
                        {t('dynamicTables.actions.retry')}
                      </Button>
                    </div>
                  )}
                  {relationTargets.status === 'ready' &&
                    relationTargets.truncated && (
                      <p
                        role="status"
                        className="text-body-sm text-on-surface-variant"
                      >
                        {t(
                          'dynamicTables.fieldEditor.relationTargets.truncated',
                          { count: relationTargetOptions.length },
                        )}
                      </p>
                    )}
                </div>
              )}
              <div className="md:col-span-4">
                <Input
                  label={t('dynamicTables.fieldEditor.fields.config')}
                  value={field.config}
                  error={errors[`new-${field.id}-config`]}
                  onChange={(event) =>
                    updateNew(field.id, { config: event.target.value })
                  }
                />
              </div>
            </div>
          ))}
          <Button
            className="justify-self-start"
            variant="secondary"
            icon="add"
            onClick={() => {
              setNewFields((current) => [...current, newField(nextFieldId)]);
              setNextFieldId((current) => current + 1);
            }}
          >
            {t('dynamicTables.fieldEditor.actions.addField')}
          </Button>
        </fieldset>

        {errors.form && (
          <p className="text-body-sm text-error" role="alert">
            {errors.form}
          </p>
        )}
        {readOnly && (
          <p className="text-body-sm text-on-surface-variant">
            {t('dynamicTables.fieldEditor.readOnly')}
          </p>
        )}
        {removeCandidate && (
          <Card className="flex flex-col gap-md" role="alertdialog">
            <p className="text-body-sm text-on-surface">
              {t('dynamicTables.fieldEditor.removeConfirmation')}
            </p>
            <div className="flex justify-end gap-sm">
              <Button
                variant="secondary"
                onClick={() => setRemoveCandidate(null)}
              >
                {t('dynamicTables.fieldEditor.actions.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  updateExisting(removeCandidate, { removed: true });
                  setRemoveCandidate(null);
                }}
              >
                {t('dynamicTables.fieldEditor.actions.confirmRemove')}
              </Button>
            </div>
          </Card>
        )}
        {submission.status === 'confirming' && (
          <Card className="flex flex-col gap-md" role="alertdialog">
            <p className="text-body-sm text-on-surface">
              {t('dynamicTables.fieldEditor.typeChangeWarning')}
            </p>
            <div className="flex justify-end gap-sm">
              <Button
                variant="secondary"
                onClick={() => setSubmission({ status: 'idle' })}
              >
                {t('dynamicTables.fieldEditor.actions.cancel')}
              </Button>
              <Button onClick={() => void sendRequest(submission.request)}>
                {t('dynamicTables.fieldEditor.actions.confirmChanges')}
              </Button>
            </div>
          </Card>
        )}
        {submission.status === 'polling' && (
          <p className="text-body-sm text-on-surface-variant" role="status">
            {t('dynamicTables.fieldEditor.polling', {
              jobId: submission.jobId,
              attempt: submission.attempt,
            })}
          </p>
        )}
        {submission.status === 'error' && (
          <p className="text-body-sm text-error" role="alert">
            {submission.detail
              ? t('dynamicTables.fieldEditor.submitErrorDetail', {
                  code: submission.code,
                  detail: submission.detail,
                })
              : t('dynamicTables.fieldEditor.submitError', {
                  code: submission.code,
                })}
          </p>
        )}
        {!readOnly && (
          <div className="flex justify-end">
            <Button type="submit" disabled={isLocked}>
              {submission.status === 'submitting'
                ? t('dynamicTables.fieldEditor.actions.submitting')
                : t('dynamicTables.fieldEditor.actions.submit')}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
