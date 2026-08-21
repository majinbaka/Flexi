import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ActorType,
  AuthenticatedUserDto,
  NotImplementedStatus,
  SYSTEM_TENANTS_ONBOARD_PERMISSION,
  TenantOnboardingActorIdentityDto,
  TenantOnboardingAttemptDto,
  TenantOnboardingCreateRequestDto,
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

  @Post('v1/super-admin/tenants')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(SYSTEM_TENANTS_ONBOARD_PERMISSION)
  createOnboardingAttempt(
    @Body() body: Partial<TenantOnboardingCreateRequestDto> | undefined,
    @CurrentUser() currentUser: AuthenticatedUserDto | undefined,
    @Req() request: Request,
  ): Promise<TenantOnboardingAttemptDto> {
    const actorIdentity = this.toSystemActorIdentity(currentUser);

    return this.tenantsService.createOnboardingAttempt(body, actorIdentity, {
      requestId: this.firstHeaderValue(request.headers['x-request-id']),
      ipAddress: request.ip ?? request.socket.remoteAddress ?? null,
      userAgent: this.firstHeaderValue(request.headers['user-agent']),
      idempotencyKey: this.firstHeaderValue(
        request.headers['idempotency-key'],
      ),
    });
  }

  private toSystemActorIdentity(
    currentUser: AuthenticatedUserDto | undefined,
  ): TenantOnboardingActorIdentityDto {
    if (
      currentUser?.actorType !== ActorType.SYSTEM ||
      !currentUser.systemUserId
    ) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: 'Tenant onboarding is only available to System users.',
      });
    }

    return {
      actorType: ActorType.SYSTEM,
      authAccountId: currentUser.authAccountId,
      systemUserId: currentUser.systemUserId,
      email: currentUser.email,
      name: currentUser.name,
      roles: currentUser.roles,
      permissions: currentUser.permissions,
    };
  }

  private firstHeaderValue(value: string | string[] | undefined): string | null {
    const firstValue = Array.isArray(value) ? value[0] : value;

    if (!firstValue) {
      return null;
    }

    const trimmed = firstValue.trim();
    return trimmed ? trimmed : null;
  }
}
