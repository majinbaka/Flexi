import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ActorType,
  AuthenticatedUserDto,
  NotImplementedStatus,
  SYSTEM_TENANTS_ONBOARD_PERMISSION,
  TenantSlugAvailabilityDto,
} from '@flexi/shared-types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { TenantsService } from './tenants.service';

/**
 * Stub controller for the "tenants" feature area.
 * Single placeholder route: GET /api/tenants -> { success:true, data:{ status:'not-implemented' } }
 * (envelope applied globally by ResponseInterceptor).
 */
@Controller()
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get('tenants')
  getStatus(): NotImplementedStatus {
    return this.tenantsService.getStatus();
  }

  @Get('v1/super-admin/tenants/slug-availability')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(SYSTEM_TENANTS_ONBOARD_PERMISSION)
  checkSlugAvailability(
    @Query('slug') slug: unknown,
    @CurrentUser() currentUser?: AuthenticatedUserDto,
  ): Promise<TenantSlugAvailabilityDto> {
    if (currentUser?.actorType !== ActorType.SYSTEM) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: 'Tenant onboarding is only available to System users.',
      });
    }

    return this.tenantsService.checkSlugAvailability(
      typeof slug === 'string' ? slug : '',
    );
  }
}
