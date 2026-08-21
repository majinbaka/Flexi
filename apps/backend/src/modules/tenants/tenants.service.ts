import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import {
  isTenantSlugFormatValid,
  isTenantOnboardingIdempotencyKeyValid,
  NotImplementedStatus,
  TenantOnboardingActorIdentityDto,
  TenantOnboardingAttemptDto,
  TenantOnboardingCreateRequestDto,
  TenantOnboardingIdempotencyIdentityDto,
  TenantOnboardingPlan,
  TenantOnboardingRequestIdentityDto,
  TenantOnboardingSafePayloadDto,
  TenantOnboardingStepOutcomeDto,
  validateTenantOnboardingInput,
  TenantSlugAvailabilityDto,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';

export interface TenantOnboardingRequestContext {
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  idempotencyKey: string | null;
}

interface TenantOnboardingAttemptRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Stub service for the "tenants" feature area. Holds no business logic yet --
 * see deferred-work.md for the real scope of this module.
 */
@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  getStatus(): NotImplementedStatus {
    return { status: 'not-implemented' };
  }

  async checkSlugAvailability(
    slug: string,
  ): Promise<TenantSlugAvailabilityDto> {
    const normalizedSlug = slug.trim();

    if (!isTenantSlugFormatValid(normalizedSlug)) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message:
          'Slug must be 3-63 characters using lowercase letters, numbers, and single hyphens, and must start and end with a letter or number.',
      });
    }

    const existingTenant = await this.prisma.tenant.findUnique({
      where: { slug: normalizedSlug },
      select: { id: true },
    });

    if (existingTenant) {
      return {
        slug: normalizedSlug,
        available: false,
        reason: 'already_in_use',
      };
    }

    return {
      slug: normalizedSlug,
      available: true,
      reason: 'available',
    };
  }

  async createOnboardingAttempt(
    input: Partial<TenantOnboardingCreateRequestDto> | null | undefined,
    actorIdentity: TenantOnboardingActorIdentityDto,
    requestContext: TenantOnboardingRequestContext,
  ): Promise<TenantOnboardingAttemptDto> {
    const request = input ?? {};
    const safePayload = this.normalizeCreateRequest(input);
    const validationErrors = validateTenantOnboardingInput(safePayload);
    const idempotencyIdentity = this.normalizeIdempotencyIdentity(
      request.idempotencyKey,
      requestContext,
    );

    if (!idempotencyIdentity) {
      validationErrors.idempotencyKey = 'IDEMPOTENCY_KEY_REQUIRED';
    } else if (!isTenantOnboardingIdempotencyKeyValid(idempotencyIdentity.key)) {
      validationErrors.idempotencyKey = 'IDEMPOTENCY_KEY_FORMAT';
    }

    if (Object.keys(validationErrors).length > 0) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: 'Tenant onboarding request is invalid.',
        fields: validationErrors,
      });
    }

    if (!idempotencyIdentity) {
      throw new Error('Validated onboarding attempt is missing idempotency.');
    }

    const existingTenant = await this.prisma.tenant.findUnique({
      where: { slug: safePayload.tenantSlug },
      select: { id: true },
    });

    if (existingTenant) {
      throw new ConflictException({
        error: 'SLUG_ALREADY_IN_USE',
        message: 'Slug is already in use.',
      });
    }

    const actorStillActive = await this.prisma.systemUser.findFirst({
      where: {
        id: actorIdentity.systemUserId,
        isActive: true,
      },
      select: { id: true },
    });

    if (!actorStillActive) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: 'Tenant onboarding is only available to active System users.',
      });
    }

    const occurredAt = new Date().toISOString();
    const stepOutcomes: TenantOnboardingStepOutcomeDto[] = [
      { step: 'permission_check', status: 'succeeded', occurredAt },
      { step: 'payload_validation', status: 'succeeded', occurredAt },
      { step: 'slug_availability', status: 'succeeded', occurredAt },
      { step: 'attempt_reservation', status: 'succeeded', occurredAt },
    ];
    const requestIdentity: TenantOnboardingRequestIdentityDto = {
      requestId: requestContext.requestId,
      ipAddress: requestContext.ipAddress,
      userAgent: requestContext.userAgent,
    };

    const [attempt] = await this.prisma.$queryRaw<TenantOnboardingAttemptRow[]>(
      Prisma.sql`
        INSERT INTO "tenant_onboarding_attempts" (
          "id",
          "actorSystemUserId",
          "status",
          "safePayload",
          "actorIdentity",
          "requestIdentity",
          "idempotencyKey",
          "idempotencyIdentity",
          "stepOutcomes",
          "updatedAt"
        ) VALUES (
          ${randomUUID()},
          ${actorIdentity.systemUserId},
          ${'accepted'},
          ${JSON.stringify(safePayload)}::jsonb,
          ${JSON.stringify(actorIdentity)}::jsonb,
          ${JSON.stringify(requestIdentity)}::jsonb,
          ${idempotencyIdentity.key},
          ${JSON.stringify(idempotencyIdentity)}::jsonb,
          ${JSON.stringify(stepOutcomes)}::jsonb,
          CURRENT_TIMESTAMP
        )
        RETURNING "id", "createdAt", "updatedAt"
      `,
    );

    if (!attempt) {
      throw new Error('Onboarding attempt insert returned no row.');
    }

    return {
      id: attempt.id,
      status: 'accepted',
      safePayload,
      actorIdentity,
      requestIdentity,
      idempotencyIdentity,
      stepOutcomes,
      createdAt: attempt.createdAt.toISOString(),
      updatedAt: attempt.updatedAt.toISOString(),
    };
  }

  private normalizeCreateRequest(
    input: Partial<TenantOnboardingCreateRequestDto> | null | undefined,
  ): TenantOnboardingSafePayloadDto {
    const request = input ?? {};

    return {
      tenantName:
        typeof request.tenantName === 'string'
          ? request.tenantName.trim()
          : '',
      tenantSlug:
        typeof request.tenantSlug === 'string'
          ? request.tenantSlug.trim()
          : '',
      firstAdminEmail:
        typeof request.firstAdminEmail === 'string'
          ? request.firstAdminEmail.trim().toLowerCase()
          : '',
      plan: request.plan as TenantOnboardingPlan,
    };
  }

  private normalizeIdempotencyIdentity(
    bodyIdempotencyKey: unknown,
    requestContext: TenantOnboardingRequestContext,
  ): TenantOnboardingIdempotencyIdentityDto | null {
    const headerKey = requestContext.idempotencyKey?.trim();
    const bodyKey =
      typeof bodyIdempotencyKey === 'string' ? bodyIdempotencyKey.trim() : '';

    if (headerKey) {
      return { key: headerKey, source: 'header' };
    }

    if (bodyKey) {
      return { key: bodyKey, source: 'body' };
    }

    return null;
  }
}
