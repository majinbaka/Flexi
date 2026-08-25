import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
  SYSTEM_TENANTS_READ_PERMISSION,
  SYSTEM_TENANTS_ONBOARD_PERMISSION,
  SYSTEM_TENANTS_SETUP_LINK_PERMISSION,
  TenantListQueryDto,
  TenantListResponseDto,
  TenantOnboardingActorIdentityDto,
  TenantOnboardingAttemptDto,
  TenantOnboardingAttemptStatusDto,
  TenantOnboardingCreateRequestDto,
  RedeemSetupTokenResponseDto,
  TenantSetupLinkDto,
  TenantSlugAvailabilityDto,
} from '@flexi/shared-types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RedeemSetupTokenDto } from './dto/redeem-setup-token.dto';
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

  @Get('v1/super-admin/tenants')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(SYSTEM_TENANTS_READ_PERMISSION)
  listTenants(
    @Query() query: Record<string, unknown>,
    @CurrentUser() currentUser?: AuthenticatedUserDto,
  ): Promise<TenantListResponseDto> {
    this.toSystemActorIdentity(
      currentUser,
      'Tenant administration is only available to System users.',
    );

    return this.tenantsService.listTenants(this.toTenantListQuery(query));
  }

  @Get('v1/super-admin/tenants/onboarding-attempts/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(SYSTEM_TENANTS_READ_PERMISSION)
  getOnboardingAttemptStatus(
    @Param('id') attemptId: string,
    @CurrentUser() currentUser?: AuthenticatedUserDto,
  ): Promise<TenantOnboardingAttemptStatusDto> {
    this.toSystemActorIdentity(
      currentUser,
      'Onboarding attempt history is only available to System users.',
    );

    return this.tenantsService.getOnboardingAttemptStatus(attemptId);
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
      idempotencyKey: this.firstHeaderValue(request.headers['idempotency-key']),
    });
  }

  @Post('v1/super-admin/tenants/:id/setup-link')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(SYSTEM_TENANTS_SETUP_LINK_PERMISSION)
  regenerateSetupLink(
    @Param('id') tenantId: string,
    @CurrentUser() currentUser?: AuthenticatedUserDto,
  ): Promise<TenantSetupLinkDto> {
    const actorIdentity = this.toSystemActorIdentity(
      currentUser,
      'Setup link regeneration is only available to System users.',
    );

    return this.tenantsService.regenerateSetupLink(tenantId, actorIdentity);
  }

  @Post('v1/setup/redeem')
  @HttpCode(HttpStatus.OK)
  redeemSetupToken(
    @Body() dto: RedeemSetupTokenDto,
  ): Promise<RedeemSetupTokenResponseDto> {
    return this.tenantsService.redeemSetupToken(dto);
  }

  /**
   * Normalizes raw Express query params (always strings, or string arrays
   * for repeated keys) into `TenantListQueryDto`. Deliberately permissive
   * at this layer -- e.g. a non-numeric `page` is passed through as-is
   * (via `Number(...)` in the service) rather than silently coerced to a
   * default here, so the service's reject-don't-clamp validation is the
   * single source of truth for what counts as invalid.
   */
  private toTenantListQuery(
    query: Record<string, unknown>,
  ): TenantListQueryDto {
    return {
      status: this.firstQueryValue(query.status) as
        TenantListQueryDto['status'] | undefined,
      keyword: this.firstQueryValue(query.keyword) ?? undefined,
      createdFrom: this.firstQueryValue(query.createdFrom) ?? undefined,
      createdTo: this.firstQueryValue(query.createdTo) ?? undefined,
      page: this.toQueryNumber(query.page),
      pageSize: this.toQueryNumber(query.pageSize),
    };
  }

  private firstQueryValue(value: unknown): string | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  }

  private toQueryNumber(value: unknown): number | undefined {
    const raw = this.firstQueryValue(value);
    if (raw === undefined) {
      return undefined;
    }

    const numeric = Number(raw);
    // NaN is passed through (not coerced to undefined) so the service's
    // integer/positivity check rejects it with VALIDATION_ERROR instead of
    // this layer silently falling back to the default.
    return numeric;
  }

  private toSystemActorIdentity(
    currentUser: AuthenticatedUserDto | undefined,
    forbiddenMessage = 'Tenant onboarding is only available to System users.',
  ): TenantOnboardingActorIdentityDto {
    if (
      currentUser?.actorType !== ActorType.SYSTEM ||
      !currentUser.systemUserId
    ) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: forbiddenMessage,
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

  private firstHeaderValue(
    value: string | string[] | undefined,
  ): string | null {
    const firstValue = Array.isArray(value) ? value[0] : value;

    if (!firstValue) {
      return null;
    }

    const trimmed = firstValue.trim();
    return trimmed ? trimmed : null;
  }
}
