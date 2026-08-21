import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { Knex } from 'knex';
import { FieldDataType } from '@flexi/shared-types';
import { TenantKnexService } from '../../tenancy/tenant-knex.service';
import { resolveTenantSchema } from '../../tenancy/resolve-tenant-schema';
import { TenancyClsStore } from '../../tenancy/tenant-context';
import {
  DDL_QUEUE_NAME,
  DdlJobData,
  FieldEditStep,
} from './dynamic-tables.types';

const META_TABLES = '_meta_tables';
const META_FIELDS = '_meta_fields';
const META_MIGRATIONS = '_meta_migrations';

/**
 * Maps the app-level `FieldDataType` enum to a concrete Postgres column
 * type/`ColumnBuilder` call. Kept as its own function (not duplicated
 * between `add-column`/`add-shadow-column` handling) since both step kinds
 * need the exact same mapping.
 */
function addTypedColumn(
  table: Knex.CreateTableBuilder | Knex.AlterTableBuilder,
  columnName: string,
  dataType: FieldDataType,
): Knex.ColumnBuilder {
  switch (dataType) {
    case FieldDataType.STRING:
    case FieldDataType.EMAIL:
    case FieldDataType.URL:
    case FieldDataType.SELECT:
      return table.string(columnName);
    case FieldDataType.TEXT:
      return table.text(columnName);
    case FieldDataType.NUMBER:
      return table.decimal(columnName);
    case FieldDataType.BOOLEAN:
      return table.boolean(columnName);
    case FieldDataType.DATE:
      return table.date(columnName);
    case FieldDataType.DATETIME:
      return table.timestamp(columnName);
    case FieldDataType.JSON:
      return table.jsonb(columnName);
    case FieldDataType.RELATION:
      // A RELATION field's column is built by addRelationColumn() (its own
      // FK-aware step, `add-relation-column`), never through this generic
      // typed-column mapping -- CreateTableDto's NON_RELATION_FIELD_DATA_TYPES
      // allowlist keeps RELATION out of `create-table` jobs entirely (Story
      // 4/CAP-4: relations are added only via the field-edit path), so this
      // case is unreachable here; fail loudly rather than silently create a
      // wrong-shaped (non-FK) column if that invariant is ever broken
      // upstream.
      throw new Error(
        'RELATION fields must go through the add-relation-column step, not addTypedColumn()',
      );
    default:
      throw new Error(`Unsupported FieldDataType: ${dataType as string}`);
  }
}

/**
 * Builds a Story 4/CAP-4 relation column: an integer FK column matching
 * `_meta_tables`/row PK shape (`t.increments('id')`, see
 * `processCreateTable()` below), referencing `qualifiedTargetTable`'s `id`
 * with `ON DELETE SET NULL` (spec Design Notes -- CASCADE would silently
 * delete unrelated rows, and CAP-4 has no requirement to block target-row
 * deletion via RESTRICT). `qualifiedTargetTable` MUST already be
 * schema-qualified by the caller (the same `${schema}.${tableName}` pattern
 * `dynamic-tables.service.ts`'s `qualifiedMetaTables` uses) -- this is the
 * structural defense making cross-tenant linking impossible (AD-7): an
 * unqualified `.inTable()` value would resolve via Postgres's `search_path`
 * instead of the tenant schema the target table actually lives in.
 */
function addRelationColumn(
  table: Knex.CreateTableBuilder | Knex.AlterTableBuilder,
  columnName: string,
  qualifiedTargetTable: string,
  required: boolean,
): Knex.ReferencingColumnBuilder {
  const column = table
    .integer(columnName)
    .references('id')
    .inTable(qualifiedTargetTable)
    .onDelete('SET NULL');

  // Nullable unless `required: true` (spec Boundaries) -- `required` is
  // still app-validated at write time (checkFieldType()/validateRowPayload()
  // in dynamic-tables.service.ts), same as every other field's `required`,
  // not DB-enforced via NOT NULL, so this only governs whether the column
  // itself can physically hold NULL (needed for ON DELETE SET NULL to ever
  // apply to it).
  return required ? column.notNullable() : column.nullable();
}

/**
 * BullMQ worker (in-process, per AD-8) that dequeues `ddl` jobs enqueued by
 * `DynamicTablesService.enqueueCreateTable()`/`enqueueFieldEdit()`, executes
 * the DDL via `TenantKnexService.schemaForCurrentTenant()`/`transaction()`
 * (AD-3 -- never a raw `pg` client), and records the outcome in
 * `_meta_migrations` keyed by `job_id` (CAP-5).
 *
 * A worker has no request-scoped CLS (unlike an HTTP request, which gets
 * its tenant context from `JwtAuthGuard`) -- `ClsService.runWith()`
 * re-establishes `tenantId`/`schema` from the job payload's own `tenantId`
 * for the duration of `process()`, so `TenantKnexService.forCurrentTenant()`/
 * `schemaForCurrentTenant()` resolve correctly inside it.
 *
 * Every step is written to be safe to re-execute (existence-guarded), so a
 * BullMQ-level job retry that restarts from `steps[0]` after a mid-sequence
 * failure never errors on a step a prior attempt already committed -- see
 * this story's Spec Change Log finding (2). Per-step-own-transaction (not
 * one shared transaction across all steps of a `field-edit` job) is
 * deliberate: an earlier committed step is not auto-reverted by a later
 * step's failure (Design Notes) -- only re-execution safety was missing,
 * not the transaction boundaries.
 */
@Injectable()
@Processor(DDL_QUEUE_NAME)
export class DdlWorker extends WorkerHost {
  private readonly logger = new Logger(DdlWorker.name);

  constructor(
    private readonly tenantKnexService: TenantKnexService,
    private readonly configService: ConfigService,
    private readonly cls: ClsService<TenancyClsStore>,
  ) {
    super();
  }

  async process(job: Job<DdlJobData>): Promise<void> {
    const { tenantId } = job.data;
    const schema = resolveTenantSchema(tenantId);

    await this.cls.runWith({ tenantId, schema }, async () => {
      if (job.data.kind === 'create-table') {
        await this.processCreateTable(job.data);
      } else {
        await this.processFieldEdit(job.data);
      }
    });
  }

  // ------------------------------------------------------------------
  // CAP-1: create table
  // ------------------------------------------------------------------

  private async processCreateTable(
    data: Extract<DdlJobData, { kind: 'create-table' }>,
  ): Promise<void> {
    const statement = `CREATE TABLE "${data.tableName}" (...${data.fields.length} field(s))`;

    try {
      await this.tenantKnexService.transaction(async (trx) => {
        await this.setDdlTimeouts(trx);

        // A fresh Knex.SchemaBuilder per statement -- NOT one shared
        // instance reused across the hasTable()+createTable() awaits
        // below. A SchemaBuilder is a mutable, single-use thenable:
        // awaiting the same instance twice replays its entire accumulated
        // statement list on the second await, not just the new statement,
        // which surfaces as a spurious "relation already exists" against
        // real Postgres (see this.buildSchema()'s doc comment).
        const buildSchema = () => this.freshSchemaBuilder(trx);

        // Existence-guarded: a retried job (e.g. after the metadata-row
        // insert below failed on a prior attempt, once BullMQ retries)
        // must not error with "relation already exists" on a table this
        // job already created.
        const alreadyExists = await buildSchema().hasTable(data.tableName);
        if (!alreadyExists) {
          await buildSchema().createTable(data.tableName, (table) => {
            table.increments('id').primary();
            for (const field of data.fields) {
              const column = addTypedColumn(table, field.name, field.dataType);
              if (field.required) {
                column.notNullable();
              } else {
                column.nullable();
              }
            }
            table.timestamps(true, true);
          });
        }

        await this.upsertMetaTable(
          trx,
          data.tableId,
          data.tableName,
          data.description,
        );
        for (const field of data.fields) {
          await this.upsertMetaField(
            trx,
            data.tableId,
            field.name,
            field.name,
            {
              dataType: field.dataType,
              required: field.required,
              config: field.config,
            },
          );
        }
      });

      await this.recordMigration({
        tableId: data.tableId,
        jobId: data.jobId,
        operation: 'create-table',
        statement,
        status: 'completed',
        error: null,
      });
    } catch (error) {
      await this.recordMigration({
        tableId: data.tableId,
        jobId: data.jobId,
        operation: 'create-table',
        statement,
        status: 'failed',
        error: this.errorMessage(error),
      });
      throw error;
    }
  }

  // ------------------------------------------------------------------
  // CAP-2: add/remove/modify fields (CAP-6 expand/contract)
  // ------------------------------------------------------------------

  private async processFieldEdit(
    data: Extract<DdlJobData, { kind: 'field-edit' }>,
  ): Promise<void> {
    for (const step of data.steps) {
      const statement = this.describeStep(data.tableName, step);

      try {
        await this.tenantKnexService.transaction(async (trx) => {
          await this.setDdlTimeouts(trx);
          await this.executeStep(trx, data.tableName, step);
        });

        await this.recordMigration({
          tableId: data.tableId,
          jobId: data.jobId,
          operation: step.kind,
          statement,
          status: 'completed',
          error: null,
        });
      } catch (error) {
        await this.recordMigration({
          tableId: data.tableId,
          jobId: data.jobId,
          operation: step.kind,
          statement,
          status: 'failed',
          error: this.errorMessage(error),
        });
        // Per Design Notes: earlier completed steps are not auto-reverted;
        // re-throw so BullMQ's retry/backoff can retry the whole job from
        // steps[0] (safe, since every step below is existence-guarded).
        throw error;
      }
    }

    // All DDL steps succeeded -- apply the metadata-row effects
    // (_meta_fields) in their own transaction. One migration row was
    // already written per DDL step above (CAP-5: each structural change is
    // its own migration record); metadata bookkeeping isn't itself a
    // structural change, so it gets no additional row.
    await this.tenantKnexService.transaction(async (trx) => {
      for (const effect of data.metadataEffects) {
        if (effect.kind === 'upsert-field') {
          await this.upsertMetaField(
            trx,
            data.tableId,
            effect.name,
            effect.slug,
            {
              dataType: effect.dataType,
              required: effect.required,
              config: effect.config,
              relationTargetTableId: effect.relationTargetTableId,
            },
          );
        } else {
          await this.metaTable(trx, META_FIELDS)
            .where({ table_id: data.tableId, slug: effect.slug })
            .delete();
        }
      }
    });
  }

  private async executeStep(
    trx: Knex.Transaction,
    tableName: string,
    step: FieldEditStep,
  ): Promise<void> {
    // A fresh Knex.SchemaBuilder per statement, never one instance reused
    // across multiple awaits -- see freshSchemaBuilder()'s doc comment for
    // why (awaiting the same builder twice replays its whole accumulated
    // statement history against real Postgres).
    const buildSchema = () => this.freshSchemaBuilder(trx);

    switch (step.kind) {
      case 'add-column': {
        // Existence-guarded: safe to re-run after a retry that already
        // committed this step in a prior attempt.
        const exists = await buildSchema().hasColumn(
          tableName,
          step.columnName,
        );
        if (exists) {
          return;
        }
        await buildSchema().alterTable(tableName, (table) => {
          const column = addTypedColumn(table, step.columnName, step.dataType);
          if (step.required) {
            column.notNullable();
          } else {
            column.nullable();
          }
        });
        return;
      }

      case 'add-relation-column': {
        // Existence-guarded, same as add-column -- safe to re-run after a
        // retry that already committed this step in a prior attempt.
        const exists = await buildSchema().hasColumn(
          tableName,
          step.columnName,
        );
        if (exists) {
          return;
        }

        // Schema-qualified `.inTable()` value, built the exact same way as
        // `dynamic-tables.service.ts`'s `qualifiedMetaTables` (AD-7's
        // structural cross-tenant defense: an unqualified `.inTable()`
        // value would resolve via Postgres's `search_path`/`public` rather
        // than this tenant's own schema, letting the FK reference a
        // same-named table living in a different schema entirely).
        const qualifiedTargetTable = `${this.currentSchema()}.${step.targetTableName}`;

        await buildSchema().alterTable(tableName, (table) => {
          addRelationColumn(
            table,
            step.columnName,
            qualifiedTargetTable,
            step.required,
          );
        });
        return;
      }

      case 'drop-column': {
        // No-op if the source column is already gone -- so a retry after a
        // mid-job failure doesn't error on "column does not exist".
        const exists = await buildSchema().hasColumn(
          tableName,
          step.columnName,
        );
        if (!exists) {
          return;
        }
        await buildSchema().alterTable(tableName, (table) => {
          table.dropColumn(step.columnName);
        });
        return;
      }

      case 'add-shadow-column': {
        const exists = await buildSchema().hasColumn(
          tableName,
          step.shadowColumnName,
        );
        if (exists) {
          return;
        }
        await buildSchema().alterTable(tableName, (table) => {
          const column = addTypedColumn(
            table,
            step.shadowColumnName,
            step.dataType,
          );
          // The shadow column starts nullable regardless of the target
          // field's final required-ness -- backfill-column populates it
          // from the source column before cutover-column can safely make
          // it NOT NULL-equivalent by renaming it into the final slot.
          column.nullable();
        });
        return;
      }

      case 'backfill-column': {
        // Re-running a backfill after a retry is safe: it's just another
        // UPDATE ... SET copying current source values into the shadow
        // column, not a create/drop that could error on already-applied
        // state.
        await trx.raw(
          `UPDATE "${this.currentSchema()}"."${tableName}" ` +
            `SET "${step.shadowColumnName}" = "${step.sourceColumnName}"`,
        );
        return;
      }

      case 'cutover-column': {
        const sourceExists = await buildSchema().hasColumn(
          tableName,
          step.sourceColumnName,
        );
        const shadowExists = await buildSchema().hasColumn(
          tableName,
          step.shadowColumnName,
        );

        // A retried cutover where a prior attempt already dropped the
        // source and renamed the shadow into place: the final column
        // already exists under its final name and the shadow name is
        // gone -- nothing left to do.
        if (!sourceExists && !shadowExists) {
          return;
        }

        if (sourceExists) {
          await buildSchema().alterTable(tableName, (table) => {
            table.dropColumn(step.sourceColumnName);
          });
        }

        if (shadowExists) {
          await buildSchema().alterTable(tableName, (table) => {
            table.renameColumn(step.shadowColumnName, step.finalColumnName);
          });
        }
        return;
      }

      default: {
        const exhaustiveCheck: never = step;
        throw new Error(
          `Unsupported field-edit step: ${JSON.stringify(exhaustiveCheck)}`,
        );
      }
    }
  }

  private describeStep(tableName: string, step: FieldEditStep): string {
    switch (step.kind) {
      case 'add-column':
        return `ADD COLUMN "${step.columnName}" on "${tableName}"`;
      case 'add-relation-column':
        return `ADD COLUMN "${step.columnName}" (FK -> "${step.targetTableName}", ON DELETE SET NULL) on "${tableName}"`;
      case 'drop-column':
        return `DROP COLUMN "${step.columnName}" on "${tableName}"`;
      case 'add-shadow-column':
        return `ADD COLUMN "${step.shadowColumnName}" (shadow) on "${tableName}"`;
      case 'backfill-column':
        return `BACKFILL "${step.shadowColumnName}" FROM "${step.sourceColumnName}" on "${tableName}"`;
      case 'cutover-column':
        return `CUTOVER "${step.shadowColumnName}" -> "${step.finalColumnName}" (drop "${step.sourceColumnName}") on "${tableName}"`;
      default:
        return 'unknown field-edit step';
    }
  }

  // ------------------------------------------------------------------
  // Shared helpers
  // ------------------------------------------------------------------

  /**
   * `SET LOCAL lock_timeout`/`statement_timeout`, scoped per-transaction
   * (never session-level -- PgBouncer transaction-mode pooling can recycle
   * a backend connection to a different tenant between statements, same
   * discipline `TenantKnexService` already follows). Config-backed via
   * `env.validation.ts`, never hardcoded.
   */
  private async setDdlTimeouts(trx: Knex.Transaction): Promise<void> {
    const lockTimeoutMs = this.configService.get<number>('DDL_LOCK_TIMEOUT_MS');
    const statementTimeoutMs = this.configService.get<number>(
      'DDL_STATEMENT_TIMEOUT_MS',
    );

    await trx.raw(`SET LOCAL lock_timeout = ${Number(lockTimeoutMs)}`);
    await trx.raw(
      `SET LOCAL statement_timeout = ${Number(statementTimeoutMs)}`,
    );
  }

  /**
   * Returns a brand-new `Knex.SchemaBuilder` scoped to the current tenant
   * schema and the given transaction. MUST be called fresh for every
   * single DDL statement -- never call `.hasTable()`/`.hasColumn()`/
   * `.createTable()`/`.alterTable()` more than once on the same returned
   * instance. A `SchemaBuilder` is a mutable, single-use thenable query
   * object: each method call queues onto its internal statement list, and
   * `await`-ing it (its `.then()`) executes and REPLAYS every statement
   * queued on it so far -- so awaiting the same instance a second time
   * (e.g. `hasTable()` then `createTable()` on one shared builder) re-runs
   * the first statement too, surfacing as a spurious "relation already
   * exists"/"column already exists" against real Postgres. Verified via a
   * live-Postgres e2e test during this story's implementation; caught a
   * real bug in this exact pattern.
   */
  private freshSchemaBuilder(trx: Knex.Transaction): Knex.SchemaBuilder {
    return this.tenantKnexService.schemaForCurrentTenant().transacting(trx);
  }

  /** The current job's tenant schema, set by `process()`'s `cls.runWith()` call. */
  private currentSchema(): string {
    return this.cls.get('schema');
  }

  /**
   * AD-3: every statement is built from `tenantKnexService.forCurrentTenant()`,
   * even inside a transaction -- `.transacting(trx)` scopes it, matching the
   * pattern `DynamicTablesService.ensureMetaTables()` already established
   * for schema-builder calls.
   */
  private metaTable(trx: Knex.Transaction, name: string): Knex.QueryBuilder {
    return this.tenantKnexService
      .forCurrentTenant()
      .table(name)
      .transacting(trx);
  }

  private async upsertMetaTable(
    trx: Knex.Transaction,
    tableId: string,
    name: string,
    description: string | null,
  ): Promise<void> {
    const existing = await this.metaTable(trx, META_TABLES)
      .where({ id: tableId })
      .first();

    if (existing) {
      await this.metaTable(trx, META_TABLES).where({ id: tableId }).update({
        name,
        slug: name,
        description,
        updated_at: new Date(),
      });
      return;
    }

    await this.metaTable(trx, META_TABLES).insert({
      id: tableId,
      name,
      slug: name,
      description,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }

  private async upsertMetaField(
    trx: Knex.Transaction,
    tableId: string,
    name: string,
    slug: string,
    fieldDef: {
      dataType: FieldDataType;
      required: boolean;
      config: Record<string, unknown> | null;
      /**
       * Story 4/CAP-4: the target `_meta_tables.id` a `RELATION` field
       * points at, written into `_meta_fields.relation_target_table_id`
       * (column already exists per `ensureMetaFieldsTable()`,
       * dynamic-tables.service.ts:178-182). `undefined`/omitted for every
       * non-relation field, persisted as `null`.
       */
      relationTargetTableId?: string;
    },
  ): Promise<void> {
    const existing = await this.metaTable(trx, META_FIELDS)
      .where({ table_id: tableId, slug })
      .first();

    if (existing) {
      await this.metaTable(trx, META_FIELDS)
        .where({ table_id: tableId, slug })
        .update({
          name,
          data_type: fieldDef.dataType,
          required: fieldDef.required,
          config: fieldDef.config,
          relation_target_table_id: fieldDef.relationTargetTableId ?? null,
          updated_at: new Date(),
        });
      return;
    }

    await this.metaTable(trx, META_FIELDS).insert({
      id: randomUUID(),
      table_id: tableId,
      name,
      slug,
      data_type: fieldDef.dataType,
      required: fieldDef.required,
      config: fieldDef.config,
      relation_target_table_id: fieldDef.relationTargetTableId ?? null,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }

  private async recordMigration(row: {
    tableId: string | null;
    jobId: string;
    operation: string;
    statement: string;
    status: 'completed' | 'failed';
    error: string | null;
  }): Promise<void> {
    const now = new Date();
    await this.tenantKnexService
      .forCurrentTenant()
      .table(META_MIGRATIONS)
      .insert({
        id: randomUUID(),
        table_id: row.tableId,
        job_id: row.jobId,
        operation: row.operation,
        statement: row.statement,
        status: row.status,
        error: row.error,
        created_at: now,
        completed_at: now,
      });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
