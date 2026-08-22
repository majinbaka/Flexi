import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { createBullMqPostgresConnectionOptions } from '../queue/bullmq-postgres';
import { TenantsController } from './tenants.controller';
import { TenantProvisioningService } from './provisioning.service';
import { TENANT_PROVISIONING_QUEUE_NAME } from './provisioning.types';
import { TenantProvisioningWorker } from './provisioning.worker';
import { TenantsService } from './tenants.service';

@Module({
  imports: [
    ConfigModule,
    AuthModule,
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
