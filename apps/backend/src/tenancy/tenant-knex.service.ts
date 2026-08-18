import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import KnexBuilder, { Knex } from 'knex';
import { TenantContext } from './tenant-context';

/**
 * One shared Knex `pg` pool for the whole app, reusing the same
 * `DATABASE_URL` Prisma connects with (apps/backend/src/config/env.
 * validation.ts) -- never a per-tenant pool, which would exhaust Postgres
 * `max_connections` as tenant count grows. Lifecycle-hooked the same way as
 * `PrismaService` (apps/backend/src/prisma/prisma.service.ts): the pool is
 * built on module init and torn down cleanly on shutdown. Unlike
 * `PrismaService.$connect()`, building the pool here does NOT eagerly open
 * a real connection or validate connectivity -- Knex/`pg`'s pool is lazy
 * and only opens a connection when a query actually executes. That's
 * intentional (see spec-schema-per-tenant-core.md's Design Notes): it's
 * what lets `forCurrentTenant()`'s SQL-compilation be unit-tested without a
 * live Postgres instance.
 */
@Injectable()
export class TenantKnexService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantKnexService.name);
  private knex!: Knex;

  constructor(
    private readonly configService: ConfigService,
    private readonly tenantContext: TenantContext,
  ) {}

  onModuleInit(): void {
    this.knex = KnexBuilder({
      client: 'pg',
      connection: this.configService.get<string>('DATABASE_URL'),
      pool: { min: 2, max: 50 },
    });
    this.logger.log('Tenant Knex pool initialized');
  }

  async onModuleDestroy(): Promise<void> {
    // Guard against onModuleInit() never having run (e.g. a different
    // module failed to initialize first) -- calling destroy() on an unset
    // pool would throw a TypeError that masks the real startup failure.
    if (this.knex) {
      await this.knex.destroy();
    }
  }

  /**
   * Scoped query builder for the CURRENT request's tenant, resolved from
   * `TenantContext` (JWT-derived, allowlist-validated -- never string-
   * concatenated here). Every dynamic-table query must be built from this
   * method's return value; nothing in this codebase issues a session-level
   * `SET search_path` -- see spec-schema-per-tenant-core.md's "Always"
   * boundary and the reason why (PgBouncer transaction-mode pooling can
   * recycle a backend connection to a different tenant between statements).
   */
  forCurrentTenant(): Knex.QueryBuilder {
    return this.knex.withSchema(this.tenantContext.schema);
  }
}
