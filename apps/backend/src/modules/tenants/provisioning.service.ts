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
  TenantOnboardingCompensationAction,
  TenantOnboardingCompensationOutcomeDto,
  TenantOnboardingSafePayloadDto,
  TenantOnboardingStepName,
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
  FirstAdminDeactivationIds,
  FirstAdminService,
} from './first-admin.service';
import { SetupLinkService } from './setup-link.service';
import { EmailDeliveryService } from './email-delivery.service';
import {
  TENANT_PROVISIONING_QUEUE_NAME,
  TENANT_PROVISIONING_START_JOB,
  TenantProvisioningJobData,
} from './provisioning.types';

const TENANT_STATUS_PROVISIONING: TenantLifecycleStatus = 'PROVISIONING';
const TENANT_STATUS_ACTIVE: TenantLifecycleStatus = 'ACTIVE';
const TENANT_STATUS_FAILED: TenantLifecycleStatus = 'FAILED';
const ATTEMPT_STATUS_ACCEPTED = 'accepted';
const ATTEMPT_STATUS_PROVISIONING = 'provisioning';
const ATTEMPT_STATUS_FAILED = 'failed';
const ATTEMPT_STATUS_SUCCEEDED = 'succeeded';
const ATTEMPT_STATUS_FAILED_MANUAL_CLEANUP = 'failed-needs-manual-cleanup';

/**
 * Thrown by `activation()` when its conditional `Tenant.status` update
 * finds the tenant already `FAILED` (a concurrent compensation run got
 * there first) -- distinguishes a deliberately-blocked activation from a
 * generic DB/unexpected failure so the catch block can log/record the
 * specific reason.
 */
class ActivationBlockedError extends Error {}

/**
 * Thrown by `startLifecycle()`'s resume path when a full-job BullMQ retry
 * lands on an attempt already in `failed-needs-manual-cleanup` -- that
 * status is a deliberate human-intervention stop (spec's Manual Cleanup
 * Threshold); a retry must not silently resolve as if it helped.
 */
class ManualCleanupRequiredError extends Error {}

/**
 * Signals that the BullMQ worker timed out and fenced this in-flight
 * lifecycle. This is intentionally distinct from a provisioning failure:
 * timeout handling in the worker owns compensation and audit finalization.
 */
class ProvisioningCancelledError extends Error {}

interface AttemptProvisioningRow {
  id: string;
  status: string;
  safePayload: unknown;
  stepOutcomes: unknown;
}

interface AttemptAuditRow {
  id: string;
  safePayload: unknown;
  actorIdentity: unknown;
  requestIdentity: unknown;
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
    private readonly firstAdminService: FirstAdminService,
    private readonly setupLinkService: SetupLinkService,
    private readonly emailDeliveryService: EmailDeliveryService,
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

  async startLifecycle(attemptId: string, signal?: AbortSignal): Promise<void> {
    this.throwIfProvisioningCancelled(signal);
    const jobId = this.jobIdForAttempt(attemptId);
    const linkedTenant = await this.findTenantByAttemptId(attemptId);
    this.throwIfProvisioningCancelled(signal);
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

      // Story 2.6 added two more terminal states beyond 'failed'. A retry
      // landing on 'succeeded' is a true no-op -- every step already ran
      // and Tenant.status is already ACTIVE, so resolving without touching
      // anything further is the correct idempotent behavior (asserted
      // explicitly here rather than left implicit in a fallthrough).
      if (currentStatus === ATTEMPT_STATUS_SUCCEEDED) {
        return;
      }

      // A retry landing on 'failed-needs-manual-cleanup' must NOT silently
      // resolve as success -- that status is a deliberate human-
      // intervention stop (spec's Manual Cleanup Threshold: compensation
      // itself failed and the exact stuck resources are already recorded
      // in the audit row). Auto-resuming compensation here would risk
      // exactly the ambiguous-state action the threshold exists to avoid,
      // so this throws instead of quietly doing nothing.
      if (currentStatus === ATTEMPT_STATUS_FAILED_MANUAL_CLEANUP) {
        throw new ManualCleanupRequiredError(
          `Attempt ${attemptId} is in failed-needs-manual-cleanup and requires operator intervention before it can be retried.`,
        );
      }

      if (currentStatus === ATTEMPT_STATUS_FAILED) {
        await this.resetAttemptStatusToProvisioning(attemptId);
      }

      this.throwIfProvisioningCancelled(signal);
      await this.recordTenantCreationSuccess(attemptId, {
        id: linkedTenant.id,
        slug: linkedTenant.slug,
        status: linkedTenant.status as TenantLifecycleStatus,
      });
      await this.provisionTenantSchema(attemptId, linkedTenant.id, signal);
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
      tenant = await this.createOrResolveTenant(
        attempt.id,
        safePayload,
        signal,
      );
      this.throwIfProvisioningCancelled(signal);
      await this.recordTenantCreationSuccess(attempt.id, {
        id: tenant.id,
        slug: tenant.slug,
        status: tenant.status as TenantLifecycleStatus,
      });
    } catch (error) {
      if (this.isProvisioningCancelled(error)) {
        throw error;
      }
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
          await this.provisionTenantSchema(
            attempt.id,
            existingTenant.id,
            signal,
          );
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
    await this.provisionTenantSchema(attempt.id, tenant.id, signal);
  }

  /**
   * Runs the schema-provisioning steps for `tenantId` sequentially:
   * `createTenantSchema()`, `bootstrapTenantSchema()`, `bootstrapTenantSeed()`
   * (Story 2.3), `assignFirstAdmin()` (Story 2.4), then (Story 2.5)
   * `generateSetupLink()` and `sendBackupEmail()`. Each blocking step
   * records its own `succeeded`/`failed` outcome and re-throws on failure
   * (no catch-and-swallow here). Story 2.6 closes the workflow: on success,
   * `activation()` flips `Tenant.status = ACTIVE` and `finalizeAudit()`
   * writes the permanent audit row. On any steps-1-through-6 failure,
   * caught here (not inside each step, which still self-record and
   * rethrow), `runCompensation()` cleans up whatever succeeded,
   * `Tenant.status` becomes `FAILED` (or stays whatever it already is if
   * compensation itself fails), `finalizeAudit()` still runs, and the
   * original error is rethrown unchanged so BullMQ retry visibility is
   * preserved.
   */
  private async provisionTenantSchema(
    attemptId: string,
    tenantId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.createTenantSchema(attemptId, tenantId, signal);
      await this.bootstrapTenantSchema(attemptId, tenantId, signal);
      await this.bootstrapTenantSeed(attemptId, tenantId, signal);
      await this.assignFirstAdmin(attemptId, tenantId, signal);
      const setupToken = await this.generateSetupLink(
        attemptId,
        tenantId,
        signal,
      );
      await this.sendBackupEmail(attemptId, tenantId, setupToken, signal);
      await this.activation(attemptId, tenantId, signal);
      await this.finalizeAudit(
        attemptId,
        tenantId,
        ATTEMPT_STATUS_SUCCEEDED,
        undefined,
        signal,
      );
    } catch (error) {
      if (this.isProvisioningCancelled(error)) {
        throw error;
      }
      await this.handleProvisioningFailure(attemptId, tenantId);
      throw error;
    }
  }

  /**
   * Orchestrator-level failure handler (spec Design Notes: compensation
   * needs to know which steps actually succeeded, only knowable one level
   * up after catching the rethrown error). Reads back the attempt's current
   * `stepOutcomes`, runs best-effort compensation per the Compensation
   * Matrix for whichever steps succeeded, transitions `Tenant.status =
   * FAILED` unless compensation itself failed (in which case the tenant is
   * left as-is -- neither activated nor silently cleaned up -- per the
   * Manual Cleanup Threshold), and always finishes with `finalizeAudit()`.
   * Never throws -- a failure here must not mask the original provisioning
   * error being rethrown by the caller.
   */
  private async handleProvisioningFailure(
    attemptId: string,
    tenantId: string,
  ): Promise<void> {
    try {
      const stepOutcomes = await this.readAttemptStepOutcomes(attemptId);
      const compensation = await this.runCompensation(tenantId, stepOutcomes);
      const compensationFailed = compensation.some(
        (outcome) => outcome.status === 'failed',
      );

      if (!compensationFailed) {
        await this.markTenantFailed(tenantId);
      }

      await this.finalizeAudit(
        attemptId,
        tenantId,
        compensationFailed
          ? ATTEMPT_STATUS_FAILED_MANUAL_CLEANUP
          : ATTEMPT_STATUS_FAILED,
        compensation,
      );
    } catch (handlerError) {
      this.logger.error(
        `Compensation/audit finalization itself failed for attempt ${attemptId}, tenant ${tenantId}`,
        handlerError instanceof Error ? handlerError.stack : undefined,
      );
    }
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
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      this.throwIfProvisioningCancelled(signal);
      const schema = resolveTenantSchema(tenantId);
      await this.cls.runWith({ tenantId, schema }, async () => {
        await this.tenantKnexService.raw('CREATE SCHEMA IF NOT EXISTS ??', [
          schema,
        ]);
      });

      await this.updateAttemptStep(
        attemptId,
        ATTEMPT_STATUS_PROVISIONING,
        {
          step: 'schema_created',
          status: 'succeeded',
          occurredAt: new Date().toISOString(),
          tenantId,
        },
        signal,
      );
    } catch (error) {
      if (this.isProvisioningCancelled(error)) {
        throw error;
      }
      this.logger.error(
        `Tenant schema creation failed for tenant ${tenantId}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.updateAttemptStep(
        attemptId,
        ATTEMPT_STATUS_PROVISIONING,
        {
          step: 'schema_created',
          status: 'failed',
          occurredAt: new Date().toISOString(),
          tenantId,
          errorCode: 'SCHEMA_CREATION_FAILED',
          message: 'Tenant schema creation failed.',
        },
        signal,
      );
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
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      this.throwIfProvisioningCancelled(signal);
      const schema = resolveTenantSchema(tenantId);
      await this.cls.runWith({ tenantId, schema }, async () => {
        await this.dynamicTablesService.ensureMetaTables();
      });

      await this.updateAttemptStep(
        attemptId,
        ATTEMPT_STATUS_PROVISIONING,
        {
          step: 'bootstrap_migrated',
          status: 'succeeded',
          occurredAt: new Date().toISOString(),
          tenantId,
        },
        signal,
      );
    } catch (error) {
      if (this.isProvisioningCancelled(error)) {
        throw error;
      }
      this.logger.error(
        `Tenant bootstrap migration failed for tenant ${tenantId}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.updateAttemptStep(
        attemptId,
        ATTEMPT_STATUS_PROVISIONING,
        {
          step: 'bootstrap_migrated',
          status: 'failed',
          occurredAt: new Date().toISOString(),
          tenantId,
          errorCode: 'BOOTSTRAP_MIGRATION_FAILED',
          message: 'Tenant bootstrap migration failed.',
        },
        signal,
      );
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
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      this.throwIfProvisioningCancelled(signal);
      const schema = resolveTenantSchema(tenantId);
      await this.cls.runWith({ tenantId, schema }, async () => {
        await this.tenantSeedService.bootstrapSeed();
      });

      await this.updateAttemptStep(
        attemptId,
        ATTEMPT_STATUS_PROVISIONING,
        {
          step: 'bootstrap_seeded',
          status: 'succeeded',
          occurredAt: new Date().toISOString(),
          tenantId,
        },
        signal,
      );
    } catch (error) {
      if (this.isProvisioningCancelled(error)) {
        throw error;
      }
      this.logger.error(
        `Tenant bootstrap seed failed for tenant ${tenantId}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.updateAttemptStep(
        attemptId,
        ATTEMPT_STATUS_PROVISIONING,
        {
          step: 'bootstrap_seeded',
          status: 'failed',
          occurredAt: new Date().toISOString(),
          tenantId,
          errorCode: 'BOOTSTRAP_SEED_FAILED',
          message: 'Tenant bootstrap seed failed.',
        },
        signal,
      );
      throw error;
    }
  }

  /**
   * Resolves the First Admin's email via a fresh `readAttemptSafePayload()`
   * re-query, then runs `FirstAdminService.assign()` inside a CLS `runWith`
   * context, creating the First Admin `AuthAccount` + `TenantUser`
   * (`status: 'pending_setup'`) and assigning the tenant-scoped
   * `TENANT_ADMIN` role. Follows the exact `bootstrapTenantSeed()` template:
   * resolve schema, populate CLS, call the service, record
   * `first_admin_assigned` succeeded/failed, rethrow on failure so a BullMQ
   * retry occurs and the tenant is never activated on a partial failure.
   */
  private async assignFirstAdmin(
    attemptId: string,
    tenantId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      this.throwIfProvisioningCancelled(signal);
      const safePayload = await this.readAttemptSafePayload(attemptId);
      if (!safePayload) {
        throw new Error(
          'Attempt safe payload was not available for First Admin assignment.',
        );
      }

      const schema = resolveTenantSchema(tenantId);
      await this.cls.runWith({ tenantId, schema }, async () => {
        await this.firstAdminService.assign(
          tenantId,
          safePayload.firstAdminEmail,
        );
      });

      await this.updateAttemptStep(
        attemptId,
        ATTEMPT_STATUS_PROVISIONING,
        {
          step: 'first_admin_assigned',
          status: 'succeeded',
          occurredAt: new Date().toISOString(),
          tenantId,
        },
        signal,
      );
    } catch (error) {
      if (this.isProvisioningCancelled(error)) {
        throw error;
      }
      this.logger.error(
        `First Admin assignment failed for tenant ${tenantId}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.updateAttemptStep(
        attemptId,
        ATTEMPT_STATUS_PROVISIONING,
        {
          step: 'first_admin_assigned',
          status: 'failed',
          occurredAt: new Date().toISOString(),
          tenantId,
          errorCode: 'FIRST_ADMIN_ASSIGNMENT_FAILED',
          message: 'First Admin assignment failed.',
        },
        signal,
      );
      throw error;
    }
  }

  /**
   * Mints the tenant's one-time setup token via `SetupLinkService.generate()`
   * inside a CLS `runWith` context, following `assignFirstAdmin()`'s exact
   * template: resolve schema, populate CLS, call the service, record
   * `setup_link_generated` succeeded/failed, rethrow on failure so a
   * BullMQ retry occurs and the tenant is never activated on a partial
   * failure. Only safe metadata (`tenantId`) is ever recorded in the step
   * outcome. The raw token is returned only to its immediate caller so it can
   * be passed directly to the non-blocking email step; it is never logged,
   * persisted, or written to an audit outcome.
   */
  private async generateSetupLink(
    attemptId: string,
    tenantId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      this.throwIfProvisioningCancelled(signal);
      const schema = resolveTenantSchema(tenantId);
      const generatedLink = await this.cls.runWith(
        { tenantId, schema },
        async () => this.setupLinkService.generate(tenantId),
      );
      const setupToken = generatedLink.setupToken;

      await this.updateAttemptStep(
        attemptId,
        ATTEMPT_STATUS_PROVISIONING,
        {
          step: 'setup_link_generated',
          status: 'succeeded',
          occurredAt: new Date().toISOString(),
          tenantId,
        },
        signal,
      );
      return setupToken;
    } catch (error) {
      if (this.isProvisioningCancelled(error)) {
        throw error;
      }
      this.logger.error(
        `Setup link generation failed for tenant ${tenantId}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.updateAttemptStep(
        attemptId,
        ATTEMPT_STATUS_PROVISIONING,
        {
          step: 'setup_link_generated',
          status: 'failed',
          occurredAt: new Date().toISOString(),
          tenantId,
          errorCode: 'SETUP_LINK_GENERATION_FAILED',
          message: 'Setup link generation failed.',
        },
        signal,
      );
      throw error;
    }
  }

  /**
   * Best-effort backup email delivery via
   * `EmailDeliveryService.sendSetupInvite()`. Runs only after
   * `generateSetupLink()` has succeeded (sequential await in
   * `provisionTenantSchema()`). Unlike every other provisioning step, this
   * one's try/catch never rethrows -- any failure (rejected promise,
   * `{ delivered: false }` outcome, or a missing safe payload) is recorded
   * `failed` on `setup_email_sent` warning-only, and provisioning continues
   * regardless (spec Boundaries: backup email is non-blocking). Its raw setup
   * token argument is forwarded directly to the mailer and is never logged
   * or written into an attempt outcome.
   */
  private async sendBackupEmail(
    attemptId: string,
    tenantId: string,
    setupToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const occurredAt = new Date().toISOString();
    try {
      this.throwIfProvisioningCancelled(signal);
      const safePayload = await this.readAttemptSafePayload(attemptId);
      if (!safePayload) {
        throw new Error(
          'Attempt safe payload was not available for backup email delivery.',
        );
      }

      const outcome = await this.emailDeliveryService.sendSetupInvite(
        safePayload.firstAdminEmail,
        safePayload.tenantName,
        setupToken,
      );

      if (outcome.delivered) {
        await this.updateAttemptStep(
          attemptId,
          ATTEMPT_STATUS_PROVISIONING,
          {
            step: 'setup_email_sent',
            status: 'succeeded',
            occurredAt,
            tenantId,
          },
          signal,
        );
        return;
      }

      await this.updateAttemptStep(
        attemptId,
        ATTEMPT_STATUS_PROVISIONING,
        {
          step: 'setup_email_sent',
          status: 'failed',
          occurredAt,
          tenantId,
          errorCode: outcome.errorCode ?? 'SETUP_EMAIL_DELIVERY_FAILED',
          message: 'Backup setup email delivery failed.',
        },
        signal,
      );
    } catch (error) {
      if (this.isProvisioningCancelled(error)) {
        throw error;
      }
      this.logger.warn(
        `Backup setup email delivery failed for tenant ${tenantId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
        error instanceof Error ? error.stack : undefined,
      );
      try {
        await this.updateAttemptStep(
          attemptId,
          ATTEMPT_STATUS_PROVISIONING,
          {
            step: 'setup_email_sent',
            status: 'failed',
            occurredAt,
            tenantId,
            errorCode: 'SETUP_EMAIL_DELIVERY_FAILED',
            message: 'Backup setup email delivery failed.',
          },
          signal,
        );
      } catch (recordError) {
        if (this.isProvisioningCancelled(recordError)) {
          throw recordError;
        }
        this.logger.warn(
          `Failed to record setup_email_sent failure outcome for tenant ${tenantId}: ${
            recordError instanceof Error ? recordError.message : 'unknown error'
          }`,
          recordError instanceof Error ? recordError.stack : undefined,
        );
      }
    }
  }

  /**
   * Final blocking step: only runs after `sendBackupEmail()` completes
   * (regardless of its own outcome, since it's non-blocking). Sets
   * `Tenant.status = 'ACTIVE'` via `prisma.tenant.update` -- the product
   * commit boundary (spec Intent) -- then records the `activation` step
   * outcome with the same `tenantId`/`tenantSlug`/`tenantStatus` shape
   * `recordTenantCreationSuccess()` uses. Idempotent against a full-job
   * BullMQ retry: re-running against an already-`ACTIVE` tenant is a safe
   * no-op status-wise (the UPDATE just re-sets the same value), still
   * recorded `succeeded`. Rethrows on failure like every other blocking
   * step so the orchestrator's catch runs compensation.
   */
  private async activation(
    attemptId: string,
    tenantId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      this.throwIfProvisioningCancelled(signal);
      // The attempt's persisted status is the final fence in addition to
      // AbortSignal. If timeout handling has already marked it FAILED, this
      // query cannot activate the tenant even if a stale async continuation
      // reached this point after the signal was raised.
      const { count } = await this.prisma.tenant.updateMany({
        where: {
          id: tenantId,
          status: { not: TENANT_STATUS_FAILED },
          onboardingAttempt: {
            is: { id: attemptId, status: ATTEMPT_STATUS_PROVISIONING },
          },
        },
        data: { status: TENANT_STATUS_ACTIVE },
      });

      if (count === 0) {
        throw new ActivationBlockedError(
          `Tenant ${tenantId} activation blocked: tenant is already FAILED.`,
        );
      }

      const tenant = await this.prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { id: true, slug: true, status: true },
      });

      await this.updateAttemptStep(
        attemptId,
        ATTEMPT_STATUS_PROVISIONING,
        {
          step: 'activation',
          status: 'succeeded',
          occurredAt: new Date().toISOString(),
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          tenantStatus: tenant.status as TenantLifecycleStatus,
        },
        signal,
      );
    } catch (error) {
      if (this.isProvisioningCancelled(error)) {
        throw error;
      }
      const blocked = error instanceof ActivationBlockedError;
      this.logger.error(
        blocked
          ? `Tenant activation skipped for tenant ${tenantId}: tenant is already FAILED.`
          : `Tenant activation failed for tenant ${tenantId}`,
        !blocked && error instanceof Error ? error.stack : undefined,
      );
      await this.updateAttemptStep(
        attemptId,
        ATTEMPT_STATUS_PROVISIONING,
        {
          step: 'activation',
          status: 'failed',
          occurredAt: new Date().toISOString(),
          tenantId,
          errorCode: blocked
            ? 'ACTIVATION_BLOCKED_TENANT_FAILED'
            : 'ACTIVATION_FAILED',
          message: blocked
            ? 'Tenant activation was blocked because the tenant is already FAILED.'
            : 'Tenant activation failed.',
        },
        signal,
      );
      throw error;
    }
  }

  /**
   * Best-effort compensation for a steps-1-through-6 failure, run by
   * `handleProvisioningFailure()` in reverse order of what the Compensation
   * Matrix (`failure-modes.md`) requires: revoke `SetupToken` rows, remove
   * the First Admin actor (`TenantUser` + `AuthAccount` + `TENANT_ADMIN`
   * `Role`), then drop the tenant schema -- only when `schema_created`
   * itself is known to have succeeded (spec Never: "Attempt schema-drop
   * compensation for a schema that was never confirmed created"). Each
   * sub-step is individually try/caught so one failure never blocks the
   * rest from being attempted; every outcome (including a `skipped`
   * sub-step whose forward step never succeeded) is returned for the audit
   * `compensation` field. On failure, `detail` carries every known
   * identifier (tenant id always; schema name for the schema sub-step;
   * TenantUser/AuthAccount/Role ids for the first-admin sub-step, reported
   * by `FirstAdminService.deactivate()` even if the delete itself failed)
   * per spec Boundaries/Acceptance Criteria. Never throws.
   */
  private async runCompensation(
    tenantId: string,
    stepOutcomes: TenantOnboardingStepOutcomeDto[],
  ): Promise<TenantOnboardingCompensationOutcomeDto[]> {
    const succeeded = (step: TenantOnboardingStepName) =>
      stepOutcomes.some(
        (outcome) => outcome.step === step && outcome.status === 'succeeded',
      );

    const outcomes: TenantOnboardingCompensationOutcomeDto[] = [];

    outcomes.push(
      await this.runCompensationSubStep(
        'setup_link_generated',
        'revoke_setup_tokens',
        async () => {
          await this.setupLinkService.revokeAll(tenantId);
        },
        () => `tenantId=${tenantId}`,
      ),
    );

    let firstAdminIds: FirstAdminDeactivationIds = {};
    outcomes.push(
      await this.runCompensationSubStep(
        'first_admin_assigned',
        'deactivate_first_admin',
        async () => {
          firstAdminIds = await this.firstAdminService.deactivate(tenantId);
        },
        () => this.describeFirstAdminIds(tenantId, firstAdminIds),
      ),
    );

    if (succeeded('schema_created')) {
      const schema = resolveTenantSchema(tenantId);
      outcomes.push(
        await this.runCompensationSubStep(
          'schema_created',
          'drop_tenant_schema',
          async () => {
            await this.cls.runWith({ tenantId, schema }, async () => {
              await this.tenantKnexService.raw(
                'DROP SCHEMA IF EXISTS ?? CASCADE',
                [schema],
              );
            });
          },
          () => `tenantId=${tenantId}, schema=${schema}`,
        ),
      );
    } else {
      outcomes.push({
        step: 'schema_created',
        action: 'drop_tenant_schema',
        status: 'skipped',
        detail: 'schema_created never succeeded for this attempt.',
      });
    }

    return outcomes;
  }

  /**
   * Formats the known First Admin identifiers for a compensation-failure
   * `detail` string. `firstAdminIds` reflects whatever
   * `FirstAdminService.deactivate()` found before/during its attempt (via
   * closure mutation from the caller) -- populated even when `deactivate()`
   * itself ends up throwing, since ids are read before the delete runs.
   */
  private describeFirstAdminIds(
    tenantId: string,
    firstAdminIds: FirstAdminDeactivationIds | undefined,
  ): string {
    const parts = [`tenantId=${tenantId}`];
    if (firstAdminIds?.tenantUserId) {
      parts.push(`tenantUserId=${firstAdminIds.tenantUserId}`);
    }
    if (firstAdminIds?.authAccountId) {
      parts.push(`authAccountId=${firstAdminIds.authAccountId}`);
    }
    if (firstAdminIds?.roleId) {
      parts.push(`roleId=${firstAdminIds.roleId}`);
    }
    return parts.join(', ');
  }

  /**
   * Runs one compensation sub-step, catching any throw so
   * `runCompensation()` can keep attempting the remaining sub-steps (spec
   * Boundaries: "If any compensation sub-step throws, catch it, continue
   * attempting the remaining sub-steps"). `describeIdentifiers` is called
   * only on failure, after `run()` has had a chance to populate whatever
   * closure state it captures (e.g. ids found before a delete failed) --
   * only safe identifiers ever end up in `detail`, never a raw error
   * message or stack trace.
   */
  private async runCompensationSubStep(
    step: TenantOnboardingStepName,
    action: TenantOnboardingCompensationAction,
    run: () => Promise<void>,
    describeIdentifiers: () => string,
  ): Promise<TenantOnboardingCompensationOutcomeDto> {
    try {
      await run();
      return { step, action, status: 'succeeded' };
    } catch (error) {
      this.logger.error(
        `Compensation sub-step ${action} (for ${step}) failed`,
        error instanceof Error ? error.stack : undefined,
      );
      return {
        step,
        action,
        status: 'failed',
        detail: `${action} failed and requires manual cleanup. Known identifiers: ${describeIdentifiers()}.`,
      };
    }
  }

  /**
   * Transitions `Tenant.status = 'FAILED'` -- the terminal state for a
   * compensated failure (spec Never: "Delete the Tenant row as
   * compensation"). Deliberately not routed through `updateAttemptStep()`
   * (which targets the attempt row, not `Tenant`) -- a direct
   * `prisma.tenant.update`, mirroring `activation()`'s own call shape.
   * Swallows a missing/already-deleted tenant row rather than throwing,
   * since `handleProvisioningFailure()` must never let this crash the job.
   */
  private async markTenantFailed(tenantId: string): Promise<void> {
    try {
      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { status: TENANT_STATUS_FAILED },
      });
    } catch (error) {
      this.logger.error(
        `Failed to mark tenant ${tenantId} as FAILED`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Always the last action in `provisionTenantSchema()`'s success path and
   * in every catch-driven failure path (`handleProvisioningFailure()`).
   * Re-queries the attempt's `safePayload`/`actorIdentity`/
   * `requestIdentity`/`stepOutcomes` and writes the permanent
   * `TenantOnboardingAuditLog` row via `prisma.tenantOnboardingAuditLog.
   * upsert` keyed on `attemptId` -- idempotent against a full-job BullMQ
   * retry re-entering an already-finalized attempt (spec Design Notes).
   * Follows `sendBackupEmail()`'s double-guarded never-rethrow shape: a
   * failure to write the audit row must not crash the job, so both the
   * outer read and the upsert itself are caught and only logged.
   */
  private async finalizeAudit(
    attemptId: string,
    tenantId: string | null,
    finalStatus: string,
    compensation?: TenantOnboardingCompensationOutcomeDto[],
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      this.throwIfProvisioningCancelled(signal);
      const attempt = await this.readAttemptAuditRow(attemptId);
      if (!attempt) {
        this.logger.warn(
          `Could not finalize audit for attempt ${attemptId}: attempt row not found.`,
        );
        return;
      }

      const stepOutcomes = this.normalizeStepOutcomes(attempt.stepOutcomes);
      const compensationJson = compensation
        ? (compensation as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull;

      await this.prisma.tenantOnboardingAuditLog.upsert({
        where: { attemptId },
        create: {
          attemptId,
          tenantId,
          actorIdentity: attempt.actorIdentity as Prisma.InputJsonValue,
          requestIdentity: attempt.requestIdentity as Prisma.InputJsonValue,
          safePayload: attempt.safePayload as Prisma.InputJsonValue,
          stepOutcomes: stepOutcomes as unknown as Prisma.InputJsonValue,
          compensation: compensationJson,
          finalStatus,
        },
        update: {
          tenantId,
          actorIdentity: attempt.actorIdentity as Prisma.InputJsonValue,
          requestIdentity: attempt.requestIdentity as Prisma.InputJsonValue,
          safePayload: attempt.safePayload as Prisma.InputJsonValue,
          stepOutcomes: stepOutcomes as unknown as Prisma.InputJsonValue,
          compensation: compensationJson,
          finalStatus,
        },
      });

      await this.updateAttemptStep(
        attemptId,
        finalStatus,
        {
          step: 'audit_finalized',
          status: 'succeeded',
          occurredAt: new Date().toISOString(),
          ...(tenantId ? { tenantId } : {}),
        },
        signal,
      );
    } catch (error) {
      if (this.isProvisioningCancelled(error)) {
        throw error;
      }
      this.logger.error(
        `Audit finalization failed for attempt ${attemptId}, tenant ${tenantId ?? 'none'}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Full re-fetch of the attempt row's audit-relevant columns
   * (`safePayload`, `actorIdentity`, `requestIdentity`, `stepOutcomes`),
   * mirroring `readAttemptSafePayload()`'s targeted-SELECT-by-id pattern
   * but returning every field `finalizeAudit()` needs in one round trip.
   */
  private async readAttemptAuditRow(
    attemptId: string,
  ): Promise<AttemptAuditRow | null> {
    const [attempt] = await this.prisma.$queryRaw<AttemptAuditRow[]>(
      Prisma.sql`
        SELECT "id", "safePayload", "actorIdentity", "requestIdentity", "stepOutcomes"
        FROM "tenant_onboarding_attempts"
        WHERE "id" = ${attemptId}
        LIMIT 1
      `,
    );

    return attempt ?? null;
  }

  /**
   * Re-fetch of just the attempt's current `stepOutcomes`, used by
   * `handleProvisioningFailure()` to know which of steps 1-6 actually
   * succeeded before compensating (spec Design Notes: only knowable one
   * level up, after catching the rethrown error).
   *
   * If the row itself can't be found, this returns `[]` -- the same safe
   * fallback as "no steps succeeded yet" -- which makes `runCompensation()`
   * skip every forward-gated sub-step (e.g. schema drop) rather than risk
   * compensating against a resource that might not actually exist
   * (under-compensating is safer than over-compensating). That fallback is
   * abnormal enough to be worth a visible warning, though, mirroring
   * `finalizeAudit()`'s own "could not finalize" log -- an unreadable
   * attempt row here means compensation may silently skip work it should
   * have done.
   */
  private async readAttemptStepOutcomes(
    attemptId: string,
  ): Promise<TenantOnboardingStepOutcomeDto[]> {
    const [attempt] = await this.prisma.$queryRaw<
      Array<{ stepOutcomes: unknown }>
    >(
      Prisma.sql`
        SELECT "stepOutcomes"
        FROM "tenant_onboarding_attempts"
        WHERE "id" = ${attemptId}
        LIMIT 1
      `,
    );

    if (!attempt) {
      this.logger.warn(
        `Could not read stepOutcomes for attempt ${attemptId}: attempt row not found. Compensation will skip every forward-gated sub-step (e.g. schema drop) since prior step success can't be confirmed.`,
      );
      return [];
    }

    return this.normalizeStepOutcomes(attempt.stepOutcomes);
  }

  /**
   * Targeted re-fetch of the accepted attempt's `safePayload`, mirroring
   * `readAttemptStatus()`'s `$queryRaw`-by-id pattern. `startLifecycle()`
   * has two paths into `provisionTenantSchema()` (fresh attempt,
   * already-linked-tenant retry); only the fresh path currently has
   * `safePayload` in scope, so this new step re-queries it directly rather
   * than threading it through both call sites (spec Design Notes).
   */
  private async readAttemptSafePayload(
    attemptId: string,
  ): Promise<TenantOnboardingSafePayloadDto | null> {
    const [attempt] = await this.prisma.$queryRaw<
      Array<{ safePayload: unknown }>
    >(
      Prisma.sql`
        SELECT "safePayload"
        FROM "tenant_onboarding_attempts"
        WHERE "id" = ${attemptId}
        LIMIT 1
      `,
    );

    if (!attempt) {
      return null;
    }

    return this.readSafePayload(attempt.safePayload);
  }

  private async readAttemptStatus(attemptId: string): Promise<string | null> {
    const [attempt] = await this.prisma.$queryRaw<Array<{ status: string }>>(
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

  /**
   * Called by `TenantProvisioningWorker` when the whole job exceeds its
   * timeout. Records the durable timeout failure on the attempt, then --
   * like every other steps-1-through-6 failure path -- runs compensation
   * for whatever succeeded and finalizes the permanent audit row. A tenant
   * may or may not exist yet at timeout (the timeout can fire before
   * `createOrResolveTenant()` ever ran); when none is linked, compensation
   * and the tenant-status transition are skipped, but the audit row still
   * gets written with `tenantId: null`, matching how `TenantOnboardingAuditLog.
   * tenantId` is nullable for exactly this reason.
   */
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

    const linkedTenant = await this.findTenantByAttemptId(attemptId);

    if (!linkedTenant) {
      await this.finalizeAudit(attemptId, null, ATTEMPT_STATUS_FAILED);
      return;
    }

    await this.handleProvisioningFailure(attemptId, linkedTenant.id);
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
    signal?: AbortSignal,
  ): Promise<TenantLifecycleRow> {
    this.throwIfProvisioningCancelled(signal);
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
    signal?: AbortSignal,
  ): Promise<void> {
    await this.updateAttemptSteps(attemptId, status, [outcome], signal);
  }

  private async updateAttemptSteps(
    attemptId: string,
    status: string,
    outcomes: TenantOnboardingStepOutcomeDto[],
    signal?: AbortSignal,
  ): Promise<void> {
    this.throwIfProvisioningCancelled(signal);
    await this.prisma.$transaction(async (tx) => {
      this.throwIfProvisioningCancelled(signal);
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

      // Once an attempt has reached ANY terminal state (failed, succeeded,
      // or failed-needs-manual-cleanup), a write must not silently revert
      // it back to 'provisioning' -- e.g. a stale/duplicate step-outcome
      // write racing behind the orchestrator's own finalizeAudit() call.
      // A write that is itself moving the attempt between terminal states
      // (e.g. finalizeAudit()'s failed -> failed-needs-manual-cleanup, or
      // recordProvisioningTimeout()'s own failed -> failed) is allowed
      // through.
      const isTerminal = (value: string) =>
        value === ATTEMPT_STATUS_FAILED ||
        value === ATTEMPT_STATUS_SUCCEEDED ||
        value === ATTEMPT_STATUS_FAILED_MANUAL_CLEANUP;

      if (isTerminal(attempt.status) && !isTerminal(status)) {
        return;
      }

      const stepOutcomes = outcomes.reduce(
        (current, outcome) => this.upsertStepOutcome(current, outcome),
        this.normalizeStepOutcomes(attempt.stepOutcomes),
      );

      this.throwIfProvisioningCancelled(signal);
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

  private throwIfProvisioningCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ProvisioningCancelledError(
        'Tenant provisioning lifecycle was cancelled after exceeding its job timeout.',
      );
    }
  }

  private isProvisioningCancelled(
    error: unknown,
  ): error is ProvisioningCancelledError {
    return error instanceof ProvisioningCancelledError;
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
