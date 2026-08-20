import { Knex } from 'knex';
import { Queue } from 'bullmq';
import { BadRequestException } from '@nestjs/common';
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
  });

  // ----------------------------------------------------------------------
  // Story 2: CAP-1 create table, CAP-2 field edits, job-status polling
  // ----------------------------------------------------------------------

  describe('enqueueCreateTable', () => {
    const TENANT_ID = 'tenant-abc';

    function buildTenantKnexServiceForEnqueue(hasTableResult = true) {
      const hasTable = jest.fn().mockResolvedValue(hasTableResult);
      const transacting = jest.fn().mockReturnThis();
      const schema = { hasTable, transacting } as unknown as Knex.SchemaBuilder;

      return {
        schemaForCurrentTenant: jest.fn().mockReturnValue(schema),
        transaction: jest.fn(
          async (fn: (trx: Knex.Transaction) => Promise<void>) =>
            fn({} as Knex.Transaction),
        ),
        forCurrentTenant: jest.fn(),
      } as unknown as TenantKnexService;
    }

    function buildQueue() {
      return {
        add: jest.fn().mockResolvedValue(undefined),
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
          fields: [{ name: 'bad name; DROP TABLE', dataType: 'STRING' as never }],
        } as never),
      ).rejects.toThrow(BadRequestException);

      expect(ddlQueue.add).not.toHaveBeenCalled();
    });

    it('enqueues a create-table job carrying the caller tenantId and returns its jobId', async () => {
      const tenantKnexService = buildTenantKnexServiceForEnqueue();
      const ddlQueue = buildQueue();
      const service = buildService(tenantKnexService, {
        tenantContext: { tenantId: TENANT_ID },
        configService: { get: jest.fn().mockReturnValue(3) },
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
  });

  describe('enqueueFieldEdit', () => {
    const TENANT_ID = 'tenant-abc';
    const TABLE_ID = 'table-1';

    function buildTenantKnexServiceWithTable(
      row: { id: string; name: string } | null,
    ) {
      const first = jest.fn().mockResolvedValue(row);
      const where = jest.fn().mockReturnValue({ first });
      const table = jest.fn().mockReturnValue({ where });

      return {
        forCurrentTenant: jest.fn().mockReturnValue({ table }),
      } as unknown as TenantKnexService;
    }

    function buildQueue() {
      return {
        add: jest.fn().mockResolvedValue(undefined),
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
        configService: { get: jest.fn().mockReturnValue(3) },
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
        configService: { get: jest.fn().mockReturnValue(3) },
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
});
