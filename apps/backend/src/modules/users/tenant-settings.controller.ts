import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AuthenticatedUserDto, TenantSettingsDto } from '@flexi/shared-types';
import { TenantIdHeader } from '../../common/tenant-context.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UpdateTenantSettingsDto } from './dto/update-tenant-settings.dto';
import { TenantSettingsService } from './tenant-settings.service';

/**
 * One tenant's self-registration policy: the toggle, the email-domain
 * whitelist, the default role and the approval flag.
 *
 * Guarded by `JwtAuthGuard` alone, with the permission asserted in the
 * service rather than by `@RequirePermissions()`. The required code
 * depends on the caller -- `tenant.settings.manage` for a TenantUser,
 * `system.settings.manage` for a SystemUser -- which the guard cannot know
 * at decoration time; `AdminUsersController` is guarded the same way for
 * the same reason.
 *
 * `x-tenant-id` is how a system caller says which tenant they mean. It is
 * not how a tenant caller picks one: their token already pins them to
 * theirs, and a header naming another tenant is refused.
 */
@Controller('tenant-settings')
export class TenantSettingsController {
  constructor(private readonly tenantSettingsService: TenantSettingsService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  getSettings(
    @CurrentUser() user: AuthenticatedUserDto,
    @TenantIdHeader() tenantId?: string,
  ): Promise<TenantSettingsDto> {
    return this.tenantSettingsService.getSettings(user, tenantId);
  }

  /** Partial: only the fields the body carries are written. */
  @Patch()
  @UseGuards(JwtAuthGuard)
  updateSettings(
    @Body() dto: UpdateTenantSettingsDto,
    @CurrentUser() user: AuthenticatedUserDto,
    @TenantIdHeader() tenantId?: string,
  ): Promise<TenantSettingsDto> {
    return this.tenantSettingsService.updateSettings(dto, user, tenantId);
  }
}
