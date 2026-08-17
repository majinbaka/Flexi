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
