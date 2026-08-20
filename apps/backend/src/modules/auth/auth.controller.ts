import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthenticatedUserDto, AuthTokensDto } from '@flexi/shared-types';
import { TenantContext } from '../../common/tenant-context.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';

/**
 * Password login, refresh-token rotation, logout and a protected `me`
 * route proving JWT + RBAC enforcement end-to-end for both actor types.
 * See spec-core-authentication.md.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
    @TenantContext() tenantId?: string,
  ): Promise<AuthTokensDto> {
    return this.authService.login(dto, tenantId);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  refresh(@Body() dto: RefreshDto): Promise<AuthTokensDto> {
    return this.authService.refresh(dto);
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

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUserDto): AuthenticatedUserDto {
    return this.authService.me(user);
  }
}
