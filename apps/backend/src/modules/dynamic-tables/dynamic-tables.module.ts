import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import {
  ConnectionOptions,
  setDefaultBackendFactory,
  createPostgresBackend,
} from 'bullmq';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { DynamicTablesController } from './dynamic-tables.controller';
import { DynamicTablesService } from './dynamic-tables.service';
import { TablesController } from './tables.controller';
import { DdlWorker } from './ddl-worker';
import { DDL_QUEUE_NAME } from './dynamic-tables.types';

// CAP-6/AD-8: BullMQ backed by Postgres (no Redis/ioredis), reusing this
// app's existing DATABASE_URL connection. Set once, process-wide, before
// any Queue/Worker instance is constructed -- every `Queue`/`Worker` this
// module's `BullModule.registerQueueAsync()` call below creates then uses
// the Postgres backend automatically (see bullmq's own
// `setDefaultBackendFactory` docs: "Inject this into the queue classes...
// or set it as the process-wide default").
setDefaultBackendFactory(createPostgresBackend);

/**
 * Supersedes the Story 1 stub in place (same directory/module name, per the
 * architecture spine's Structural Seed). Registers the `ddl` BullMQ queue
 * (Postgres-backed, AD-8), `tables.controller.ts` (CAP-1/2's real routes,
 * replacing the stub's single GET route), and `ddl-worker.ts` as an
 * in-process worker provider. `DynamicTablesController`'s original stub
 * route is left registered alongside the new one -- CAP-3/4's
 * `rows.controller.ts` (Story 3+) is a separate, not-yet-built route, and
 * the stub route is harmless to leave as a placeholder for it.
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
        // `QueueOptions.connection` is typed for BullMQ's Redis backend,
        // but `setDefaultBackendFactory(createPostgresBackend)` above
        // routes every Queue/Worker constructed from this config through
        // the Postgres backend instead, whose own `PostgresConnectionOptions`
        // accepts a node-postgres pool config (see bullmq's postgres-
        // connection.d.ts) -- the cast bridges that intentional type gap,
        // not a real Redis connection value. `migrate: true` is required in
        // this config-object form (a bare connection string does NOT run
        // migrations): BullMQ's Postgres backend keeps its own bookkeeping
        // tables in a dedicated `bullmq` Postgres schema and throws
        // `SchemaMigrationRequiredError` on first connect if that schema
        // hasn't been migrated yet -- verified against a live Postgres
        // instance during this story's implementation.
        connection: {
          connectionString: configService.get<string>('DATABASE_URL'),
          migrate: true,
        } as unknown as ConnectionOptions,
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [DynamicTablesController, TablesController],
  providers: [DynamicTablesService, DdlWorker, JwtAuthGuard, PermissionsGuard],
})
export class DynamicTablesModule {}
