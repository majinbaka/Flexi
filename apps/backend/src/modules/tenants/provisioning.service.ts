import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import {
  TenantLifecycleStatus,
  TenantOnboardingSafePayloadDto,
  TenantOnboardingStepOutcomeDto,
  validateTenantOnboardingInput,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantKnexService } from '../../tenancy/tenant-knex.service';
import { resolveTenantSchema } from '../../tenancy/resolve-tenant-schema';
import { TenancyClsStore } from '../../tenancy/tenant-context';
import { DynamicTablesService } from '../dynamic-tables/dynamic-tables.service';
import { TenantSeedService } from './tenant-seed.service';
import {
  TENANT_PROVISIONING_QUEUE_NAME,
  TENANT_PROVISIONING_START_JOB,
  TenantProvisioningJobData,
} from './provisioning.types';

const TENANT_STATUS_PROVISIONING: TenantLifecycleStatus = 'PROVISIONING';
const ATTEMPT_STATUS_ACCEPTED = 'accepted';
const ATTEMPT_STATUS_PROVISIONING = 'provisioning';
const ATTEMPT_STATUS_FAILED = 'failed';

interface AttemptProvisioningRow {
  id: string;
  status: string;
  safePayload: unknown;
  stepOutcomes: unknown;
}

interface TenantLifecycleRow {
  id: string;
  slug: string;
  status: string;
  onboardingAttemptId: string | null;
}

@Injectable()
export class TenantProvisioningService {
  private readonly logger = new Logger(TenantProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @InjectQueue(TENANT_PROVISIONING_QUEUE_NAME)
    private readonly provisioningQueue: Queue<TenantProvisioningJobData>,
    private readonly cls: ClsService<TenancyClsStore>,
    private readonly tenantKnexService: TenantKnexService,
    private readonly dynamicTablesService: DynamicTablesService,
    private readonly tenantSeedService: TenantSeedService,
  ) {}

  async enqueueAcceptedAttempt(attemptId: string): Promise<void> {
    const jobId = this.jobIdForAttempt(attemptId);
    const retryCount = this.configService.get<number>(
      'TENANT_PROVISIONING_JOB_RETRY_COUNT',
    );

    try {
      const linkedRows = await this.prisma.$executeRaw(
        Prisma.sql`
          UPDATE "tenant_onboarding_attempts"
          SET
            "provisioningJobId" = ${jobId},
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE
            "id" = ${attemptId}
            AND (
              "provisioningJobId" IS NULL
              OR "provisioningJobId" = ${jobId}
            )
        `,
      );

      if (linkedRows === 0) {
        throw new Error(
          `Attempt ${attemptId} could not be linked to provisioning job ${jobId}.`,
        );
      }

      await this.provisioningQueue.add(
        TENANT_PROVISIONING_START_JOB,
        { attemptId },
        {
          jobId,
          attempts: retryCount,
          backoff: { type: 'exponential', delay: 1000 },
        },
      );
    } catch (error) {
      this.logger.error(
        `Failed to enqueue tenant provisioning attempt ${attemptId}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException({
        error: 'PROVISIONING_ENQUEUE_FAILED',
        message:
          'Tenant onboarding was accepted but provisioning could not be scheduled.',
      });
    }
  }

  async startLifecycle(attemptId: string): Promise<void> {
    const jobId = this.jobIdForAttempt(attemptId);
    const linkedTenant = await this.findTenantByAttemptId(attemptId);
    if (linkedTenant) {
      // Resume/retry path: a tenant is already linked to this attempt from
      // a prior run. If that prior run ended in a job timeout,
      // `recordProvisioningTimeout()` (provisioning.worker.ts) already set
      // the attempt's `status` to `'failed'` even though BullMQ is retrying
      // the same job -- left alone, every step write below would be
      // silently dropped by `updateAttemptSteps()`'s
      // already-failed-stays-failed guard (`attempt.status === FAILED &&
      // status !== FAILED => return`). That guard reads the row's status
      // from inside its OWN `FOR UPDATE` transaction, so a call to
      // `updateAttemptSteps(attemptId, PROVISIONING, [])` for the reset
      // itself would see the still-`'failed'` row and be dropped by the
      // very same guard it's meant to get past. The reset is therefore a
      // direct, ungated status-only UPDATE (`resetAttemptStatusToProvisioning()`)
      // -- status flip only, no step outcomes touched -- run only when a
      // tenant is already linked, i.e. provisioning is known to be
      // resuming, never for a fresh permanently-dead attempt. Does not
      // touch the guard itself or `recordProvisioningTimeout()`.
      const currentStatus = await this.readAttemptStatus(attemptId);
      if (currentStatus === ATTEMPT_STATUS_FAILED) {
        await this.resetAttemptStatusToProvisioning(attemptId);
      }

      await this.recordTenantCreationSuccess(attemptId, {
        id: linkedTenant.id,
        slug: linkedTenant.slug,
        status: linkedTenant.status as TenantLifecycleStatus,
      });
      await this.provisionTenantSchema(attemptId, linkedTenant.id);
      return;
    }

    const attempt = await this.claimAttempt(attemptId, jobId);

    if (!attempt) {
      return;
    }

    const safePayload = this.readSafePayload(attempt.safePayload);
    if (!safePayload) {
      await this.recordTenantCreationFailure(
        attempt.id,
        'INVALID_SAFE_PAYLOAD',
        'Accepted attempt payload was not safe to provision.',
      );
      return;
    }

    let tenant: TenantLifecycleRow;
    try {
      tenant = await this.createOrResolveTenant(attempt.id, safePayload);
      await this.recordTenantCreationSuccess(attempt.id, {
        id: tenant.id,
        slug: tenant.slug,
        status: tenant.status as TenantLifecycleStatus,
      });
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        const existingTenant = await this.findTenantBySlug(
          safePayload.tenantSlug,
        );

        if (existingTenant?.onboardingAttemptId === attempt.id) {
          await this.recordTenantCreationSuccess(attempt.id, {
            id: existingTenant.id,
            slug: existingTenant.slug,
            status: existingTenant.status as TenantLifecycleStatus,
          });
          await this.provisionTenantSchema(attempt.id, existingTenant.id);
          return;
        }

        await this.recordTenantCreationFailure(
          attempt.id,
          'TENANT_SLUG_CONFLICT',
          'Tenant slug is no longer available.',
        );
        return;
      }

      this.logger.error(
        `Tenant lifecycle start failed for attempt ${attempt.id}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.recordTenantCreationFailure(
        attempt.id,
        'TENANT_CREATION_FAILED',
        'Tenant creation failed before activation.',
      );
      return;
    }

    // Deliberately outside the try/catch above (spec Design Notes /
    // Spec Change Log "KEEP instructions") so a schema/bootstrap failure
    // propagates unreshaped -- it must never be caught and reported as a
    // 'TENANT_CREATION_FAILED' tenant_creation failure, since tenant
    // creation itself already succeeded by this point.
    await this.provisionTenantSchema(attempt.id, tenant.id);
  }

  /**
   * Runs the schema-provisioning steps for `tenantId` sequentially:
   * `createTenantSchema()`, `bootstrapTenantSchema()`, then (Story 2.3)
   * `bootstrapTenantSeed()`. Each step records its own `succeeded`/`failed`
   * outcome and re-throws on failure (no catch-and-swallow here) so a
   * BullMQ job retry occurs and the tenant is never activated on a partial
   * failure (spec Boundaries: "Never ... Set Tenant.status = ACTIVE in this
   * story").
   */
  private async provisionTenantSchema(
    attemptId: string,
    tenantId: string,
  ): Promise<void> {
    await this.createTenantSchema(attemptId, tenantId);
    await this.bootstrapTenantSchema(attemptId, tenantId);
    await this.bootstrapTenantSeed(attemptId, tenantId);
  }

  /**
   * Creates the tenant's Postgres schema (`tenant_<tenantId>`) via
   * `CREATE SCHEMA IF NOT EXISTS`, identifier-bound (`??`, never
   * string-interpolated) through `TenantKnexService.raw()`. Runs inside a
   * CLS `runWith` context populated before any `TenantKnexService` call,
   * mirroring `DdlWorker.process()`'s pattern -- this is a BullMQ worker
   * context with no request-scoped CLS of its own. Idempotent: re-running
   * against an already-created schema is a no-op, still recorded
   * `succeeded` (spec I/O matrix's worker-retry row).
   */
  private async createTenantSchema(
    attemptId: string,
    tenantId: string,
  ): Promise<void> {
    try {
      const schema = resolveTenantSchema(tenantId);
      await this.cls.runWith({ tenantId, schema }, async () => {
        await this.tenantKnexService.raw('CREATE SCHEMA IF NOT EXISTS ??', [
          schema,
        ]);
      });

      await this.updateAttemptStep(attemptId, ATTEMPT_STATUS_PROVISIONING, {
        step: 'schema_created',
        status: 'succeeded',
        occurredAt: new Date().toISOString(),
        tenantId,
      });
    } catch (error) {
      this.logger.error(
        `Tenant schema creation failed for tenant ${tenantId}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.updateAttemptStep(attemptId, ATTEMPT_STATUS_PROVISIONING, {
        step: 'schema_created',
        status: 'failed',
        occurredAt: new Date().toISOString(),
        tenantId,
        errorCode: 'SCHEMA_CREATION_FAILED',
        message: 'Tenant schema creation failed.',
      });
      throw error;
    }
  }

  /**
   * Runs the existing idempotent `DynamicTablesService.ensureMetaTables()`
   * bootstrap migration inside a CLS `runWith` context, creating
   * `_meta_tables`, `_meta_fields`, and `_meta_migrations` inside the
   * tenant's own schema. Does not modify `ensureMetaTables()` itself (spec
   * Ask First) -- only calls it from this new provisioning call site.
   */
  private async bootstrapTenantSchema(
    attemptId: string,
    tenantId: string,
  ): Promise<void> {
    try {
      const schema = resolveTenantSchema(tenantId);
      await this.cls.runWith({ tenantId, schema }, async () => {
        await this.dynamicTablesService.ensureMetaTables();
      });

      await this.updateAttemptStep(attemptId, ATTEMPT_STATUS_PROVISIONING, {
        step: 'bootstrap_migrated',
        status: 'succeeded',
        occurredAt: new Date().toISOString(),
        tenantId,
      });
    } catch (error) {
      this.logger.error(
        `Tenant bootstrap migration failed for tenant ${tenantId}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.updateAttemptStep(attemptId, ATTEMPT_STATUS_PROVISIONING, {
        step: 'bootstrap_migrated',
        status: 'failed',
        occurredAt: new Date().toISOString(),
        tenantId,
        errorCode: 'BOOTSTRAP_MIGRATION_FAILED',
        message: 'Tenant bootstrap migration failed.',
      });
      throw error;
    }
  }

  /**
   * Runs `TenantSeedService.bootstrapSeed()` (Story 2.3) inside a CLS
   * `runWith` context, creating the tenant-schema business-defaults/RBAC
   * tables (`system_settings`, `statuses`, `roles`, `permissions`,
   * `role_permissions`, `categories`, `notification_templates`) and their
   * default rows. Follows the exact `createTenantSchema`/
   * `bootstrapTenantSchema` template: resolve schema, populate CLS, call
   * the service, record `bootstrap_seeded` succeeded/failed, rethrow on
   * failure so a BullMQ retry occurs and the tenant is never activated on a
   * partial failure.
   */
  private async bootstrapTenantSeed(
    attemptId: string,
    tenantId: string,
  ): Promise<void> {
    try {
      const schema = resolveTenantSchema(tenantId);
      await this.cls.runWith({ tenantId, schema }, async () => {
        await this.tenantSeedService.bootstrapSeed();
      });

      await this.updateAttemptStep(attemptId, ATTEMPT_STATUS_PROVISIONING, {
        step: 'bootstrap_seeded',
        status: 'succeeded',
        occurredAt: new Date().toISOString(),
        tenantId,
      });
    } catch (error) {
      this.logger.error(
        `Tenant bootstrap seed failed for tenant ${tenantId}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.updateAttemptStep(attemptId, ATTEMPT_STATUS_PROVISIONING, {
        step: 'bootstrap_seeded',
        status: 'failed',
        occurredAt: new Date().toISOString(),
        tenantId,
        errorCode: 'BOOTSTRAP_SEED_FAILED',
        message: 'Tenant bootstrap seed failed.',
      });
      throw error;
    }
  }

  private async readAttemptStatus(attemptId: string): Promise<string | null> {
    const [attempt] = await this.prisma.$queryRaw<
      Array<{ status: string }>
    >(
      Prisma.sql`
        SELECT "status"
        FROM "tenant_onboarding_attempts"
        WHERE "id" = ${attemptId}
        LIMIT 1
      `,
    );

    return attempt?.status ?? null;
  }

  /**
   * Status-only reset of a `'failed'` attempt back to `'provisioning'` on
   * the resume path -- deliberately NOT routed through `updateAttemptSteps()`
   * (whose already-failed-stays-failed guard would drop this exact write,
   * since it reads the row's still-`'failed'` status inside its own `FOR
   * UPDATE` transaction before this reset has run). No step outcomes are
   * touched here, matching the spec's "status flip only, no step write"
   * instruction; every subsequent `schema_created`/`bootstrap_migrated`
   * write goes through the normal guarded `updateAttemptSteps()` path once
   * the row's status is back to `'provisioning'`.
   */
  private async resetAttemptStatusToProvisioning(
    attemptId: string,
  ): Promise<void> {
    await this.prisma.$executeRaw(
      Prisma.sql`
        UPDATE "tenant_onboarding_attempts"
        SET
          "status" = ${ATTEMPT_STATUS_PROVISIONING},
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${attemptId} AND "status" = ${ATTEMPT_STATUS_FAILED}
      `,
    );
  }

  async recordProvisioningTimeout(attemptId: string): Promise<void> {
    await this.updateAttemptSteps(attemptId, ATTEMPT_STATUS_FAILED, [
      {
        step: 'provisioning_start',
        status: 'failed',
        occurredAt: new Date().toISOString(),
        errorCode: 'PROVISIONING_TIMEOUT',
        message: 'Tenant provisioning lifecycle start timed out.',
      },
    ]);
  }

  private async claimAttempt(
    attemptId: string,
    jobId: string,
  ): Promise<AttemptProvisioningRow | null> {
    return this.prisma.$transaction(async (tx) => {
      const [attempt] = await tx.$queryRaw<AttemptProvisioningRow[]>(
        Prisma.sql`
          SELECT
            "id",
            "status",
            "safePayload",
            "stepOutcomes"
          FROM "tenant_onboarding_attempts"
          WHERE
            "id" = ${attemptId}
            AND "status" = ${ATTEMPT_STATUS_ACCEPTED}
          FOR UPDATE
        `,
      );

      if (!attempt) {
        return null;
      }

      const stepOutcomes = this.upsertStepOutcome(attempt.stepOutcomes, {
        step: 'provisioning_start',
        status: 'running',
        occurredAt: new Date().toISOString(),
      });

      const [claimedAttempt] = await tx.$queryRaw<AttemptProvisioningRow[]>(
        Prisma.sql`
          UPDATE "tenant_onboarding_attempts"
          SET
            "status" = ${ATTEMPT_STATUS_PROVISIONING},
            "provisioningJobId" = COALESCE("provisioningJobId", ${jobId}),
            "stepOutcomes" = ${JSON.stringify(stepOutcomes)}::jsonb,
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${attemptId}
          RETURNING
            "id",
            "status",
            "safePayload",
            "stepOutcomes"
        `,
      );

      return claimedAttempt ?? null;
    });
  }

  private async createOrResolveTenant(
    attemptId: string,
    safePayload: TenantOnboardingSafePayloadDto,
  ): Promise<TenantLifecycleRow> {
    const linkedTenant = await this.findTenantByAttemptId(attemptId);

    if (linkedTenant) {
      return linkedTenant;
    }

    const [tenant] = await this.prisma.$queryRaw<TenantLifecycleRow[]>(
      Prisma.sql`
        INSERT INTO "tenants" (
          "id",
          "name",
          "slug",
          "status",
          "onboardingAttemptId",
          "updatedAt"
        ) VALUES (
          ${this.createTenantId()},
          ${safePayload.tenantName},
          ${safePayload.tenantSlug},
          ${TENANT_STATUS_PROVISIONING},
          ${attemptId},
          CURRENT_TIMESTAMP
        )
        RETURNING
          "id",
          "slug",
          "status",
          "onboardingAttemptId"
      `,
    );

    if (!tenant) {
      throw new Error('Tenant insert returned no row.');
    }

    return tenant;
  }

  private async findTenantByAttemptId(
    attemptId: string,
  ): Promise<TenantLifecycleRow | null> {
    const [tenant] = await this.prisma.$queryRaw<TenantLifecycleRow[]>(
      Prisma.sql`
        SELECT
          "id",
          "slug",
          "status",
          "onboardingAttemptId"
        FROM "tenants"
        WHERE "onboardingAttemptId" = ${attemptId}
        LIMIT 1
      `,
    );

    return tenant ?? null;
  }

  private async findTenantBySlug(
    slug: string,
  ): Promise<TenantLifecycleRow | null> {
    const [tenant] = await this.prisma.$queryRaw<TenantLifecycleRow[]>(
      Prisma.sql`
        SELECT
          "id",
          "slug",
          "status",
          "onboardingAttemptId"
        FROM "tenants"
        WHERE "slug" = ${slug}
        LIMIT 1
      `,
    );

    return tenant ?? null;
  }

  private async recordTenantCreationSuccess(
    attemptId: string,
    tenant: { id: string; slug: string; status: TenantLifecycleStatus },
  ): Promise<void> {
    await this.updateAttemptStep(attemptId, ATTEMPT_STATUS_PROVISIONING, {
      step: 'tenant_creation',
      status: 'succeeded',
      occurredAt: new Date().toISOString(),
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      tenantStatus: tenant.status,
    });
  }

  private async recordTenantCreationFailure(
    attemptId: string,
    errorCode: string,
    message: string,
  ): Promise<void> {
    const occurredAt = new Date().toISOString();
    await this.updateAttemptSteps(attemptId, ATTEMPT_STATUS_FAILED, [
      {
        step: 'provisioning_start',
        status: 'failed',
        occurredAt,
        errorCode,
        message,
      },
      {
        step: 'tenant_creation',
        status: 'failed',
        occurredAt,
        errorCode,
        message,
      },
    ]);
  }

  private async updateAttemptStep(
    attemptId: string,
    status: string,
    outcome: TenantOnboardingStepOutcomeDto,
  ): Promise<void> {
    await this.updateAttemptSteps(attemptId, status, [outcome]);
  }

  private async updateAttemptSteps(
    attemptId: string,
    status: string,
    outcomes: TenantOnboardingStepOutcomeDto[],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const [attempt] = await tx.$queryRaw<AttemptProvisioningRow[]>(
        Prisma.sql`
          SELECT "id", "status", "safePayload", "stepOutcomes"
          FROM "tenant_onboarding_attempts"
          WHERE "id" = ${attemptId}
          FOR UPDATE
        `,
      );

      if (!attempt) {
        return;
      }

      if (attempt.status === ATTEMPT_STATUS_FAILED && status !== ATTEMPT_STATUS_FAILED) {
        return;
      }

      const stepOutcomes = outcomes.reduce(
        (current, outcome) => this.upsertStepOutcome(current, outcome),
        this.normalizeStepOutcomes(attempt.stepOutcomes),
      );

      await tx.$executeRaw(
        Prisma.sql`
          UPDATE "tenant_onboarding_attempts"
          SET
            "status" = ${status},
            "stepOutcomes" = ${JSON.stringify(stepOutcomes)}::jsonb,
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${attemptId}
        `,
      );
    });
  }

  private upsertStepOutcome(
    current: unknown,
    outcome: TenantOnboardingStepOutcomeDto,
  ): TenantOnboardingStepOutcomeDto[] {
    const outcomes = this.normalizeStepOutcomes(current);
    const existingIndex = outcomes.findIndex(
      (item) => item.step === outcome.step,
    );

    if (existingIndex === -1) {
      return [...outcomes, outcome];
    }

    return outcomes.map((item, index) =>
      index === existingIndex ? outcome : item,
    );
  }

  private normalizeStepOutcomes(
    current: unknown,
  ): TenantOnboardingStepOutcomeDto[] {
    if (!Array.isArray(current)) {
      return [];
    }

    return current.filter((item): item is TenantOnboardingStepOutcomeDto => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return false;
      }

      const outcome = item as Partial<TenantOnboardingStepOutcomeDto>;
      return (
        typeof outcome.step === 'string' &&
        typeof outcome.status === 'string' &&
        typeof outcome.occurredAt === 'string'
      );
    });
  }

  private readSafePayload(
    value: unknown,
  ): TenantOnboardingSafePayloadDto | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const payload = value as Partial<TenantOnboardingSafePayloadDto>;
    if (typeof payload.plan !== 'string') {
      return null;
    }

    const safePayload = {
      tenantName:
        typeof payload.tenantName === 'string' ? payload.tenantName.trim() : '',
      tenantSlug:
        typeof payload.tenantSlug === 'string' ? payload.tenantSlug.trim() : '',
      firstAdminEmail:
        typeof payload.firstAdminEmail === 'string'
          ? payload.firstAdminEmail.trim().toLowerCase()
          : '',
      plan: payload.plan,
    };

    return Object.keys(validateTenantOnboardingInput(safePayload)).length === 0
      ? safePayload
      : null;
  }

  private jobIdForAttempt(attemptId: string): string {
    return `tenant-provisioning-${attemptId}`;
  }

  private createTenantId(): string {
    return `c${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return error.code === 'P2002';
    }

    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === '23505'
    );
  }
}
