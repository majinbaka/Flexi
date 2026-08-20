import { Knex } from 'knex';
import { DynamicTablesService } from './dynamic-tables.service';
import { TenantKnexService } from '../../tenancy/tenant-knex.service';

/**
 * Covers Story 1's bootstrap-migration acceptance criteria: correct
 * table/column shape requested via a mocked
 * `TenantKnexService.schemaForCurrentTenant()` for all three tables (not
 * just `_meta_tables`), each FK column's `.onDelete('CASCADE')`, the three
 * `createTable` calls running inside one `TenantKnexService.transaction()`,
 * and idempotency (a second invocation is a no-op when `hasTable()` already
 * returns true).
 */
describe('DynamicTablesService', () => {
  describe('getStatus', () => {
    it('still returns the not-implemented placeholder (no regression to the stub route)', () => {
      const tenantKnexService = {} as TenantKnexService;
      const service = new DynamicTablesService(tenantKnexService);

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
          recorder.calls.push({ column: name, method: `type:${type}`, args: rest });
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
      const service = new DynamicTablesService(tenantKnexService);

      await service.ensureMetaTables();

      expect(tenantKnexService.transaction).toHaveBeenCalledTimes(1);
      expect(schema.transacting).toHaveBeenCalledTimes(1);
    });

    it('creates _meta_tables, _meta_fields, and _meta_migrations when none exist yet', async () => {
      const { schema, hasTable, createTable } = buildMockSchema(false);
      const tenantKnexService = buildTenantKnexService(schema);
      const service = new DynamicTablesService(tenantKnexService);

      await service.ensureMetaTables();

      expect(tenantKnexService.schemaForCurrentTenant).toHaveBeenCalledTimes(
        1,
      );
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
      const service = new DynamicTablesService(tenantKnexService);

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
      const service = new DynamicTablesService(tenantKnexService);

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
    });

    it("builds _meta_migrations with AD-10's pinned columns and a CASCADE table_id FK", async () => {
      const { schema, createTable } = buildMockSchema(false);
      const tenantKnexService = buildTenantKnexService(schema);
      const service = new DynamicTablesService(tenantKnexService);

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

      const cascadeColumns = recorder.calls
        .filter((c) => c.method === 'onDelete' && c.args[0] === 'CASCADE')
        .map((c) => c.column);
      expect(cascadeColumns).toEqual(expect.arrayContaining(['table_id']));
    });

    it('is idempotent: a second invocation with hasTable() returning true creates nothing', async () => {
      const { schema, hasTable, createTable } = buildMockSchema(true);
      const tenantKnexService = buildTenantKnexService(schema);
      const service = new DynamicTablesService(tenantKnexService);

      await service.ensureMetaTables();

      expect(hasTable).toHaveBeenCalledTimes(3);
      expect(createTable).not.toHaveBeenCalled();
    });
  });
});
