import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  AuthenticatedUserDto,
  AuthTokensDto,
  ListSessionsResponseDto,
  RevokeSessionsResponseDto,
} from '@flexi/shared-types';
import { TenantIdHeader } from '../../common/tenant-context.decorator';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { SessionsService } from './sessions.service';
import { RevokeAllSessionsDto } from './dto/revoke-all-sessions.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';

/**
 * Window the password-recovery routes are throttled over. Both are far
 * stricter than the module-wide default because they are the two endpoints
 * an attacker can drive without any credential at all: one sends mail to an
 * address of their choosing, the other guesses a six-digit code.
 *
 * `@Throttle` is a static decorator, so these are constants rather than env
 * variables -- the numbers are fixed by the authentication specification,
 * not per-deployment tuning.
 */
const PASSWORD_RESET_THROTTLE_TTL_MS = 15 * 60 * 1000;
const FORGOT_PASSWORD_THROTTLE_LIMIT = 3;
const RESET_PASSWORD_THROTTLE_LIMIT = 5;

/**
 * Password login, refresh-token rotation, logout, password recovery and a
 * protected `me` route proving JWT + RBAC enforcement end-to-end for both
 * actor types. See
 * apps/frontend/src/docs/specifications/authentication.mdx.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly passwordResetService: PasswordResetService,
    private readonly sessionsService: SessionsService,
  ) {}

  /**
   * `x-tenant-id` presence/absence is the login-resolution signal: present
   * -> tenant login, absent -> system login. No separate endpoint or
   * explicit "login type" field.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  login(
    @Body() dto: LoginDto,
    @TenantIdHeader() tenantId?: string,
  ): Promise<AuthTokensDto> {
    return this.authService.login(dto, tenantId);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  refresh(@Body() dto: RefreshDto): Promise<AuthTokensDto> {
    return this.authService.refresh(dto);
  }

  /**
   * Always answers `200` with an empty body -- whether the address has an
   * account, whether that account is active, and whether a code was
   * actually sent. That uniformity is the whole point of the endpoint's
   * contract: it must not be usable to find out which addresses are
   * registered.
   */
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({
    default: {
      limit: FORGOT_PASSWORD_THROTTLE_LIMIT,
      ttl: PASSWORD_RESET_THROTTLE_TTL_MS,
    },
  })
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @TenantIdHeader() tenantId?: string,
  ): Promise<Record<string, never>> {
    await this.passwordResetService.requestReset(dto, tenantId);
    return {};
  }

  /**
   * Consumes a reset code, sets the new password and revokes every live
   * session. Every failure mode returns the same `INVALID_OTP`; only a
   * password that breaks the strength policy is reported distinctly, since
   * that depends on the submitted password alone and so tells the caller
   * nothing about the address.
   */
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({
    default: {
      limit: RESET_PASSWORD_THROTTLE_LIMIT,
      ttl: PASSWORD_RESET_THROTTLE_TTL_MS,
    },
  })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @TenantIdHeader() tenantId?: string,
  ): Promise<Record<string, never>> {
    await this.passwordResetService.resetPassword(dto, tenantId);
    return {};
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async logout(
    @Body() dto: LogoutDto,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<Record<string, never>> {
    await this.authService.logout(dto, user);
    return {};
  }

  /**
   * The caller's own live sessions. Guarded by JWT alone -- it can only
   * ever read the requester's own account.
   */
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  listSessions(
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<ListSessionsResponseDto> {
    return this.sessionsService.listSessions(user);
  }

  /**
   * Revokes every live session of the calling account. No permission
   * beyond a valid token: it acts only on the caller's own account, so
   * there is nobody to authorise it against.
   */
  @Post('sessions/revoke-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  revokeAllSessions(
    @Body() dto: RevokeAllSessionsDto,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<RevokeSessionsResponseDto> {
    return this.sessionsService.revokeAllSessions(dto, user);
  }

  /**
   * Revokes one session. The actor-scoped `session.manage` permission is
   * asserted in the service rather than through `@RequirePermissions()`,
   * because the required code depends on whether the caller is a
   * TenantUser or a SystemUser -- the same reason `me` resolves its own
   * permission.
   */
  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  revokeSession(
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<RevokeSessionsResponseDto> {
    return this.sessionsService.revokeSession(sessionId, user);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUserDto): AuthenticatedUserDto {
    return this.authService.me(user);
  }
}
