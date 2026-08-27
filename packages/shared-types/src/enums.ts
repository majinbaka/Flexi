/**
 * Canonical set of data types a dynamic-table field can hold.
 * This is the single source of truth consumed by both apps/backend
 * (Prisma's DynamicField.dataType is a plain string validated against this)
 * and apps/frontend (future Table/Field Builder UI - deferred).
 */
export enum FieldDataType {
  STRING = 'STRING',
  TEXT = 'TEXT',
  NUMBER = 'NUMBER',
  BOOLEAN = 'BOOLEAN',
  DATE = 'DATE',
  DATETIME = 'DATETIME',
  JSON = 'JSON',
  EMAIL = 'EMAIL',
  URL = 'URL',
  SELECT = 'SELECT',
  RELATION = 'RELATION',
}

/** Severity levels for LogEntry.level. */
export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

/**
 * Scope of a Permission: SYSTEM permissions may only be held by a Role with
 * no tenantId (a system role, assignable only to a SystemUser); TENANT
 * permissions may only be held by a Role with a tenantId set (assignable
 * only to TenantUsers of that tenant). See Permission.scope in
 * apps/backend/prisma/schema.prisma.
 */
export enum PermissionScope {
  SYSTEM = 'SYSTEM',
  TENANT = 'TENANT',
}

/** Which actor table an AuthAccount's authenticated request resolved to. */
export enum ActorType {
  SYSTEM = 'system',
  TENANT = 'tenant',
}

/**
 * The 11 planned feature-area modules. Shared between the backend
 * (route prefixes registered in AppModule) and the frontend
 * (router table + sidebar nav) so the two never drift apart.
 */
export const FEATURE_MODULES = [
  'auth',
  'tenants',
  'dynamic-tables',
  'workflows',
  'pages',
  'cron-jobs',
  'mail-templates',
  'wiki',
  'i18n',
  'settings',
  'logs',
] as const;

export type FeatureModule = (typeof FEATURE_MODULES)[number];

/**
 * Append-only audit events recorded for password recovery, session
 * revocation and account lifecycle actions (`AuthAuditLog.event` in
 * apps/backend/prisma/schema.prisma). Stored as a plain string column and
 * validated against this enum at the service layer, the same way
 * `Permission.scope` and `DynamicField.dataType` are -- one source of
 * truth shared by both apps.
 *
 * Every value is written by exactly one code path; an audit row never
 * carries the OTP, the temporary password, a token or a password hash --
 * only non-secret context (which account, which actor, why it failed).
 */
export enum AuthAuditEvent {
  IMPERSONATION_STARTED = 'AUTH_IMPERSONATION_STARTED',
  IMPERSONATION_ENDED = 'AUTH_IMPERSONATION_ENDED',
  IMPERSONATED_ACTION = 'AUTH_IMPERSONATED_ACTION',
  FORGOT_PASSWORD_REQUESTED = 'AUTH_FORGOT_PASSWORD_REQUESTED',
  PASSWORD_RESET_SUCCESS = 'AUTH_PASSWORD_RESET_SUCCESS',
  PASSWORD_RESET_FAILED = 'AUTH_PASSWORD_RESET_FAILED',
  PASSWORD_CHANGED = 'AUTH_PASSWORD_CHANGED',
  SESSION_REVOKED = 'AUTH_SESSION_REVOKED',
  ALL_SESSIONS_REVOKED = 'AUTH_ALL_SESSIONS_REVOKED',
  ACCOUNT_DEACTIVATED = 'ACCOUNT_DEACTIVATED',
  ACCOUNT_ACTIVATED = 'ACCOUNT_ACTIVATED',
  ADMIN_FORCE_PASSWORD_RESET = 'ADMIN_FORCE_PASSWORD_RESET',
  /**
   * Invite lifecycle. The subject of a `USER_INVITE_*` row is the invited
   * account, the actor the administrator who acted -- except for
   * `USER_INVITE_REDEEMED`, which the invited person performs on
   * themselves from a public endpoint, so it carries no actor. None of
   * them ever carries the raw token or its hash in `metadata`.
   */
  USER_INVITE_SENT = 'USER_INVITE_SENT',
  USER_INVITE_RESENT = 'USER_INVITE_RESENT',
  USER_INVITE_REVOKED = 'USER_INVITE_REVOKED',
  USER_INVITE_REDEEMED = 'USER_INVITE_REDEEMED',
  /**
   * Every accepted `PATCH /api/tenant-settings`, whatever it changed. The
   * actor is the administrator who wrote it; there is no subject, since
   * the row belongs to the tenant rather than to a person.
   */
  TENANT_SETTINGS_UPDATED = 'TENANT_SETTINGS_UPDATED',
  /**
   * Recorded *in addition to* `TENANT_SETTINGS_UPDATED`, and only when
   * `allowSelfRegistration` actually changed value. Opening a tenant to
   * public sign-up is the one settings change with a security consequence,
   * so it is findable by event alone rather than by parsing the metadata
   * of every settings write.
   */
  SELF_REGISTRATION_ENABLED = 'SELF_REGISTRATION_ENABLED',
  SELF_REGISTRATION_DISABLED = 'SELF_REGISTRATION_DISABLED',
  /**
   * One row per account created through `POST /api/auth/register`. Carries
   * no actor: the subject registered themselves, from a public endpoint.
   */
  USER_SELF_REGISTERED = 'USER_SELF_REGISTERED',
  /**
   * User administration (`/api/users`). The subject is the user acted on,
   * the actor the administrator who acted; neither the generated temporary
   * password nor any hash ever reaches `metadata`.
   *
   * `USER_ROLE_CHANGED` is recorded *in addition to* `USER_UPDATED`, and
   * only when the role set actually changed value -- the same pattern
   * `SELF_REGISTRATION_ENABLED` follows next to `TENANT_SETTINGS_UPDATED`.
   * A privilege change is the one user edit with a security consequence,
   * so it is findable by event alone rather than by parsing the metadata
   * of every profile write.
   */
  USER_DIRECT_CREATED = 'USER_DIRECT_CREATED',
  USER_UPDATED = 'USER_UPDATED',
  USER_ROLE_CHANGED = 'USER_ROLE_CHANGED',
  USER_APPROVED = 'USER_APPROVED',
  USER_LOCKED = 'USER_LOCKED',
  USER_UNLOCKED = 'USER_UNLOCKED',
  /** A membership was soft-deleted and its sessions were revoked. */
  USER_SOFT_DELETED = 'USER_SOFT_DELETED',
  /** A tenant membership and its tenant-local login identity were removed. */
  USER_HARD_DELETED = 'USER_HARD_DELETED',
  /**
   * Rows protected by Dynamic Tables' ownership contract moved between two
   * active tenant users as part of one hard-delete database transaction.
   */
  DATA_TRANSFERRED = 'DATA_TRANSFERRED',
}

/**
 * Lifecycle of a `TenantUser` (`TenantUser.status` in
 * apps/backend/prisma/schema.prisma). A plain string column validated
 * against this enum at the service layer, like `Permission.scope` and
 * `DynamicField.dataType` -- one source of truth shared by both apps.
 *
 * The stored spellings are lowercase because two of them
 * (`active`, `pending_setup`) already exist in provisioned databases and
 * are written by the First Admin flow; the Users specification names the
 * same states in upper case (`ACTIVE`, `PENDING_INVITE`, ...). Renaming
 * the stored values would buy nothing but a data migration, so the
 * specification's names map onto these values instead.
 *
 * `status` says where in the lifecycle a membership is; `isActive` says
 * whether it may authenticate. They are separate on purpose -- a `LOCKED`
 * user still occupies a seat and still exists to an administrator, but
 * `AuthService` refuses the login because `isActive` is false (it never
 * reads `status`). Any transition into `LOCKED` or `DELETED` must clear
 * `isActive` in the same write.
 */
export enum TenantUserStatus {
  ACTIVE = 'active',
  /** First Admin who has not yet claimed their account via a setup link. */
  PENDING_SETUP = 'pending_setup',
  /** Invited, invite not yet redeemed. */
  PENDING_INVITE = 'pending_invite',
  /** Self-registered into a tenant that requires admin approval. */
  PENDING_APPROVAL = 'pending_approval',
  /** Administratively suspended. Still occupies a seat. */
  LOCKED = 'locked',
  /** Soft-deleted. Frees its seat and never authenticates again. */
  DELETED = 'deleted',
}

/**
 * Lifecycle of a `UserInvite`. `PENDING` is the only state that holds a
 * seat, and only while `expiresAt` is still in the future -- expiry is a
 * fact about the clock, not a stored transition, so a `PENDING` row whose
 * `expiresAt` has passed is already `EXPIRED` in every rule that matters
 * and no sweeper job is required to make that true.
 */
export enum UserInviteStatus {
  PENDING = 'pending',
  USED = 'used',
  REVOKED = 'revoked',
  EXPIRED = 'expired',
}
