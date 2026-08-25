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
  TENANT_LIST_DEFAULT_PAGE,
  TENANT_LIST_DEFAULT_PAGE_SIZE,
  TENANT_LIST_MAX_PAGE_SIZE,
  TENANT_LIFECYCLE_STATUSES,
  TenantLifecycleStatus,
  TenantListItemDto,
  TenantListQueryDto,
  TenantListResponseDto,
  TenantOnboardingActorIdentityDto,
  TenantOnboardingAttemptDto,
  TenantOnboardingAttemptStatus,
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

  /**
   * Backs `GET /api/v1/super-admin/tenants` (Story 3.1). Joins each tenant
   * to its latest onboarding attempt via the direct `onboardingAttemptId`
   * FK (no max-by-createdAt subquery needed -- a tenant has at most one
   * linked attempt), applies optional status/keyword/date-range filters
   * with AND logic, and paginates. The same `where` clause is built once
   * and reused by both `findMany` and `count` so the two can never drift.
   * Plan and actor name are read from the linked attempt's `safePayload`/
   * `actorIdentity` JSON, never stored redundantly on `Tenant`.
   */
  async listTenants(query: TenantListQueryDto): Promise<TenantListResponseDto> {
    const page = this.parsePositiveInteger(
      query.page,
      TENANT_LIST_DEFAULT_PAGE,
      'page',
    );
    const pageSize = this.parsePositiveInteger(
      query.pageSize,
      TENANT_LIST_DEFAULT_PAGE_SIZE,
      'pageSize',
    );
    const clampedPageSize = Math.min(pageSize, TENANT_LIST_MAX_PAGE_SIZE);

    const status = this.parseStatusFilter(query.status);
    const createdFrom = this.parseFilterDate(query.createdFrom, 'createdFrom');
    const createdTo = this.parseFilterDate(query.createdTo, 'createdTo');

    if (
      createdFrom &&
      createdTo &&
      createdFrom.getTime() > createdTo.getTime()
    ) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: 'createdFrom must not be after createdTo.',
        fields: { createdFrom: 'DATE_RANGE_INVALID' },
      });
    }

    const where: Prisma.TenantWhereInput = {
      ...(status ? { status } : {}),
      ...(createdFrom || createdTo
        ? {
            createdAt: {
              ...(createdFrom ? { gte: createdFrom } : {}),
              ...(createdTo ? { lte: createdTo } : {}),
            },
          }
        : {}),
      ...(query.keyword?.trim()
        ? {
            OR: [
              {
                name: {
                  contains: this.escapeLikeKeyword(query.keyword.trim()),
                  mode: 'insensitive' as const,
                },
              },
              {
                slug: {
                  contains: this.escapeLikeKeyword(query.keyword.trim()),
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
    };

    const [tenants, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where,
        include: { onboardingAttempt: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * clampedPageSize,
        take: clampedPageSize,
      }),
      this.prisma.tenant.count({ where }),
    ]);

    return {
      items: tenants.map((tenant) => this.mapTenantListItem(tenant)),
      meta: { total, page, pageSize: clampedPageSize },
    };
  }

  private mapTenantListItem(tenant: {
    id: string;
    name: string;
    slug: string;
    status: string;
    createdAt: Date;
    onboardingAttempt: {
      status: string;
      safePayload: unknown;
      actorIdentity: unknown;
    } | null;
  }): TenantListItemDto {
    const attempt = tenant.onboardingAttempt;
    const safePayload = attempt?.safePayload as
      TenantOnboardingSafePayloadDto | undefined;
    const actorIdentity = attempt?.actorIdentity as
      TenantOnboardingActorIdentityDto | undefined;

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status as TenantLifecycleStatus,
      plan: safePayload?.plan ?? null,
      createdAt: tenant.createdAt.toISOString(),
      latestAttemptStatus:
        (attempt?.status as TenantOnboardingAttemptStatus | undefined) ?? null,
      actorName: actorIdentity?.name ?? null,
    };
  }

  private parsePositiveInteger(
    value: unknown,
    defaultValue: number,
    field: 'page' | 'pageSize',
  ): number {
    if (value === undefined || value === null || value === '') {
      return defaultValue;
    }

    const numeric = typeof value === 'number' ? value : Number(value);

    if (!Number.isInteger(numeric) || numeric <= 0) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: `${field} must be a positive integer.`,
        fields: { [field]: `${field.toUpperCase()}_INVALID` },
      });
    }

    return numeric;
  }

  private parseStatusFilter(value: unknown): TenantLifecycleStatus | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    if (
      typeof value !== 'string' ||
      !TENANT_LIFECYCLE_STATUSES.includes(value as TenantLifecycleStatus)
    ) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: 'status must be a valid tenant lifecycle status.',
        fields: { status: 'STATUS_INVALID' },
      });
    }

    return value as TenantLifecycleStatus;
  }

  /**
   * A date-only `createdTo` (e.g. `"2026-12-31"`, no time component) parses
   * to midnight UTC, which would exclude the entire day the caller meant to
   * include. For `createdTo` specifically, a date-only value is pushed to
   * the last instant of that day so the range is inclusive as a human would
   * expect; a value that already carries a time component is used as-is.
   */
  private parseFilterDate(
    value: string | undefined,
    field: 'createdFrom' | 'createdTo',
  ): Date | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: `${field} must be a valid date.`,
        fields: { [field]: 'DATE_INVALID' },
      });
    }

    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    if (field === 'createdTo' && isDateOnly) {
      parsed.setUTCHours(23, 59, 59, 999);
    }

    return parsed;
  }

  /**
   * Escapes Prisma/SQL `LIKE` metacharacters (`%`, `_`, `\`) in a raw
   * keyword before it's passed to a `contains` filter, so user input can
   * never act as a wildcard.
   */
  private escapeLikeKeyword(keyword: string): string {
    return keyword.replace(/[\\%_]/g, (match) => `\\${match}`);
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
    actorIdentity: TenantOnboardingActorIdentityDto,
  ): Promise<TenantSetupLinkDto>;
  async regenerateSetupLink(
    tenantId: string,
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
