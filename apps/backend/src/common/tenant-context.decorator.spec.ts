import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ExecutionContext } from '@nestjs/common';
import { TenantIdHeader } from './tenant-context.decorator';

/**
 * Custom param decorators can't be invoked directly outside a real request
 * pipeline -- this extracts the underlying factory the same way Nest's own
 * ExecutionUtils does at request time, then drives it against a
 * hand-built ExecutionContext. Covers the `x-tenant-id` header's
 * array-vs-string normalization, which was previously only exercised
 * indirectly via mocked AuthService/AuthController specs.
 */
describe('TenantIdHeader', () => {
  class TestController {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    handler(@TenantIdHeader() _tenantId?: string) {}
  }

  function getFactory() {
    const metadata = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      TestController,
      'handler',
    );
    const key = Object.keys(metadata).find((k) => k.includes('__custom'));
    return metadata[key as string]
      .factory as (data: unknown, ctx: ExecutionContext) => string | undefined;
  }

  function makeContext(headers: Record<string, unknown>): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers }),
      }),
    } as unknown as ExecutionContext;
  }

  it('returns the header value when x-tenant-id is a single string', () => {
    const factory = getFactory();
    const ctx = makeContext({ 'x-tenant-id': 'tenant_1' });

    expect(factory(undefined, ctx)).toBe('tenant_1');
  });

  it('returns the first value when x-tenant-id is sent as multiple headers', () => {
    const factory = getFactory();
    const ctx = makeContext({ 'x-tenant-id': ['tenant_1', 'tenant_2'] });

    expect(factory(undefined, ctx)).toBe('tenant_1');
  });

  it('returns undefined when x-tenant-id is absent', () => {
    const factory = getFactory();
    const ctx = makeContext({});

    expect(factory(undefined, ctx)).toBeUndefined();
  });
});
