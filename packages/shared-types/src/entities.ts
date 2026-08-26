import { ActorType, FieldDataType, LogLevel, PermissionScope } from './enums';

/**
 * Lightweight DTOs mirroring the 14 core metadata models defined in
 * apps/backend/prisma/schema.prisma. These describe *shapes*, not
 * runtime behavior -- kept here so frontend and backend never drift
 * on field names/types for the metadata entities. Deep validation
 * (class-validator DTOs, zod schemas, etc.) is deferred to each
 * module's real implementation.
 */

export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  status: TenantLifecycleStatus;
  createdAt: string;
  updatedAt: string;
}

export const TENANT_LIFECYCLE_STATUSES = [
  'PROVISIONING',
  'ACTIVE',
  'FAILED',
  'SUSPENDED',
] as const;

export type TenantLifecycleStatus = (typeof TENANT_LIFECYCLE_STATUSES)[number];

export const TENANT_SLUG_MIN_LENGTH = 3;
export const TENANT_SLUG_MAX_LENGTH = 63;
export const TENANT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const TENANT_ONBOARDING_IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const TENANT_ONBOARDING_IDEMPOTENCY_KEY_MAX_LENGTH = 128;
export const TENANT_ONBOARDING_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
/**
 * Deliberately written so no two adjacent quantifiers can match the same
 * character: the domain is split into dot-free labels rather than the
 * simpler `[^\s@]+\.[^\s@]+`, whose `+` and `\.` both accept a dot and so
 * backtrack quadratically on a long non-matching address (CodeQL
 * js/polynomial-redos). Keep any future edit non-ambiguous the same way.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export const TENANT_ONBOARDING_PLANS = [
  'starter',
  'growth',
  'enterprise',
] as const;

export type TenantOnboardingPlan = (typeof TENANT_ONBOARDING_PLANS)[number];

export type TenantSlugAvailabilityReason = 'available' | 'already_in_use';

export interface TenantSlugAvailabilityDto {
  slug: string;
  available: boolean;
  reason: TenantSlugAvailabilityReason;
}

/**
 * One row of `GET /api/v1/super-admin/tenants` (Story 3.1). `latestAttemptStatus`
 * and `actorName` are read from the tenant's linked `TenantOnboardingAttempt`
 * (`Tenant.onboardingAttemptId` is a direct FK to exactly one attempt, so
 * "latest attempt" needs no max-by-createdAt subquery) -- both are `null`
 * when the tenant has no linked attempt, rendered as a safe placeholder by
 * the caller rather than erroring. `plan` is read from
 * `TenantOnboardingAttempt.safePayload.plan`, also `null` with no attempt.
 * Actor filtering is explicitly out of scope -- `actorName` is display-only.
 */
export interface TenantListItemDto {
  id: string;
  name: string;
  slug: string;
  status: TenantLifecycleStatus;
  plan: TenantOnboardingPlan | null;
  createdAt: string;
  latestAttemptStatus: TenantOnboardingAttemptStatus | null;
  actorName: string | null;
}

/**
 * Query params accepted by `GET /api/v1/super-admin/tenants`. All filters
 * are optional and combined with AND logic. `keyword` matches tenant `name`
 * OR `slug` (case-insensitive `contains`). `createdFrom`/`createdTo` must
 * each parse as a valid date; an inverted or unparseable range is rejected,
 * not silently ignored. `page`/`pageSize` default to 1/20; `pageSize` clamps
 * to a max of 100 (upper bound only) but a non-positive or non-integer
 * `page`/`pageSize` is rejected rather than clamped.
 */
export interface TenantListQueryDto {
  status?: TenantLifecycleStatus;
  keyword?: string;
  createdFrom?: string;
  createdTo?: string;
  page?: number;
  pageSize?: number;
}

export interface TenantListMetaDto {
  total: number;
  page: number;
  pageSize: number;
}

export interface TenantListResponseDto {
  items: TenantListItemDto[];
  meta: TenantListMetaDto;
}

export const TENANT_LIST_DEFAULT_PAGE = 1;
export const TENANT_LIST_DEFAULT_PAGE_SIZE = 20;
export const TENANT_LIST_MAX_PAGE_SIZE = 100;

/**
 * Response shape for `POST /api/v1/super-admin/tenants/:id/setup-link`
 * (Story 2.5). `setupToken` is the raw, one-time setup secret -- returned
 * exactly once here and never re-readable afterward (only its hash is
 * persisted). Deliberately excludes any constructed setup URL: no frontend
 * route exists yet to redeem the token.
 */
export interface TenantSetupLinkDto {
  tenantId: string;
  setupToken: string;
  expiresAt: string;
}

/**
 * Public body for claiming a First Admin account through a one-time setup
 * link. The token is supplied only for this request; callers must never
 * persist or display it after reading it from the setup-link URL.
 */
export interface RedeemSetupTokenRequestDto {
  token: string;
  password: string;
}

/**
 * Public success response for setup-token redemption. It intentionally
 * contains no tenant, account, or session information: the user signs in
 * through the normal tenant login flow after setting their password.
 */
export interface RedeemSetupTokenResponseDto {
  status: 'completed';
}

export type TenantOnboardingAttemptStatus =
  | 'accepted'
  | 'provisioning'
  | 'failed'
  | 'succeeded'
  | 'failed-needs-manual-cleanup';

export type TenantOnboardingStepName =
  | 'permission_check'
  | 'payload_validation'
  | 'slug_availability'
  | 'attempt_reservation'
  | 'provisioning_start'
  | 'tenant_creation'
  | 'schema_created'
  | 'bootstrap_migrated'
  | 'bootstrap_seeded'
  | 'first_admin_assigned'
  | 'setup_link_generated'
  | 'setup_email_sent'
  | 'activation'
  | 'audit_finalized';

export type TenantOnboardingStepStatus = 'running' | 'succeeded' | 'failed';

export interface TenantOnboardingStepOutcomeDto {
  step: TenantOnboardingStepName;
  status: TenantOnboardingStepStatus;
  occurredAt: string;
  tenantId?: string;
  tenantSlug?: string;
  tenantStatus?: TenantLifecycleStatus;
  errorCode?: string;
  message?: string;
}

/**
 * One best-effort compensation sub-step's outcome (Story 2.6), recorded in
 * `TenantOnboardingAuditLogDto.compensation` when a required provisioning
 * step (1-6) fails. `action` names the compensation performed (e.g.
 * `revoke_setup_tokens`, `deactivate_first_admin`, `drop_tenant_schema`);
 * `status: 'skipped'` covers a sub-step deliberately not attempted because
 * its corresponding forward step never succeeded (e.g. schema drop is
 * skipped if `schema_created` itself failed). Only safe identifiers/detail
 * ever appear in `detail` -- never a raw error message, stack trace, or
 * raw SQL.
 */
export interface TenantOnboardingCompensationOutcomeDto {
  step: TenantOnboardingStepName;
  action: string;
  status: 'succeeded' | 'failed' | 'skipped';
  detail?: string;
}

/**
 * Permanent, append-only audit row mirroring the `TenantOnboardingAuditLog`
 * Prisma model (Story 2.6). Written exactly once per attempt via an
 * `attemptId`-keyed upsert (idempotent against a full-job BullMQ retry);
 * never updated or deleted after its terminal content is first persisted.
 * Excludes plaintext passwords, plaintext setup tokens, secrets, stack
 * traces, and raw SQL -- the same safe/redacted shape already used by
 * `TenantOnboardingStepOutcomeDto`.
 */
export interface TenantOnboardingAuditLogDto {
  attemptId: string;
  /**
   * Null on the `recordProvisioningTimeout()` no-linked-tenant path
   * (matches the nullable `TenantOnboardingAuditLog.tenantId` Prisma
   * column: a timeout can fire before a tenant is ever created).
   */
  tenantId?: string | null;
  actorIdentity: TenantOnboardingActorIdentityDto;
  requestIdentity: TenantOnboardingRequestIdentityDto;
  safePayload: TenantOnboardingSafePayloadDto;
  stepOutcomes: TenantOnboardingStepOutcomeDto[];
  compensation?: TenantOnboardingCompensationOutcomeDto[];
  finalStatus: TenantOnboardingAttemptStatus;
  createdAt: string;
}

export interface TenantOnboardingCreateRequestDto {
  tenantName: string;
  tenantSlug: string;
  firstAdminEmail: string;
  plan: TenantOnboardingPlan;
  idempotencyKey?: string;
}

export interface TenantOnboardingSafePayloadDto {
  tenantName: string;
  tenantSlug: string;
  firstAdminEmail: string;
  plan: TenantOnboardingPlan;
}

export interface TenantOnboardingActorIdentityDto {
  actorType: ActorType.SYSTEM;
  authAccountId: string;
  systemUserId: string;
  email: string;
  name: string | null;
  roles: string[];
  permissions: string[];
}

export interface TenantOnboardingRequestIdentityDto {
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface TenantOnboardingIdempotencyIdentityDto {
  key: string;
  source: 'header' | 'body';
}

export interface TenantOnboardingIdempotencyOutcomeDto {
  replayed: boolean;
  existingAttemptId?: string;
}

export interface TenantOnboardingAttemptDto {
  id: string;
  status: TenantOnboardingAttemptStatus;
  safePayload: TenantOnboardingSafePayloadDto;
  actorIdentity: TenantOnboardingActorIdentityDto;
  requestIdentity: TenantOnboardingRequestIdentityDto;
  idempotencyIdentity: TenantOnboardingIdempotencyIdentityDto;
  idempotencyOutcome: TenantOnboardingIdempotencyOutcomeDto;
  stepOutcomes: TenantOnboardingStepOutcomeDto[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Read-only, redacted evidence that a provisioning attempt reached a
 * terminal state. This deliberately excludes the full audit payload: actor
 * and request identities, the original request/idempotency key, raw errors,
 * and any data that could be mistaken for a credential do not belong on a
 * progress-polling endpoint.
 */
export interface TenantOnboardingAuditSummaryDto {
  finalStatus: TenantOnboardingAttemptStatus;
  recordedAt: string;
  compensation?: Array<
    Pick<TenantOnboardingCompensationOutcomeDto, 'step' | 'action' | 'status'>
  >;
}

/**
 * The System-only projection used to poll one onboarding attempt. Unlike
 * `TenantOnboardingAttemptDto`, this omits intake/audit identities and only
 * exposes the safe status timeline needed to render provisioning progress.
 */
export interface TenantOnboardingAttemptStatusDto {
  id: string;
  status: TenantOnboardingAttemptStatus;
  stepOutcomes: TenantOnboardingStepOutcomeDto[];
  audit: TenantOnboardingAuditSummaryDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface TenantOnboardingIdempotencyConflictErrorResponseDto {
  success: false;
  data: null;
  error: {
    code: 'IDEMPOTENCY_CONFLICT';
    message: string;
    existingAttemptId: string;
  };
}

export type TenantOnboardingField =
  'tenantName' | 'tenantSlug' | 'firstAdminEmail' | 'plan' | 'idempotencyKey';

export type TenantOnboardingValidationErrorCode =
  | 'TENANT_NAME_REQUIRED'
  | 'SLUG_REQUIRED'
  | 'SLUG_FORMAT'
  | 'EMAIL_REQUIRED'
  | 'EMAIL_FORMAT'
  | 'PLAN_REQUIRED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_FORMAT';

export type TenantOnboardingValidationErrors = Partial<
  Record<TenantOnboardingField, TenantOnboardingValidationErrorCode>
>;

export interface TenantOnboardingValidationErrorResponseDto {
  success: false;
  data: null;
  error: {
    code: 'VALIDATION_ERROR';
    message: string;
    fields: TenantOnboardingValidationErrors;
  };
}

export interface TenantOnboardingValidationInput {
  tenantName: string;
  tenantSlug: string;
  firstAdminEmail: string;
  plan: string;
}

export function isTenantSlugFormatValid(slug: string): boolean {
  return (
    slug.length >= TENANT_SLUG_MIN_LENGTH &&
    slug.length <= TENANT_SLUG_MAX_LENGTH &&
    TENANT_SLUG_PATTERN.test(slug) &&
    !slug.includes('--')
  );
}

export function isTenantOnboardingIdempotencyKeyValid(key: string): boolean {
  return (
    key.length >= TENANT_ONBOARDING_IDEMPOTENCY_KEY_MIN_LENGTH &&
    key.length <= TENANT_ONBOARDING_IDEMPOTENCY_KEY_MAX_LENGTH &&
    TENANT_ONBOARDING_IDEMPOTENCY_KEY_PATTERN.test(key)
  );
}

export function validateTenantOnboardingInput(
  input: TenantOnboardingValidationInput,
): TenantOnboardingValidationErrors {
  const errors: TenantOnboardingValidationErrors = {};
  const tenantName = input.tenantName.trim();
  const tenantSlug = input.tenantSlug.trim();
  const firstAdminEmail = input.firstAdminEmail.trim();

  if (!tenantName) {
    errors.tenantName = 'TENANT_NAME_REQUIRED';
  }

  if (!tenantSlug) {
    errors.tenantSlug = 'SLUG_REQUIRED';
  } else if (!isTenantSlugFormatValid(tenantSlug)) {
    errors.tenantSlug = 'SLUG_FORMAT';
  }

  if (!firstAdminEmail) {
    errors.firstAdminEmail = 'EMAIL_REQUIRED';
  } else if (!EMAIL_PATTERN.test(firstAdminEmail)) {
    errors.firstAdminEmail = 'EMAIL_FORMAT';
  }

  if (!TENANT_ONBOARDING_PLANS.includes(input.plan as TenantOnboardingPlan)) {
    errors.plan = 'PLAN_REQUIRED';
  }

  return errors;
}

/**
 * Login identity only. Deliberately excludes `passwordHash` -- never
 * returned to a client. `email` carries no implied global-uniqueness: the
 * same address may back independent AuthAccount rows in different tenants
 * or as a SystemUser. See Permission.scope / AuthAccount comments in
 * apps/backend/prisma/schema.prisma.
 */
export interface AuthAccountDto {
  id: string;
  email: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Platform-level actor (e.g. Super Admin) -- not scoped to any tenant. */
export interface SystemUserDto {
  id: string;
  authAccountId: string;
  name: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Tenant-scoped actor -- replaces the prior flat `User` model. */
export interface TenantUserDto {
  id: string;
  tenantId: string;
  authAccountId: string;
  name: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoleDto {
  id: string;
  /** null marks a system-level role (assignable only to a SystemUser). */
  tenantId: string | null;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionDto {
  id: string;
  code: string;
  description: string | null;
  scope: PermissionScope;
  createdAt: string;
}

export interface RolePermissionDto {
  id: string;
  roleId: string;
  permissionId: string;
}

export interface DynamicTableDto {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DynamicFieldDto {
  id: string;
  tenantId: string;
  tableId: string;
  name: string;
  slug: string;
  dataType: FieldDataType;
  required: boolean;
  config: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Runtime Dynamic Tables metadata is stored per tenant schema in
 * `_meta_tables`, rather than in Prisma's legacy `DynamicTable` model.
 *
 * `DynamicTableDto` and `DynamicFieldDto` above deliberately remain the
 * Prisma-model DTOs for backwards compatibility. New Dynamic Tables API
 * consumers must use the `DynamicTable*` contracts below, which have no
 * `tenantId`: tenant isolation is supplied by the authenticated context and
 * the `_meta_*` rows do not contain that column.
 */
export interface DynamicTableCatalogItemDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One `_meta_fields` definition exposed by a Dynamic Table detail API. */
export interface DynamicTableFieldDefinitionDto {
  id: string;
  tableId: string;
  name: string;
  slug: string;
  dataType: FieldDataType;
  required: boolean;
  /** The `_meta_tables.id` targeted by a RELATION field, otherwise null. */
  relationTargetTableId: string | null;
  config: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** A catalog entry plus every field required to build a table/row form. */
export interface DynamicTableDetailDto extends DynamicTableCatalogItemDto {
  fields: DynamicTableFieldDefinitionDto[];
}

export interface DynamicTableCatalogQueryDto {
  page?: number;
  pageSize?: number;
}

export interface DynamicTableCatalogPageDto {
  items: DynamicTableCatalogItemDto[];
  meta: {
    total: number;
    page: number;
    pageSize: number;
  };
}

/** Safe, public DDL job status -- intentionally excludes BullMQ job data. */
export interface DynamicTableDdlJobDto {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error: string | null;
}

/** Returned when a Dynamic Tables DDL mutation is accepted for processing. */
export interface DynamicTableDdlJobAcceptedDto {
  jobId: string;
}

/** A runtime row's fields vary by its table's `_meta_fields` definitions. */
export type DynamicTableRowDto = Record<string, unknown>;

export type DynamicTableRowSortDirection = 'asc' | 'desc';

/**
 * Query shape for server-side row browsing. `sortBy` and every key in
 * `filters` are validated by the backend against that table's metadata.
 */
export interface DynamicTableRowQueryDto {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDirection?: DynamicTableRowSortDirection;
  filters?: Record<string, unknown>;
}

export interface DynamicTableRowPageDto {
  items: DynamicTableRowDto[];
  meta: {
    total: number;
    page: number;
    pageSize: number;
  };
}

/** Payload returned after a successful create or update row mutation. */
export interface DynamicTableRowMutationResultDto {
  row: DynamicTableRowDto;
}

export interface WorkflowDto {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  status: string;
  definition: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface PageDto {
  id: string;
  tenantId: string;
  name: string;
  path: string;
  status: string;
  definition: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface CronJobDto {
  id: string;
  tenantId: string;
  name: string;
  schedule: string;
  targetRef: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MailTemplateDto {
  id: string;
  tenantId: string;
  name: string;
  subject: string;
  body: string;
  variables: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WikiPageDto {
  id: string;
  tenantId: string;
  title: string;
  slug: string;
  content: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LogEntryDto {
  id: string;
  tenantId: string | null;
  level: LogLevel;
  message: string;
  context: Record<string, unknown> | null;
  createdAt: string;
}

export interface TranslationDto {
  id: string;
  locale: string;
  namespace: string;
  key: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Auth response shapes -- shared between backend and future frontend.
// ---------------------------------------------------------------------------

/** Returned once by login/refresh. Never persisted or logged in plaintext. */
export interface AuthTokensDto {
  accessToken: string;
  refreshToken: string;
  /** Access token lifetime in seconds. */
  expiresIn: number;
}

/**
 * Shape of the caller resolved by JwtAuthGuard from a decoded access token,
 * and returned by GET /api/auth/me. Fields present depend on `actorType`:
 * a tenant actor carries tenantId + tenantUserId, a system actor carries
 * systemUserId.
 */
export interface AuthenticatedUserDto {
  authAccountId: string;
  actorType: ActorType;
  tenantId?: string;
  tenantUserId?: string;
  systemUserId?: string;
  email: string;
  name: string | null;
  roles: string[];
  permissions: string[];
}
