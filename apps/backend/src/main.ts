import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

// ResponseInterceptor and HttpExceptionFilter are registered as
// APP_INTERCEPTOR/APP_FILTER providers in AppModule (not bound here
// imperatively) so Nest's standard testing pattern
// (Test.createTestingModule({ imports: [AppModule] })) picks them up too.

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  app.setGlobalPrefix('api');

  // CORS_ORIGIN is an optional comma-separated allowlist. Unset (local dev
  // default) stays fully permissive; set it in production to lock this down.
  const corsOrigin = configService.get<string>('CORS_ORIGIN');
  app.enableCors({
    origin: corsOrigin
      ? corsOrigin.split(',').map((origin) => origin.trim())
      : true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port);

  Logger.log(
    `Flexi backend listening on http://localhost:${port}/api`,
    'Bootstrap',
  );
}

bootstrap().catch((err: Error) => {
  Logger.error(err.message ?? err, err.stack, 'Bootstrap');
  process.exit(1);
});
