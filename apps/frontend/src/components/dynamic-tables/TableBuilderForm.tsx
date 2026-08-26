import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FieldDataType,
  type DynamicTableDdlJobAcceptedDto,
  type DynamicTableDdlJobDto,
} from '@flexi/shared-types';
import { Button, Card, Input, Select } from '../ui';
import {
  createDynamicTable,
  getDynamicTableJob,
  type CreateDynamicTableRequest,
} from '../../lib/dynamic-tables-api';
import {
  DEFAULT_POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS,
  useDdlJobSubmission,
} from './use-ddl-job-submission';

const FIELD_TYPES = Object.values(FieldDataType).filter(
  (dataType) => dataType !== FieldDataType.RELATION,
);

interface FieldDraft {
  id: number;
  name: string;
  dataType: FieldDataType;
  required: boolean;
  config: string;
}

type FormErrors = Record<string, string>;

export interface TableBuilderFormProps {
  createTable?: (
    request: CreateDynamicTableRequest,
    signal?: AbortSignal,
  ) => Promise<DynamicTableDdlJobAcceptedDto>;
  getJob?: (
    jobId: string,
    signal?: AbortSignal,
  ) => Promise<DynamicTableDdlJobDto>;
  onCompleted?: () => void;
  onCancel?: () => void;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

function newField(id: number): FieldDraft {
  return {
    id,
    name: '',
    dataType: FieldDataType.STRING,
    required: false,
    config: '',
  };
}

function validateConfig(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('invalid config');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Collects the table metadata required by POST /tables and owns the
 * short-lived DDL job polling lifecycle. The server remains authoritative for
 * identifier and schema validation; these checks keep mistakes actionable
 * before a job is enqueued.
 */
export function TableBuilderForm({
  createTable = (request, signal) => createDynamicTable(request, { signal }),
  getJob = (jobId, signal) => getDynamicTableJob(jobId, { signal }),
  onCompleted,
  onCancel,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPollAttempts = MAX_POLL_ATTEMPTS,
}: TableBuilderFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<FieldDraft[]>(() => [newField(1)]);
  const [nextFieldId, setNextFieldId] = useState(2);
  const [errors, setErrors] = useState<FormErrors>({});
  const {
    state: submission,
    isBusy,
    isInFlight,
    submit: submitJob,
  } = useDdlJobSubmission({
    getJob,
    onCompleted,
    pollIntervalMs,
    maxPollAttempts,
  });

  const updateField = (id: number, changes: Partial<FieldDraft>) => {
    setFields((current) =>
      current.map((field) =>
        field.id === id ? { ...field, ...changes } : field,
      ),
    );
  };

  const validate = (): CreateDynamicTableRequest | null => {
    const nextErrors: FormErrors = {};
    const trimmedName = name.trim();
    if (!trimmedName) nextErrors.name = t('dynamicTables.builder.errors.name');
    if (fields.length === 0) {
      nextErrors.fields = t('dynamicTables.builder.errors.fieldRequired');
    }

    const fieldNames = new Set<string>();
    const requestFields = fields.map((field) => {
      const trimmedFieldName = field.name.trim();
      if (!trimmedFieldName) {
        nextErrors[`field-${field.id}-name`] = t(
          'dynamicTables.builder.errors.fieldName',
        );
      } else {
        const key = trimmedFieldName.toLowerCase();
        if (fieldNames.has(key)) {
          nextErrors[`field-${field.id}-name`] = t(
            'dynamicTables.builder.errors.duplicateField',
          );
        }
        fieldNames.add(key);
      }

      let config: Record<string, unknown> | undefined;
      try {
        config = validateConfig(field.config);
      } catch {
        nextErrors[`field-${field.id}-config`] = t(
          'dynamicTables.builder.errors.config',
        );
      }

      return {
        name: trimmedFieldName,
        dataType: field.dataType,
        ...(field.required ? { required: true } : {}),
        ...(config ? { config } : {}),
      };
    });

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return null;

    const trimmedDescription = description.trim();
    return {
      name: trimmedName,
      ...(trimmedDescription ? { description: trimmedDescription } : {}),
      fields: requestFields,
    };
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isInFlight()) {
      return;
    }
    const request = validate();
    if (!request) return;

    void submitJob((signal) => createTable(request, signal));
  };

  return (
    <Card>
      <form className="grid gap-lg" onSubmit={submit} noValidate>
        <div>
          <h2 className="font-headline-sm text-headline-sm text-on-surface">
            {t('dynamicTables.builder.title')}
          </h2>
          <p className="mt-xs text-body-sm text-on-surface-variant">
            {t('dynamicTables.builder.description')}
          </p>
        </div>

        <div className="grid gap-md md:grid-cols-2">
          <Input
            label={t('dynamicTables.builder.fields.tableName')}
            value={name}
            disabled={isBusy}
            error={errors.name}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            label={t('dynamicTables.builder.fields.description')}
            value={description}
            disabled={isBusy}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <fieldset className="grid gap-md" disabled={isBusy}>
          <legend className="font-label-caps text-label-caps uppercase tracking-wider text-on-surface-variant">
            {t('dynamicTables.builder.fields.fields')}
          </legend>
          {errors.fields && (
            <p className="text-body-sm text-error" role="alert">
              {errors.fields}
            </p>
          )}
          {fields.map((field, index) => (
            <div
              className="grid gap-sm rounded border border-outline-variant bg-surface-container-low p-md md:grid-cols-[minmax(0,1fr)_11rem_auto_auto]"
              key={field.id}
            >
              <Input
                label={t('dynamicTables.builder.fields.fieldName')}
                value={field.name}
                error={errors[`field-${field.id}-name`]}
                onChange={(event) =>
                  updateField(field.id, { name: event.target.value })
                }
              />
              <Select
                label={t('dynamicTables.builder.fields.dataType')}
                value={field.dataType}
                onChange={(event) =>
                  updateField(field.id, {
                    dataType: event.target.value as FieldDataType,
                  })
                }
              >
                {FIELD_TYPES.map((dataType) => (
                  <option key={dataType} value={dataType}>
                    {t(`dynamicTables.builder.dataTypes.${dataType}`)}
                  </option>
                ))}
              </Select>
              <label className="flex items-center gap-xs self-end pb-2 text-body-sm text-on-surface">
                <input
                  type="checkbox"
                  checked={field.required}
                  onChange={(event) =>
                    updateField(field.id, { required: event.target.checked })
                  }
                />
                {t('dynamicTables.builder.fields.required')}
              </label>
              <Button
                aria-label={t('dynamicTables.builder.actions.removeField', {
                  number: index + 1,
                })}
                className="self-end"
                disabled={fields.length === 1}
                icon="delete"
                size="sm"
                variant="ghost"
                onClick={() =>
                  setFields((current) =>
                    current.filter((candidate) => candidate.id !== field.id),
                  )
                }
              />
              <div className="md:col-span-4">
                <Input
                  label={t('dynamicTables.builder.fields.config')}
                  placeholder={t(
                    'dynamicTables.builder.fields.configPlaceholder',
                  )}
                  value={field.config}
                  error={errors[`field-${field.id}-config`]}
                  onChange={(event) =>
                    updateField(field.id, { config: event.target.value })
                  }
                />
              </div>
            </div>
          ))}
          <Button
            className="justify-self-start"
            icon="add"
            variant="secondary"
            onClick={() => {
              setFields((current) => [...current, newField(nextFieldId)]);
              setNextFieldId((current) => current + 1);
            }}
          >
            {t('dynamicTables.builder.actions.addField')}
          </Button>
        </fieldset>

        {submission.status === 'polling' && (
          <p className="text-body-sm text-on-surface-variant" role="status">
            {t('dynamicTables.builder.polling', {
              jobId: submission.jobId,
              attempt: submission.attempt,
            })}
          </p>
        )}
        {submission.status === 'error' && (
          <p className="text-body-sm text-error" role="alert">
            {t('dynamicTables.builder.submitError', { code: submission.code })}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-sm">
          {onCancel && (
            <Button disabled={isBusy} variant="secondary" onClick={onCancel}>
              {t('dynamicTables.builder.actions.cancel')}
            </Button>
          )}
          <Button disabled={isBusy} icon="add" type="submit">
            {submission.status === 'submitting'
              ? t('dynamicTables.builder.actions.submitting')
              : t('dynamicTables.builder.actions.submit')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
