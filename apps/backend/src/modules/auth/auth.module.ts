import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';

@Module({
  imports: [
    // Default secret/expiry are the ACCESS token's -- refresh tokens are
    // signed with an explicit `{ secret: JWT_REFRESH_SECRET }` override per
    // call in AuthService, since they need a different secret/expiry.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          expiresIn: configService.get<string>('JWT_ACCESS_EXPIRES_IN', '15m'),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, PermissionsGuard],
  // JwtAuthGuard/PermissionsGuard are reusable exports other modules can
  // adopt on their own guarded routes (this spec does not wire them onto
  // any other module's stub controller).
  exports: [JwtAuthGuard, PermissionsGuard],
})
export class AuthModule {}
