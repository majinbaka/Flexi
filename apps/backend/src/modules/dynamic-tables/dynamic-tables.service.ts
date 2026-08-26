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
import {
  DynamicTableCatalogItemDto,
  DynamicTableCatalogPageDto,
  DynamicTableCatalogQueryDto,
  DynamicTableDdlJobAcceptedDto,
  DynamicTableDdlJobDto,
  DynamicTableDetailDto,
  DynamicTableFieldDefinitionDto,
  DynamicTableRowPageDto,
  DynamicTableRowQueryDto,
  FieldDataType,
  NotImplementedStatus,
} from '@flexi/shared-types';
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
  FieldValidationRule,
  ResolvedRowListQuery,
  TableValidationSchema,
} from './dynamic-tables.types';

const META_TABLES = '_meta_tables';
const META_FIELDS = '_meta_fields';
const META_MIGRATIONS = '_meta_migrations';
const CATALOG_DEFAULT_PAGE = 1;
const CATALOG_DEFAULT_PAGE_SIZE = 20;
const ROW_DEFAULT_PAGE = 1;
const ROW_DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_TABLES_PER_TENANT = 50;
const DEFAULT_MAX_FIELDS_PER_TABLE = 100;
const DEFAULT_MAX_MUTATION_PAYLOAD_BYTES = 65536;
const DEFAULT_MAX_PAGE_SIZE = 100;

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

/** @deprecated Use `DynamicTableDdlJobDto` from `@flexi/shared-types`. */
export type JobStatusResult = DynamicTableDdlJobDto;

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

  /**
   * In-memory validation-schema cache, keyed by `_meta_tables.id`, per
   * AD-5: generated once per table (lazily, on first row-route access) and
   * invalidated/rebuilt synchronously by `enqueueFieldEdit()` whenever a
   * field edit is accepted -- never rebuilt per DML request. Per-backend-
   * instance, no Redis (AD-5's accepted cross-instance-staleness tradeoff).
   */
  private readonly validationSchemaCache = new Map<
    string,
    TableValidationSchema
  >();

  constructor(
    private readonly tenantKnexService: TenantKnexService,
    private readonly tenantContext: TenantContext,
    private readonly configService: ConfigService,
    @InjectQueue(DDL_QUEUE_NAME) private readonly ddlQueue: Queue<DdlJobData>,
  ) {}

  getStatus(): NotImplementedStatus {
    return { status: 'not-implemented' };
  }

  // ------------------------------------------------------------------
  // Runtime metadata reads
  // ------------------------------------------------------------------

  /**
   * Returns one page of the current tenant's runtime-table catalog. Runtime
   * metadata lives exclusively in the tenant schema's `_meta_tables` table;
   * the public-schema Prisma `DynamicTable` model is intentionally not read
   * here, because it is not the source of truth for the DDL worker.
   */
  async listTables(
    query: DynamicTableCatalogQueryDto = {},
  ): Promise<DynamicTableCatalogPageDto> {
    const page = this.parseCatalogPositiveInteger(
      query.page,
      CATALOG_DEFAULT_PAGE,
      'page',
    );
    const requestedPageSize = this.parseCatalogPositiveInteger(
      query.pageSize,
      CATALOG_DEFAULT_PAGE_SIZE,
      'pageSize',
    );
    const maxPageSize = this.getGuardrailLimit(
      'DYNAMIC_TABLES_MAX_PAGE_SIZE',
      DEFAULT_MAX_PAGE_SIZE,
    );
    if (requestedPageSize > maxPageSize) {
      throw this.guardrailExceeded(
        'DYNAMIC_TABLES_PAGE_SIZE_EXCEEDED',
        `pageSize must not exceed ${maxPageSize}`,
      );
    }
    const pageSize = requestedPageSize;

    // Use fresh scoped builders for the independent count and page queries.
    // Both are built through TenantKnexService, so schema qualification always
    // comes from the authenticated TenantContext rather than a request header.
    const [countRows, rows] = await Promise.all([
      this.tenantKnexService
        .forCurrentTenant()
        .table(META_TABLES)
        .count<{ count: string }[]>({ count: '*' }),
      this.tenantKnexService
        .forCurrentTenant()
        .table(META_TABLES)
        .select('id', 'name', 'slug', 'description', 'created_at', 'updated_at')
        .orderBy('created_at', 'desc')
        .orderBy('id', 'asc')
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ]);

    return {
      items: rows.map((row: Record<string, unknown>) =>
        this.mapCatalogItem(row),
      ),
      meta: {
        total: Number(countRows[0]?.count ?? 0),
        page,
        pageSize,
      },
    };
  }

  /**
   * Reads one table and all of its field definitions from the caller's own
   * tenant schema. A table id owned by another tenant is indistinguishable
   * from a missing id because this query is scoped before the `WHERE` clause.
   */
  async getTableDetail(tableId: string): Promise<DynamicTableDetailDto> {
    const tableRow = await this.tenantKnexService
      .forCurrentTenant()
      .table(META_TABLES)
      .where({ id: tableId })
      .first();

    if (!tableRow) {
      throw new NotFoundException({
        error: 'NOT_FOUND',
        message: `No dynamic table found with id ${tableId}`,
      });
    }

    const fieldRows = await this.tenantKnexService
      .forCurrentTenant()
      .table(META_FIELDS)
      .where({ table_id: tableRow.id })
      .select(
        'id',
        'table_id',
        'name',
        'slug',
        'data_type',
        'required',
        'relation_target_table_id',
        'config',
        'created_at',
        'updated_at',
      )
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc');

    return {
      ...this.mapCatalogItem(tableRow),
      fields: fieldRows.map((row: Record<string, unknown>) =>
        this.mapFieldDefinition(row),
      ),
    };
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
  async enqueueCreateTable(
    dto: CreateTableDto,
  ): Promise<DynamicTableDdlJobAcceptedDto> {
    this.assertMutationPayloadSize(dto);
    this.assertFieldDefinitionCount(dto.fields.length);
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

    await this.enqueueCreateTableWithinLimit(jobId, jobData);

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
  ): Promise<DynamicTableDdlJobAcceptedDto> {
    this.assertMutationPayloadSize(dto);
    const tableRow = await this.findMetaTableOrThrow(tableId);

    const steps: FieldEditStep[] = [];
    const metadataEffects: FieldMetadataEffect[] = [];

    for (const edit of dto.edits) {
      const { steps: editSteps, effect } = await this.buildFieldEditSteps(
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

    await this.enqueueFieldEditWithinLimit(jobId, jobData);

    // AD-5: the very next DML request against this table must validate
    // against the rebuilt schema (post-edit), not a stale cached one. The
    // cache entry is invalidated here, synchronously, after the edit's own
    // validation has succeeded and the job is enqueued -- not deferred
    // until the (asynchronous) DDL job actually completes. This matches
    // this story's Boundaries: "rebuilt synchronously inside
    // enqueueFieldEdit() after a successful validation, before the job is
    // enqueued". A subsequent getOrBuildValidationSchema() call lazily
    // rebuilds from `_meta_fields` the next time it's needed.
    this.invalidateValidationSchema(tableRow.id);

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
   *
   * Async since a `RELATION` "add" edit (Story 4/CAP-4) must resolve
   * `relatedTableId` via `findMetaTableOrThrow()` -- the same 404 shape as
   * an unknown `tableId` -- before any DDL job is enqueued. A `modify` edit
   * that would change a field's `dataType` to or from `RELATION` is
   * rejected synchronously (400) instead of being built into a step at all
   * (spec's "Never" boundary -- converting a live column to/from an FK is
   * out of scope; removing and re-adding the field is the supported
   * workaround), which requires reading the field's CURRENT `dataType` from
   * `_meta_fields` here too.
   */
  private async buildFieldEditSteps(
    tableId: string,
    edit: FieldEditDto,
  ): Promise<{ steps: FieldEditStep[]; effect: FieldMetadataEffect }> {
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

      if (edit.dataType === FieldDataType.RELATION) {
        if (!edit.relatedTableId) {
          throw new BadRequestException({
            error: 'VALIDATION_ERROR',
            message: `Field "${edit.name}": relatedTableId is required for a RELATION field`,
          });
        }

        // Validate the target table exists in the SAME tenant schema
        // before any DDL job is enqueued (404, same shape as an unknown
        // tableId) -- findMetaTableOrThrow() only ever queries the
        // caller's own current-tenant schema (TenantKnexService.
        // forCurrentTenant()), so a cross-tenant relatedTableId simply
        // can't resolve to a row here.
        const targetTable = await this.findMetaTableOrThrow(
          edit.relatedTableId,
        );

        return {
          steps: [
            {
              kind: 'add-relation-column',
              columnName,
              targetTableName: targetTable.name,
              required,
            },
          ],
          effect: {
            kind: 'upsert-field',
            name: edit.name,
            slug: columnName,
            dataType: edit.dataType,
            required,
            config,
            relationTargetTableId: targetTable.id,
          },
        };
      }

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

    // Reject a modify edit that would change a field's dataType to or from
    // RELATION, synchronously (400, before any step is built/job enqueued)
    // -- spec's "Never" boundary. Converting to RELATION requires the
    // dataType being set to RELATION on this edit; converting away from
    // RELATION requires reading the field's CURRENT dataType, since the
    // edit's own `edit.dataType` only ever describes the NEW type.
    if (edit.dataType === FieldDataType.RELATION) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: `Field "${edit.name}": changing an existing field's dataType to RELATION via "modify" is not supported -- remove and re-add the field instead`,
      });
    }

    const currentField = await this.tenantKnexService
      .forCurrentTenant()
      .table(META_FIELDS)
      .where({ table_id: tableId, slug: columnName })
      .first();

    if (currentField?.data_type === FieldDataType.RELATION) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: `Field "${edit.name}": changing an existing RELATION field's dataType away from RELATION via "modify" is not supported -- remove and re-add the field instead`,
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
  // CAP-3: validation-schema generation + cache (AD-5)
  // ------------------------------------------------------------------

  /**
   * Returns the cached `TableValidationSchema` for `tableId`, building and
   * caching it first if this is the first row-route access since the last
   * cache miss/invalidation (AD-5: generated once per table, lazily, never
   * rebuilt per DML request). Reads `_meta_fields` via
   * `TenantKnexService.forCurrentTenant()` -- the sole DML owner's own
   * tenancy-layer entry point (AD-2/AD-3), never a second path.
   */
  private async getOrBuildValidationSchema(
    tableId: string,
  ): Promise<TableValidationSchema> {
    const cached = this.validationSchemaCache.get(tableId);
    if (cached) {
      return cached;
    }

    const fieldRows = await this.tenantKnexService
      .forCurrentTenant()
      .table(META_FIELDS)
      .where({ table_id: tableId });

    const fields: Record<string, FieldValidationRule> = {};
    for (const row of fieldRows) {
      const config = (row.config ?? {}) as Record<string, unknown>;
      fields[row.slug] = {
        slug: row.slug,
        dataType: row.data_type as FieldDataType,
        required: Boolean(row.required),
        minLength: this.readNumberConfig(config, 'minLength'),
        maxLength: this.readNumberConfig(config, 'maxLength'),
        min: this.readNumberConfig(config, 'min'),
        max: this.readNumberConfig(config, 'max'),
        enum: Array.isArray(config.enum)
          ? (config.enum as unknown[])
          : undefined,
        // Story 4/CAP-4: carries which _meta_tables row this RELATION
        // field points at, so the row-DML relation-resolving helper
        // (buildRowQuery()) knows which table/field to join against
        // without a second metadata round trip. undefined for every
        // non-relation field.
        relationTargetTableId:
          (row.relation_target_table_id as string | null) ?? undefined,
      };
    }

    const schema: TableValidationSchema = { tableId, fields };
    this.validationSchemaCache.set(tableId, schema);
    return schema;
  }

  private readNumberConfig(
    config: Record<string, unknown>,
    key: 'minLength' | 'maxLength' | 'min' | 'max',
  ): number | undefined {
    const value = config[key];
    return typeof value === 'number' ? value : undefined;
  }

  /**
   * Invalidates (drops) the cached schema entry for `tableId`, forcing the
   * next `getOrBuildValidationSchema()` call to rebuild it from
   * `_meta_fields`. Called synchronously by `enqueueFieldEdit()` after its
   * own validation succeeds, before returning (AD-5) -- so the very next
   * row DML request against this table validates against the rebuilt
   * schema, not a stale one.
   */
  private invalidateValidationSchema(tableId: string): void {
    this.validationSchemaCache.delete(tableId);
  }

  /**
   * Checks a row payload against a table's generated validation schema:
   * required fields (skipped per-field when `partial: true`, for PATCH),
   * `dataType` type-checking, and `config`-derived constraints
   * (`minLength`/`maxLength` for STRING/TEXT, `min`/`max` for NUMBER,
   * `enum` for SELECT). Collects every violation before throwing (rather
   * than failing on the first) so a caller sees the full set of problems
   * in one round trip, matching this codebase's existing DTO
   * `ValidationPipe` behavior. Throws `BadRequestException` with a
   * `"<fieldSlug>: <reason>"` field-error array as `message` -- picked up
   * by `HttpExceptionFilter`'s existing array-join path, no new error
   * shape (Design Notes).
   */
  private validateRowPayload(
    schema: TableValidationSchema,
    payload: Record<string, unknown>,
    options: { partial: boolean },
  ): void {
    const errors: string[] = [];

    for (const rule of Object.values(schema.fields)) {
      const hasValue = Object.prototype.hasOwnProperty.call(payload, rule.slug);
      const value = payload[rule.slug];

      if (!hasValue) {
        if (rule.required && !options.partial) {
          errors.push(`${rule.slug}: is required`);
        }
        continue;
      }

      if (value === null || value === undefined) {
        if (rule.required) {
          errors.push(`${rule.slug}: is required`);
        }
        continue;
      }

      const typeError = this.checkFieldType(rule, value);
      if (typeError) {
        errors.push(`${rule.slug}: ${typeError}`);
        continue;
      }

      errors.push(...this.checkFieldConstraints(rule, value));
    }

    if (errors.length > 0) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: errors,
      });
    }
  }

  /** Type-checks one field's value against its `dataType`, mirroring `ddl-worker.ts`'s `addTypedColumn()` mapping. */
  private checkFieldType(
    rule: FieldValidationRule,
    value: unknown,
  ): string | null {
    switch (rule.dataType) {
      case FieldDataType.STRING:
      case FieldDataType.TEXT:
      case FieldDataType.EMAIL:
      case FieldDataType.URL:
      case FieldDataType.SELECT:
        return typeof value === 'string' ? null : 'must be a string';
      case FieldDataType.NUMBER:
        return typeof value === 'number' && !Number.isNaN(value)
          ? null
          : 'must be a number';
      case FieldDataType.BOOLEAN:
        return typeof value === 'boolean' ? null : 'must be a boolean';
      case FieldDataType.DATE:
      case FieldDataType.DATETIME:
        return typeof value === 'string' && !Number.isNaN(Date.parse(value))
          ? null
          : 'must be a valid date string';
      case FieldDataType.JSON:
        return typeof value === 'object' ? null : 'must be a JSON object';
      case FieldDataType.RELATION:
        // A relation field's DML value is the target row's integer `id`
        // (matches `t.increments('id')`'s shape, ddl-worker.ts:141) or
        // `null` (handled earlier in validateRowPayload(), before this is
        // reached). Postgres's own FK constraint (ON DELETE SET NULL) is
        // the sole enforcer of referential integrity at write time -- no
        // service-layer existence re-check duplicating it (spec
        // Boundaries); a dangling value surfaces as a caught FK-violation
        // in createRow()/updateRow(), not here.
        return Number.isInteger(value) ? null : 'must be an integer id';
      default:
        return `unsupported data type "${rule.dataType as string}"`;
    }
  }

  /** Checks `config`-derived constraints (length/range/enum) for one field's already type-checked value. */
  private checkFieldConstraints(
    rule: FieldValidationRule,
    value: unknown,
  ): string[] {
    const errors: string[] = [];

    if (
      typeof value === 'string' &&
      rule.minLength !== undefined &&
      value.length < rule.minLength
    ) {
      errors.push(
        `${rule.slug}: must be at least ${rule.minLength} characters`,
      );
    }
    if (
      typeof value === 'string' &&
      rule.maxLength !== undefined &&
      value.length > rule.maxLength
    ) {
      errors.push(`${rule.slug}: must not exceed ${rule.maxLength} characters`);
    }
    if (
      typeof value === 'number' &&
      rule.min !== undefined &&
      value < rule.min
    ) {
      errors.push(`${rule.slug}: must be at least ${rule.min}`);
    }
    if (
      typeof value === 'number' &&
      rule.max !== undefined &&
      value > rule.max
    ) {
      errors.push(`${rule.slug}: must not exceed ${rule.max}`);
    }
    if (rule.enum !== undefined && !rule.enum.includes(value)) {
      errors.push(`${rule.slug}: must be one of ${JSON.stringify(rule.enum)}`);
    }

    return errors;
  }

  // ------------------------------------------------------------------
  // CAP-3/AD-2/AD-6: row DML (create/list/get/update/delete)
  // ------------------------------------------------------------------

  /**
   * `POST /api/tables/:tableId/rows` (201). Resolves `tableId` through
   * `_meta_tables` (never trusted as a literal table name -- AD-2/AD-6),
   * validates the full payload against the table's cached/generated schema
   * (required fields checked, since this is not a partial write), then
   * inserts via `TenantKnexService.forCurrentTenant().table(tableName)` --
   * a parameterized Knex call, never string-concatenated raw SQL.
   *
   * A dangling `RELATION` value (an id with no matching target row) is
   * rejected by Postgres's own FK constraint, not a service-layer
   * existence re-check (spec Boundaries) -- the catch below reshapes that
   * FK-violation (`23503`) into the same field-error `BadRequestException`
   * envelope every other validation failure uses, rather than letting it
   * surface as a raw `500`.
   */
  async createRow(
    tableId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.assertMutationPayloadSize(payload);
    const tableRow = await this.findMetaTableOrThrow(tableId);
    const schema = await this.getOrBuildValidationSchema(tableRow.id);
    const data = this.pickKnownFields(schema, payload);
    this.validateRowPayload(schema, data, { partial: false });

    try {
      const [row] = await this.tenantKnexService
        .forCurrentTenant()
        .table(tableRow.name)
        .insert(data)
        .returning('*');

      return row;
    } catch (error) {
      throw this.reshapeForeignKeyViolation(error);
    }
  }

  /**
   * `GET /api/tables/:tableId/rows` (200, page). The service always queries
   * one bounded page; it never materializes a tenant table in memory. Every
   * `RELATION` field is resolved by `buildRowQuery()`'s shared `leftJoin` +
   * `json_agg` helper -- one additional join per relation field, never one
   * query per row.
   */
  async listRows(
    tableId: string,
    queryDto: DynamicTableRowQueryDto = {},
  ): Promise<DynamicTableRowPageDto> {
    const tableRow = await this.findMetaTableOrThrow(tableId);
    const schema = await this.getOrBuildValidationSchema(tableRow.id);
    const queryOptions = this.resolveRowListQuery(queryDto, schema);

    // buildRowQuery() is wrapped in `{ query }` (not returned bare) --
    // a Knex.QueryBuilder is itself thenable, so `await`-ing an async
    // function's return value that IS the builder would trigger the
    // builder's own `.then()` (executing it) as part of Promise
    // resolution, rather than handing back the still-unexecuted builder to
    // chain further `.where()`/`.first()` calls onto (verified against a
    // live Knex instance while implementing this story -- it throws
    // "Unable to acquire a connection" instead of yielding the builder).
    const { query } = await this.buildRowQuery(tableRow.name, schema);
    this.applyRowListFilters(query, tableRow.name, queryOptions);

    if (queryOptions.sortBy) {
      query.orderBy(
        `${tableRow.name}.${queryOptions.sortBy}`,
        queryOptions.sortDirection,
      );
    }
    // A user-selected field is not necessarily unique. Appending the primary
    // key makes page boundaries deterministic when values are tied.
    query
      .orderBy(`${tableRow.name}.id`, 'asc')
      .limit(queryOptions.pageSize)
      .offset((queryOptions.page - 1) * queryOptions.pageSize);

    const countQuery = this.tenantKnexService
      .forCurrentTenant()
      .table(tableRow.name)
      .count<{ count: string }[]>({ count: '*' });
    this.applyRowListFilters(countQuery, tableRow.name, queryOptions);

    const [rows, countRows] = await Promise.all([
      query as Promise<Record<string, unknown>[]>,
      countQuery,
    ]);

    return {
      items: rows.map((row) => this.shapeRelationColumns(row, schema)),
      meta: {
        total: Number(countRows[0]?.count ?? 0),
        page: queryOptions.page,
        pageSize: queryOptions.pageSize,
      },
    };
  }

  /**
   * `GET /api/tables/:tableId/rows/:rowId` (200). 404s (same shape as
   * `findMetaTableOrThrow()`) when `rowId` doesn't match an existing row.
   * Resolves `RELATION` fields the same way `listRows()` does, sharing
   * `buildRowQuery()` rather than duplicating the join-building logic.
   */
  async getRow(
    tableId: string,
    rowId: string,
  ): Promise<Record<string, unknown>> {
    const tableRow = await this.findMetaTableOrThrow(tableId);
    const schema = await this.getOrBuildValidationSchema(tableRow.id);

    // See listRows()'s comment on why buildRowQuery()'s result is
    // destructured out of a `{ query }` wrapper rather than awaited bare.
    const { query } = await this.buildRowQuery(tableRow.name, schema);
    const row = await query.where(`${tableRow.name}.id`, rowId).first();

    if (!row) {
      throw new NotFoundException({
        error: 'NOT_FOUND',
        message: `No row found with id ${rowId}`,
      });
    }

    return this.shapeRelationColumns(row, schema);
  }

  /**
   * `PATCH /api/tables/:tableId/rows/:rowId` (200). Partial validation --
   * only the fields present in `payload` are checked (required-field
   * checks are skipped, per the spec's I/O matrix: "only cache-validated
   * fields checked"). Reads the schema via `getOrBuildValidationSchema()`
   * on every call, so a request arriving after a Story-2 field edit
   * validates against the rebuilt schema, not a stale cached one.
   *
   * A dangling `RELATION` value is rejected by Postgres's own FK
   * constraint, reshaped into the same field-error `BadRequestException`
   * envelope `createRow()` uses (spec I/O matrix: "same reshaped field-error
   * envelope createRow uses, not a raw 500") -- shared via
   * `reshapeForeignKeyViolation()` rather than duplicating the try/catch.
   */
  async updateRow(
    tableId: string,
    rowId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.assertMutationPayloadSize(payload);
    const tableRow = await this.findMetaTableOrThrow(tableId);
    await this.findRowOrThrow(tableRow.name, rowId);

    const schema = await this.getOrBuildValidationSchema(tableRow.id);
    const data = this.pickKnownFields(schema, payload);
    this.validateRowPayload(schema, data, { partial: true });

    if (Object.keys(data).length === 0) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: ['no updatable fields provided'],
      });
    }

    try {
      const [row] = await this.tenantKnexService
        .forCurrentTenant()
        .table(tableRow.name)
        .where({ id: rowId })
        .update(data)
        .returning('*');

      return row;
    } catch (error) {
      throw this.reshapeForeignKeyViolation(error);
    }
  }

  /**
   * Whitelists `payload` down to keys present in the table's generated
   * schema (i.e. actual `_meta_fields` slugs) before it ever reaches
   * validation or a Knex insert/update. Without this, a caller could pass
   * `id`, `created_at`, `updated_at`, or any other physical column name not
   * declared as a field, bypassing the auto-increment primary key /
   * system-managed timestamps or writing columns the validation schema
   * never checked -- a mass-assignment gap, not a defense-in-depth nicety.
   */
  private pickKnownFields(
    schema: TableValidationSchema,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: ['payload must be a JSON object'],
      });
    }

    const data: Record<string, unknown> = {};
    for (const slug of Object.keys(schema.fields)) {
      if (Object.prototype.hasOwnProperty.call(payload, slug)) {
        data[slug] = payload[slug];
      }
    }
    return data;
  }

  /** `DELETE /api/tables/:tableId/rows/:rowId` (204). */
  async deleteRow(tableId: string, rowId: string): Promise<void> {
    const tableRow = await this.findMetaTableOrThrow(tableId);
    await this.findRowOrThrow(tableRow.name, rowId);

    await this.tenantKnexService
      .forCurrentTenant()
      .table(tableRow.name)
      .where({ id: rowId })
      .delete();
  }

  /** Shared 404 for `getRow`/`updateRow`/`deleteRow` -- same error shape as `findMetaTableOrThrow()`'s unknown-table 404. */
  private async findRowOrThrow(
    tableName: string,
    rowId: string,
  ): Promise<Record<string, unknown>> {
    const row = await this.tenantKnexService
      .forCurrentTenant()
      .table(tableName)
      .where({ id: rowId })
      .first();

    if (!row) {
      throw new NotFoundException({
        error: 'NOT_FOUND',
        message: `No row found with id ${rowId}`,
      });
    }

    return row;
  }

  /**
   * Reshapes a Postgres foreign-key-violation error (SQLSTATE `23503` --
   * raised when a `RELATION` field's value doesn't match any row in its
   * target table) into the same field-error `BadRequestException` envelope
   * every other row-validation failure uses (spec Boundaries: "Postgres FK
   * violation caught and reshaped, not a raw 500"). Any other error
   * (a real infra failure, an unrelated constraint) is re-thrown unchanged
   * -- this only narrows the one specific, expected-at-write-time case.
   * Shared by `createRow()`/`updateRow()` rather than duplicated.
   */
  private reshapeForeignKeyViolation(error: unknown): unknown {
    const code = (error as { code?: string } | undefined)?.code;
    if (code !== '23503') {
      return error;
    }

    return new BadRequestException({
      error: 'VALIDATION_ERROR',
      message: [
        'one or more relation fields reference a row that does not exist',
      ],
    });
  }

  // ------------------------------------------------------------------
  // Story 4/CAP-4: relation-field resolution (leftJoin + json_agg)
  // ------------------------------------------------------------------

  /**
   * Shared by `listRows()`/`getRow()` (spec Code Map: "share the
   * join-building logic between both methods (one private helper) rather
   * than duplicating it"). Builds one query selecting every physical
   * column of `tableName` plus, for each `RELATION` field found on
   * `schema`, one `leftJoin` against that field's target table aggregated
   * via `json_agg` into a single JSON column aliased to the field's slug --
   * exactly one additional join per relation field, never a per-row query
   * (AD-2/AD-6's "still through `TenantKnexService.forCurrentTenant()` only"
   * boundary).
   *
   * Returns `{ query }` -- a plain object wrapping the builder, NOT the
   * builder itself -- because `Knex.QueryBuilder` is thenable; an `async`
   * method returning it bare would have its own `.then()` invoked as part
   * of the caller's `await` (Promise resolution recursively chains
   * thenables), executing the query prematurely instead of handing back a
   * still-unexecuted builder the caller can chain `.where()`/`.first()`
   * onto.
   *
   * `json_agg` naturally returns an array; since CAP-4 is many-to-one
   * (AD-7), each join can resolve to at most one target row, and
   * `shapeRelationColumns()` unwraps that array down to a single object (or
   * `null`) before the row is returned to the caller.
   */
  private async buildRowQuery(
    tableName: string,
    schema: TableValidationSchema,
  ): Promise<{ query: Knex.QueryBuilder }> {
    const relationRules = Object.values(schema.fields).filter(
      (rule) =>
        rule.dataType === FieldDataType.RELATION && rule.relationTargetTableId,
    );

    let query = this.tenantKnexService
      .forCurrentTenant()
      .table(tableName)
      .select(`${tableName}.*`);

    if (relationRules.length === 0) {
      return { query };
    }

    const targetTables = await this.resolveRelationTargetTables(
      relationRules.map((rule) => rule.relationTargetTableId!),
    );

    for (const rule of relationRules) {
      const targetTableName = targetTables.get(rule.relationTargetTableId!);
      // A target table row can be missing only if `_meta_tables` itself was
      // altered out from under a still-cached validation schema (schema
      // cache invalidation is synchronous on every field edit, per AD-5) --
      // skip resolving this one relation defensively rather than throwing,
      // so the rest of the row still comes back.
      if (!targetTableName) {
        continue;
      }

      const joinAlias = `${rule.slug}__rel`;
      query = query
        .leftJoin(
          `${targetTableName} as ${joinAlias}`,
          `${joinAlias}.id`,
          `${tableName}.${rule.slug}`,
        )
        .select(
          this.tenantKnexService.raw(
            'json_agg(??) filter (where ?? is not null) as ??',
            [`${joinAlias}.*`, `${joinAlias}.id`, rule.slug],
          ),
        );
    }

    // Grouping only by tableName.id (the PK) while SELECT tableName.* pulls
    // every other physical column unaggregated relies on Postgres's
    // primary-key functional-dependency exception to GROUP BY's usual rule
    // (every non-aggregated selected column must appear in GROUP BY) -- valid
    // specifically because `id` is this table's actual primary key
    // (t.increments('id')), so every other column is functionally determined
    // by it. This is a Postgres-specific relaxation, not standard SQL.
    if (relationRules.length > 0) {
      query = query.groupBy(`${tableName}.id`);
    }

    return { query };
  }

  /**
   * Resolves each relation's target `_meta_tables.id` to its physical table
   * name in one query (never one lookup per relation field per row) --
   * distinct from `findMetaTableOrThrow()`, which 404s on a miss; a missing
   * target here is handled by `buildRowQuery()` skipping that one relation.
   */
  private async resolveRelationTargetTables(
    tableIds: string[],
  ): Promise<Map<string, string>> {
    const uniqueIds = Array.from(new Set(tableIds));
    const rows: Array<{ id: string; name: string }> =
      await this.tenantKnexService
        .forCurrentTenant()
        .table(META_TABLES)
        .whereIn('id', uniqueIds)
        .select('id', 'name');

    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /**
   * Unwraps each relation slug's `json_agg` array (built by
   * `buildRowQuery()`) down to a single `{ id, ...targetRowFields }` object,
   * or `null` when the relation is unset/the target row is missing
   * (`ON DELETE SET NULL`, or the FK column itself is `null`) -- per spec
   * Boundaries: "Row responses embed a resolved relation as
   * `{ id, ...targetRowFields }` under the field's slug (`null` when
   * unset), alongside the existing raw FK-id column."
   */
  private shapeRelationColumns(
    row: Record<string, unknown>,
    schema: TableValidationSchema,
  ): Record<string, unknown> {
    const relationSlugs = Object.values(schema.fields)
      .filter((rule) => rule.dataType === FieldDataType.RELATION)
      .map((rule) => rule.slug);

    if (relationSlugs.length === 0) {
      return row;
    }

    const shaped = { ...row };
    for (const slug of relationSlugs) {
      const aggregated = shaped[slug];
      shaped[slug] =
        Array.isArray(aggregated) && aggregated.length > 0
          ? aggregated[0]
          : null;
    }
    return shaped;
  }

  // ------------------------------------------------------------------
  // Shared helpers
  // ------------------------------------------------------------------

  private parseCatalogPositiveInteger(
    value: number | undefined,
    defaultValue: number,
    field: 'page' | 'pageSize',
  ): number {
    if (value === undefined) {
      return defaultValue;
    }

    if (!Number.isInteger(value) || value <= 0) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: `${field} must be a positive integer.`,
        fields: { [field]: `${field.toUpperCase()}_INVALID` },
      });
    }

    return value;
  }

  /** Applies page defaults and rejects query values before they reach Knex. */
  private resolveRowListQuery(
    query: DynamicTableRowQueryDto,
    schema: TableValidationSchema,
  ): ResolvedRowListQuery {
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      throw this.invalidRowQuery('query must be an object');
    }

    const page = this.parseRowPositiveInteger(
      query.page,
      ROW_DEFAULT_PAGE,
      'page',
    );
    const requestedPageSize = this.parseRowPositiveInteger(
      query.pageSize,
      ROW_DEFAULT_PAGE_SIZE,
      'pageSize',
    );
    const maxPageSize = this.getGuardrailLimit(
      'DYNAMIC_TABLES_MAX_PAGE_SIZE',
      DEFAULT_MAX_PAGE_SIZE,
    );
    if (requestedPageSize > maxPageSize) {
      throw this.guardrailExceeded(
        'DYNAMIC_TABLES_PAGE_SIZE_EXCEEDED',
        `pageSize must not exceed ${maxPageSize}`,
      );
    }

    let sortBy: string | undefined;
    if (query.sortBy !== undefined) {
      if (!schema.fields[query.sortBy]) {
        throw this.invalidRowQuery('sortBy must name a table field', 'sortBy');
      }
      sortBy = this.sanitizeRowQueryIdentifier(query.sortBy, 'sortBy');
    }
    if (
      query.sortDirection !== undefined &&
      query.sortDirection !== 'asc' &&
      query.sortDirection !== 'desc'
    ) {
      throw this.invalidRowQuery(
        'sortDirection must be either "asc" or "desc"',
        'sortDirection',
      );
    }

    const requestedFilters = query.filters ?? {};
    if (
      !requestedFilters ||
      typeof requestedFilters !== 'object' ||
      Array.isArray(requestedFilters)
    ) {
      throw this.invalidRowQuery('filters must be an object', 'filters');
    }
    const filters: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(requestedFilters)) {
      const rule = schema.fields[field];
      if (!rule) {
        throw this.invalidRowQuery(
          `filters.${field} must name a table field`,
          'filters',
        );
      }
      if (value !== null && this.checkFieldType(rule, value)) {
        throw this.invalidRowQuery(
          `filters.${field} has an invalid value`,
          'filters',
        );
      }
      filters[this.sanitizeRowQueryIdentifier(field, 'filters')] = value;
    }

    return {
      page,
      pageSize: requestedPageSize,
      sortBy,
      sortDirection: query.sortDirection ?? 'asc',
      filters,
    };
  }

  /**
   * AD-3: `sortBy` and every `filters` key end up interpolated into a
   * `<table>.<column>` identifier string that Knex cannot parameterize, so
   * they go through the module's single identifier choke point like any
   * other user-supplied column name. Looking the name up in
   * `schema.fields` is a metadata check, not an identifier check -- it
   * would silently stop re-confirming `sanitizeIdentifier()`'s invariants
   * (character allowlist, 63-byte NAMEDATALEN cap) if the way
   * `schema.fields` is built ever changed. Failures are reported as the
   * row-query `400` shape rather than `sanitizeUserIdentifier()`'s generic
   * one so the client still learns which query parameter was rejected.
   */
  private sanitizeRowQueryIdentifier(
    name: string,
    field: 'sortBy' | 'filters',
  ): string {
    try {
      return sanitizeIdentifier(name);
    } catch (error) {
      throw this.invalidRowQuery((error as Error).message, field);
    }
  }

  private parseRowPositiveInteger(
    value: number | undefined,
    defaultValue: number,
    field: 'page' | 'pageSize',
  ): number {
    if (value === undefined) {
      return defaultValue;
    }
    if (!Number.isInteger(value) || value <= 0) {
      throw this.invalidRowQuery(`${field} must be a positive integer`, field);
    }
    return value;
  }

  private invalidRowQuery(
    message: string,
    field?: 'page' | 'pageSize' | 'sortBy' | 'sortDirection' | 'filters',
  ): BadRequestException {
    return new BadRequestException({
      error: 'VALIDATION_ERROR',
      message,
      ...(field
        ? { fields: { [field]: `${field.toUpperCase()}_INVALID` } }
        : {}),
    });
  }

  /**
   * Applies exact-match filters. Every key was resolved through
   * `sanitizeRowQueryIdentifier()` by `resolveRowListQuery()`, so the
   * interpolated column identifiers are already choke-point validated.
   */
  private applyRowListFilters(
    query: Knex.QueryBuilder,
    tableName: string,
    options: ResolvedRowListQuery,
  ): void {
    for (const [field, value] of Object.entries(options.filters)) {
      const column = `${tableName}.${field}`;
      if (value === null) {
        query.whereNull(column);
      } else {
        // Values were checked against the runtime field rule above. Knex's
        // public value union cannot express arbitrary JSON-field values,
        // despite PostgreSQL accepting the bound JSON parameter.
        query.where(column, value as never);
      }
    }
  }

  private mapCatalogItem(
    row: Record<string, unknown>,
  ): DynamicTableCatalogItemDto {
    return {
      id: String(row.id),
      name: String(row.name),
      slug: String(row.slug),
      description: typeof row.description === 'string' ? row.description : null,
      createdAt: this.toIsoTimestamp(row.created_at),
      updatedAt: this.toIsoTimestamp(row.updated_at),
    };
  }

  private mapFieldDefinition(
    row: Record<string, unknown>,
  ): DynamicTableFieldDefinitionDto {
    return {
      id: String(row.id),
      tableId: String(row.table_id),
      name: String(row.name),
      slug: String(row.slug),
      dataType: row.data_type as FieldDataType,
      required: Boolean(row.required),
      relationTargetTableId:
        typeof row.relation_target_table_id === 'string'
          ? row.relation_target_table_id
          : null,
      config: this.toMetadataConfig(row.config),
      createdAt: this.toIsoTimestamp(row.created_at),
      updatedAt: this.toIsoTimestamp(row.updated_at),
    };
  }

  private toMetadataConfig(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private toIsoTimestamp(value: unknown): string {
    if (value instanceof Date) {
      return value.toISOString();
    }

    // PostgreSQL's node driver normally returns `Date`, but accepting an
    // already-serialized timestamp keeps this mapping correct for tests and
    // alternative driver configurations without leaking a non-string value.
    return String(value);
  }

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

  /**
   * Serializes table-create admission per tenant schema. The advisory lock is
   * held until the queue write succeeds, so another API instance cannot read
   * the same table count and admit a competing request in the meantime.
   *
   * Metadata rows appear only once the DDL worker completes. Therefore the
   * check includes waiting/active create jobs as reservations; otherwise two
   * requests could both observe the same metadata count before either job
   * creates its table. Completed jobs need not be counted because their
   * metadata row is committed before BullMQ marks them completed.
   */
  private async enqueueCreateTableWithinLimit(
    jobId: string,
    data: CreateTableJobData,
  ): Promise<void> {
    const maximum = this.getGuardrailLimit(
      'DYNAMIC_TABLES_MAX_TABLES_PER_TENANT',
      DEFAULT_MAX_TABLES_PER_TENANT,
    );

    await this.tenantKnexService.transaction(async (trx) => {
      await this.acquireTenantGuardrailLock(trx, 'tables');

      const [countRows, pendingJobs] = await Promise.all([
        this.tenantKnexService
          .forCurrentTenant()
          .table(META_TABLES)
          .count<{ count: string }[]>({ count: '*' })
          .transacting(trx),
        this.getPendingDdlJobs(),
      ]);
      const pendingCreates = pendingJobs.filter(
        (job) =>
          job.kind === 'create-table' &&
          job.tenantId === this.tenantContext.tenantId,
      ).length;
      const existing = Number(countRows[0]?.count ?? 0);

      if (existing + pendingCreates >= maximum) {
        throw this.guardrailExceeded(
          'DYNAMIC_TABLES_TABLE_LIMIT_EXCEEDED',
          `A tenant may have at most ${maximum} dynamic tables`,
        );
      }

      // This must remain inside the advisory-lock transaction. The queue's
      // durable waiting job is the reservation observed by the next caller.
      await this.enqueueDdlJob(jobId, data);
    });
  }

  /** Applies the same serialized admission pattern to additions of fields. */
  private async enqueueFieldEditWithinLimit(
    jobId: string,
    data: FieldEditJobData,
  ): Promise<void> {
    const additionsInRequest = this.countFieldAdditions(data);
    if (additionsInRequest === 0) {
      await this.enqueueDdlJob(jobId, data);
      return;
    }

    const maximum = this.getGuardrailLimit(
      'DYNAMIC_TABLES_MAX_FIELDS_PER_TABLE',
      DEFAULT_MAX_FIELDS_PER_TABLE,
    );

    await this.tenantKnexService.transaction(async (trx) => {
      await this.acquireTenantGuardrailLock(trx, `fields:${data.tableId}`);

      const [countRows, pendingJobs] = await Promise.all([
        this.tenantKnexService
          .forCurrentTenant()
          .table(META_FIELDS)
          .where({ table_id: data.tableId })
          .count<{ count: string }[]>({ count: '*' })
          .transacting(trx),
        this.getPendingDdlJobs(),
      ]);
      const pendingAdditions = pendingJobs
        .filter(
          (job): job is FieldEditJobData =>
            job.kind === 'field-edit' &&
            job.tenantId === this.tenantContext.tenantId &&
            job.tableId === data.tableId,
        )
        .reduce((total, job) => total + this.countFieldAdditions(job), 0);
      const existing = Number(countRows[0]?.count ?? 0);

      if (existing + pendingAdditions + additionsInRequest > maximum) {
        throw this.guardrailExceeded(
          'DYNAMIC_TABLES_FIELD_LIMIT_EXCEEDED',
          `A dynamic table may have at most ${maximum} fields`,
        );
      }

      await this.enqueueDdlJob(jobId, data);
    });
  }

  private async acquireTenantGuardrailLock(
    trx: Knex.Transaction,
    resource: string,
  ): Promise<void> {
    // The lock key is a bound value, never SQL interpolation. xact locks are
    // released automatically on commit/rollback, including queue failures.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [
      `dynamic-tables:${this.tenantContext.schema}:${resource}`,
    ]);
  }

  private async getPendingDdlJobs(): Promise<DdlJobData[]> {
    const jobs = await this.ddlQueue.getJobs(['wait', 'active', 'delayed']);
    return jobs.map((job) => job.data);
  }

  private countFieldAdditions(data: FieldEditJobData): number {
    return data.steps.filter(
      (step) =>
        step.kind === 'add-column' || step.kind === 'add-relation-column',
    ).length;
  }

  private assertFieldDefinitionCount(count: number): void {
    const maximum = this.getGuardrailLimit(
      'DYNAMIC_TABLES_MAX_FIELDS_PER_TABLE',
      DEFAULT_MAX_FIELDS_PER_TABLE,
    );
    if (count > maximum) {
      throw this.guardrailExceeded(
        'DYNAMIC_TABLES_FIELD_LIMIT_EXCEEDED',
        `A dynamic table may have at most ${maximum} fields`,
      );
    }
  }

  private assertMutationPayloadSize(payload: unknown): void {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      throw this.guardrailExceeded(
        'DYNAMIC_TABLES_MUTATION_PAYLOAD_INVALID',
        'Mutation payload must be JSON-serializable',
      );
    }

    if (typeof serialized !== 'string') {
      throw this.guardrailExceeded(
        'DYNAMIC_TABLES_MUTATION_PAYLOAD_INVALID',
        'Mutation payload must be JSON-serializable',
      );
    }

    const maximum = this.getGuardrailLimit(
      'DYNAMIC_TABLES_MAX_MUTATION_PAYLOAD_BYTES',
      DEFAULT_MAX_MUTATION_PAYLOAD_BYTES,
    );
    if (Buffer.byteLength(serialized, 'utf8') > maximum) {
      throw this.guardrailExceeded(
        'DYNAMIC_TABLES_MUTATION_PAYLOAD_TOO_LARGE',
        `Mutation payload must not exceed ${maximum} bytes`,
      );
    }
  }

  private getGuardrailLimit(key: string, fallback: number): number {
    return this.configService.get<number>(key) ?? fallback;
  }

  private guardrailExceeded(
    error: string,
    message: string,
  ): BadRequestException {
    return new BadRequestException({ error, message });
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
