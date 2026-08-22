import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { createBullMqPostgresConnectionOptions } from '../queue/bullmq-postgres';
import { DynamicTablesController } from './dynamic-tables.controller';
import { DynamicTablesService } from './dynamic-tables.service';
import { TablesController } from './tables.controller';
import { RowsController } from './rows.controller';
import { DdlWorker } from './ddl-worker';
import { DDL_QUEUE_NAME } from './dynamic-tables.types';

/**
 * Supersedes the Story 1 stub in place (same directory/module name, per the
 * architecture spine's Structural Seed). Registers the `ddl` BullMQ queue
 * (Postgres-backed, AD-8), `tables.controller.ts` (CAP-1/2's real routes,
 * replacing the stub's single GET route), `rows.controller.ts` (CAP-3's row
 * DML routes, added this story), and `ddl-worker.ts` as an in-process
 * worker provider. `DynamicTablesController`'s original stub route is left
 * registered alongside the new ones -- harmless placeholder, superseded in
 * spirit by `tables.controller.ts`/`rows.controller.ts`.
 *
 * Imports `AuthModule` (for `JwtService`/`AuthService`'s own DI graph) and
 * also re-declares `JwtAuthGuard`/`PermissionsGuard` directly as providers
 * here -- exporting a provider from `AuthModule` makes its already-built
 * instance visible for constructor injection into other providers of an
 * importing module, but `@UseGuards(ClassRef)` on `tables.controller.ts`
 * resolves that class through the controller's OWN host module, which
 * still needs the class registered as a provider there (a NestJS nuance:
 * guard/interceptor classes referenced by type, not by token, are not
 * satisfied by a same-name export alone). This module is the first real
 * cross-module consumer of this guard combo (auth.module.ts's own comment
 * anticipates other modules adopting it).
 */
@Module({
  imports: [
    ConfigModule,
    AuthModule,
    BullModule.registerQueueAsync({
      name: DDL_QUEUE_NAME,
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: createBullMqPostgresConnectionOptions(configService),
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [DynamicTablesController, TablesController, RowsController],
  providers: [DynamicTablesService, DdlWorker, JwtAuthGuard, PermissionsGuard],
  // Exported so `TenantsModule` can inject `DynamicTablesService` directly
  // for the Story 2.2 bootstrap-migration step (`ensureMetaTables()`), the
  // second call site of that method alongside `enqueueCreateTable()`. No
  // circular dependency: this module only imports `AuthModule`/
  // `ConfigModule`, neither of which imports `TenantsModule`.
  exports: [DynamicTablesService],
})
export class DynamicTablesModule {}
