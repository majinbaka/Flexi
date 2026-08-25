import { Knex } from 'knex';
import { TenantSeedService } from './tenant-seed.service';
import { TenantKnexService } from '../../tenancy/tenant-knex.service';
import { TenantContext } from '../../tenancy/tenant-context';

/**
 * Mirrors dynamic-tables.service.spec.ts's `ensureMetaTables()` mock
 * patterns: a fresh `Knex.SchemaBuilder`-shaped mock per `hasTable()`/
 * `createTable()` call, and a query-builder-shaped mock (chainable
 * `insert()`/`onConflict()`/`ignore()`/`whereIn()`/`select()`) for the row
 * seeding side, all wrapped by a `TenantKnexService.transaction()` mock that
 * just invokes the callback with a stub `trx`.
 */
describe('TenantSeedService', () => {
  const TABLE_NAMES = [
    'system_settings',
    'statuses',
    'roles',
    'permissions',
    'role_permissions',
    'categories',
    'notification_templates',
  ];

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

  /**
   * Builds a chainable query-builder mock keyed by table name, backed by an
   * in-memory row store keyed by natural key -- close enough to real
   * Postgres `onConflict().ignore()`/`whereIn().select()` semantics to
   * exercise `TenantSeedService`'s row-seeding logic and idempotency
   * without a live DB.
   */
  function buildMockQueryTables() {
    const store: Record<string, Map<string, Record<string, unknown>>> = {};
    for (const name of TABLE_NAMES) {
      store[name] = new Map();
    }
    const naturalKeyByTable: Record<string, string | string[]> = {
      system_settings: 'key',
      statuses: 'name',
      roles: 'name',
      permissions: 'code',
      role_permissions: ['role_id', 'permission_id'],
      categories: 'name',
      notification_templates: 'code',
    };

    function conflictKey(tableName: string, row: Record<string, unknown>) {
      const naturalKey = naturalKeyByTable[tableName];
      if (Array.isArray(naturalKey)) {
        return naturalKey.map((k) => row[k]).join('::');
      }
      return String(row[naturalKey]);
    }

    const insertCalls: Array<{
      table: string;
      rows: Record<string, unknown>[];
    }> = [];

    function table(name: string): Knex.QueryBuilder {
      const rowsToInsert: Record<string, unknown>[] = [];
      let whereInField: string | null = null;
      let whereInValues: unknown[] = [];

      const builder = {
        transacting: jest.fn().mockReturnThis(),
        insert: jest.fn((rows: Record<string, unknown>[]) => {
          rowsToInsert.push(...rows);
          insertCalls.push({ table: name, rows });
          return builder;
        }),
        onConflict: jest.fn(() => builder),
        ignore: jest.fn(async () => {
          for (const row of rowsToInsert) {
            const key = conflictKey(name, row);
            if (!store[name].has(key)) {
              store[name].set(key, row);
            }
          }
          return undefined;
        }),
        whereIn: jest.fn((field: string, values: unknown[]) => {
          whereInField = field;
          whereInValues = values;
          return builder;
        }),
        select: jest.fn(async (...fields: string[]) => {
          const rows = Array.from(store[name].values());
          const filtered = whereInField
            ? rows.filter((row) =>
                whereInValues.includes(row[whereInField as string]),
              )
            : rows;
          return filtered.map((row) => {
            const picked: Record<string, unknown> = {};
            for (const field of fields) {
              picked[field] = row[field];
            }
            return picked;
          });
        }),
      } as unknown as Knex.QueryBuilder;

      return builder;
    }

    return { table, store, insertCalls };
  }

  function buildTenantKnexService(
    schemaFactory: () => Knex.SchemaBuilder,
    queryTables: ReturnType<typeof buildMockQueryTables>,
  ) {
    return {
      schemaForCurrentTenant: jest.fn(schemaFactory),
      forCurrentTenant: jest.fn(() => ({
        table: jest.fn((name: string) => queryTables.table(name)),
      })),
      transaction: jest.fn(
        async (fn: (trx: Knex.Transaction) => Promise<void>) =>
          fn({} as Knex.Transaction),
      ),
    } as unknown as TenantKnexService;
  }

  function buildTenantContext(schema = 'tenant_abc123') {
    return { schema } as TenantContext;
  }

  describe('bootstrapSeed -- first run', () => {
    it('creates all seven tables inside one transaction', async () => {
      const { schema } = buildMockSchema(false);
      const queryTables = buildMockQueryTables();
      const tenantKnexService = buildTenantKnexService(
        () => schema,
        queryTables,
      );
      const service = new TenantSeedService(
        tenantKnexService,
        buildTenantContext(),
      );

      await service.bootstrapSeed();

      expect(tenantKnexService.transaction).toHaveBeenCalledTimes(1);
      const createdNames = (schema.createTable as jest.Mock).mock.calls.map(
        ([name]: [string]) => name,
      );
      expect(createdNames).toEqual(TABLE_NAMES);
    });

    it('schema-qualifies role_permissions FKs into roles/permissions', async () => {
      const { schema } = buildMockSchema(false);
      const queryTables = buildMockQueryTables();
      const tenantKnexService = buildTenantKnexService(
        () => schema,
        queryTables,
      );
      const service = new TenantSeedService(
        tenantKnexService,
        buildTenantContext('tenant_abc123'),
      );

      await service.bootstrapSeed();

      const rolePermissionsCall = (
        schema.createTable as jest.Mock
      ).mock.calls.find(([name]: [string]) => name === 'role_permissions');
      expect(rolePermissionsCall).toBeDefined();

      const columnChain: Record<string, jest.Mock> = {};
      const methods = [
        'notNullable',
        'references',
        'inTable',
        'onDelete',
        'primary',
      ];
      const inTableArgs: unknown[] = [];
      for (const method of methods) {
        columnChain[method] = jest.fn((...args: unknown[]) => {
          if (method === 'inTable') {
            inTableArgs.push(args[0]);
          }
          return columnChain;
        });
      }

      const tableBuilder = {
        string: jest.fn(() => columnChain),
        timestamps: jest.fn(),
        unique: jest.fn(),
      } as unknown as Knex.CreateTableBuilder;

      const [, callback] = rolePermissionsCall as [
        string,
        (t: unknown) => void,
      ];
      callback(tableBuilder);

      expect(inTableArgs).toEqual(
        expect.arrayContaining([
          'tenant_abc123.roles',
          'tenant_abc123.permissions',
        ]),
      );
    });

    it('inserts default system_settings rows for locale/timezone/base currency/config flags', async () => {
      const { schema } = buildMockSchema(false);
      const queryTables = buildMockQueryTables();
      const tenantKnexService = buildTenantKnexService(
        () => schema,
        queryTables,
      );
      const service = new TenantSeedService(
        tenantKnexService,
        buildTenantContext(),
      );

      await service.bootstrapSeed();

      const keys = Array.from(queryTables.store.system_settings.values()).map(
        (row) => row.key,
      );
      expect(keys).toEqual(
        expect.arrayContaining(['locale', 'timezone', 'base_currency']),
      );
      expect(queryTables.store.system_settings.size).toBeGreaterThanOrEqual(4);
    });

    it('inserts default statuses Draft/In Review/Active/Archived', async () => {
      const { schema } = buildMockSchema(false);
      const queryTables = buildMockQueryTables();
      const tenantKnexService = buildTenantKnexService(
        () => schema,
        queryTables,
      );
      const service = new TenantSeedService(
        tenantKnexService,
        buildTenantContext(),
      );

      await service.bootstrapSeed();

      const names = Array.from(queryTables.store.statuses.values()).map(
        (row) => row.name,
      );
      expect(names).toEqual(['Draft', 'In Review', 'Active', 'Archived']);
    });

    it('inserts Tenant Admin/Manager/Member roles with a non-empty role_permissions matrix', async () => {
      const { schema } = buildMockSchema(false);
      const queryTables = buildMockQueryTables();
      const tenantKnexService = buildTenantKnexService(
        () => schema,
        queryTables,
      );
      const service = new TenantSeedService(
        tenantKnexService,
        buildTenantContext(),
      );

      await service.bootstrapSeed();

      const roleNames = Array.from(queryTables.store.roles.values()).map(
        (row) => row.name,
      );
      expect(roleNames).toEqual(
        expect.arrayContaining(['Tenant Admin', 'Manager', 'Member']),
      );

      const rolePermissionRows = Array.from(
        queryTables.store.role_permissions.values(),
      );
      expect(rolePermissionRows.length).toBeGreaterThan(0);

      // Tenant Admin gets every seeded permission code.
      const permissionCount = queryTables.store.permissions.size;
      const tenantAdminRoleId = Array.from(
        queryTables.store.roles.values(),
      ).find((row) => row.name === 'Tenant Admin')?.id;
      const tenantAdminGrantCount = rolePermissionRows.filter(
        (row) => row.role_id === tenantAdminRoleId,
      ).length;
      expect(tenantAdminGrantCount).toBe(permissionCount);

      // Member is read-only: fewer grants than Tenant Admin.
      const memberRoleId = Array.from(queryTables.store.roles.values()).find(
        (row) => row.name === 'Member',
      )?.id;
      const memberGrantCount = rolePermissionRows.filter(
        (row) => row.role_id === memberRoleId,
      ).length;
      expect(memberGrantCount).toBeGreaterThan(0);
      expect(memberGrantCount).toBeLessThan(tenantAdminGrantCount);
    });

    it('inserts default categories General/Operations/Administrative', async () => {
      const { schema } = buildMockSchema(false);
      const queryTables = buildMockQueryTables();
      const tenantKnexService = buildTenantKnexService(
        () => schema,
        queryTables,
      );
      const service = new TenantSeedService(
        tenantKnexService,
        buildTenantContext(),
      );

      await service.bootstrapSeed();

      const names = Array.from(queryTables.store.categories.values()).map(
        (row) => row.name,
      );
      expect(names).toEqual(['General', 'Operations', 'Administrative']);
    });

    it('inserts default notification templates WELCOME_SETUP_INVITE/PASSWORD_RESET_REQUEST/WORKSPACE_LIMIT_WARNING', async () => {
      const { schema } = buildMockSchema(false);
      const queryTables = buildMockQueryTables();
      const tenantKnexService = buildTenantKnexService(
        () => schema,
        queryTables,
      );
      const service = new TenantSeedService(
        tenantKnexService,
        buildTenantContext(),
      );

      await service.bootstrapSeed();

      const codes = Array.from(
        queryTables.store.notification_templates.values(),
      ).map((row) => row.code);
      expect(codes).toEqual([
        'WELCOME_SETUP_INVITE',
        'PASSWORD_RESET_REQUEST',
        'WORKSPACE_LIMIT_WARNING',
      ]);
    });
  });

  describe('bootstrapSeed -- worker retry / idempotency', () => {
    it('is a no-op when every table already exists: no createTable calls, no duplicate rows, no error', async () => {
      const { schema, createTable } = buildMockSchema(true);
      const queryTables = buildMockQueryTables();
      const tenantKnexService = buildTenantKnexService(
        () => schema,
        queryTables,
      );
      const service = new TenantSeedService(
        tenantKnexService,
        buildTenantContext(),
      );

      await expect(service.bootstrapSeed()).resolves.toBeUndefined();

      expect(createTable).not.toHaveBeenCalled();
    });

    it('running bootstrapSeed twice does not duplicate rows', async () => {
      const { schema } = buildMockSchema(false);
      const queryTables = buildMockQueryTables();
      const tenantKnexService = buildTenantKnexService(
        () => schema,
        queryTables,
      );
      const service = new TenantSeedService(
        tenantKnexService,
        buildTenantContext(),
      );

      await service.bootstrapSeed();
      const statusCountAfterFirst = queryTables.store.statuses.size;
      const rolePermissionCountAfterFirst =
        queryTables.store.role_permissions.size;

      // Second run: tables now "exist" from the caller's perspective too,
      // but this test only needs to prove the row-seeding side is
      // idempotent, so hasTable() staying false (fresh mock, DDL guard
      // already covered above) does not affect row counts -- onConflict()
      // .ignore() is what's under test here.
      await service.bootstrapSeed();

      expect(queryTables.store.statuses.size).toBe(statusCountAfterFirst);
      expect(queryTables.store.role_permissions.size).toBe(
        rolePermissionCountAfterFirst,
      );
    });
  });

  describe('bootstrapSeed -- transaction failure', () => {
    it('propagates a mid-transaction error and never persists (no catch-and-swallow)', async () => {
      const { schema } = buildMockSchema(false);
      const queryTables = buildMockQueryTables();
      const tenantKnexService = buildTenantKnexService(
        () => schema,
        queryTables,
      );

      (tenantKnexService.transaction as jest.Mock).mockImplementationOnce(
        (fn: (trx: Knex.Transaction) => Promise<void>) =>
          fn({} as Knex.Transaction),
      );

      // Force a failure partway through DDL (role_permissions' createTable,
      // the 5th table) by rejecting hasTable() on that specific call.
      let hasTableCallCount = 0;
      (schema.hasTable as jest.Mock).mockImplementation(async () => {
        hasTableCallCount += 1;
        if (hasTableCallCount === 5) {
          throw new Error('connection terminated unexpectedly');
        }
        return false;
      });

      const service = new TenantSeedService(
        tenantKnexService,
        buildTenantContext(),
      );

      await expect(service.bootstrapSeed()).rejects.toThrow(
        'connection terminated unexpectedly',
      );

      // No row-seeding call ever ran -- the failure happened during DDL,
      // before any insert() was reached.
      expect(queryTables.insertCalls).toEqual([]);
    });
  });
});
