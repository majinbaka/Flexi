import {
  ActorType,
  FieldDataType,
  LogLevel,
  PermissionScope,
  TenantUserStatus,
  UserInviteStatus,
} from './enums';

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

/**
 * Every onboarding-attempt status, as a const array so the runtime
 * allowlist and the type stay one declaration (same pattern as
 * `TENANT_LIFECYCLE_STATUSES`): a new status added here is immediately
 * accepted by every validator that reads it, instead of being silently
 * rejected by a hand-copied array that TypeScript cannot check.
 */
export const TENANT_ONBOARDING_ATTEMPT_STATUSES = [
  'accepted',
  'provisioning',
  'failed',
  'succeeded',
  'failed-needs-manual-cleanup',
] as const;

export type TenantOnboardingAttemptStatus =
  (typeof TENANT_ONBOARDING_ATTEMPT_STATUSES)[number];

/**
 * Every onboarding step name, in workflow order. Const array for the same
 * reason as `TENANT_ONBOARDING_ATTEMPT_STATUSES`: the sanitizer that drops
 * unknown steps from a stored audit record reads this exact list.
 */
export const TENANT_ONBOARDING_STEP_NAMES = [
  'permission_check',
  'payload_validation',
  'slug_availability',
  'attempt_reservation',
  'provisioning_start',
  'tenant_creation',
  'schema_created',
  'bootstrap_migrated',
  'bootstrap_seeded',
  'first_admin_assigned',
  'setup_link_generated',
  'setup_email_sent',
  'activation',
  'audit_finalized',
] as const;

export type TenantOnboardingStepName =
  (typeof TENANT_ONBOARDING_STEP_NAMES)[number];

/**
 * Every compensation sub-step action a failed provisioning run can record.
 * Shared by the writer (`TenantProvisioningService.runCompensation()`) and
 * the reader that sanitizes stored audit rows, so both move together.
 */
export const TENANT_ONBOARDING_COMPENSATION_ACTIONS = [
  'revoke_setup_tokens',
  'deactivate_first_admin',
  'drop_tenant_schema',
] as const;

export type TenantOnboardingCompensationAction =
  (typeof TENANT_ONBOARDING_COMPENSATION_ACTIONS)[number];

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
  action: TenantOnboardingCompensationAction;
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
  /**
   * Id of the `RefreshToken` row this access token was issued alongside --
   * the caller's own session. Present on every token issued after the
   * session-management work landed; optional so an access token minted by
   * an older build stays decodable for the rest of its (<= 15 minute)
   * lifetime. `POST /api/auth/sessions/revoke-all` reads it to honour
   * `keepCurrent`, and `DELETE /api/auth/sessions/:sessionId` reads it to
   * tell a self-revoke from revoking somebody else's session.
   */
  sessionId?: string;
  /**
   * Mirrors `AuthAccount.mustChangePassword` at token-issuance time. Set by
   * an admin force-reset; the holder must call
   * `POST /api/auth/change-password` before the flag clears. Only advisory
   * on the access token -- the authoritative value is re-read from the
   * database by the change-password path itself.
   */
  mustChangePassword?: boolean;
}

// ---------------------------------------------------------------------------
// Password policy -- one definition shared by the backend DTO validators and
// the frontend forms, so the two never disagree about what a strong password
// is. Deliberately a set of independent character-class checks rather than
// one combined regex: a single pattern with several `.*` lookaheads is both
// unreadable and a polynomial-backtracking risk (see EMAIL_PATTERN above).
// ---------------------------------------------------------------------------

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_SPECIAL_CHARACTERS = '!@#$%^&*()_+-=[]{};\':"\\|,.<>/?~`';

export const PASSWORD_POLICY_VIOLATIONS = [
  'TOO_SHORT',
  'TOO_LONG',
  'MISSING_LOWERCASE',
  'MISSING_UPPERCASE',
  'MISSING_DIGIT',
  'MISSING_SPECIAL',
] as const;

export type PasswordPolicyViolation =
  (typeof PASSWORD_POLICY_VIOLATIONS)[number];

/**
 * Returns every policy rule `password` breaks, in a stable order; an empty
 * array means the password is acceptable. Returning the full list (rather
 * than the first failure) lets a form show all remaining requirements at
 * once instead of making the user discover them one submit at a time.
 */
export function validatePasswordStrength(
  password: string,
): PasswordPolicyViolation[] {
  const violations: PasswordPolicyViolation[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    violations.push('TOO_SHORT');
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    violations.push('TOO_LONG');
  }
  if (!/[a-z]/.test(password)) {
    violations.push('MISSING_LOWERCASE');
  }
  if (!/[A-Z]/.test(password)) {
    violations.push('MISSING_UPPERCASE');
  }
  if (!/[0-9]/.test(password)) {
    violations.push('MISSING_DIGIT');
  }
  if (
    ![...password].some((char) => PASSWORD_SPECIAL_CHARACTERS.includes(char))
  ) {
    violations.push('MISSING_SPECIAL');
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Password recovery, session revocation and account lifecycle
// ---------------------------------------------------------------------------

/** Length of the emailed password-reset code. Digits only, zero-padded. */
export const PASSWORD_RESET_OTP_LENGTH = 6;
/** How long a freshly issued reset code stays usable. */
export const PASSWORD_RESET_OTP_TTL_SECONDS = 5 * 60;
/** Minimum gap between two `POST /api/auth/forgot-password` calls for one account. */
export const PASSWORD_RESET_OTP_COOLDOWN_SECONDS = 60;
/** Wrong-code submissions tolerated before the code is burned outright. */
export const PASSWORD_RESET_OTP_MAX_ATTEMPTS = 3;

/** Body of `POST /api/auth/forgot-password`. */
export interface ForgotPasswordRequestDto {
  email: string;
}

/**
 * Response of `POST /api/auth/forgot-password`. Deliberately contentless
 * and identical whether or not the address belongs to an account -- the
 * endpoint always answers `200`, so it can never be used to enumerate
 * registered emails.
 */
export type ForgotPasswordResponseDto = Record<string, never>;

/** Body of `POST /api/auth/reset-password`. */
export interface ResetPasswordRequestDto {
  email: string;
  otp: string;
  newPassword: string;
}

export type ResetPasswordResponseDto = Record<string, never>;

/** Body of `POST /api/auth/change-password`. */
export interface ChangePasswordRequestDto {
  currentPassword: string;
  newPassword: string;
}

export type ChangePasswordResponseDto = Record<string, never>;

/**
 * One live session in `GET /api/auth/sessions`. Deliberately carries no
 * token and no token hash: the list exists so a holder can recognise and
 * kill a session, which needs only its id and its timestamps.
 */
export interface AuthSessionDto {
  /** `RefreshToken.id` -- the id `DELETE /api/auth/sessions/:sessionId` takes. */
  id: string;
  createdAt: string;
  expiresAt: string;
  /** True for the session whose access token made this request. */
  current: boolean;
}

/** Response of `GET /api/auth/sessions`. */
export interface ListSessionsResponseDto {
  sessions: AuthSessionDto[];
}

/** Body of `POST /api/auth/sessions/revoke-all`. */
export interface RevokeAllSessionsRequestDto {
  /** Keep the refresh token of the session making this request alive. */
  keepCurrent?: boolean;
}

/** Response of both session-revocation endpoints. */
export interface RevokeSessionsResponseDto {
  /** How many still-live refresh tokens this call actually revoked. */
  revokedCount: number;
}

/** Response of the account activate/deactivate endpoints. */
export interface AccountLifecycleResponseDto {
  userId: string;
  actorType: ActorType;
  isActive: boolean;
  /** Refresh tokens revoked as a side effect (always 0 when activating). */
  revokedSessionCount: number;
}

/** Body of `POST /api/admin/users/:userId/force-reset-password`. */
export interface ForceResetPasswordRequestDto {
  /** Email the temporary password to the account holder. Defaults to true. */
  sendEmail?: boolean;
}

/**
 * Response of `POST /api/admin/users/:userId/force-reset-password`. Never
 * carries the generated temporary password -- it only ever leaves the
 * server through the email transport, so a caller who is not the account
 * holder cannot read it from an API response, a log line or an audit row.
 */
export interface ForceResetPasswordResponseDto {
  userId: string;
  mustChangePassword: true;
  revokedSessionCount: number;
  emailDelivered: boolean;
}

/**
 * Stable error codes for the password-recovery / session / lifecycle
 * endpoints. Frontend code branches on these instead of matching message
 * text, which is server-authored and not translated.
 */
export const AUTH_ERROR_CODES = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  /**
   * Returned by every failing `reset-password` condition alike -- wrong
   * code, expired code, no code outstanding, unknown email, attempt budget
   * exhausted. Collapsing them is what stops the endpoint from confirming
   * which emails have an account or a live code.
   */
  INVALID_OTP: 'INVALID_OTP',
  /** The actor behind a valid refresh token has since been deactivated. */
  ACTOR_INACTIVE: 'ACTOR_INACTIVE',
  PASSWORD_POLICY_VIOLATION: 'PASSWORD_POLICY_VIOLATION',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
} as const;

export type AuthErrorCode =
  (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

/**
 * Stable error codes for the Users endpoints (invites, self-registration,
 * user administration and deletion). Same contract as
 * `AUTH_ERROR_CODES`: the frontend branches on the code, never on the
 * server-authored message text.
 *
 * The spellings come from the Users specification and are not repeated
 * from `AUTH_ERROR_CODES` -- where a condition already has an auth code
 * (`USER_NOT_FOUND`, `PASSWORD_POLICY_VIOLATION`), that code is reused
 * rather than duplicated here.
 */
export const USER_ERROR_CODES = {
  /** The tenant has no free seat left. Nothing is written. */
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  /** Self-registration email is outside the tenant's domain whitelist. */
  DOMAIN_NOT_ALLOWED: 'DOMAIN_NOT_ALLOWED',
  /** The tenant has self-registration turned off. */
  SELF_REG_DISABLED: 'SELF_REG_DISABLED',
  /** Another non-deleted user of the same tenant already has this email. */
  EMAIL_ALREADY_EXISTS: 'EMAIL_ALREADY_EXISTS',
  /**
   * Returned by every failing invite redemption alike -- unknown, expired,
   * revoked or already-used token -- so the endpoint cannot be used to
   * probe which invites exist.
   */
  INVITE_TOKEN_EXPIRED: 'INVITE_TOKEN_EXPIRED',
  /**
   * No invite with this id belongs to the caller's tenant. Distinct from
   * `INVITE_TOKEN_EXPIRED`, and safely so: the administrative routes are
   * addressed by id and sit behind `tenant.user.invite`, so telling the
   * holder of that permission that an id is unknown to their own tenant
   * discloses nothing. The public redemption route says nothing of the
   * kind.
   */
  INVITE_NOT_FOUND: 'INVITE_NOT_FOUND',
  /**
   * The invite has already been used or revoked, so it can no longer be
   * resent or revoked. An expired invite is still `pending` and can be
   * resent -- that is what resend is for.
   */
  INVITE_NOT_PENDING: 'INVITE_NOT_PENDING',
  /** An administrator tried to delete their own account. */
  CANNOT_DELETE_SELF: 'CANNOT_DELETE_SELF',
  /**
   * The ownership-transfer target is not active, belongs to another
   * tenant, or is the user being deleted.
   */
  INVALID_TARGET_USER: 'INVALID_TARGET_USER',
} as const;

export type UserErrorCode =
  (typeof USER_ERROR_CODES)[keyof typeof USER_ERROR_CODES];

/**
 * Seat usage of one tenant, as computed by the backend's
 * `UserQuotaService`. Surfaced on the Users screen next to the invite
 * action so an administrator can see how much room is left before the API
 * refuses with `QUOTA_EXCEEDED`.
 */
export interface TenantSeatUsageDto {
  /** Seats currently held. See `UserQuotaService` for what counts. */
  usedSeats: number;
  /** `Tenant.maxUsers`. `-1` means unlimited. */
  maxUsers: number;
  /** `null` when `maxUsers` is `-1` (unlimited), otherwise never negative. */
  remainingSeats: number | null;
  unlimited: boolean;
}

// ---------------------------------------------------------------------------
// User invites
// ---------------------------------------------------------------------------

/**
 * How long a freshly minted invite token stays redeemable. Exported so the
 * invitation email, the accept-invite screen and the backend all quote the
 * same number.
 */
export const USER_INVITE_TTL_HOURS = 72;

/** Frontend route the invitation email links to, with `?token=...`. */
export const USER_INVITE_ACCEPT_PATH = '/accept-invite';

/**
 * One invite as an administrator sees it. Deliberately carries neither the
 * raw token nor its hash: the hash never leaves the database, and the raw
 * token exists only in the response of the call that minted it
 * (`CreatedUserInviteDto`).
 */
export interface UserInviteDto {
  id: string;
  tenantId: string;
  /** The address the invitation was sent to, as stored at invite time. */
  email: string;
  roleId: string | null;
  roleName: string | null;
  /** The `TenantUser` row held for the invitee while the invite is live. */
  tenantUserId: string | null;
  /**
   * Derived, not merely copied: a `pending` row whose `expiresAt` has
   * passed reports `expired`, because expiry is a fact about the clock
   * rather than a stored transition (see `UserInviteStatus`).
   */
  status: UserInviteStatus;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  invitedById: string | null;
  createdAt: string;
}

/**
 * An invite plus the one thing that is readable exactly once: the raw
 * token, returned only by the call that created or resent it. Only the
 * SHA-256 hash is persisted, so no later call -- and no database read --
 * can recover it; the invitee's copy arrives by email.
 */
export interface CreatedUserInviteDto extends UserInviteDto {
  inviteToken: string;
  /** The full `/accept-invite?token=...` URL that was emailed. */
  acceptUrl: string;
  /**
   * Whether the invitation email actually went out. A failed delivery does
   * not fail the request -- the invite exists and can be resent -- so the
   * caller is told rather than left to assume.
   */
  emailDelivered: boolean;
}

/** Response of `POST /api/users/invites`. */
export interface InviteUsersResponseDto {
  invites: CreatedUserInviteDto[];
  /** Seat usage after the batch, so the UI need not re-fetch it. */
  seatUsage: TenantSeatUsageDto;
}

/** Public body for claiming an invited account. */
export interface RedeemUserInviteRequestDto {
  token: string;
  fullName: string;
  password: string;
  confirmPassword: string;
}

/**
 * Response of `POST /api/users/invites/redeem`. Carries no session: the
 * invitee signs in normally with the password they just chose, so the
 * public endpoint never mints a token of its own.
 */
export interface RedeemUserInviteResponseDto {
  tenantId: string;
  userId: string;
  email: string;
  status: TenantUserStatus;
}

// ---------------------------------------------------------------------------
// Tenant settings and self-registration
// ---------------------------------------------------------------------------

/**
 * One tenant's self-registration policy, as `GET /api/tenant-settings`
 * reports it.
 *
 * Every field has a value even for a tenant that has never written any
 * settings: the `tenant_settings` row is created on first write, and until
 * then the column defaults are reported instead. That is not a placeholder
 * -- "no row" and "a row holding the defaults" mean exactly the same thing
 * everywhere, and the defaults are the closed policy (registration off,
 * approval required), so a missing row can never be the permissive case.
 */
export interface TenantSettingsDto {
  tenantId: string;
  /** Master switch for `POST /api/auth/register`. Off by default. */
  allowSelfRegistration: boolean;
  /**
   * Bare domains, lowercased and without the `@` (e.g. `acme.com`). An
   * empty list does not close registration -- it means "any domain"; the
   * whitelist only ever narrows.
   */
  allowedEmailDomains: string[];
  /**
   * Role granted to a self-registered user. `null` is refused at
   * registration time rather than granting nothing, so enabling
   * registration without choosing a role leaves the tenant closed rather
   * than open with role-less accounts arriving in it.
   */
  defaultRoleId: string | null;
  defaultRoleName: string | null;
  /** `true` lands a registrant in `pending_approval` instead of `active`. */
  requireApproval: boolean;
  /**
   * Whether a `tenant_settings` row exists yet. `false` means what is
   * being reported are the platform defaults, which behave identically --
   * it is there so the UI can say "not configured" rather than imply the
   * tenant chose this policy.
   */
  configured: boolean;
  /** `null` while `configured` is false. */
  updatedAt: string | null;
}

/**
 * Body of `PATCH /api/tenant-settings`. Every field is optional and only
 * the ones present are written; `defaultRoleId: null` explicitly clears
 * the role, which is different from omitting it.
 */
export interface UpdateTenantSettingsRequestDto {
  allowSelfRegistration?: boolean;
  allowedEmailDomains?: string[];
  defaultRoleId?: string | null;
  requireApproval?: boolean;
}

/** Public body of `POST /api/auth/register`. */
export interface SelfRegisterRequestDto {
  email: string;
  fullName: string;
  password: string;
  confirmPassword: string;
}

/**
 * Response of `POST /api/auth/register`. Carries no session, for the same
 * reason invite redemption does not: the account may not even be allowed
 * to authenticate yet, and one that is signs in normally with the password
 * it just chose.
 */
export interface SelfRegisterResponseDto {
  tenantId: string;
  userId: string;
  email: string;
  /** `active`, or `pending_approval` when the tenant reviews sign-ups. */
  status: TenantUserStatus;
  /** `true` when an administrator has to approve before the account works. */
  requiresApproval: boolean;
}
