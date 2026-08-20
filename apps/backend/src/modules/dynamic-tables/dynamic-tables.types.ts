import { FieldDataType } from '@flexi/shared-types';

/** BullMQ queue name shared by `tables.controller.ts`'s enqueue calls and `ddl-worker.ts`'s `@Processor()`. */
export const DDL_QUEUE_NAME = 'ddl';

/**
 * One field definition as carried inside a `create-table` job payload.
 * Mirrors `CreateTableFieldDto` but decoupled from the DTO/HTTP layer so
 * the worker never imports `class-validator`-decorated classes.
 */
export interface CreateTableJobField {
  name: string;
  dataType: FieldDataType;
  required: boolean;
  config: Record<string, unknown> | null;
}

export interface CreateTableJobData {
  kind: 'create-table';
  jobId: string;
  tenantId: string;
  tableId: string;
  tableName: string;
  description: string | null;
  fields: CreateTableJobField[];
}

/**
 * A single DDL step inside a `field-edit` job. Additive add/remove is one
 * step; a destructive type change is three steps run in sequence within the
 * same job (expand/contract, per AD-8's Design Notes). Every step must be
 * safe to re-execute (existence-guarded) so a BullMQ-level job retry can
 * restart from `steps[0]` without erroring on a step a prior attempt
 * already committed -- see this story's Spec Change Log finding (2).
 */
export type FieldEditStep =
  | {
      kind: 'add-column';
      columnName: string;
      dataType: FieldDataType;
      required: boolean;
      config: Record<string, unknown> | null;
    }
  | { kind: 'drop-column'; columnName: string }
  | {
      kind: 'add-shadow-column';
      shadowColumnName: string;
      dataType: FieldDataType;
      required: boolean;
      config: Record<string, unknown> | null;
    }
  | {
      kind: 'backfill-column';
      sourceColumnName: string;
      shadowColumnName: string;
    }
  | {
      kind: 'cutover-column';
      sourceColumnName: string;
      shadowColumnName: string;
      finalColumnName: string;
    };

export interface FieldEditJobData {
  kind: 'field-edit';
  jobId: string;
  tenantId: string;
  tableId: string;
  tableName: string;
  steps: FieldEditStep[];
  /**
   * Metadata-row side effects to apply once every step in `steps` has
   * completed successfully -- kept alongside the DDL steps so the worker
   * (the sole DDL/metadata owner's execution arm) can write `_meta_fields`
   * without a second round trip back through the service after the fact.
   */
  metadataEffects: FieldMetadataEffect[];
}

export type FieldMetadataEffect =
  | {
      kind: 'upsert-field';
      name: string;
      slug: string;
      dataType: FieldDataType;
      required: boolean;
      config: Record<string, unknown> | null;
    }
  | { kind: 'remove-field'; slug: string };

export type DdlJobData = CreateTableJobData | FieldEditJobData;

/** CAP-5's `_meta_migrations.status` string literals -- consistent, not CHECK-constrained (spec's "Never" boundary). */
export type MigrationStatus = 'pending' | 'completed' | 'failed';
