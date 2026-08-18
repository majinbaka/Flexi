import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { TenantContext, TenancyClsStore } from './tenant-context';

/**
 * Covers the I/O matrix rows in spec-schema-per-tenant-core.md that describe
 * TenantContext's own contract: no-DB-round-trip schema resolution for a
 * valid tenant request, and throwing (never `undefined`/`public`) both for
 * a System actor's request and for code that runs with no CLS store at all
 * (e.g. app bootstrap).
 */
describe('TenantContext', () => {
  function makeContext(): {
    cls: ClsService<TenancyClsStore>;
    context: TenantContext;
  } {
    const cls = new ClsService<TenancyClsStore>(new AsyncLocalStorage());
    return { cls, context: new TenantContext(cls) };
  }

  it('returns tenant_<id> once CLS holds a tenant schema, with no DB round trip', async () => {
    const { cls, context } = makeContext();

    await cls.run(async () => {
      cls.set('tenantId', 'tenant_1');
      cls.set('schema', 'tenant_tenant_1');

      expect(context.tenantId).toBe('tenant_1');
      expect(context.schema).toBe('tenant_tenant_1');
    });
  });

  it('throws when accessed for a system (non-tenant) request -- CLS store open but no schema set', async () => {
    const { cls, context } = makeContext();

    await cls.run(async () => {
      // Mirrors JwtAuthGuard's behavior for a System actor's token: the CLS
      // store is active (middleware opened it) but tenantId/schema were
      // never set because the verified claim carried no tenantId.
      expect(() => context.schema).toThrow(/No tenant context/);
      expect(() => context.tenantId).toThrow(/No tenant context/);
    });
  });

  it('throws when accessed outside any CLS store (e.g. app bootstrap code)', () => {
    const { context } = makeContext();

    // No cls.run() wrapper here at all -- simulates code executing outside
    // a request entirely.
    expect(() => context.schema).toThrow(/No tenant context/);
    expect(() => context.tenantId).toThrow(/No tenant context/);
  });
});
