import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { envValidationSchema } from './config/env.validation';
import { ResponseInterceptor } from './common/response.interceptor';
import { HttpExceptionFilter } from './common/http-exception.filter';

import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { DynamicTablesModule } from './modules/dynamic-tables/dynamic-tables.module';
import { WorkflowsModule } from './modules/workflows/workflows.module';
import { PagesModule } from './modules/pages/pages.module';
import { CronJobsModule } from './modules/cron-jobs/cron-jobs.module';
import { MailTemplatesModule } from './modules/mail-templates/mail-templates.module';
import { WikiModule } from './modules/wiki/wiki.module';
import { I18nModule } from './modules/i18n/i18n.module';
import { SettingsModule } from './modules/settings/settings.module';
import { LogsModule } from './modules/logs/logs.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    PrismaModule,
    TenancyModule,

    HealthModule,

    // One module per planned feature area (stub-only, see deferred-work.md).
    AuthModule,
    TenantsModule,
    DynamicTablesModule,
    WorkflowsModule,
    PagesModule,
    CronJobsModule,
    MailTemplatesModule,
    WikiModule,
    I18nModule,
    SettingsModule,
    LogsModule,
  ],
  providers: [
    // Registered as providers (rather than app.useGlobalInterceptors/
    // useGlobalFilters in main.ts) so they're picked up by Nest's standard
    // testing pattern too: Test.createTestingModule({ imports: [AppModule] })
    // wires up everything declared here, but nothing bound imperatively in
    // main.ts (which never runs in tests).
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
