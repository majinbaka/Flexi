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
  FORGOT_PASSWORD_REQUESTED = 'AUTH_FORGOT_PASSWORD_REQUESTED',
  PASSWORD_RESET_SUCCESS = 'AUTH_PASSWORD_RESET_SUCCESS',
  PASSWORD_RESET_FAILED = 'AUTH_PASSWORD_RESET_FAILED',
  PASSWORD_CHANGED = 'AUTH_PASSWORD_CHANGED',
  SESSION_REVOKED = 'AUTH_SESSION_REVOKED',
  ALL_SESSIONS_REVOKED = 'AUTH_ALL_SESSIONS_REVOKED',
  ACCOUNT_DEACTIVATED = 'ACCOUNT_DEACTIVATED',
  ACCOUNT_ACTIVATED = 'ACCOUNT_ACTIVATED',
  ADMIN_FORCE_PASSWORD_RESET = 'ADMIN_FORCE_PASSWORD_RESET',
}
