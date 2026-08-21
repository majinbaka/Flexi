import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { TenantContext } from './tenant-context';
import { TenantKnexService } from './tenant-knex.service';

/**
 * `ClsModule.forRoot({ middleware: { mount: true } })` -- deliberately no
 * `setup` callback. The source implementation guide's example sets tenant
 * context inside that hook by reading `req.user`, but in this codebase JWT
 * verification happens in `JwtAuthGuard`, which runs *after* Nest
 * middleware -- `req.user` isn't populated yet at that point. Mounting the
 * middleware here only opens the CLS store early (via AsyncLocalStorage);
 * `JwtAuthGuard.canActivate()` sets `tenantId`/`schema` explicitly once the
 * token is verified (see jwt-auth.guard.ts).
 *
 * `@Global()` + re-exporting `ClsModule` here (rather than passing
 * `ClsModule.forRoot({ global: true, ... })`) mirrors this codebase's
 * existing `PrismaModule` convention (apps/backend/src/prisma/
 * prisma.module.ts): one foundational module, imported once from
 * `AppModule`, whose providers -- including the underlying `ClsService`
 * that `JwtAuthGuard` needs to populate the store -- are then injectable
 * from any feature module without it having to import TenancyModule itself.
 */
@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      middleware: { mount: true },
    }),
  ],
  providers: [TenantContext, TenantKnexService],
  exports: [ClsModule, TenantContext, TenantKnexService],
})
export class TenancyModule {}
