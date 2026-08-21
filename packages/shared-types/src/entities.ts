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
  createdAt: string;
  updatedAt: string;
}

export const TENANT_SLUG_MIN_LENGTH = 3;
export const TENANT_SLUG_MAX_LENGTH = 63;
export const TENANT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const TENANT_ONBOARDING_IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const TENANT_ONBOARDING_IDEMPOTENCY_KEY_MAX_LENGTH = 128;
export const TENANT_ONBOARDING_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export type TenantOnboardingAttemptStatus = 'accepted';

export type TenantOnboardingStepName =
  | 'permission_check'
  | 'payload_validation'
  | 'slug_availability'
  | 'attempt_reservation';

export type TenantOnboardingStepStatus = 'succeeded';

export interface TenantOnboardingStepOutcomeDto {
  step: TenantOnboardingStepName;
  status: TenantOnboardingStepStatus;
  occurredAt: string;
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

export interface TenantOnboardingAttemptDto {
  id: string;
  status: TenantOnboardingAttemptStatus;
  safePayload: TenantOnboardingSafePayloadDto;
  actorIdentity: TenantOnboardingActorIdentityDto;
  requestIdentity: TenantOnboardingRequestIdentityDto;
  idempotencyIdentity: TenantOnboardingIdempotencyIdentityDto;
  stepOutcomes: TenantOnboardingStepOutcomeDto[];
  createdAt: string;
  updatedAt: string;
}

export type TenantOnboardingField =
  | 'tenantName'
  | 'tenantSlug'
  | 'firstAdminEmail'
  | 'plan'
  | 'idempotencyKey';

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
