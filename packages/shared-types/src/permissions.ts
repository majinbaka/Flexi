import { PermissionScope } from './enums';

/**
 * Permission codes and metadata that must exist in every deployed MVP
 * database. Keep route authorization and database seeding aligned by adding
 * new public permissions here before they are consumed elsewhere.
 */
export interface PermissionCatalogEntry {
  code: string;
  description: string;
  scope: PermissionScope;
}

export const TENANT_ME_READ_PERMISSION = 'auth.me.read';
export const SYSTEM_ME_READ_PERMISSION = 'system.me.read';

export const SYSTEM_TENANTS_READ_PERMISSION = 'system.tenants.read';
export const SYSTEM_TENANTS_ONBOARD_PERMISSION = 'system.tenants.onboard';
export const SYSTEM_TENANTS_SETUP_LINK_PERMISSION = 'system.tenants.setup-link';

export const DYNAMIC_TABLES_TABLES_CREATE_PERMISSION =
  'dynamic-tables.tables.create';
export const DYNAMIC_TABLES_FIELDS_UPDATE_PERMISSION =
  'dynamic-tables.fields.update';
export const DYNAMIC_TABLES_JOBS_READ_PERMISSION = 'dynamic-tables.jobs.read';
export const DYNAMIC_TABLES_ROWS_CREATE_PERMISSION =
  'dynamic-tables.rows.create';
export const DYNAMIC_TABLES_ROWS_READ_PERMISSION = 'dynamic-tables.rows.read';
export const DYNAMIC_TABLES_ROWS_UPDATE_PERMISSION =
  'dynamic-tables.rows.update';
export const DYNAMIC_TABLES_ROWS_DELETE_PERMISSION =
  'dynamic-tables.rows.delete';

/**
 * The production permission catalog. Migrations and local demo seeding use
 * this same list; the SQL migration mirrors it because migrations cannot
 * import TypeScript at deployment time.
 */
export const MVP_PERMISSION_CATALOG = [
  {
    code: TENANT_ME_READ_PERMISSION,
    description: 'Read own profile via GET /api/auth/me (TenantUser)',
    scope: PermissionScope.TENANT,
  },
  {
    code: SYSTEM_ME_READ_PERMISSION,
    description: 'Read own profile via GET /api/auth/me (SystemUser)',
    scope: PermissionScope.SYSTEM,
  },
  {
    code: SYSTEM_TENANTS_READ_PERMISSION,
    description: 'List tenant records and onboarding history as a SystemUser',
    scope: PermissionScope.SYSTEM,
  },
  {
    code: SYSTEM_TENANTS_ONBOARD_PERMISSION,
    description: 'Start tenant onboarding intake as a SystemUser',
    scope: PermissionScope.SYSTEM,
  },
  {
    code: SYSTEM_TENANTS_SETUP_LINK_PERMISSION,
    description: 'Regenerate a tenant setup link as a SystemUser',
    scope: PermissionScope.SYSTEM,
  },
  {
    code: DYNAMIC_TABLES_TABLES_CREATE_PERMISSION,
    description: 'Create Dynamic Tables tables',
    scope: PermissionScope.TENANT,
  },
  {
    code: DYNAMIC_TABLES_FIELDS_UPDATE_PERMISSION,
    description: 'Add, modify, or remove Dynamic Tables fields',
    scope: PermissionScope.TENANT,
  },
  {
    code: DYNAMIC_TABLES_JOBS_READ_PERMISSION,
    description: 'Read Dynamic Tables DDL job status',
    scope: PermissionScope.TENANT,
  },
  {
    code: DYNAMIC_TABLES_ROWS_CREATE_PERMISSION,
    description: 'Create Dynamic Tables rows',
    scope: PermissionScope.TENANT,
  },
  {
    code: DYNAMIC_TABLES_ROWS_READ_PERMISSION,
    description: 'Read Dynamic Tables rows',
    scope: PermissionScope.TENANT,
  },
  {
    code: DYNAMIC_TABLES_ROWS_UPDATE_PERMISSION,
    description: 'Update Dynamic Tables rows',
    scope: PermissionScope.TENANT,
  },
  {
    code: DYNAMIC_TABLES_ROWS_DELETE_PERMISSION,
    description: 'Delete Dynamic Tables rows',
    scope: PermissionScope.TENANT,
  },
] as const satisfies readonly PermissionCatalogEntry[];
