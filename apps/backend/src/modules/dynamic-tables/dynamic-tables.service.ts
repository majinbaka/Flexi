import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { NotImplementedStatus } from '@flexi/shared-types';
import { Knex } from 'knex';
import { TenantKnexService } from '../../tenancy/tenant-knex.service';
import { TenantContext } from '../../tenancy/tenant-context';
import { sanitizeIdentifier } from '../../tenancy/sanitize-identifier';
import { CreateTableDto } from './dto/create-table.dto';
import { FieldEditDto, UpdateFieldDto } from './dto/update-field.dto';
import {
  CreateTableJobData,
  DDL_QUEUE_NAME,
  DdlJobData,
  FieldEditJobData,
  FieldEditStep,
  FieldMetadataEffect,
} from './dynamic-tables.types';

const META_TABLES = '_meta_tables';
const META_FIELDS = '_meta_fields';
const META_MIGRATIONS = '_meta_migrations';

// AD-10's reserved prefix: a tenant-chosen table name can never start with
// this, since it would collide with this module's own bookkeeping tables in
// the same schema.
const RESERVED_TABLE_PREFIX = '_meta_';

// Suffix appended to a field name to derive its expand/contract shadow
// column name. Kept short and fixed (no timestamp) so the same
// `buildFieldEditSteps()` call is deterministic and so the length budget
// left for the original field name is predictable when checking against
// sanitizeIdentifier()'s 63-byte cap below.
const SHADOW_COLUMN_SUFFIX = '__shadow';

export interface JobStatusResult {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error: string | null;
}

/**
 * Sole DDL/metadata owner for the DynamicTables module (AD-2). Story 1 added
 * the bootstrap migration (`ensureMetaTables()`) that creates the three
 * tenant-schema metadata tables AD-10 pins the shape of. This story adds
 * CAP-1 (create table) and CAP-2 (add/remove/modify fields): validating and
 * enqueueing a BullMQ DDL job (AD-4/AD-6/AD-8), and `getJobStatus()` for
 * polling a queued job's outcome. CAP-3 validation-schema caching (AD-5) and
 * CAP-4 relation fields are still deliberately not implemented here (Story
 * 3/4).
 */
@Injectable()
export class DynamicTablesService {
  private readonly logger = new Logger(DynamicTablesService.name);

  constructor(
    private readonly tenantKnexService: TenantKnexService,
    private readonly tenantContext: TenantContext,
    private readonly configService: ConfigService,
    @InjectQueue(DDL_QUEUE_NAME) private readonly ddlQueue: Queue<DdlJobData>,
  ) {}

  getStatus(): NotImplementedStatus {
    return { status: 'not-implemented' };
  }

  /**
   * Bootstrap migration: creates `_meta_tables`, `_meta_fields`, and
   * `_meta_migrations` inside the current tenant's own Postgres schema
   * (never `public`) if they don't already exist, per AD-10's pinned column
   * shapes. Idempotent -- each table creation is guarded by a `hasTable()`
   * check, so invoking this twice for the same tenant schema is a no-op the
   * second time (no error, no duplicate/recreated tables).
   *
   * All three `createTable` calls run inside one transaction (via
   * `TenantKnexService.transaction()`) so a mid-bootstrap failure never
   * leaves the tenant schema with only some of the three tables created.
   *
   * Only creates the tables; `_meta_migrations` is not written to here --
   * that's CAP-5's job, done by Story 2's `ddl-worker.ts`.
   */
  async ensureMetaTables(): Promise<void> {
    await this.tenantKnexService.transaction(async (trx) => {
      // A `Knex.SchemaBuilder` is a mutable, single-use, thenable query
      // object: awaiting it triggers `.then()`, which executes its entire
      // accumulated internal statement list -- and awaiting the SAME
      // builder instance again (e.g. for a second `hasTable()`/
      // `createTable()` call) REPLAYS every previously-run statement on
      // top of the new one, not just the new one. Reusing one builder
      // instance across the three tables' hasTable/createTable calls below
      // caused a real "relation already exists" failure against live
      // Postgres (Story 1's mocked-builder unit tests never caught this,
      // since the mock has no such replay behavior) -- so a FRESH builder
      // is fetched for every single statement via this factory, never
      // reused across awaits.
      const buildSchema = () =>
        this.tenantKnexService.schemaForCurrentTenant().transacting(trx);

      // `.inTable(x)` for a cross-table foreign key does NOT inherit the
      // schema-builder's own `.withSchema()` scoping -- verified against
      // live Postgres during this story's implementation: an unqualified
      // `.inTable('_meta_tables')` compiles to `references "_meta_tables"
      // (...)` with no schema prefix, which Postgres resolves via
      // `search_path` (defaulting to `public`) rather than the tenant
      // schema the table actually lives in, so the FK fails with "relation
      // does not exist" even though `_meta_tables` was just created one
      // statement earlier in the same transaction. Every FK referencing
      // `_meta_tables` from inside this tenant schema must use this
      // schema-qualified name instead of the bare `META_TABLES` constant.
      const qualifiedMetaTables = `${this.tenantContext.schema}.${META_TABLES}`;

      await this.ensureMetaTablesTable(buildSchema);
      await this.ensureMetaFieldsTable(buildSchema, qualifiedMetaTables);
      await this.ensureMetaMigrationsTable(buildSchema, qualifiedMetaTables);
    });
  }

  private async ensureMetaTablesTable(
    buildSchema: () => Knex.SchemaBuilder,
  ): Promise<void> {
    if (await buildSchema().hasTable(META_TABLES)) {
      return;
    }

    this.logger.log(`Creating ${META_TABLES}`);
    await buildSchema().createTable(META_TABLES, (t) => {
      t.string('id').primary();
      t.text('name').notNullable();
      t.text('slug').notNullable().unique();
      t.text('description').nullable();
      t.timestamps(true, true);
    });
  }

  private async ensureMetaFieldsTable(
    buildSchema: () => Knex.SchemaBuilder,
    qualifiedMetaTables: string,
  ): Promise<void> {
    if (await buildSchema().hasTable(META_FIELDS)) {
      return;
    }

    this.logger.log(`Creating ${META_FIELDS}`);
    await buildSchema().createTable(META_FIELDS, (t) => {
      t.string('id').primary();
      t.string('table_id')
        .notNullable()
        .references('id')
        .inTable(qualifiedMetaTables)
        .onDelete('CASCADE');
      t.text('name').notNullable();
      t.text('slug').notNullable();
      // Plain text column, app-validated against FieldDataType from
      // @flexi/shared-types -- not a native Postgres enum (AD-10).
      t.text('data_type').notNullable();
      t.boolean('required').notNullable().defaultTo(false);
      t.string('relation_target_table_id')
        .nullable()
        .references('id')
        .inTable(qualifiedMetaTables)
        .onDelete('CASCADE');
      t.jsonb('config').nullable();
      t.timestamps(true, true);
      t.unique(['table_id', 'slug']);
    });
  }

  private async ensureMetaMigrationsTable(
    buildSchema: () => Knex.SchemaBuilder,
    qualifiedMetaTables: string,
  ): Promise<void> {
    if (await buildSchema().hasTable(META_MIGRATIONS)) {
      return;
    }

    this.logger.log(`Creating ${META_MIGRATIONS}`);
    await buildSchema().createTable(META_MIGRATIONS, (t) => {
      t.string('id').primary();
      t.string('table_id')
        .nullable()
        .references('id')
        .inTable(qualifiedMetaTables)
        .onDelete('CASCADE');
      t.text('job_id').notNullable();
      t.text('operation').notNullable();
      t.text('statement').notNullable();
      t.text('status').notNullable();
      t.text('error').nullable();
      // No DB-level default: this table isn't written to by this story
      // (see Design Notes) -- Story 2's ddl-worker.ts sets created_at
      // explicitly on insert, same as every other _meta_ table's app-set id.
      t.timestamp('created_at').notNullable();
      t.timestamp('completed_at').nullable();
    });
  }

  // ------------------------------------------------------------------
  // CAP-1: create table
  // ------------------------------------------------------------------

  /**
   * Validates a create-table request synchronously (identifier safety +
   * AD-10's reserved `_meta_` prefix), then enqueues a `create-table` DDL
   * job and returns its id. Does NOT touch the tenant schema itself --
   * `ddl-worker.ts` executes the actual `CREATE TABLE` and writes the
   * `_meta_tables`/`_meta_fields` rows once the DDL succeeds (this keeps
   * DDL entirely off the request/response path, per AD-4).
   */
  async enqueueCreateTable(dto: CreateTableDto): Promise<{ jobId: string }> {
    const tableName = this.sanitizeUserTableName(dto.name);

    const fields = dto.fields.map((field) => ({
      name: this.sanitizeUserIdentifier(field.name),
      dataType: field.dataType,
      required: field.required ?? false,
      config: field.config ?? null,
    }));

    await this.ensureMetaTables();

    const jobId = randomUUID();
    const tableId = randomUUID();

    const jobData: CreateTableJobData = {
      kind: 'create-table',
      jobId,
      tenantId: this.tenantContext.tenantId,
      tableId,
      tableName,
      description: dto.description ?? null,
      fields,
    };

    await this.enqueueDdlJob(jobId, jobData);

    return { jobId };
  }

  // ------------------------------------------------------------------
  // CAP-2: add/remove/modify fields
  // ------------------------------------------------------------------

  /**
   * Validates a field-edit request synchronously, builds the DDL step
   * sequence (`buildFieldEditSteps()`), and enqueues a `field-edit` job.
   * Additive edits (`add`, `remove`) become a single step; a `modify` whose
   * `dataType` changes becomes a 3-step expand/contract sequence -- never a
   * single in-place `ALTER ... TYPE` (spec Boundaries).
   *
   * `tableId` is the `_meta_tables` row's cuid (AD-6), used only as a
   * parameterized `WHERE id = ?` value via Knex -- never interpolated into
   * DDL/DML text, so it deliberately does NOT go through
   * `sanitizeIdentifier()` (that function guards Postgres *identifiers*
   * placed directly into statement text, e.g. table/column names; a cuid
   * bound as a query parameter is a different, already-safe trust
   * boundary, and cuids legitimately contain characters
   * `sanitizeIdentifier()`'s allowlist would reject).
   */
  async enqueueFieldEdit(
    tableId: string,
    dto: UpdateFieldDto,
  ): Promise<{ jobId: string }> {
    const tableRow = await this.findMetaTableOrThrow(tableId);

    const steps: FieldEditStep[] = [];
    const metadataEffects: FieldMetadataEffect[] = [];

    for (const edit of dto.edits) {
      const { steps: editSteps, effect } = this.buildFieldEditSteps(
        tableRow.id,
        edit,
      );
      steps.push(...editSteps);
      metadataEffects.push(effect);
    }

    const jobId = randomUUID();
    const jobData: FieldEditJobData = {
      kind: 'field-edit',
      jobId,
      tenantId: this.tenantContext.tenantId,
      tableId: tableRow.id,
      tableName: tableRow.name,
      steps,
      metadataEffects,
    };

    await this.enqueueDdlJob(jobId, jobData);

    return { jobId };
  }

  /**
   * Builds the DDL step(s) + metadata-row effect for one field-edit
   * operation. `modify`'s destructive branch (a `dataType` change) derives
   * a shadow-column name and MUST run it through `sanitizeIdentifier()`
   * before it can ever reach a job payload -- an over-length shadow name
   * (a field name legally under the 63-byte cap whose derived shadow name
   * pushes past it) is rejected synchronously here (400, no job enqueued),
   * not discovered by the worker after retries are exhausted. See this
   * story's Spec Change Log finding (1).
   */
  private buildFieldEditSteps(
    tableId: string,
    edit: FieldEditDto,
  ): { steps: FieldEditStep[]; effect: FieldMetadataEffect } {
    const columnName = this.sanitizeUserIdentifier(edit.name);

    if (edit.operation === 'remove') {
      return {
        steps: [{ kind: 'drop-column', columnName }],
        effect: { kind: 'remove-field', slug: columnName },
      };
    }

    if (edit.operation === 'add') {
      if (!edit.dataType) {
        throw new BadRequestException({
          error: 'VALIDATION_ERROR',
          message: `Field "${edit.name}": dataType is required for an "add" edit`,
        });
      }

      const required = edit.required ?? false;
      const config = edit.config ?? null;

      return {
        steps: [
          {
            kind: 'add-column',
            columnName,
            dataType: edit.dataType,
            required,
            config,
          },
        ],
        effect: {
          kind: 'upsert-field',
          name: edit.name,
          slug: columnName,
          dataType: edit.dataType,
          required,
          config,
        },
      };
    }

    // edit.operation === 'modify'
    if (!edit.dataType) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: `Field "${edit.name}": dataType is required for a "modify" edit`,
      });
    }

    const required = edit.required ?? false;
    const config = edit.config ?? null;

    // Destructive/type-changing edit: expand/contract, never a single
    // in-place ALTER ... TYPE. The shadow column name is derived from the
    // original (already-sanitized) column name -- re-validate the DERIVED
    // name too, since concatenating a suffix can push an under-the-cap
    // field name over sanitizeIdentifier()'s 63-byte limit even though the
    // original name alone passed.
    const shadowColumnName = this.buildShadowColumnName(columnName);

    return {
      steps: [
        {
          kind: 'add-shadow-column',
          shadowColumnName,
          dataType: edit.dataType,
          required,
          config,
        },
        {
          kind: 'backfill-column',
          sourceColumnName: columnName,
          shadowColumnName,
        },
        {
          kind: 'cutover-column',
          sourceColumnName: columnName,
          shadowColumnName,
          finalColumnName: columnName,
        },
      ],
      effect: {
        kind: 'upsert-field',
        name: edit.name,
        slug: columnName,
        dataType: edit.dataType,
        required,
        config,
      },
    };
  }

  /**
   * Derives a shadow-column name for a destructive `modify` edit and runs
   * it through `sanitizeIdentifier()` before it can be placed in a job
   * payload. Throws `BadRequestException` (400, caught by the controller's
   * normal validation path -- no job enqueued) rather than letting an
   * over-length name reach `ddl-worker.ts`, where it would only surface as
   * a confusing failure after every retry attempt is exhausted.
   */
  private buildShadowColumnName(columnName: string): string {
    const candidate = `${columnName}${SHADOW_COLUMN_SUFFIX}`;
    try {
      return sanitizeIdentifier(candidate);
    } catch {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message:
          `Field "${columnName}": the shadow column name generated for this ` +
          `destructive edit ("${candidate}") exceeds Postgres's 63-byte ` +
          'identifier limit. Use a shorter field name.',
      });
    }
  }

  // ------------------------------------------------------------------
  // Job status polling
  // ------------------------------------------------------------------

  /**
   * Looks up a DDL job's status for `GET /api/tables/jobs/:jobId`. Rejects
   * (404, identical shape to an unknown job id) a job whose `data.tenantId`
   * does not match the caller's own `TenantContext.tenantId` -- a job's
   * status/error details must never be visible to a tenant other than the
   * one that created it (this story's Spec Change Log finding (3)).
   */
  async getJobStatus(jobId: string): Promise<JobStatusResult> {
    const job = await this.ddlQueue.getJob(jobId);

    if (!job || job.data.tenantId !== this.tenantContext.tenantId) {
      throw new NotFoundException({
        error: 'NOT_FOUND',
        message: `No job found with id ${jobId}`,
      });
    }

    const state = await job.getState();

    return {
      jobId,
      status: this.mapJobState(state),
      error: job.failedReason ?? null,
    };
  }

  private mapJobState(
    state: string,
  ): 'pending' | 'processing' | 'completed' | 'failed' {
    switch (state) {
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      case 'active':
        return 'processing';
      default:
        // waiting, delayed, waiting-children, prioritized, unknown, etc.
        return 'pending';
    }
  }

  // ------------------------------------------------------------------
  // Shared helpers
  // ------------------------------------------------------------------

  /** AD-10: rejects a tenant-chosen table name starting with `_meta_`, before running it through sanitizeIdentifier(). */
  private sanitizeUserTableName(name: string): string {
    if (name.startsWith(RESERVED_TABLE_PREFIX)) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: `Table name "${name}" is reserved (the "${RESERVED_TABLE_PREFIX}" prefix is used by this module's own metadata tables)`,
      });
    }

    return this.sanitizeUserIdentifier(name);
  }

  /**
   * `sanitizeIdentifier()` throws a plain `Error`, not an `HttpException` --
   * left uncaught, the global `HttpExceptionFilter` maps it to a `500`
   * instead of the `400` every caller of this module expects for an
   * unsafe/invalid user-supplied identifier (spec I/O matrix). Every call
   * site that validates a user-supplied table/column name (table name,
   * field names) must go through this wrapper, not `sanitizeIdentifier()`
   * directly.
   */
  private sanitizeUserIdentifier(name: string): string {
    try {
      return sanitizeIdentifier(name);
    } catch (error) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: (error as Error).message,
      });
    }
  }

  private async enqueueDdlJob(jobId: string, data: DdlJobData): Promise<void> {
    const retryCount = this.configService.get<number>('DDL_JOB_RETRY_COUNT');

    await this.ddlQueue.add(data.kind, data, {
      jobId,
      attempts: retryCount,
      backoff: { type: 'exponential', delay: 1000 },
    });
  }

  private async findMetaTableOrThrow(
    tableId: string,
  ): Promise<{ id: string; name: string }> {
    const row = await this.tenantKnexService
      .forCurrentTenant()
      .table(META_TABLES)
      .where({ id: tableId })
      .first();

    if (!row) {
      throw new NotFoundException({
        error: 'NOT_FOUND',
        message: `No dynamic table found with id ${tableId}`,
      });
    }

    return { id: row.id, name: row.name };
  }
}
