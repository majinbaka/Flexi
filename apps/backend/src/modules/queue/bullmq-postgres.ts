import { ConfigService } from '@nestjs/config';
import {
  ConnectionOptions,
  createPostgresBackend,
  setDefaultBackendFactory,
} from 'bullmq';

let postgresBackendConfigured = false;

export function configureBullMqPostgresBackend(): void {
  if (!postgresBackendConfigured) {
    setDefaultBackendFactory(createPostgresBackend);
    postgresBackendConfigured = true;
  }
}

export function createBullMqPostgresConnectionOptions(
  configService: ConfigService,
): ConnectionOptions {
  configureBullMqPostgresBackend();

  return {
    connectionString: configService.get<string>('DATABASE_URL'),
    migrate: true,
  } as unknown as ConnectionOptions;
}
