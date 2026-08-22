import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { DynamicTablesModule } from '../dynamic-tables/dynamic-tables.module';
import { createBullMqPostgresConnectionOptions } from '../queue/bullmq-postgres';
import { TenantsController } from './tenants.controller';
import { TenantProvisioningService } from './provisioning.service';
import { TENANT_PROVISIONING_QUEUE_NAME } from './provisioning.types';
import { TenantProvisioningWorker } from './provisioning.worker';
import { TenantsService } from './tenants.service';

// `ClsService` is not imported/provided here directly -- it's injectable
// via `TenancyModule`'s `@Global()` export (apps/backend/src/tenancy/
// tenancy.module.ts), same as `DynamicTablesModule`'s own providers. Story
// 2.2 adds `DynamicTablesModule` so `TenantProvisioningService` can inject
// `DynamicTablesService` for `ensureMetaTables()` (the bootstrap-migration
// step) -- verified no circular dependency: `DynamicTablesModule` only
// imports `AuthModule`/`ConfigModule`.
@Module({
  imports: [
    ConfigModule,
    AuthModule,
    DynamicTablesModule,
    BullModule.registerQueueAsync({
      name: TENANT_PROVISIONING_QUEUE_NAME,
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: createBullMqPostgresConnectionOptions(configService),
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [TenantsController],
  providers: [
    TenantsService,
    TenantProvisioningService,
    TenantProvisioningWorker,
  ],
})
export class TenantsModule {}
