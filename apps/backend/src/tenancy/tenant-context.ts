import { Injectable } from '@nestjs/common';
import { ClsService, ClsStore } from 'nestjs-cls';

/**
 * Keys this module's CLS store holds. Set only from inside
 * `JwtAuthGuard.canActivate()` once a tenant-scoped access token has been
 * verified -- see tenancy.module.ts's Design Notes for why that happens
 * there and not in `ClsModule`'s middleware `setup` hook.
 *
 * Extends the library's own `ClsStore` (a `[key: symbol]: any` index
 * signature used internally for Proxy Providers) so this type can be used
 * as `ClsService<TenancyClsStore>`'s generic parameter.
 */
export interface TenancyClsStore extends ClsStore {
  tenantId: string;
  schema: string;
}

/**
 * Thin typed wrapper around `ClsService` so call sites never sprinkle raw
 * string keys around. Both getters throw rather than returning
 * `undefined`/`public` -- a caller that isn't inside a verified tenant
 * request (a System actor's token, or code running outside a request
 * entirely, e.g. app bootstrap) must fail loudly, not silently fall back to
 * an ambient schema.
 */
@Injectable()
export class TenantContext {
  constructor(private readonly cls: ClsService<TenancyClsStore>) {}

  get tenantId(): string {
    return this.require('tenantId');
  }

  /** `tenant_<tenantId>` for the current request. No DB round trip. */
  get schema(): string {
    return this.require('schema');
  }

  private require(key: keyof TenancyClsStore): string {
    const value = this.cls.get(key);
    if (!value) {
      throw new Error(
        'No tenant context -- this code path must run inside a request ' +
          'authenticated with a tenant-scoped access token',
      );
    }
    return value;
  }
}
