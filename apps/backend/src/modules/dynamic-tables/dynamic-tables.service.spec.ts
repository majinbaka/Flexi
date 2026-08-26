import { Knex } from 'knex';
import { Queue } from 'bullmq';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamicTablesService } from './dynamic-tables.service';
import { TenantKnexService } from '../../tenancy/tenant-knex.service';
import { TenantContext } from '../../tenancy/tenant-context';
import { DdlJobData } from './dynamic-tables.types';

/**
 * Story 1's bootstrap-migration tests below construct `DynamicTablesService`
 * directly; Story 2 added three more constructor dependencies
 * (`TenantContext`, `ConfigService`, the injected `ddl` `Queue`). This
 * factory keeps every existing `ensureMetaTables()` test unchanged in intent
 * while satisfying the new constructor shape -- callers that only exercise
 * `ensureMetaTables()`/`getStatus()` never touch the new mocks.
 */
function buildService(
  tenantKnexService: TenantKnexService,
  overrides?: {
    tenantContext?: Partial<TenantContext>;
    configService?: Partial<ConfigService>;
    ddlQueue?: Partial<Queue<DdlJobData>>;
  },
): DynamicTablesService {
  const tenantContext = (overrides?.tenantContext ?? {}) as TenantContext;
  const configService = (overrides?.configService ?? {
    get: jest.fn(),
  }) as unknown as ConfigService;
  const ddlQueue = (overrides?.ddlQueue ?? {}) as Queue<DdlJobData>;

  return new DynamicTablesService(
    tenantKnexService,
    tenantContext,
    configService,
    ddlQueue,
  );
}

/**
 * Covers Story 1's bootstrap-migration acceptance criteria: correct
 * table/column shape requested via a mocked
 * `TenantKnexService.schemaForCurrentTenant()` for all three tables (not
 * just `_meta_tables`), each FK column's `.onDelete('CASCADE')`, the three
 * `createTable` calls running inside one `TenantKnexService.transaction()`,
 * and idempotency (a second invocation is a no-op when `hasTable()` already
 * returns true). Story 2 adds CAP-1/2 enqueue + job-status coverage further
 * below.
 */
describe('DynamicTablesService', () => {
  describe('getStatus', () => {
    it('still returns the not-implemented placeholder (no regression to the stub route)', () => {
      const tenantKnexService = {} as TenantKnexService;
      const service = buildService(tenantKnexService);

      expect(service.getStatus()).toEqual({ status: 'not-implemented' });
    });
  });

  describe('ensureMetaTables', () => {
    /** Fake ColumnBuilder-style chain that records every method call. */
    function buildColumnChainFactory(recorder: ColumnCallRecorder) {
      const chain: Record<string, jest.Mock> = {};
      const methods = [
        'primary',
        'notNullable',
        'nullable',
        'unique',
        'defaultTo',
        'references',
        'inTable',
        'onDelete',
      ];
      for (const method of methods) {
        chain[method] = jest.fn((...args: unknown[]) => {
          recorder.record(method, args);
          return chain;
        });
      }
      return chain as unknown as Knex.ColumnBuilder;
    }

    interface ColumnCallRecorder {
      columns: string[];
      calls: { column: string; method: string; args: unknown[] }[];
      record: (method: string, args: unknown[]) => void;
      currentColumn: string;
    }

    function buildTableBuilder(): {
      tableBuilder: Knex.CreateTableBuilder;
      recorder: ColumnCallRecorder;
    } {
      const recorder: ColumnCallRecorder = {
        columns: [],
        calls: [],
        currentColumn: '',
        record(method, args) {
          this.calls.push({ column: this.currentColumn, method, args });
        },
      };

      const columnFactory =
        (type: string) =>
        (name: string, ...rest: unknown[]) => {
          recorder.columns.push(name);
          recorder.currentColumn = name;
          recorder.calls.push({
            column: name,
            method: `type:${type}`,
            args: rest,
          });
          return buildColumnChainFactory(recorder);
        };

      const tableBuilder = {
        string: columnFactory('string'),
        text: columnFactory('text'),
        boolean: columnFactory('boolean'),
        jsonb: columnFactory('jsonb'),
        timestamp: columnFactory('timestamp'),
        timestamps: jest.fn(() => {
          recorder.columns.push('created_at', 'updated_at');
        }),
        unique: jest.fn((cols: string[]) => {
          recorder.calls.push({
            column: cols.join(','),
            method: 'table:unique',
            args: [cols],
          });
        }),
      } as unknown as Knex.CreateTableBuilder;

      return { tableBuilder, recorder };
    }

    function buildMockSchema(hasTableResult: boolean) {
      const createTable = jest.fn().mockReturnThis();
      const hasTable = jest.fn().mockResolvedValue(hasTableResult);
      const transacting = jest.fn().mockReturnThis();

      const schema = {
        hasTable,
        createTable,
        transacting,
      } as unknown as Knex.SchemaBuilder;

      return { schema, hasTable, createTable, transacting };
    }

    function buildTenantKnexService(schema: Knex.SchemaBuilder) {
      return {
        schemaForCurrentTenant: jest.fn().mockReturnValue(schema),
        transaction: jest.fn(
          async (fn: (trx: Knex.Transaction) => Promise<void>) =>
            fn({} as Knex.Transaction),
        ),
      } as unknown as TenantKnexService;
    }

    it('runs the bootstrap inside one TenantKnexService.transaction()', async () => {
      const { schema } = buildMockSchema(false);
      const tenantKnexService = buildTenantKnexService(schema);
      const service = buildService(tenantKnexService);

      await service.ensureMetaTables();

      expect(tenantKnexService.transaction).toHaveBeenCalledTimes(1);
      // A fresh Knex.SchemaBuilder is fetched for every single hasTable()/
      // createTable() statement (never one shared builder instance reused
      // across awaits -- reusing one replays its whole statement history
      // against real Postgres, a real bug this story's e2e test caught).
      // 3 tables x (1 hasTable + 1 createTable, since none exist yet) = 6.
      expect(schema.transacting).toHaveBeenCalledTimes(6);
    });

    it('creates _meta_tables, _meta_fields, and _meta_migrations when none exist yet', async () => {
      const { schema, hasTable, createTable } = buildMockSchema(false);
      const tenantKnexService = buildTenantKnexService(schema);
      const service = buildService(tenantKnexService);

      await service.ensureMetaTables();

      // One schemaForCurrentTenant() call per statement (see the
      // "fresh builder per statement" note above), not per table.
      expect(tenantKnexService.schemaForCurrentTenant).toHaveBeenCalledTimes(6);
      expect(hasTable).toHaveBeenCalledWith('_meta_tables');
      expect(hasTable).toHaveBeenCalledWith('_meta_fields');
      expect(hasTable).toHaveBeenCalledWith('_meta_migrations');
      expect(createTable).toHaveBeenCalledTimes(3);

      const createdTableNames = createTable.mock.calls.map(
        ([name]: [string]) => name,
      );
      expect(createdTableNames).toEqual([
        '_meta_tables',
        '_meta_fields',
        '_meta_migrations',
      ]);
    });

    it("builds _meta_tables with AD-10's pinned columns", async () => {
      const { schema, createTable } = buildMockSchema(false);
      const tenantKnexService = buildTenantKnexService(schema);
      const service = buildService(tenantKnexService);

      await service.ensureMetaTables();

      const [, callback] = createTable.mock.calls[0];
      const { tableBuilder, recorder } = buildTableBuilder();
      callback(tableBuilder);

      expect(recorder.columns).toEqual(
        expect.arrayContaining([
          'id',
          'name',
          'slug',
          'description',
          'created_at',
          'updated_at',
        ]),
      );
    });

    it("builds _meta_fields with AD-10's pinned columns, CASCADE FKs, and the table_id+slug unique constraint", async () => {
      const { schema, createTable } = buildMockSchema(false);
      const tenantKnexService = buildTenantKnexService(schema);
      const service = buildService(tenantKnexService);

      await service.ensureMetaTables();

      const [, callback] = createTable.mock.calls[1];
      const { tableBuilder, recorder } = buildTableBuilder();
      callback(tableBuilder);

      expect(recorder.columns).toEqual(
        expect.arrayContaining([
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
        ]),
      );

      const cascadeColumns = recorder.calls
        .filter((c) => c.method === 'onDelete' && c.args[0] === 'CASCADE')
        .map((c) => c.column);
      expect(cascadeColumns).toEqual(
        expect.arrayContaining(['table_id', 'relation_target_table_id']),
      );

      const uniqueCall = recorder.calls.find(
        (c) => c.method === 'table:unique',
      );
      expect(uniqueCall?.args[0]).toEqual(['table_id', 'slug']);

      // Regression guard: `.inTable(x)` for a cross-table FK does NOT
      // inherit the schema-builder's own `.withSchema()` scoping --
      // an unqualified `.inTable('_meta_tables')` resolves via Postgres's
      // `search_path` (defaulting to `public`) rather than the tenant
      // schema, and fails with "relation does not exist" even though
      // `_meta_tables` was created moments earlier in the same
      // transaction (verified against live Postgres during this story).
      // Every `.inTable()` call referencing `_meta_tables` must pass a
      // schema-qualified name, never the bare `_meta_tables` constant.
      const inTableCalls = recorder.calls.filter((c) => c.method === 'inTable');
      expect(inTableCalls.length).toBeGreaterThan(0);
      for (const call of inTableCalls) {
        expect(call.args[0]).not.toBe('_meta_tables');
        expect(call.args[0]).toEqual(expect.stringContaining('_meta_tables'));
        expect(call.args[0]).toEqual(expect.stringContaining('.'));
      }
    });

    it("builds _meta_migrations with AD-10's pinned columns and a CASCADE table_id FK", async () => {
      const { schema, createTable } = buildMockSchema(false);
      const tenantKnexService = buildTenantKnexService(schema);
      const service = buildService(tenantKnexService, {
        tenantContext: { schema: 'tenant_abc123' },
      });

      await service.ensureMetaTables();

      const [, callback] = createTable.mock.calls[2];
      const { tableBuilder, recorder } = buildTableBuilder();
      callback(tableBuilder);

      expect(recorder.columns).toEqual(
        expect.arrayContaining([
          'id',
          'table_id',
          'job_id',
          'operation',
          'statement',
          'status',
          'error',
          'created_at',
          'completed_at',
        ]),
      );

      const inTableCall = recorder.calls.find((c) => c.method === 'inTable');
      expect(inTableCall?.args[0]).toBe('tenant_abc123._meta_tables');

      const cascadeColumns = recorder.calls
        .filter((c) => c.method === 'onDelete' && c.args[0] === 'CASCADE')
        .map((c) => c.column);
      expect(cascadeColumns).toEqual(expect.arrayContaining(['table_id']));
    });

    it('is idempotent: a second invocation with hasTable() returning true creates nothing', async () => {
      const { schema, hasTable, createTable } = buildMockSchema(true);
      const tenantKnexService = buildTenantKnexService(schema);
      const service = buildService(tenantKnexService);

      await service.ensureMetaTables();

      expect(hasTable).toHaveBeenCalledTimes(3);
      expect(createTable).not.toHaveBeenCalled();
    });

    it('still queries Postgres on every direct invocation -- the request-path bootstrap cache never short-circuits the provisioning call site', async () => {
      const { schema, hasTable } = buildMockSchema(true);
      const tenantKnexService = buildTenantKnexService(schema);
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: 'tenant-abc' },
      });

      await service.ensureMetaTables();
      await service.ensureMetaTables();

      expect(tenantKnexService.transaction).toHaveBeenCalledTimes(2);
      expect(hasTable).toHaveBeenCalledTimes(6);
    });
  });

  // ----------------------------------------------------------------------
  // Story 2: CAP-1 create table, CAP-2 field edits, job-status polling
  // ----------------------------------------------------------------------

  describe('enqueueCreateTable', () => {
    const TENANT_ID = 'tenant-abc';

    function buildTenantKnexServiceForEnqueue(
      hasTableResult = true,
      tableCount = 0,
    ) {
      const hasTable = jest.fn().mockResolvedValue(hasTableResult);
      const transacting = jest.fn().mockReturnThis();
      const schema = { hasTable, transacting } as unknown as Knex.SchemaBuilder;
      const count = jest.fn().mockReturnValue({
        transacting: jest
          .fn()
          .mockResolvedValue([{ count: String(tableCount) }]),
      });

      return {
        schemaForCurrentTenant: jest.fn().mockReturnValue(schema),
        transaction: jest.fn(
          async (fn: (trx: Knex.Transaction) => Promise<void>) =>
            fn({
              raw: jest.fn().mockResolvedValue(undefined),
            } as unknown as Knex.Transaction),
        ),
        forCurrentTenant: jest.fn().mockReturnValue({
          table: jest.fn().mockReturnValue({ count }),
        }),
      } as unknown as TenantKnexService;
    }

    function buildQueue(pendingJobs: DdlJobData[] = []) {
      return {
        add: jest.fn().mockResolvedValue(undefined),
        getJobs: jest
          .fn()
          .mockResolvedValue(pendingJobs.map((data) => ({ data }))),
      } as unknown as Queue;
    }

    it('rejects a table name starting with _meta_ synchronously -- no job enqueued', async () => {
      const tenantKnexService = buildTenantKnexServiceForEnqueue();
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });

      await expect(
        service.enqueueCreateTable({
          name: '_meta_foo',
          fields: [{ name: 'title', dataType: 'STRING' as never }],
        } as never),
      ).rejects.toThrow(BadRequestException);

      expect(ddlQueue.add).not.toHaveBeenCalled();
    });

    it('rejects an unsafe/invalid table identifier synchronously with a 400, not a 500 -- no job enqueued', async () => {
      const tenantKnexService = buildTenantKnexServiceForEnqueue();
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });

      await expect(
        service.enqueueCreateTable({
          name: 'bad name; DROP TABLE',
          fields: [{ name: 'title', dataType: 'STRING' as never }],
        } as never),
      ).rejects.toThrow(BadRequestException);

      expect(ddlQueue.add).not.toHaveBeenCalled();
    });

    it('rejects an unsafe/invalid field identifier synchronously with a 400, not a 500 -- no job enqueued', async () => {
      const tenantKnexService = buildTenantKnexServiceForEnqueue();
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });

      await expect(
        service.enqueueCreateTable({
          name: 'invoices',
          fields: [
            { name: 'bad name; DROP TABLE', dataType: 'STRING' as never },
          ],
        } as never),
      ).rejects.toThrow(BadRequestException);

      expect(ddlQueue.add).not.toHaveBeenCalled();
    });

    it('enqueues a create-table job carrying the caller tenantId and returns its jobId', async () => {
      const tenantKnexService = buildTenantKnexServiceForEnqueue();
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        configService: {
          get: jest.fn((key: string) =>
            key === 'DDL_JOB_RETRY_COUNT' ? 3 : undefined,
          ),
        },
        ddlQueue,
      });

      const result = await service.enqueueCreateTable({
        name: 'invoices',
        fields: [
          { name: 'title', dataType: 'STRING' as never, required: true },
        ],
      } as never);

      expect(result.jobId).toEqual(expect.any(String));
      expect(ddlQueue.add).toHaveBeenCalledTimes(1);
      const [, jobData, opts] = (ddlQueue.add as jest.Mock).mock.calls[0];
      expect(jobData).toMatchObject({
        kind: 'create-table',
        tenantId: TENANT_ID,
        tableName: 'invoices',
      });
      expect(opts).toMatchObject({ jobId: result.jobId, attempts: 3 });
    });

    it('runs the meta-table bootstrap once per tenant, not on every create-table request', async () => {
      const tenantKnexService = buildTenantKnexServiceForEnqueue();
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });
      const dto = {
        name: 'invoices',
        fields: [{ name: 'title', dataType: 'STRING' as never }],
      } as never;

      await service.enqueueCreateTable(dto);
      await service.enqueueCreateTable(dto);
      await service.enqueueCreateTable(dto);

      // One bootstrap = three `hasTable()` checks, each fetching a fresh
      // schema builder; the guardrail transaction never touches it.
      expect(tenantKnexService.schemaForCurrentTenant).toHaveBeenCalledTimes(3);
      expect(ddlQueue.add).toHaveBeenCalledTimes(3);
    });

    it('bootstraps once per tenant, not once per backend instance -- a second tenant still gets its own check', async () => {
      const tenantKnexService = buildTenantKnexServiceForEnqueue();
      const ddlQueue = buildQueue();
      const tenantContext = { tenantId: TENANT_ID };
      const service = buildService(tenantKnexService, {
        tenantContext,
        ddlQueue,
      });
      const dto = {
        name: 'invoices',
        fields: [{ name: 'title', dataType: 'STRING' as never }],
      } as never;

      await service.enqueueCreateTable(dto);
      tenantContext.tenantId = 'tenant-other';
      await service.enqueueCreateTable(dto);

      expect(tenantKnexService.schemaForCurrentTenant).toHaveBeenCalledTimes(6);
    });

    it('does not cache a failed bootstrap: the next create-table request retries it', async () => {
      const tenantKnexService = buildTenantKnexServiceForEnqueue();
      (tenantKnexService.transaction as jest.Mock).mockRejectedValueOnce(
        new Error('bootstrap boom'),
      );
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });
      const dto = {
        name: 'invoices',
        fields: [{ name: 'title', dataType: 'STRING' as never }],
      } as never;

      await expect(service.enqueueCreateTable(dto)).rejects.toThrow(
        'bootstrap boom',
      );
      expect(ddlQueue.add).not.toHaveBeenCalled();

      await service.enqueueCreateTable(dto);

      expect(tenantKnexService.schemaForCurrentTenant).toHaveBeenCalledTimes(3);
      expect(ddlQueue.add).toHaveBeenCalledTimes(1);
    });

    it('rejects a create when existing tables plus a queued reservation reach the tenant limit', async () => {
      const tenantKnexService = buildTenantKnexServiceForEnqueue(true, 0);
      const ddlQueue = buildQueue([
        {
          kind: 'create-table',
          jobId: 'waiting-create',
          tenantId: TENANT_ID,
          tableId: 'table-pending',
          tableName: 'pending',
          description: null,
          fields: [],
        },
      ]);
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID, schema: 'tenant_abc' },
        configService: {
          get: jest.fn((key: string) => {
            if (key === 'DYNAMIC_TABLES_MAX_TABLES_PER_TENANT') return 1;
            if (key === 'DDL_JOB_RETRY_COUNT') return 3;
            return undefined;
          }),
        },
        ddlQueue,
      });

      await expect(
        service.enqueueCreateTable({
          name: 'invoices',
          fields: [{ name: 'title', dataType: 'STRING' as never }],
        } as never),
      ).rejects.toThrow(BadRequestException);

      expect(ddlQueue.add).not.toHaveBeenCalled();
      expect(ddlQueue.getJobs).toHaveBeenCalledWith([
        'wait',
        'active',
        'delayed',
      ]);
    });

    it('rejects an oversized mutation body before bootstrap or queueing', async () => {
      const tenantKnexService = buildTenantKnexServiceForEnqueue();
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        configService: {
          get: jest.fn((key: string) =>
            key === 'DYNAMIC_TABLES_MAX_MUTATION_PAYLOAD_BYTES'
              ? 10
              : undefined,
          ),
        },
        ddlQueue,
      });

      await expect(
        service.enqueueCreateTable({
          name: 'invoices',
          fields: [{ name: 'title', dataType: 'STRING' as never }],
        } as never),
      ).rejects.toThrow(BadRequestException);

      expect(ddlQueue.add).not.toHaveBeenCalled();
      expect(tenantKnexService.transaction).not.toHaveBeenCalled();
    });

    it('rejects a create definition with more fields than the configured table limit', async () => {
      const tenantKnexService = buildTenantKnexServiceForEnqueue();
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        configService: {
          get: jest.fn((key: string) =>
            key === 'DYNAMIC_TABLES_MAX_FIELDS_PER_TABLE' ? 1 : undefined,
          ),
        },
        ddlQueue,
      });

      await expect(
        service.enqueueCreateTable({
          name: 'invoices',
          fields: [
            { name: 'title', dataType: 'STRING' as never },
            { name: 'notes', dataType: 'TEXT' as never },
          ],
        } as never),
      ).rejects.toThrow(BadRequestException);

      expect(ddlQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('enqueueFieldEdit', () => {
    const TENANT_ID = 'tenant-abc';
    const TABLE_ID = 'table-1';

    function buildTenantKnexServiceWithTable(
      row: { id: string; name: string } | null,
    ) {
      const first = jest.fn().mockResolvedValue(row);
      const where = jest.fn().mockReturnValue({ first });
      const count = jest.fn().mockReturnValue({
        transacting: jest.fn().mockResolvedValue([{ count: '0' }]),
      });
      const fieldsQuery = { count, first: jest.fn().mockResolvedValue(null) };
      const table = jest.fn((name: string) =>
        name === '_meta_fields'
          ? {
              where: jest.fn().mockReturnValue(fieldsQuery),
            }
          : { where },
      );

      return {
        forCurrentTenant: jest.fn().mockReturnValue({ table }),
        transaction: jest.fn(
          async (fn: (trx: Knex.Transaction) => Promise<void>) =>
            fn({
              raw: jest.fn().mockResolvedValue(undefined),
            } as unknown as Knex.Transaction),
        ),
      } as unknown as TenantKnexService;
    }

    function buildQueue() {
      return {
        add: jest.fn().mockResolvedValue(undefined),
        getJobs: jest.fn().mockResolvedValue([]),
      } as unknown as Queue;
    }

    it('404s when the target table id does not exist', async () => {
      const tenantKnexService = buildTenantKnexServiceWithTable(null);
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });

      await expect(
        service.enqueueFieldEdit(TABLE_ID, {
          edits: [{ operation: 'remove', name: 'title' } as never],
        } as never),
      ).rejects.toThrow();

      expect(ddlQueue.add).not.toHaveBeenCalled();
    });

    it('rejects an unsafe/invalid field identifier synchronously with a 400, not a 500 -- no job enqueued', async () => {
      const tenantKnexService = buildTenantKnexServiceWithTable({
        id: TABLE_ID,
        name: 'invoices',
      });
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });

      await expect(
        service.enqueueFieldEdit(TABLE_ID, {
          edits: [
            { operation: 'remove', name: 'bad name; DROP TABLE' } as never,
          ],
        } as never),
      ).rejects.toThrow(BadRequestException);

      expect(ddlQueue.add).not.toHaveBeenCalled();
    });

    it('builds a single ADD COLUMN step for an additive add edit', async () => {
      const tenantKnexService = buildTenantKnexServiceWithTable({
        id: TABLE_ID,
        name: 'invoices',
      });
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        configService: {
          get: jest.fn((key: string) =>
            key === 'DDL_JOB_RETRY_COUNT' ? 3 : undefined,
          ),
        },
        ddlQueue,
      });

      await service.enqueueFieldEdit(TABLE_ID, {
        edits: [
          {
            operation: 'add',
            name: 'notes',
            dataType: 'TEXT' as never,
            required: false,
          } as never,
        ],
      } as never);

      const [, jobData] = (ddlQueue.add as jest.Mock).mock.calls[0];
      expect(jobData.steps).toEqual([
        expect.objectContaining({ kind: 'add-column', columnName: 'notes' }),
      ]);
    });

    it('builds a 3-step expand/contract sequence for a destructive modify edit (never a single in-place ALTER)', async () => {
      const tenantKnexService = buildTenantKnexServiceWithTable({
        id: TABLE_ID,
        name: 'invoices',
      });
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        configService: {
          get: jest.fn((key: string) =>
            key === 'DDL_JOB_RETRY_COUNT' ? 3 : undefined,
          ),
        },
        ddlQueue,
      });

      await service.enqueueFieldEdit(TABLE_ID, {
        edits: [
          {
            operation: 'modify',
            name: 'amount',
            dataType: 'NUMBER' as never,
          } as never,
        ],
      } as never);

      const [, jobData] = (ddlQueue.add as jest.Mock).mock.calls[0];
      expect(jobData.steps.map((s: { kind: string }) => s.kind)).toEqual([
        'add-shadow-column',
        'backfill-column',
        'cutover-column',
      ]);
      expect(jobData.steps[0].shadowColumnName).toBe('amount__shadow');
    });

    it('rejects synchronously (no job enqueued) when a modify edit would derive a shadow-column name over 63 bytes', async () => {
      const longFieldName = 'a'.repeat(60); // 60 + '__shadow' (8) = 68 > 63
      const tenantKnexService = buildTenantKnexServiceWithTable({
        id: TABLE_ID,
        name: 'invoices',
      });
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });

      await expect(
        service.enqueueFieldEdit(TABLE_ID, {
          edits: [
            {
              operation: 'modify',
              name: longFieldName,
              dataType: 'NUMBER' as never,
            } as never,
          ],
        } as never),
      ).rejects.toThrow();

      expect(ddlQueue.add).not.toHaveBeenCalled();
    });

    it('accepts a modify edit whose field name is within the 63-byte cap but whose shadow name would not be, without silently truncating', async () => {
      // 56 chars + '__shadow' (8) = 64 > 63 -- exercises the boundary just
      // past the cap, distinct from the "obviously too long" case above.
      const boundaryFieldName = 'b'.repeat(56);
      const tenantKnexService = buildTenantKnexServiceWithTable({
        id: TABLE_ID,
        name: 'invoices',
      });
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });

      await expect(
        service.enqueueFieldEdit(TABLE_ID, {
          edits: [
            {
              operation: 'modify',
              name: boundaryFieldName,
              dataType: 'NUMBER' as never,
            } as never,
          ],
        } as never),
      ).rejects.toThrow();

      expect(ddlQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('enqueueFieldEdit -- RELATION fields (Story 4/CAP-4)', () => {
    const TENANT_ID = 'tenant-abc';
    const TABLE_ID = 'table-1';
    const TARGET_TABLE_ID = 'table-2';

    /**
     * Dispatches `_meta_tables` lookups by id -- distinct from
     * `buildTenantKnexServiceWithTable()` above (which always resolves the
     * same single row regardless of the queried id), since a RELATION
     * "add" edit resolves TWO different `_meta_tables` rows in the same
     * call: the source table (`tableId`) and the relation's target table
     * (`relatedTableId`).
     */
    function buildTenantKnexServiceWithTables(
      rows: Record<string, { id: string; name: string } | null>,
      fieldRow: Record<string, unknown> | null = null,
    ) {
      const table = jest.fn((name: string) => {
        if (name === '_meta_fields') {
          return {
            where: jest.fn().mockReturnValue({
              first: jest.fn().mockResolvedValue(fieldRow),
              count: jest.fn().mockReturnValue({
                transacting: jest.fn().mockResolvedValue([{ count: '0' }]),
              }),
            }),
          };
        }
        return {
          where: jest.fn((cond: { id: string }) => ({
            first: jest.fn().mockResolvedValue(rows[cond.id] ?? null),
          })),
        };
      });

      return {
        forCurrentTenant: jest.fn().mockReturnValue({ table }),
        transaction: jest.fn(
          async (fn: (trx: Knex.Transaction) => Promise<void>) =>
            fn({
              raw: jest.fn().mockResolvedValue(undefined),
            } as unknown as Knex.Transaction),
        ),
      } as unknown as TenantKnexService;
    }

    function buildQueue() {
      return {
        add: jest.fn().mockResolvedValue(undefined),
        getJobs: jest.fn().mockResolvedValue([]),
      } as unknown as Queue;
    }

    it('builds a single add-relation-column step + upsert-field effect carrying relationTargetTableId, for a valid relatedTableId in the same tenant', async () => {
      const tenantKnexService = buildTenantKnexServiceWithTables({
        [TABLE_ID]: { id: TABLE_ID, name: 'invoices' },
        [TARGET_TABLE_ID]: { id: TARGET_TABLE_ID, name: 'customers' },
      });
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        configService: {
          get: jest.fn((key: string) =>
            key === 'DDL_JOB_RETRY_COUNT' ? 3 : undefined,
          ),
        },
        ddlQueue,
      });

      await service.enqueueFieldEdit(TABLE_ID, {
        edits: [
          {
            operation: 'add',
            name: 'customer',
            dataType: 'RELATION' as never,
            relatedTableId: TARGET_TABLE_ID,
          } as never,
        ],
      } as never);

      const [, jobData] = (ddlQueue.add as jest.Mock).mock.calls[0];
      expect(jobData.steps).toEqual([
        expect.objectContaining({
          kind: 'add-relation-column',
          columnName: 'customer',
          targetTableName: 'customers',
          required: false,
        }),
      ]);
      expect(jobData.metadataEffects).toEqual([
        expect.objectContaining({
          kind: 'upsert-field',
          slug: 'customer',
          dataType: 'RELATION',
          relationTargetTableId: TARGET_TABLE_ID,
        }),
      ]);
    });

    it('404s (before any job is enqueued) when relatedTableId does not match an existing _meta_tables row', async () => {
      const tenantKnexService = buildTenantKnexServiceWithTables({
        [TABLE_ID]: { id: TABLE_ID, name: 'invoices' },
        // TARGET_TABLE_ID deliberately absent -- simulates an unknown
        // relatedTableId.
      });
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });

      let caught: unknown;
      try {
        await service.enqueueFieldEdit(TABLE_ID, {
          edits: [
            {
              operation: 'add',
              name: 'customer',
              dataType: 'RELATION' as never,
              relatedTableId: 'no-such-table',
            } as never,
          ],
        } as never);
      } catch (error) {
        caught = error;
      }

      // Same 404 shape as an unknown tableId (findMetaTableOrThrow() is
      // reused unchanged for both) -- spec: "N/A, 404, same shape as an
      // unknown tableId".
      expect(caught).toBeInstanceOf(NotFoundException);
      expect(ddlQueue.add).not.toHaveBeenCalled();
    });

    it('rejects with a 400 field-error naming the missing property when dataType is RELATION but relatedTableId is absent', async () => {
      const tenantKnexService = buildTenantKnexServiceWithTables({
        [TABLE_ID]: { id: TABLE_ID, name: 'invoices' },
      });
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });

      let caught: unknown;
      try {
        await service.enqueueFieldEdit(TABLE_ID, {
          edits: [
            {
              operation: 'add',
              name: 'customer',
              dataType: 'RELATION' as never,
            } as never,
          ],
        } as never);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(BadRequestException);
      const response = (caught as BadRequestException).getResponse() as {
        message: string;
      };
      expect(response.message).toContain('relatedTableId');
      expect(ddlQueue.add).not.toHaveBeenCalled();
    });

    it('rejects a "modify" edit setting dataType: RELATION synchronously (400), before any job is enqueued', async () => {
      const tenantKnexService = buildTenantKnexServiceWithTables({
        [TABLE_ID]: { id: TABLE_ID, name: 'invoices' },
      });
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });

      await expect(
        service.enqueueFieldEdit(TABLE_ID, {
          edits: [
            {
              operation: 'modify',
              name: 'customer',
              dataType: 'RELATION' as never,
            } as never,
          ],
        } as never),
      ).rejects.toThrow(BadRequestException);

      expect(ddlQueue.add).not.toHaveBeenCalled();
    });

    it('rejects a "modify" edit changing an existing RELATION field away from RELATION synchronously (400), before any job is enqueued', async () => {
      const tenantKnexService = buildTenantKnexServiceWithTables(
        { [TABLE_ID]: { id: TABLE_ID, name: 'invoices' } },
        {
          slug: 'customer',
          data_type: 'RELATION',
          required: false,
          config: null,
          relation_target_table_id: TARGET_TABLE_ID,
        },
      );
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });

      await expect(
        service.enqueueFieldEdit(TABLE_ID, {
          edits: [
            {
              operation: 'modify',
              name: 'customer',
              dataType: 'STRING' as never,
            } as never,
          ],
        } as never),
      ).rejects.toThrow(BadRequestException);

      expect(ddlQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('getJobStatus', () => {
    const TENANT_ID = 'tenant-abc';
    const OTHER_TENANT_ID = 'tenant-xyz';

    it('404s for an unknown job id', async () => {
      const tenantKnexService = {} as TenantKnexService;
      const ddlQueue = {
        getJob: jest.fn().mockResolvedValue(undefined),
      } as unknown as Queue;
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });

      await expect(service.getJobStatus('missing-job')).rejects.toThrow();
    });

    it('404s (same shape as unknown-job-id) when the job belongs to a different tenant', async () => {
      const tenantKnexService = {} as TenantKnexService;
      const job = {
        data: { tenantId: OTHER_TENANT_ID },
        getState: jest.fn().mockResolvedValue('completed'),
        failedReason: undefined,
      };
      const ddlQueue = {
        getJob: jest.fn().mockResolvedValue(job),
      } as unknown as Queue;
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });

      let caught: unknown;
      try {
        await service.getJobStatus('some-job');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeDefined();
      // Same NotFoundException shape as the unknown-job-id case -- a
      // cross-tenant job id must not be distinguishable from a nonexistent
      // one (this story's Spec Change Log finding (3)).
      const unknownJobService = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue: {
          getJob: jest.fn().mockResolvedValue(undefined),
        } as unknown as Queue,
      });
      let unknownCaught: unknown;
      try {
        await unknownJobService.getJobStatus('missing-job');
      } catch (error) {
        unknownCaught = error;
      }

      expect((caught as { status?: number }).constructor).toEqual(
        (unknownCaught as { constructor: unknown }).constructor,
      );
    });

    it('returns completed status for the caller own-tenant job', async () => {
      const tenantKnexService = {} as TenantKnexService;
      const job = {
        data: { tenantId: TENANT_ID },
        getState: jest.fn().mockResolvedValue('completed'),
        failedReason: undefined,
      };
      const ddlQueue = {
        getJob: jest.fn().mockResolvedValue(job),
      } as unknown as Queue;
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });

      const result = await service.getJobStatus('some-job');

      expect(result).toEqual({
        jobId: 'some-job',
        status: 'completed',
        error: null,
      });
    });

    it('maps an in-flight "active" BullMQ state to "processing"', async () => {
      const tenantKnexService = {} as TenantKnexService;
      const job = {
        data: { tenantId: TENANT_ID },
        getState: jest.fn().mockResolvedValue('active'),
        failedReason: undefined,
      };
      const ddlQueue = {
        getJob: jest.fn().mockResolvedValue(job),
      } as unknown as Queue;
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });

      const result = await service.getJobStatus('some-job');

      expect(result.status).toBe('processing');
    });

    it('surfaces failedReason for a failed job', async () => {
      const tenantKnexService = {} as TenantKnexService;
      const job = {
        data: { tenantId: TENANT_ID },
        getState: jest.fn().mockResolvedValue('failed'),
        failedReason: 'lock_timeout exceeded',
      };
      const ddlQueue = {
        getJob: jest.fn().mockResolvedValue(job),
      } as unknown as Queue;
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        ddlQueue,
      });

      const result = await service.getJobStatus('some-job');

      expect(result).toEqual({
        jobId: 'some-job',
        status: 'failed',
        error: 'lock_timeout exceeded',
      });
    });
  });

  // ----------------------------------------------------------------------
  // Story 3: row DML (createRow/listRows/getRow/updateRow/deleteRow) +
  // AD-5's generated-and-cached validation schema.
  // ----------------------------------------------------------------------

  describe('row DML', () => {
    const TENANT_ID = 'tenant-abc';
    const TABLE_ID = 'table-1';
    const TABLE_NAME = 'invoices';

    /**
     * Builds a `TenantKnexService` mock whose `forCurrentTenant().table(name)`
     * dispatches on the queried table name: `_meta_tables` resolves
     * `findMetaTableOrThrow()`/`resolveRelationTargetTables()`, `_meta_fields`
     * returns the field rows behind `getOrBuildValidationSchema()`, and the
     * data table itself (`TABLE_NAME`) drives insert/update/delete/first/
     * returning/array iteration for the DML methods under test.
     *
     * `metaTablesRows` (Story 4/CAP-4) backs `resolveRelationTargetTables()`'s
     * `.whereIn('id', ...).select('id', 'name')` -- distinct from
     * `metaTableRow`, which is the SOURCE table `findMetaTableOrThrow()`
     * resolves; a relation test needs both the source table row AND one or
     * more target `_meta_tables` rows visible at once.
     */
    function buildTenantKnexServiceForRows(options: {
      metaTableRow?: { id: string; name: string } | null;
      fieldRows?: Record<string, unknown>[];
      existingRow?: Record<string, unknown> | null;
      insertedRow?: Record<string, unknown>;
      updatedRow?: Record<string, unknown>;
      dataRows?: Record<string, unknown>[];
      metaTablesRows?: { id: string; name: string }[];
    }) {
      const {
        metaTableRow = { id: TABLE_ID, name: TABLE_NAME },
        fieldRows = [],
        existingRow = { id: 'row-1' },
        insertedRow = { id: 'row-1' },
        updatedRow = { id: 'row-1' },
        dataRows = [],
        metaTablesRows = metaTableRow ? [metaTableRow] : [],
      } = options;

      const insertReturning = jest.fn().mockResolvedValue([insertedRow]);
      const insert = jest.fn().mockReturnValue({ returning: insertReturning });

      const updateReturning = jest.fn().mockResolvedValue([updatedRow]);
      const updateFn = jest
        .fn()
        .mockReturnValue({ returning: updateReturning });
      const updateWhere = jest.fn().mockReturnValue({
        update: updateFn,
      });

      const deleteFn = jest.fn().mockResolvedValue(1);
      const deleteWhere = jest.fn().mockReturnValue({ delete: deleteFn });

      const countBuilder: Record<string, unknown> = {
        where: jest.fn(() => countBuilder),
        whereNull: jest.fn(() => countBuilder),
        then: (resolve: (rows: { count: string }[]) => void) =>
          resolve([{ count: String(dataRows.length) }]),
      };
      const count = jest.fn(() => countBuilder);
      const orderBy = jest.fn();
      const limit = jest.fn();
      const offset = jest.fn();
      const whereNull = jest.fn();

      const firstFn = jest.fn().mockResolvedValue(existingRow);
      const findWhere = jest.fn().mockReturnValue({ first: firstFn });

      const table = jest.fn((name: string) => {
        if (name === '_meta_tables') {
          return {
            where: jest.fn().mockReturnValue({
              first: jest.fn().mockResolvedValue(metaTableRow),
            }),
            whereIn: jest.fn().mockReturnValue({
              select: jest.fn().mockResolvedValue(metaTablesRows),
            }),
          };
        }
        if (name === '_meta_fields') {
          const fieldsQuery = {
            count: jest.fn().mockReturnValue({
              transacting: jest
                .fn()
                .mockResolvedValue([{ count: String(fieldRows.length) }]),
            }),
            then: (resolve: (rows: Record<string, unknown>[]) => void) =>
              resolve(fieldRows),
          };
          return {
            where: jest.fn().mockReturnValue(fieldsQuery),
          };
        }
        // Data table: supports insert (create), where().first() (row
        // lookup), where().update().returning() (update), where().delete()
        // (delete), and buildRowQuery()'s chainable select()/leftJoin()/
        // groupBy() (Story 4/CAP-4) resolving to `dataRows` when awaited
        // directly (list) or narrowed via .where(...).first() (get).
        const dataTableBuilder: Record<string, unknown> = {
          insert,
          select: jest.fn(() => dataTableBuilder),
          leftJoin: jest.fn(() => dataTableBuilder),
          groupBy: jest.fn(() => dataTableBuilder),
          orderBy: jest.fn((...args: unknown[]) => {
            orderBy(...args);
            return dataTableBuilder;
          }),
          limit: jest.fn((...args: unknown[]) => {
            limit(...args);
            return dataTableBuilder;
          }),
          offset: jest.fn((...args: unknown[]) => {
            offset(...args);
            return dataTableBuilder;
          }),
          whereNull: jest.fn((...args: unknown[]) => {
            whereNull(...args);
            return dataTableBuilder;
          }),
          count,
          where: jest.fn((cond: unknown, value?: unknown) => {
            if (typeof cond === 'object' && cond !== null && 'id' in cond) {
              return {
                first: firstFn,
                update: updateFn,
                delete: deleteFn,
              };
            }
            if (typeof cond === 'string') {
              if (value !== undefined && cond !== `${TABLE_NAME}.id`) {
                return dataTableBuilder;
              }
              // buildRowQuery()'s `.where(`${tableName}.id`, rowId)` form
              // used by getRow() -- resolves the same existingRow fixture.
              return { first: firstFn };
            }
            return findWhere(cond);
          }),
          then: (resolve: (rows: Record<string, unknown>[]) => void) =>
            resolve(dataRows),
        };
        return dataTableBuilder;
      });

      return {
        forCurrentTenant: jest.fn().mockReturnValue({ table }),
        transaction: jest.fn(
          async (fn: (trx: Knex.Transaction) => Promise<void>) =>
            fn({
              raw: jest.fn().mockResolvedValue(undefined),
            } as unknown as Knex.Transaction),
        ),
        raw: jest.fn((sql: string) => ({ sql })),
        table,
        insert,
        insertReturning,
        updateWhere,
        updateFn,
        updateReturning,
        deleteWhere,
        deleteFn,
        count,
        orderBy,
        limit,
        offset,
        whereNull,
        firstFn,
      } as unknown as TenantKnexService & {
        table: jest.Mock;
        insert: jest.Mock;
        updateFn: jest.Mock;
        count: jest.Mock;
        orderBy: jest.Mock;
        limit: jest.Mock;
        offset: jest.Mock;
        whereNull: jest.Mock;
      };
    }

    function buildQueue() {
      return {
        add: jest.fn(),
        getJobs: jest.fn().mockResolvedValue([]),
      } as unknown as Queue;
    }

    describe('createRow', () => {
      it('creates a row when the payload satisfies every required field, returning the inserted row', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'title',
              data_type: 'STRING',
              required: true,
              config: null,
            },
          ],
          insertedRow: { id: '1', title: 'Invoice #1' },
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        const result = await service.createRow(TABLE_ID, {
          title: 'Invoice #1',
        });

        expect(result).toEqual({ id: '1', title: 'Invoice #1' });
      });

      it('404s for an unknown tableId, same shape as the unknown-table error', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          metaTableRow: null,
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(
          service.createRow(TABLE_ID, { title: 'x' }),
        ).rejects.toThrow();
      });

      it('strips payload keys not present in the schema (e.g. a client-supplied id/created_at) before inserting', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'title',
              data_type: 'STRING',
              required: true,
              config: null,
            },
          ],
          insertedRow: { id: '1', title: 'Invoice #1' },
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await service.createRow(TABLE_ID, {
          title: 'Invoice #1',
          id: 'attacker-chosen-id',
          created_at: '2000-01-01',
          not_a_real_field: 'ignored',
        });

        expect(tenantKnexService.insert).toHaveBeenCalledWith({
          title: 'Invoice #1',
        });
      });

      it('rejects a null payload with a 400 instead of throwing an unhandled TypeError', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'title',
              data_type: 'STRING',
              required: false,
              config: null,
            },
          ],
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(
          service.createRow(
            TABLE_ID,
            null as unknown as Record<string, unknown>,
          ),
        ).rejects.toThrow(BadRequestException);
        expect(tenantKnexService.insert).not.toHaveBeenCalled();
      });

      it('rejects with a 400 field-error array when a required field is missing, and never inserts', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'title',
              data_type: 'STRING',
              required: true,
              config: null,
            },
          ],
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        let caught: unknown;
        try {
          await service.createRow(TABLE_ID, {});
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(BadRequestException);
        const response = (caught as BadRequestException).getResponse() as {
          message: string[];
        };
        expect(response.message).toEqual(
          expect.arrayContaining([expect.stringContaining('title')]),
        );
        expect(tenantKnexService.insert).not.toHaveBeenCalled();
      });

      it('rejects a STRING value over config.maxLength, naming the field + rule', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'title',
              data_type: 'STRING',
              required: false,
              config: { maxLength: 5 },
            },
          ],
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        let caught: unknown;
        try {
          await service.createRow(TABLE_ID, { title: 'too long a value' });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(BadRequestException);
        const response = (caught as BadRequestException).getResponse() as {
          message: string[];
        };
        expect(response.message[0]).toContain('title');
        expect(response.message[0]).toContain('exceed');
        expect(tenantKnexService.insert).not.toHaveBeenCalled();
      });

      it('rejects a SELECT value outside config.enum', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'status',
              data_type: 'SELECT',
              required: false,
              config: { enum: ['open', 'closed'] },
            },
          ],
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(
          service.createRow(TABLE_ID, { status: 'unknown-status' }),
        ).rejects.toThrow(BadRequestException);
        expect(tenantKnexService.insert).not.toHaveBeenCalled();
      });

      it('rejects a value with the wrong dataType (e.g. a string for a NUMBER field)', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'amount',
              data_type: 'NUMBER',
              required: false,
              config: null,
            },
          ],
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(
          service.createRow(TABLE_ID, { amount: 'not-a-number' }),
        ).rejects.toThrow(BadRequestException);
      });

      it('only builds the validation schema from _meta_fields once across repeated calls (cached per AD-5)', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'title',
              data_type: 'STRING',
              required: false,
              config: null,
            },
          ],
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await service.createRow(TABLE_ID, { title: 'a' });
        await service.createRow(TABLE_ID, { title: 'b' });

        const fieldsTableCalls = tenantKnexService.table.mock.calls.filter(
          ([name]: [string]) => name === '_meta_fields',
        );
        expect(fieldsTableCalls).toHaveLength(1);
      });

      it('accepts an integer id for a RELATION field', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'customer',
              data_type: 'RELATION',
              required: false,
              config: null,
              relation_target_table_id: 'table-customers',
            },
          ],
          insertedRow: { id: '1', customer: 5 },
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        const result = await service.createRow(TABLE_ID, { customer: 5 });

        expect(result).toEqual({ id: '1', customer: 5 });
        expect(tenantKnexService.insert).toHaveBeenCalledWith({ customer: 5 });
      });

      it('rejects a non-integer value for a RELATION field', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'customer',
              data_type: 'RELATION',
              required: false,
              config: null,
              relation_target_table_id: 'table-customers',
            },
          ],
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(
          service.createRow(TABLE_ID, { customer: 'not-an-id' }),
        ).rejects.toThrow(BadRequestException);
        expect(tenantKnexService.insert).not.toHaveBeenCalled();
      });

      it('reshapes a Postgres FK-violation (dangling relation value) into a 400 field-error, not a raw 500', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'customer',
              data_type: 'RELATION',
              required: false,
              config: null,
              relation_target_table_id: 'table-customers',
            },
          ],
        });
        const fkViolation = Object.assign(
          new Error(
            'insert or update on table "invoices" violates foreign key constraint',
          ),
          { code: '23503' },
        );
        (tenantKnexService.insert as jest.Mock).mockReturnValue({
          returning: jest.fn().mockRejectedValue(fkViolation),
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        let caught: unknown;
        try {
          await service.createRow(TABLE_ID, { customer: 999 });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(BadRequestException);
        const response = (caught as BadRequestException).getResponse() as {
          message: string[];
        };
        expect(response.message.join(' ')).toContain('relation');
      });

      it('re-throws a non-FK-violation error unchanged (e.g. a real infra failure)', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'title',
              data_type: 'STRING',
              required: false,
              config: null,
            },
          ],
        });
        const otherError = new Error('connection terminated unexpectedly');
        (tenantKnexService.insert as jest.Mock).mockReturnValue({
          returning: jest.fn().mockRejectedValue(otherError),
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(
          service.createRow(TABLE_ID, { title: 'x' }),
        ).rejects.toThrow('connection terminated unexpectedly');
      });
    });

    describe('listRows', () => {
      it('returns the default bounded page, ordered by primary key, with a total', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          dataRows: [{ id: '1' }, { id: '2' }],
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        const result = await service.listRows(TABLE_ID);

        expect(result).toEqual({
          items: [{ id: '1' }, { id: '2' }],
          meta: { total: 2, page: 1, pageSize: 50 },
        });
        expect(tenantKnexService.orderBy).toHaveBeenCalledWith(
          'invoices.id',
          'asc',
        );
        expect(tenantKnexService.limit).toHaveBeenCalledWith(50);
        expect(tenantKnexService.offset).toHaveBeenCalledWith(0);
      });

      it('uses metadata-validated sort/filter fields and stable primary-key tiebreaking', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'amount',
              data_type: 'NUMBER',
              required: false,
              config: null,
            },
          ],
          dataRows: [{ id: '3', amount: 20 }],
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        const result = await service.listRows(TABLE_ID, {
          page: 2,
          pageSize: 10,
          sortBy: 'amount',
          sortDirection: 'desc',
          filters: { amount: 20 },
        });

        expect(result.meta).toEqual({ total: 1, page: 2, pageSize: 10 });
        expect(tenantKnexService.orderBy).toHaveBeenNthCalledWith(
          1,
          'invoices.amount',
          'desc',
        );
        expect(tenantKnexService.orderBy).toHaveBeenNthCalledWith(
          2,
          'invoices.id',
          'asc',
        );
        expect(tenantKnexService.limit).toHaveBeenCalledWith(10);
        expect(tenantKnexService.offset).toHaveBeenCalledWith(10);
      });

      it.each([
        [{ page: 0 }],
        [{ pageSize: 101 }],
        [{ sortBy: 'id; drop table invoices' }],
        [{ filters: { unknown: 'x' } }],
        [{ filters: { amount: 'not-a-number' } }],
      ])(
        'rejects an invalid pagination, sort, or filter query: %o',
        async (query) => {
          const tenantKnexService = buildTenantKnexServiceForRows({
            fieldRows: [
              {
                slug: 'amount',
                data_type: 'NUMBER',
                required: false,
                config: null,
              },
            ],
          });
          const service = buildService(tenantKnexService, {
            tenantContext: { tenantId: TENANT_ID },
            ddlQueue: buildQueue(),
          });

          await expect(service.listRows(TABLE_ID, query)).rejects.toThrow(
            BadRequestException,
          );
          expect(tenantKnexService.count).not.toHaveBeenCalled();
        },
      );

      // AD-3 regression guard: `schema.fields` is metadata, not an
      // identifier check. If a `_meta_fields` slug ever reached the cache
      // unsanitized, `sortBy`/`filters` must still be refused at the
      // module's single identifier choke point instead of interpolating
      // the name into a `<table>.<column>` string.
      it.each([
        ['sortBy', { sortBy: 'amount"; drop table invoices --' }],
        ['filters', { filters: { 'amount"; drop table invoices --': 20 } }],
      ])(
        'refuses an unsafe %s column even when it matches a metadata field',
        async (_field, query) => {
          const tenantKnexService = buildTenantKnexServiceForRows({
            fieldRows: [
              {
                slug: 'amount"; drop table invoices --',
                data_type: 'NUMBER',
                required: false,
                config: null,
              },
            ],
          });
          const service = buildService(tenantKnexService, {
            tenantContext: { tenantId: TENANT_ID },
            ddlQueue: buildQueue(),
          });

          await expect(service.listRows(TABLE_ID, query)).rejects.toThrow(
            BadRequestException,
          );
          expect(tenantKnexService.count).not.toHaveBeenCalled();
        },
      );

      it('refuses an over-length sort column that Postgres would truncate', async () => {
        const overLengthSlug = `a${'b'.repeat(63)}`;
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: overLengthSlug,
              data_type: 'NUMBER',
              required: false,
              config: null,
            },
          ],
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(
          service.listRows(TABLE_ID, { sortBy: overLengthSlug }),
        ).rejects.toThrow(BadRequestException);
        expect(tenantKnexService.count).not.toHaveBeenCalled();
      });

      it('404s for an unknown tableId', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          metaTableRow: null,
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(service.listRows(TABLE_ID)).rejects.toThrow();
      });

      describe('RELATION field resolution (Story 4/CAP-4)', () => {
        const TARGET_TABLE_ID = 'table-customers';

        it('unwraps a resolved relation to { id, ...targetRowFields } under the field slug', async () => {
          const tenantKnexService = buildTenantKnexServiceForRows({
            fieldRows: [
              {
                slug: 'customer',
                data_type: 'RELATION',
                required: false,
                config: null,
                relation_target_table_id: TARGET_TABLE_ID,
              },
            ],
            metaTablesRows: [
              { id: TABLE_ID, name: TABLE_NAME },
              { id: TARGET_TABLE_ID, name: 'customers' },
            ],
            // buildRowQuery()'s `json_agg(...) filter (where ... is not
            // null) as "customer"` aliases the aggregated join result to
            // the field's own slug, so the row object's `customer` key
            // (as returned by the query) already holds the json_agg array
            // -- shapeRelationColumns() unwraps that array down to a
            // single object (spec Boundaries: "embed a resolved relation
            // as { id, ...targetRowFields } under the field's slug").
            dataRows: [
              {
                id: '1',
                customer: [{ id: 5, name: 'Acme Corp' }],
              },
            ],
          });
          const service = buildService(tenantKnexService, {
            tenantContext: { tenantId: TENANT_ID },
            ddlQueue: buildQueue(),
          });

          const result = await service.listRows(TABLE_ID);

          expect(result).toEqual({
            items: [
              {
                id: '1',
                customer: { id: 5, name: 'Acme Corp' },
              },
            ],
            meta: { total: 1, page: 1, pageSize: 50 },
          });
        });

        it("resolves an unset/dangling relation's slug to null, not an empty array", async () => {
          const tenantKnexService = buildTenantKnexServiceForRows({
            fieldRows: [
              {
                slug: 'customer',
                data_type: 'RELATION',
                required: false,
                config: null,
                relation_target_table_id: TARGET_TABLE_ID,
              },
            ],
            metaTablesRows: [
              { id: TABLE_ID, name: TABLE_NAME },
              { id: TARGET_TABLE_ID, name: 'customers' },
            ],
            dataRows: [{ id: '1', customer: null }],
          });
          const service = buildService(tenantKnexService, {
            tenantContext: { tenantId: TENANT_ID },
            ddlQueue: buildQueue(),
          });

          const result = await service.listRows(TABLE_ID);

          expect(result).toEqual({
            items: [{ id: '1', customer: null }],
            meta: { total: 1, page: 1, pageSize: 50 },
          });
        });

        it('resolves every relation field via one additional query (batched target-table lookup), never one per row', async () => {
          const tenantKnexService = buildTenantKnexServiceForRows({
            fieldRows: [
              {
                slug: 'customer',
                data_type: 'RELATION',
                required: false,
                config: null,
                relation_target_table_id: TARGET_TABLE_ID,
              },
            ],
            metaTablesRows: [
              { id: TABLE_ID, name: TABLE_NAME },
              { id: TARGET_TABLE_ID, name: 'customers' },
            ],
            dataRows: [
              { id: '1', customer: [{ id: 5 }] },
              { id: '2', customer: [{ id: 6 }] },
            ],
          });
          const service = buildService(tenantKnexService, {
            tenantContext: { tenantId: TENANT_ID },
            ddlQueue: buildQueue(),
          });

          await service.listRows(TABLE_ID);

          // _meta_tables is queried exactly twice for the whole listRows()
          // call regardless of row count: once by findMetaTableOrThrow()
          // (resolving the source table) and once by
          // resolveRelationTargetTables()'s single batched whereIn() (not
          // once per relation field per row).
          const metaTablesCalls = tenantKnexService.table.mock.calls.filter(
            ([name]: [string]) => name === '_meta_tables',
          );
          expect(metaTablesCalls).toHaveLength(2);
        });
      });
    });

    describe('getRow', () => {
      it('returns the row when it exists', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          existingRow: { id: 'row-1', title: 'x' },
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        const result = await service.getRow(TABLE_ID, 'row-1');

        expect(result).toEqual({ id: 'row-1', title: 'x' });
      });

      it('404s when rowId does not match an existing row', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          existingRow: null,
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(service.getRow(TABLE_ID, 'missing-row')).rejects.toThrow();
      });

      it('404s for an unknown tableId', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          metaTableRow: null,
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(service.getRow(TABLE_ID, 'row-1')).rejects.toThrow();
      });

      it('unwraps a resolved relation to { id, ...targetRowFields } the same way listRows() does (shared helper)', async () => {
        const TARGET_TABLE_ID = 'table-customers';
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'customer',
              data_type: 'RELATION',
              required: false,
              config: null,
              relation_target_table_id: TARGET_TABLE_ID,
            },
          ],
          metaTablesRows: [
            { id: TABLE_ID, name: TABLE_NAME },
            { id: TARGET_TABLE_ID, name: 'customers' },
          ],
          existingRow: {
            id: 'row-1',
            customer: [{ id: 5, name: 'Acme Corp' }],
          },
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        const result = await service.getRow(TABLE_ID, 'row-1');

        expect(result).toEqual({
          id: 'row-1',
          customer: { id: 5, name: 'Acme Corp' },
        });
      });
    });

    describe('updateRow', () => {
      it('applies a valid partial update, only checking fields present in the payload', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'title',
              data_type: 'STRING',
              required: true,
              config: null,
            },
            {
              slug: 'amount',
              data_type: 'NUMBER',
              required: true,
              config: null,
            },
          ],
          existingRow: { id: 'row-1' },
          updatedRow: { id: 'row-1', title: 'new title' },
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        // Only `title` is supplied -- `amount` is required but must NOT be
        // flagged missing on a partial PATCH (spec I/O matrix).
        const result = await service.updateRow(TABLE_ID, 'row-1', {
          title: 'new title',
        });

        expect(result).toEqual({ id: 'row-1', title: 'new title' });
      });

      it('strips payload keys not present in the schema (e.g. a client-supplied id) before updating', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'title',
              data_type: 'STRING',
              required: true,
              config: null,
            },
          ],
          existingRow: { id: 'row-1' },
          updatedRow: { id: 'row-1', title: 'new title' },
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await service.updateRow(TABLE_ID, 'row-1', {
          title: 'new title',
          id: 'attacker-chosen-id',
          created_at: '2000-01-01',
        });

        expect(
          (tenantKnexService as unknown as { updateFn: jest.Mock }).updateFn,
        ).toHaveBeenCalledWith({ title: 'new title' });
      });

      it('404s when rowId does not exist', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          existingRow: null,
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(
          service.updateRow(TABLE_ID, 'missing-row', { title: 'x' }),
        ).rejects.toThrow();
      });

      it('rejects a null payload with a 400 instead of throwing an unhandled TypeError', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'title',
              data_type: 'STRING',
              required: false,
              config: null,
            },
          ],
          existingRow: { id: 'row-1' },
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(
          service.updateRow(
            TABLE_ID,
            'row-1',
            null as unknown as Record<string, unknown>,
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('rejects a partial update whose payload matches no schema field, before issuing an empty-SET update', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'title',
              data_type: 'STRING',
              required: false,
              config: null,
            },
          ],
          existingRow: { id: 'row-1' },
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(
          service.updateRow(TABLE_ID, 'row-1', { not_a_real_field: 'x' }),
        ).rejects.toThrow(BadRequestException);
        expect(
          (tenantKnexService as unknown as { updateFn: jest.Mock }).updateFn,
        ).not.toHaveBeenCalled();
      });

      it('rejects a partial update violating a constraint on a present field', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'title',
              data_type: 'STRING',
              required: false,
              config: { maxLength: 3 },
            },
          ],
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(
          service.updateRow(TABLE_ID, 'row-1', { title: 'way too long' }),
        ).rejects.toThrow(BadRequestException);
      });

      it('validates against the rebuilt schema (not a stale cached one) after a field edit via enqueueFieldEdit', async () => {
        // First call builds and caches a schema with no fields at all.
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [],
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          configService: {
            get: jest.fn((key: string) =>
              key === 'DDL_JOB_RETRY_COUNT' ? 3 : undefined,
            ),
          },
          ddlQueue: buildQueue(),
        });

        // Warm the cache (no fields yet, so any payload is whitelisted down
        // to {} and now correctly rejected as "no updatable fields" --
        // the throw is expected, the cache population as a side effect of
        // getOrBuildValidationSchema() is what this step is actually for).
        await expect(
          service.updateRow(TABLE_ID, 'row-1', { title: 'x' }),
        ).rejects.toThrow(BadRequestException);

        // Story 2's enqueueFieldEdit() resolves the table via
        // findMetaTableOrThrow() (_meta_tables), independent of the row
        // DML mocks above, and invalidates the cached schema for TABLE_ID.
        await service.enqueueFieldEdit(TABLE_ID, {
          edits: [
            {
              operation: 'add',
              name: 'title',
              dataType: 'STRING' as never,
              required: true,
              config: { maxLength: 3 },
            } as never,
          ],
        } as never);

        // Next getOrBuildValidationSchema() call must rebuild from
        // _meta_fields -- simulate the post-edit field now existing.
        tenantKnexService.table.mockImplementation((name: string) => {
          if (name === '_meta_tables') {
            return {
              where: jest.fn().mockReturnValue({
                first: jest
                  .fn()
                  .mockResolvedValue({ id: TABLE_ID, name: TABLE_NAME }),
              }),
            };
          }
          if (name === '_meta_fields') {
            return {
              where: jest.fn().mockResolvedValue([
                {
                  slug: 'title',
                  data_type: 'STRING',
                  required: true,
                  config: { maxLength: 3 },
                },
              ]),
            };
          }
          return {
            where: jest.fn().mockReturnValue({
              first: jest.fn().mockResolvedValue({ id: 'row-1' }),
            }),
          };
        });

        // `title` is present in the payload and violates the post-edit
        // maxLength constraint -- only detectable if updateRow() rebuilt
        // the schema instead of reusing the stale (fieldless) cached one.
        await expect(
          service.updateRow(TABLE_ID, 'row-1', { title: 'too long' }),
        ).rejects.toThrow(BadRequestException);
      });

      it('reshapes a Postgres FK-violation (dangling relation value) into the same 400 field-error envelope createRow uses, not a raw 500', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          fieldRows: [
            {
              slug: 'customer',
              data_type: 'RELATION',
              required: false,
              config: null,
              relation_target_table_id: 'table-customers',
            },
          ],
          existingRow: { id: 'row-1' },
        });
        const fkViolation = Object.assign(
          new Error(
            'insert or update on table "invoices" violates foreign key constraint',
          ),
          { code: '23503' },
        );
        (tenantKnexService as unknown as { updateFn: jest.Mock }).updateFn =
          jest.fn().mockReturnValue({
            returning: jest.fn().mockRejectedValue(fkViolation),
          });
        tenantKnexService.table.mockImplementation((name: string) => {
          if (name === '_meta_tables') {
            return {
              where: jest.fn().mockReturnValue({
                first: jest
                  .fn()
                  .mockResolvedValue({ id: TABLE_ID, name: TABLE_NAME }),
              }),
            };
          }
          if (name === '_meta_fields') {
            return {
              where: jest.fn().mockResolvedValue([
                {
                  slug: 'customer',
                  data_type: 'RELATION',
                  required: false,
                  config: null,
                  relation_target_table_id: 'table-customers',
                },
              ]),
            };
          }
          return {
            where: jest.fn().mockReturnValue({
              first: jest.fn().mockResolvedValue({ id: 'row-1' }),
              update: jest.fn().mockReturnValue({
                returning: jest.fn().mockRejectedValue(fkViolation),
              }),
            }),
          };
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        let caught: unknown;
        try {
          await service.updateRow(TABLE_ID, 'row-1', { customer: 999 });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(BadRequestException);
        const response = (caught as BadRequestException).getResponse() as {
          message: string[];
        };
        expect(response.message.join(' ')).toContain('relation');
      });
    });

    describe('deleteRow', () => {
      it('deletes an existing row, returning 204/void', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          existingRow: { id: 'row-1' },
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(
          service.deleteRow(TABLE_ID, 'row-1'),
        ).resolves.toBeUndefined();
      });

      it('404s when rowId does not exist', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          existingRow: null,
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(
          service.deleteRow(TABLE_ID, 'missing-row'),
        ).rejects.toThrow();
      });

      it('404s for an unknown tableId', async () => {
        const tenantKnexService = buildTenantKnexServiceForRows({
          metaTableRow: null,
        });
        const service = buildService(tenantKnexService, {
          tenantContext: { tenantId: TENANT_ID },
          ddlQueue: buildQueue(),
        });

        await expect(service.deleteRow(TABLE_ID, 'row-1')).rejects.toThrow();
      });
    });
  });

  describe('runtime metadata reads', () => {
    it('paginates and maps the current tenant catalog without touching Prisma metadata', async () => {
      const createdAt = new Date('2026-08-20T10:00:00.000Z');
      const updatedAt = new Date('2026-08-21T10:00:00.000Z');
      const count = jest.fn().mockResolvedValue([{ count: '3' }]);
      const catalogQuery = {
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockResolvedValue([
          {
            id: 'table-2',
            name: 'orders',
            slug: 'orders',
            description: null,
            created_at: createdAt,
            updated_at: updatedAt,
          },
        ]),
      };
      const tenantKnexService = {
        forCurrentTenant: jest
          .fn()
          .mockReturnValueOnce({ table: jest.fn().mockReturnValue({ count }) })
          .mockReturnValueOnce({
            table: jest.fn().mockReturnValue(catalogQuery),
          }),
      } as unknown as TenantKnexService;
      const service = buildService(tenantKnexService);

      await expect(
        service.listTables({ page: 2, pageSize: 2 }),
      ).resolves.toEqual({
        items: [
          {
            id: 'table-2',
            name: 'orders',
            slug: 'orders',
            description: null,
            createdAt: createdAt.toISOString(),
            updatedAt: updatedAt.toISOString(),
          },
        ],
        meta: { total: 3, page: 2, pageSize: 2 },
      });

      expect(tenantKnexService.forCurrentTenant).toHaveBeenCalledTimes(2);
      expect(count).toHaveBeenCalledWith({ count: '*' });
      expect(catalogQuery.limit).toHaveBeenCalledWith(2);
      expect(catalogQuery.offset).toHaveBeenCalledWith(2);
    });

    it('returns a table detail with all field metadata from the same tenant schema', async () => {
      const tableQuery = {
        where: jest.fn().mockReturnValue({
          first: jest.fn().mockResolvedValue({
            id: 'table-1',
            name: 'orders',
            slug: 'orders',
            description: 'Customer orders',
            created_at: '2026-08-20T10:00:00.000Z',
            updated_at: '2026-08-21T10:00:00.000Z',
          }),
        }),
      };
      const fieldsQuery = {
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn(),
      };
      fieldsQuery.orderBy
        .mockReturnValueOnce(fieldsQuery)
        .mockResolvedValueOnce([
          {
            id: 'field-1',
            table_id: 'table-1',
            name: 'Customer',
            slug: 'customer',
            data_type: 'RELATION',
            required: true,
            relation_target_table_id: 'table-customers',
            config: { label: 'Customer' },
            created_at: '2026-08-20T10:00:00.000Z',
            updated_at: '2026-08-21T10:00:00.000Z',
          },
        ]);
      const table = jest
        .fn()
        .mockReturnValueOnce(tableQuery)
        .mockReturnValueOnce(fieldsQuery);
      const tenantKnexService = {
        forCurrentTenant: jest.fn().mockReturnValue({ table }),
      } as unknown as TenantKnexService;
      const service = buildService(tenantKnexService);

      await expect(service.getTableDetail('table-1')).resolves.toEqual({
        id: 'table-1',
        name: 'orders',
        slug: 'orders',
        description: 'Customer orders',
        createdAt: '2026-08-20T10:00:00.000Z',
        updatedAt: '2026-08-21T10:00:00.000Z',
        fields: [
          {
            id: 'field-1',
            tableId: 'table-1',
            name: 'Customer',
            slug: 'customer',
            dataType: 'RELATION',
            required: true,
            relationTargetTableId: 'table-customers',
            config: { label: 'Customer' },
            createdAt: '2026-08-20T10:00:00.000Z',
            updatedAt: '2026-08-21T10:00:00.000Z',
          },
        ],
      });

      expect(table).toHaveBeenNthCalledWith(1, '_meta_tables');
      expect(table).toHaveBeenNthCalledWith(2, '_meta_fields');
      expect(fieldsQuery.where).toHaveBeenCalledWith({ table_id: 'table-1' });
    });

    it('does not disclose a missing or cross-tenant table id', async () => {
      const tenantKnexService = {
        forCurrentTenant: jest.fn().mockReturnValue({
          table: jest.fn().mockReturnValue({
            where: jest
              .fn()
              .mockReturnValue({ first: jest.fn().mockResolvedValue(null) }),
          }),
        }),
      } as unknown as TenantKnexService;
      const service = buildService(tenantKnexService);

      await expect(
        service.getTableDetail('other-tenant-table'),
      ).rejects.toEqual(
        expect.objectContaining({
          response: expect.objectContaining({ error: 'NOT_FOUND' }),
        }),
      );
    });
  });
});
