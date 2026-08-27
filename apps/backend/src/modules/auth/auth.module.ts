import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { MailModule } from '../../mail/mail.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthAuditService } from './auth-audit.service';
import { PasswordResetService } from './password-reset.service';
import { SessionsService } from './sessions.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';

@Module({
  imports: [
    // Password-recovery mail. `MailModule` depends on nothing but
    // `ConfigModule`, so importing it here does not reintroduce the cycle
    // that pulling in `TenantsModule` (which imports this module) would.
    MailModule,
    // Default secret/expiry are the ACCESS token's -- refresh tokens are
    // signed with an explicit `{ secret: JWT_REFRESH_SECRET }` override per
    // call in AuthService, since they need a different secret/expiry.
    //
    // Re-exported below (`exports: [JwtModule, ...]`) so `JwtAuthGuard` --
    // itself exported for other modules to adopt -- brings its own
    // `JwtService` dependency along. Without this, a module that imports
    // AuthModule and re-declares JwtAuthGuard as a local provider (needed
    // for `@UseGuards(JwtAuthGuard)` to resolve the class in that module's
    // own DI scope) fails to construct it: `JwtService` would otherwise
    // stay private to AuthModule's own injector.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          expiresIn: configService.get<string>(
            'JWT_ACCESS_EXPIRES_IN',
            '15m',
          ) as JwtSignOptions['expiresIn'],
        },
      }),
    }),
    // Scoped to this module only -- applied via @UseGuards(ThrottlerGuard)
    // on login/refresh in AuthController, not as a global APP_GUARD, so no
    // other route's behavior changes. In-memory storage (package default);
    // no Redis wiring since this app runs single-instance today.
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        throttlers: [
          {
            ttl: configService.get<number>('AUTH_THROTTLE_TTL', 60) * 1000,
            limit: configService.get<number>('AUTH_THROTTLE_LIMIT', 5),
          },
        ],
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthAuditService,
    PasswordResetService,
    SessionsService,
    JwtAuthGuard,
    PermissionsGuard,
  ],
  // JwtAuthGuard/PermissionsGuard are reusable exports other modules can
  // adopt on their own guarded routes. JwtModule is re-exported alongside
  // them so a consumer that re-declares JwtAuthGuard as its own provider
  // (required for @UseGuards(JwtAuthGuard) to resolve cross-module -- see
  // the import-site comment above) can also satisfy its JwtService
  // dependency without duplicating this module's JwtModule.registerAsync()
  // config.
  exports: [JwtModule, JwtAuthGuard, PermissionsGuard, AuthAuditService],
})
export class AuthModule {}
