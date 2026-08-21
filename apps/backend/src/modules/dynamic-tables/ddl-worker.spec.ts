import { Knex } from 'knex';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { FieldDataType } from '@flexi/shared-types';
import { DdlWorker } from './ddl-worker';
import { TenantKnexService } from '../../tenancy/tenant-knex.service';
import { TenancyClsStore } from '../../tenancy/tenant-context';
import { CreateTableJobData, FieldEditJobData } from './dynamic-tables.types';

/**
 * Fakes the subset of `Knex.SchemaBuilder`/`Knex.QueryBuilder` behavior
 * `ddl-worker.ts` depends on, backed by simple in-memory sets so tests can
 * assert re-execution safety (a step run twice against the same fake state
 * behaves the same as BullMQ retrying a job from `steps[0]`) without a real
 * Postgres connection.
 */
function buildFakeTenantState(existingColumns: Set<string> = new Set()) {
  const tables = new Set<string>();
  const columnsByTable = new Map<string, Set<string>>();
  const metaTablesRows: Record<string, unknown>[] = [];
  const metaFieldsRows: Record<string, unknown>[] = [];
  const metaMigrationsRows: Record<string, unknown>[] = [];
  const raws: string[] = [];

  function columnsFor(table: string): Set<string> {
    if (!columnsByTable.has(table)) {
      columnsByTable.set(table, new Set(existingColumns));
    }
    return columnsByTable.get(table)!;
  }

  /** Records `.references()/.inTable()/.onDelete()` calls made against a relation column, for `add-relation-column` step assertions. */
  const relationColumnCalls: {
    column: string;
    references?: string;
    inTable?: string;
    onDelete?: string;
    nullable?: boolean;
  }[] = [];

  const schemaBuilder = {
    hasTable: jest.fn(async (name: string) => tables.has(name)),
    hasColumn: jest.fn(async (table: string, column: string) =>
      columnsFor(table).has(column),
    ),
    createTable: jest.fn(
      async (name: string, cb: (t: Knex.CreateTableBuilder) => void) => {
        tables.add(name);
        const addedColumns: string[] = [];
        const columnChain = {
          notNullable: () => columnChain,
          nullable: () => columnChain,
          primary: () => columnChain,
        };
        const fakeTableBuilder = {
          increments: () => {
            addedColumns.push('id');
            return columnChain;
          },
          string: (col: string) => {
            addedColumns.push(col);
            return columnChain;
          },
          text: (col: string) => {
            addedColumns.push(col);
            return columnChain;
          },
          decimal: (col: string) => {
            addedColumns.push(col);
            return columnChain;
          },
          boolean: (col: string) => {
            addedColumns.push(col);
            return columnChain;
          },
          date: (col: string) => {
            addedColumns.push(col);
            return columnChain;
          },
          timestamp: (col: string) => {
            addedColumns.push(col);
            return columnChain;
          },
          jsonb: (col: string) => {
            addedColumns.push(col);
            return columnChain;
          },
          timestamps: () => {
            addedColumns.push('created_at', 'updated_at');
          },
        } as unknown as Knex.CreateTableBuilder;
        cb(fakeTableBuilder);
        for (const c of addedColumns) columnsFor(name).add(c);
      },
    ),
    alterTable: jest.fn(
      async (name: string, cb: (t: Knex.CreateTableBuilder) => void) => {
        const addedColumns: string[] = [];
        const droppedColumns: string[] = [];
        const renames: [string, string][] = [];
        const columnChain = {
          notNullable: () => columnChain,
          nullable: () => columnChain,
        };
        const fakeTableBuilder = {
          string: (col: string) => {
            addedColumns.push(col);
            return columnChain;
          },
          text: (col: string) => {
            addedColumns.push(col);
            return columnChain;
          },
          decimal: (col: string) => {
            addedColumns.push(col);
            return columnChain;
          },
          boolean: (col: string) => {
            addedColumns.push(col);
            return columnChain;
          },
          date: (col: string) => {
            addedColumns.push(col);
            return columnChain;
          },
          timestamp: (col: string) => {
            addedColumns.push(col);
            return columnChain;
          },
          jsonb: (col: string) => {
            addedColumns.push(col);
            return columnChain;
          },
          // Story 4/CAP-4: add-relation-column's integer FK column,
          // chaining .references()/.inTable()/.onDelete() before
          // .notNullable()/.nullable() -- recorded into relationColumnCalls
          // so tests can assert the exact FK shape (schema-qualified
          // .inTable() value, ON DELETE SET NULL).
          integer: (col: string) => {
            addedColumns.push(col);
            const record: (typeof relationColumnCalls)[number] = { column: col };
            relationColumnCalls.push(record);
            const referencingChain = {
              references: (refCol: string) => {
                record.references = refCol;
                return referencingChain;
              },
              inTable: (target: string) => {
                record.inTable = target;
                return referencingChain;
              },
              onDelete: (behavior: string) => {
                record.onDelete = behavior;
                return referencingChain;
              },
              notNullable: () => {
                record.nullable = false;
                return referencingChain;
              },
              nullable: () => {
                record.nullable = true;
                return referencingChain;
              },
            };
            return referencingChain;
          },
          dropColumn: (col: string) => {
            droppedColumns.push(col);
          },
          renameColumn: (from: string, to: string) => {
            renames.push([from, to]);
          },
        } as unknown as Knex.CreateTableBuilder;
        cb(fakeTableBuilder);
        const cols = columnsFor(name);
        for (const c of addedColumns) cols.add(c);
        for (const c of droppedColumns) cols.delete(c);
        for (const [from, to] of renames) {
          cols.delete(from);
          cols.add(to);
        }
      },
    ),
    transacting: jest.fn().mockReturnThis(),
  } as unknown as Knex.SchemaBuilder;

  interface FakeMetaQueryBuilder {
    where: jest.Mock<FakeMetaQueryBuilder, [Record<string, unknown>]>;
    first: jest.Mock<Promise<Record<string, unknown> | undefined>, []>;
    insert: jest.Mock<Promise<void>, [Record<string, unknown>]>;
    update: jest.Mock<Promise<void>, [Record<string, unknown>]>;
    delete: jest.Mock<Promise<void>, []>;
    transacting: jest.Mock<FakeMetaQueryBuilder, [unknown]>;
  }

  // Simulates the `_meta_tables`/`_meta_fields`/`_meta_migrations` query
  // builder chain: `.table(name).where(...).first()/.insert()/.update()/.delete()`.
  function buildMetaQueryBuilder(
    rows: Record<string, unknown>[],
  ): FakeMetaQueryBuilder {
    let whereClause: Record<string, unknown> = {};
    const api: FakeMetaQueryBuilder = {
      where: jest.fn((clause: Record<string, unknown>) => {
        whereClause = clause;
        return api;
      }),
      first: jest.fn(async () =>
        rows.find((r) =>
          Object.entries(whereClause).every(([k, v]) => r[k] === v),
        ),
      ),
      insert: jest.fn(async (row: Record<string, unknown>) => {
        rows.push(row);
      }),
      update: jest.fn(async (patch: Record<string, unknown>) => {
        for (const r of rows) {
          if (Object.entries(whereClause).every(([k, v]) => r[k] === v)) {
            Object.assign(r, patch);
          }
        }
      }),
      delete: jest.fn(async () => {
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (Object.entries(whereClause).every(([k, v]) => rows[i][k] === v)) {
            rows.splice(i, 1);
          }
        }
      }),
      transacting: jest.fn().mockReturnThis(),
    };
    return api;
  }

  const forCurrentTenant = jest.fn(() => {
    const table = jest.fn((name: string) => {
      if (name === '_meta_tables') return buildMetaQueryBuilder(metaTablesRows);
      if (name === '_meta_fields') return buildMetaQueryBuilder(metaFieldsRows);
      if (name === '_meta_migrations') {
        return buildMetaQueryBuilder(metaMigrationsRows);
      }
      throw new Error(`Unexpected meta table: ${name}`);
    });
    return { table };
  });

  const trx = {
    raw: jest.fn(async (sql: string) => {
      raws.push(sql);
    }),
  } as unknown as Knex.Transaction;

  const tenantKnexService = {
    schemaForCurrentTenant: jest.fn().mockReturnValue(schemaBuilder),
    forCurrentTenant: () => forCurrentTenant(),
    transaction: jest.fn(async (fn: (trx: Knex.Transaction) => Promise<void>) =>
      fn(trx),
    ),
  } as unknown as TenantKnexService;

  return {
    tenantKnexService,
    schemaBuilder,
    tables,
    columnsByTable,
    metaTablesRows,
    metaFieldsRows,
    metaMigrationsRows,
    raws,
    relationColumnCalls,
  };
}

function buildConfigService(): ConfigService {
  const values: Record<string, number> = {
    DDL_LOCK_TIMEOUT_MS: 5000,
    DDL_STATEMENT_TIMEOUT_MS: 30000,
    DDL_JOB_RETRY_COUNT: 3,
  };
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function buildCls(): ClsService<TenancyClsStore> {
  let store: TenancyClsStore | undefined;
  return {
    runWith: jest.fn(async (s: TenancyClsStore, fn: () => Promise<void>) => {
      store = s;
      return fn();
    }),
    get: jest.fn((key: keyof TenancyClsStore) => store?.[key]),
  } as unknown as ClsService<TenancyClsStore>;
}

describe('DdlWorker', () => {
  describe('processCreateTable (CAP-1)', () => {
    it('creates the physical table and writes _meta_tables/_meta_fields rows, then records a completed migration', async () => {
      const state = buildFakeTenantState();
      const configService = buildConfigService();
      const cls = buildCls();
      const worker = new DdlWorker(state.tenantKnexService, configService, cls);

      const data: CreateTableJobData = {
        kind: 'create-table',
        jobId: 'job-1',
        tenantId: 'tenant1',
        tableId: 'table-1',
        tableName: 'invoices',
        description: null,
        fields: [
          {
            name: 'title',
            dataType: FieldDataType.STRING,
            required: true,
            config: null,
          },
        ],
      };

      await worker.process({ data } as Job<CreateTableJobData>);

      expect(state.tables.has('invoices')).toBe(true);
      expect(state.metaTablesRows).toEqual([
        expect.objectContaining({ id: 'table-1', name: 'invoices' }),
      ]);
      expect(state.metaFieldsRows).toEqual([
        expect.objectContaining({ table_id: 'table-1', slug: 'title' }),
      ]);
      expect(state.metaMigrationsRows).toEqual([
        expect.objectContaining({
          job_id: 'job-1',
          operation: 'create-table',
          status: 'completed',
        }),
      ]);
    });

    it('sets lock_timeout/statement_timeout from ConfigService before executing DDL', async () => {
      const state = buildFakeTenantState();
      const configService = buildConfigService();
      const cls = buildCls();
      const worker = new DdlWorker(state.tenantKnexService, configService, cls);

      const data: CreateTableJobData = {
        kind: 'create-table',
        jobId: 'job-1',
        tenantId: 'tenant1',
        tableId: 'table-1',
        tableName: 'invoices',
        description: null,
        fields: [],
      };

      await worker.process({ data } as Job<CreateTableJobData>);

      expect(configService.get).toHaveBeenCalledWith('DDL_LOCK_TIMEOUT_MS');
      expect(configService.get).toHaveBeenCalledWith(
        'DDL_STATEMENT_TIMEOUT_MS',
      );
    });

    it('re-establishes tenant context via ClsService.runWith() using the job payload tenantId', async () => {
      const state = buildFakeTenantState();
      const configService = buildConfigService();
      const cls = buildCls();
      const worker = new DdlWorker(state.tenantKnexService, configService, cls);

      const data: CreateTableJobData = {
        kind: 'create-table',
        jobId: 'job-1',
        tenantId: 'tenant42',
        tableId: 'table-1',
        tableName: 'invoices',
        description: null,
        fields: [],
      };

      await worker.process({ data } as Job<CreateTableJobData>);

      expect(cls.runWith).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant42' }),
        expect.any(Function),
      );
    });

    it('records a failed migration and re-throws when DDL execution fails (simulated lock_timeout)', async () => {
      const state = buildFakeTenantState();
      state.schemaBuilder.createTable = jest
        .fn()
        .mockRejectedValue(
          new Error('canceling statement due to lock timeout'),
        );
      const configService = buildConfigService();
      const cls = buildCls();
      const worker = new DdlWorker(state.tenantKnexService, configService, cls);

      const data: CreateTableJobData = {
        kind: 'create-table',
        jobId: 'job-1',
        tenantId: 'tenant1',
        tableId: 'table-1',
        tableName: 'invoices',
        description: null,
        fields: [],
      };

      await expect(
        worker.process({ data } as Job<CreateTableJobData>),
      ).rejects.toThrow('lock timeout');

      expect(state.metaMigrationsRows).toEqual([
        expect.objectContaining({
          job_id: 'job-1',
          status: 'failed',
          error: expect.stringContaining('lock timeout'),
        }),
      ]);
    });
  });

  describe('processFieldEdit (CAP-2/CAP-6 expand/contract)', () => {
    it('runs exactly one ADD COLUMN step for an additive add edit, with no table rewrite', async () => {
      const state = buildFakeTenantState(new Set(['id']));
      state.tables.add('invoices');
      const configService = buildConfigService();
      const cls = buildCls();
      const worker = new DdlWorker(state.tenantKnexService, configService, cls);

      const data: FieldEditJobData = {
        kind: 'field-edit',
        jobId: 'job-2',
        tenantId: 'tenant1',
        tableId: 'table-1',
        tableName: 'invoices',
        steps: [
          {
            kind: 'add-column',
            columnName: 'notes',
            dataType: FieldDataType.TEXT,
            required: false,
            config: null,
          },
        ],
        metadataEffects: [
          {
            kind: 'upsert-field',
            name: 'notes',
            slug: 'notes',
            dataType: FieldDataType.TEXT,
            required: false,
            config: null,
          },
        ],
      };

      await worker.process({ data } as Job<FieldEditJobData>);

      expect(state.schemaBuilder.alterTable).toHaveBeenCalledTimes(1);
      expect(state.columnsByTable.get('invoices')?.has('notes')).toBe(true);
      expect(
        state.metaMigrationsRows.filter((r) => r.operation === 'add-column'),
      ).toHaveLength(1);
    });

    it('runs an add-relation-column step: FK column schema-qualified to the tenant schema, ON DELETE SET NULL, writes relation_target_table_id (Story 4/CAP-4)', async () => {
      const state = buildFakeTenantState(new Set(['id']));
      state.tables.add('invoices');
      state.tables.add('customers');
      const configService = buildConfigService();
      const cls = buildCls();
      const worker = new DdlWorker(state.tenantKnexService, configService, cls);

      const data: FieldEditJobData = {
        kind: 'field-edit',
        jobId: 'job-relation-1',
        tenantId: 'tenant1',
        tableId: 'table-1',
        tableName: 'invoices',
        steps: [
          {
            kind: 'add-relation-column',
            columnName: 'customer',
            targetTableName: 'customers',
            required: false,
          },
        ],
        metadataEffects: [
          {
            kind: 'upsert-field',
            name: 'customer',
            slug: 'customer',
            dataType: FieldDataType.RELATION,
            required: false,
            config: null,
            relationTargetTableId: 'table-2',
          },
        ],
      };

      await worker.process({ data } as Job<FieldEditJobData>);

      expect(state.schemaBuilder.alterTable).toHaveBeenCalledTimes(1);
      expect(state.columnsByTable.get('invoices')?.has('customer')).toBe(true);

      const relationCall = state.relationColumnCalls.find(
        (c) => c.column === 'customer',
      );
      expect(relationCall).toBeDefined();
      expect(relationCall?.references).toBe('id');
      // Schema-qualified .inTable() value (AD-7's structural cross-tenant
      // defense) -- built from the job's own tenantId via
      // resolveTenantSchema(), never a bare unqualified table name.
      expect(relationCall?.inTable).toBe('tenant_tenant1.customers');
      expect(relationCall?.onDelete).toBe('SET NULL');
      expect(relationCall?.nullable).toBe(true);

      expect(state.metaFieldsRows).toEqual([
        expect.objectContaining({
          table_id: 'table-1',
          slug: 'customer',
          data_type: FieldDataType.RELATION,
          relation_target_table_id: 'table-2',
        }),
      ]);
      expect(
        state.metaMigrationsRows.filter(
          (r) => r.operation === 'add-relation-column',
        ),
      ).toHaveLength(1);
    });

    it('builds a NOT NULL relation column when required: true', async () => {
      const state = buildFakeTenantState(new Set(['id']));
      state.tables.add('invoices');
      const configService = buildConfigService();
      const cls = buildCls();
      const worker = new DdlWorker(state.tenantKnexService, configService, cls);

      const data: FieldEditJobData = {
        kind: 'field-edit',
        jobId: 'job-relation-2',
        tenantId: 'tenant1',
        tableId: 'table-1',
        tableName: 'invoices',
        steps: [
          {
            kind: 'add-relation-column',
            columnName: 'customer',
            targetTableName: 'customers',
            required: true,
          },
        ],
        metadataEffects: [
          {
            kind: 'upsert-field',
            name: 'customer',
            slug: 'customer',
            dataType: FieldDataType.RELATION,
            required: true,
            config: null,
            relationTargetTableId: 'table-2',
          },
        ],
      };

      await worker.process({ data } as Job<FieldEditJobData>);

      const relationCall = state.relationColumnCalls.find(
        (c) => c.column === 'customer',
      );
      expect(relationCall?.nullable).toBe(false);
    });

    it('add-relation-column is existence-guarded: a retry that already committed the column does not error', async () => {
      const state = buildFakeTenantState(new Set(['id', 'customer']));
      state.tables.add('invoices');
      const configService = buildConfigService();
      const cls = buildCls();
      const worker = new DdlWorker(state.tenantKnexService, configService, cls);

      const data: FieldEditJobData = {
        kind: 'field-edit',
        jobId: 'job-relation-3',
        tenantId: 'tenant1',
        tableId: 'table-1',
        tableName: 'invoices',
        steps: [
          {
            kind: 'add-relation-column',
            columnName: 'customer',
            targetTableName: 'customers',
            required: false,
          },
        ],
        metadataEffects: [
          {
            kind: 'upsert-field',
            name: 'customer',
            slug: 'customer',
            dataType: FieldDataType.RELATION,
            required: false,
            config: null,
            relationTargetTableId: 'table-2',
          },
        ],
      };

      await expect(
        worker.process({ data } as Job<FieldEditJobData>),
      ).resolves.toBeUndefined();

      expect(state.schemaBuilder.alterTable).not.toHaveBeenCalled();
    });

    it('runs a destructive modify as a 3-step expand/contract sequence, never a single in-place ALTER TYPE', async () => {
      const state = buildFakeTenantState(new Set(['id', 'amount']));
      state.tables.add('invoices');
      const configService = buildConfigService();
      const cls = buildCls();
      const worker = new DdlWorker(state.tenantKnexService, configService, cls);

      const data: FieldEditJobData = {
        kind: 'field-edit',
        jobId: 'job-3',
        tenantId: 'tenant1',
        tableId: 'table-1',
        tableName: 'invoices',
        steps: [
          {
            kind: 'add-shadow-column',
            shadowColumnName: 'amount__shadow',
            dataType: FieldDataType.NUMBER,
            required: false,
            config: null,
          },
          {
            kind: 'backfill-column',
            sourceColumnName: 'amount',
            shadowColumnName: 'amount__shadow',
          },
          {
            kind: 'cutover-column',
            sourceColumnName: 'amount',
            shadowColumnName: 'amount__shadow',
            finalColumnName: 'amount',
          },
        ],
        metadataEffects: [
          {
            kind: 'upsert-field',
            name: 'amount',
            slug: 'amount',
            dataType: FieldDataType.NUMBER,
            required: false,
            config: null,
          },
        ],
      };

      await worker.process({ data } as Job<FieldEditJobData>);

      const columns = state.columnsByTable.get('invoices');
      expect(columns?.has('amount')).toBe(true); // renamed back into place
      expect(columns?.has('amount__shadow')).toBe(false); // consumed by cutover
      expect(state.raws.some((s) => s.includes('amount__shadow'))).toBe(true); // backfill ran
      expect(state.metaMigrationsRows.map((r) => r.operation)).toEqual([
        'add-shadow-column',
        'backfill-column',
        'cutover-column',
      ]);
      expect(
        state.metaMigrationsRows.every((r) => r.status === 'completed'),
      ).toBe(true);
    });

    it('a retry that restarts from steps[0] after a mid-sequence failure does not error on an already-committed step', async () => {
      const state = buildFakeTenantState(new Set(['id', 'amount']));
      state.tables.add('invoices');
      const configService = buildConfigService();
      const cls = buildCls();
      const worker = new DdlWorker(state.tenantKnexService, configService, cls);

      const steps: FieldEditJobData['steps'] = [
        {
          kind: 'add-shadow-column',
          shadowColumnName: 'amount__shadow',
          dataType: FieldDataType.NUMBER,
          required: false,
          config: null,
        },
        {
          kind: 'backfill-column',
          sourceColumnName: 'amount',
          shadowColumnName: 'amount__shadow',
        },
        {
          kind: 'cutover-column',
          sourceColumnName: 'amount',
          shadowColumnName: 'amount__shadow',
          finalColumnName: 'amount',
        },
      ];

      const data: FieldEditJobData = {
        kind: 'field-edit',
        jobId: 'job-4',
        tenantId: 'tenant1',
        tableId: 'table-1',
        tableName: 'invoices',
        steps,
        metadataEffects: [
          {
            kind: 'upsert-field',
            name: 'amount',
            slug: 'amount',
            dataType: FieldDataType.NUMBER,
            required: false,
            config: null,
          },
        ],
      };

      // Simulate a mid-sequence transient failure: the 2nd
      // `tenantKnexService.transaction()` call ever made (i.e. step 2,
      // backfill-column, on the FIRST attempt at process()) throws once;
      // every other call -- including step 1 on the first attempt, and
      // every step on the retried second attempt -- behaves normally.
      let transactionCallCount = 0;
      (state.tenantKnexService.transaction as jest.Mock).mockImplementation(
        async (fn: (trx: Knex.Transaction) => Promise<void>) => {
          transactionCallCount += 1;
          if (transactionCallCount === 2) {
            throw new Error('simulated transient failure on backfill');
          }
          const trx = {
            raw: jest.fn(async (sql: string) => {
              state.raws.push(sql);
            }),
          } as unknown as Knex.Transaction;
          return fn(trx);
        },
      );

      // First attempt: step 1 (add-shadow-column) commits, step 2
      // (backfill-column) throws -- the whole job rejects, as BullMQ
      // expects in order to trigger its retry/backoff.
      await expect(
        worker.process({ data } as Job<FieldEditJobData>),
      ).rejects.toThrow('simulated transient failure');

      // add-shadow-column already committed in the first attempt.
      expect(state.columnsByTable.get('invoices')?.has('amount__shadow')).toBe(
        true,
      );

      // Retry from steps[0]: add-shadow-column must NOT error on "already
      // exists" even though a prior attempt already committed it -- the
      // whole job now runs to completion.
      await expect(
        worker.process({ data } as Job<FieldEditJobData>),
      ).resolves.toBeUndefined();

      const columns = state.columnsByTable.get('invoices');
      expect(columns?.has('amount')).toBe(true);
      expect(columns?.has('amount__shadow')).toBe(false);
    });

    it('drop-column is a no-op (does not error) if the source column is already gone', async () => {
      const state = buildFakeTenantState(new Set(['id'])); // 'title' already absent
      state.tables.add('invoices');
      const configService = buildConfigService();
      const cls = buildCls();
      const worker = new DdlWorker(state.tenantKnexService, configService, cls);

      const data: FieldEditJobData = {
        kind: 'field-edit',
        jobId: 'job-5',
        tenantId: 'tenant1',
        tableId: 'table-1',
        tableName: 'invoices',
        steps: [{ kind: 'drop-column', columnName: 'title' }],
        metadataEffects: [{ kind: 'remove-field', slug: 'title' }],
      };

      await expect(
        worker.process({ data } as Job<FieldEditJobData>),
      ).resolves.toBeUndefined();

      expect(state.metaMigrationsRows[0]).toEqual(
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('records a failed migration row for the specific step that fails and re-throws (BullMQ retries the whole job)', async () => {
      const state = buildFakeTenantState(new Set(['id']));
      state.tables.add('invoices');
      state.schemaBuilder.alterTable = jest
        .fn()
        .mockRejectedValue(
          new Error('canceling statement due to lock timeout'),
        );
      const configService = buildConfigService();
      const cls = buildCls();
      const worker = new DdlWorker(state.tenantKnexService, configService, cls);

      const data: FieldEditJobData = {
        kind: 'field-edit',
        jobId: 'job-6',
        tenantId: 'tenant1',
        tableId: 'table-1',
        tableName: 'invoices',
        steps: [
          {
            kind: 'add-column',
            columnName: 'notes',
            dataType: FieldDataType.TEXT,
            required: false,
            config: null,
          },
        ],
        metadataEffects: [
          {
            kind: 'upsert-field',
            name: 'notes',
            slug: 'notes',
            dataType: FieldDataType.TEXT,
            required: false,
            config: null,
          },
        ],
      };

      await expect(
        worker.process({ data } as Job<FieldEditJobData>),
      ).rejects.toThrow('lock timeout');

      expect(state.metaMigrationsRows).toEqual([
        expect.objectContaining({
          operation: 'add-column',
          status: 'failed',
          error: expect.stringContaining('lock timeout'),
        }),
      ]);
    });
  });
});
