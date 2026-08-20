import { AsyncLocalStorage } from 'async_hooks';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { TenantContext, TenancyClsStore } from './tenant-context';
import { TenantKnexService } from './tenant-knex.service';

/**
 * Covers the I/O matrix's "Scoped query compile" row and the spec's third
 * Acceptance Criterion: `forCurrentTenant()` compiles to schema-qualified
 * SQL and no code path in this change issues a session-level
 * `SET search_path`.
 *
 * Building/compiling a Knex query (`.toString()`) never calls the
 * underlying `pg` pool's `acquire()` -- connections are created lazily only
 * when a query actually executes (verified against tarn's Pool source,
 * which the pool provider dep, `knex`, uses internally) -- so these tests
 * need no live Postgres connection, per the spec's Design Notes ("no live
 * tenant schema exists yet ... tests must not depend on a real
 * tenant_<id> schema being present in Postgres").
 */
describe('TenantKnexService', () => {
  let service: TenantKnexService;
  let cls: ClsService<TenancyClsStore>;

  beforeAll(() => {
    cls = new ClsService<TenancyClsStore>(new AsyncLocalStorage());
    const tenantContext = new TenantContext(cls);
    const configService = {
      get: () => 'postgresql://user:pass@localhost:5432/flexi_test',
    } as unknown as ConfigService;

    service = new TenantKnexService(configService, tenantContext);
    service.onModuleInit();
  });

  afterAll(async () => {
    await service.onModuleDestroy();
  });

  it('compiles a schema-qualified query for the current tenant, with no SET search_path anywhere', async () => {
    await cls.run(async () => {
      cls.set('tenantId', 'tenant_1');
      cls.set('schema', 'tenant_tenant_1');

      const sql = service
        .forCurrentTenant()
        .table('orders')
        .where({ id: '1' })
        .toString();

      expect(sql).toContain('"tenant_tenant_1"."orders"');
      expect(sql.toUpperCase()).not.toContain('SET SEARCH_PATH');
      expect(sql.toUpperCase()).not.toContain('SET SESSION');
    });
  });

  it('throws instead of compiling an unscoped query outside a tenant context', () => {
    expect(() => service.forCurrentTenant()).toThrow(/No tenant context/);
  });

  it('compiles a schema-scoped DDL statement for the current tenant via schemaForCurrentTenant()', async () => {
    await cls.run(async () => {
      cls.set('tenantId', 'tenant_1');
      cls.set('schema', 'tenant_tenant_1');

      const sql = service
        .schemaForCurrentTenant()
        .createTable('_meta_tables', (t) => {
          t.string('id').primary();
        })
        .toString();

      expect(sql).toContain('"tenant_tenant_1"."_meta_tables"');
    });
  });

  it('throws instead of compiling an unscoped schema builder outside a tenant context', () => {
    expect(() => service.schemaForCurrentTenant()).toThrow(/No tenant context/);
  });

  it('delegates transaction() to the underlying knex.transaction()', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawKnex = (service as any).knex;
    const originalTransaction = rawKnex.transaction;
    const mockTransaction = jest.fn().mockResolvedValue('result');
    // knex.transaction is a non-writable (but configurable) own property --
    // plain assignment/jest.spyOn's default writer both fail against it, so
    // redefine it directly and restore the original afterward.
    Object.defineProperty(rawKnex, 'transaction', {
      value: mockTransaction,
      configurable: true,
    });

    const fn = jest.fn();
    const result = await service.transaction(fn);

    expect(mockTransaction).toHaveBeenCalledWith(fn);
    expect(result).toBe('result');

    Object.defineProperty(rawKnex, 'transaction', {
      value: originalTransaction,
      configurable: true,
    });
  });
});
