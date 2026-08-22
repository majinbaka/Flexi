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
  TenantSetupLinkDto,
  TenantSlugAvailabilityDto,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantProvisioningService } from './provisioning.service';
import { SetupLinkService } from './setup-link.service';

export interface TenantOnboardingRequestContext {
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  idempotencyKey: string | null;
}

interface TenantOnboardingAttemptRow {
  id: string;
  status: string;
  safePayload: unknown;
  actorIdentity: unknown;
  requestIdentity: unknown;
  idempotencyIdentity: unknown;
  stepOutcomes: unknown;
  provisioningJobId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Stub service for the "tenants" feature area. Holds no business logic yet --
 * see deferred-work.md for the real scope of this module.
 */
@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provisioningService: TenantProvisioningService,
    private readonly setupLinkService: SetupLinkService,
  ) {}

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

  /**
   * Regenerates a tenant's setup link on demand, delegating entirely to
   * `SetupLinkService.generate()` -- the single source of truth shared with
   * the automatic `setup_link_generated` provisioning step. Always revokes
   * every prior unexpired `SetupToken` and mints a fresh one (spec Design
   * Notes: the raw token is never persisted, so there is no other way to
   * "reuse" a previously issued token). `actorIdentity` is accepted for
   * parity with `createOnboardingAttempt()`'s call shape and future audit
   * use; the permission/actor-type gate itself lives in the controller,
   * mirroring `checkSlugAvailability()`.
   */
  async regenerateSetupLink(
    tenantId: string,
    _actorIdentity: TenantOnboardingActorIdentityDto,
  ): Promise<TenantSetupLinkDto> {
    const { setupToken, expiresAt } =
      await this.setupLinkService.generate(tenantId);

    return {
      tenantId,
      setupToken,
      expiresAt: expiresAt.toISOString(),
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
    } else if (
      !isTenantOnboardingIdempotencyKeyValid(idempotencyIdentity.key)
    ) {
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

    const existingAttempt = await this.findOnboardingAttemptByIdempotencyKey(
      idempotencyIdentity.key,
    );
    if (existingAttempt) {
      return this.resolveExistingAttempt(existingAttempt, safePayload);
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

    let attempt: TenantOnboardingAttemptRow | null = null;
    try {
      const [insertedAttempt] = await this.prisma.$queryRaw<
        TenantOnboardingAttemptRow[]
      >(Prisma.sql`
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
          RETURNING
            "id",
            "status",
            "provisioningJobId",
            "safePayload",
            "actorIdentity",
            "requestIdentity",
            "idempotencyIdentity",
            "stepOutcomes",
            "createdAt",
            "updatedAt"
        `);
      attempt = insertedAttempt ?? null;
    } catch (error) {
      if (!this.isUniqueConstraintViolation(error)) {
        throw error;
      }

      const winningAttempt = await this.findOnboardingAttemptByIdempotencyKey(
        idempotencyIdentity.key,
      );
      if (winningAttempt) {
        return this.resolveExistingAttempt(winningAttempt, safePayload);
      }

      throw error;
    }

    if (!attempt) {
      throw new Error('Onboarding attempt insert returned no row.');
    }

    await this.provisioningService.enqueueAcceptedAttempt(attempt.id);

    return this.mapOnboardingAttemptRow(attempt, false);
  }

  private async findOnboardingAttemptByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<TenantOnboardingAttemptRow | null> {
    const [attempt] = await this.prisma.$queryRaw<TenantOnboardingAttemptRow[]>(
      Prisma.sql`
        SELECT
            "id",
            "status",
            "provisioningJobId",
            "safePayload",
          "actorIdentity",
          "requestIdentity",
          "idempotencyIdentity",
          "stepOutcomes",
          "createdAt",
          "updatedAt"
        FROM "tenant_onboarding_attempts"
        WHERE "idempotencyKey" = ${idempotencyKey}
        LIMIT 1
      `,
    );

    return attempt ?? null;
  }

  private async resolveExistingAttempt(
    existingAttempt: TenantOnboardingAttemptRow,
    safePayload: TenantOnboardingSafePayloadDto,
  ): Promise<TenantOnboardingAttemptDto> {
    if (!this.safePayloadsMatch(existingAttempt.safePayload, safePayload)) {
      throw new ConflictException({
        error: 'IDEMPOTENCY_CONFLICT',
        message:
          'Idempotency key has already been used for a different onboarding payload.',
        existingAttemptId: existingAttempt.id,
      });
    }

    if (existingAttempt.status === 'accepted') {
      await this.provisioningService.enqueueAcceptedAttempt(existingAttempt.id);
    }

    return this.mapOnboardingAttemptRow(existingAttempt, true);
  }

  private mapOnboardingAttemptRow(
    attempt: TenantOnboardingAttemptRow,
    replayed: boolean,
  ): TenantOnboardingAttemptDto {
    return {
      id: attempt.id,
      status: attempt.status as TenantOnboardingAttemptDto['status'],
      safePayload: attempt.safePayload as TenantOnboardingSafePayloadDto,
      actorIdentity: attempt.actorIdentity as TenantOnboardingActorIdentityDto,
      requestIdentity:
        attempt.requestIdentity as TenantOnboardingRequestIdentityDto,
      idempotencyIdentity:
        attempt.idempotencyIdentity as TenantOnboardingIdempotencyIdentityDto,
      idempotencyOutcome: {
        replayed,
        ...(replayed ? { existingAttemptId: attempt.id } : {}),
      },
      stepOutcomes: attempt.stepOutcomes as TenantOnboardingStepOutcomeDto[],
      createdAt: attempt.createdAt.toISOString(),
      updatedAt: attempt.updatedAt.toISOString(),
    };
  }

  private safePayloadsMatch(
    existingPayload: unknown,
    safePayload: TenantOnboardingSafePayloadDto,
  ): boolean {
    if (
      !existingPayload ||
      typeof existingPayload !== 'object' ||
      Array.isArray(existingPayload)
    ) {
      return false;
    }

    const payload = existingPayload as Partial<TenantOnboardingSafePayloadDto>;
    return (
      payload.tenantName === safePayload.tenantName &&
      payload.tenantSlug === safePayload.tenantSlug &&
      payload.firstAdminEmail === safePayload.firstAdminEmail &&
      payload.plan === safePayload.plan
    );
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return true;
      }

      const meta = error.meta as Record<string, unknown> | undefined;
      return error.code === 'P2010' && meta?.code === '23505';
    }

    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === '23505'
    );
  }

  private normalizeCreateRequest(
    input: Partial<TenantOnboardingCreateRequestDto> | null | undefined,
  ): TenantOnboardingSafePayloadDto {
    const request = input ?? {};

    return {
      tenantName:
        typeof request.tenantName === 'string' ? request.tenantName.trim() : '',
      tenantSlug:
        typeof request.tenantSlug === 'string' ? request.tenantSlug.trim() : '',
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
