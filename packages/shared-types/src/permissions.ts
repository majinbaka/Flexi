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

/**
 * Session revocation, user activation/deactivation and admin force-reset
 * each exist as a TENANT/SYSTEM *pair* of codes rather than one shared
 * code. That is forced by the scope invariant `Permission.scope` encodes
 * (a tenant Role can never hold a SYSTEM permission, and vice versa --
 * enforced wherever a RolePermission link is created), so a single code
 * usable by both actor types is not representable. The service picks the
 * code by `actorType`, exactly as `GET /api/auth/me` already picks between
 * `auth.me.read` and `system.me.read`.
 *
 * Where the authentication specification names only the tenant-side code
 * (`auth.session.manage`, `admin.account.reset_password`), that code keeps
 * its spelling and the SYSTEM counterpart is added alongside it.
 */
export const TENANT_SESSION_MANAGE_PERMISSION = 'auth.session.manage';
export const SYSTEM_SESSION_MANAGE_PERMISSION = 'system.session.manage';

export const TENANT_USER_MANAGE_PERMISSION = 'tenant.user.manage';
export const SYSTEM_USER_MANAGE_PERMISSION = 'system.user.manage';

export const TENANT_ACCOUNT_RESET_PASSWORD_PERMISSION =
  'admin.account.reset_password';
export const SYSTEM_ACCOUNT_RESET_PASSWORD_PERMISSION =
  'system.account.reset_password';

export const DYNAMIC_TABLES_TABLES_CREATE_PERMISSION =
  'dynamic-tables.tables.create';
export const DYNAMIC_TABLES_TABLES_READ_PERMISSION =
  'dynamic-tables.tables.read';
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
    code: TENANT_SESSION_MANAGE_PERMISSION,
    description: 'Revoke own or managed TenantUser sessions',
    scope: PermissionScope.TENANT,
  },
  {
    code: SYSTEM_SESSION_MANAGE_PERMISSION,
    description: 'Revoke own or managed SystemUser sessions',
    scope: PermissionScope.SYSTEM,
  },
  {
    code: TENANT_USER_MANAGE_PERMISSION,
    description: 'Activate or deactivate TenantUsers of the caller tenant',
    scope: PermissionScope.TENANT,
  },
  {
    code: SYSTEM_USER_MANAGE_PERMISSION,
    description: 'Activate or deactivate SystemUsers',
    scope: PermissionScope.SYSTEM,
  },
  {
    code: TENANT_ACCOUNT_RESET_PASSWORD_PERMISSION,
    description: 'Force a password reset on a TenantUser of the caller tenant',
    scope: PermissionScope.TENANT,
  },
  {
    code: SYSTEM_ACCOUNT_RESET_PASSWORD_PERMISSION,
    description: 'Force a password reset on a SystemUser',
    scope: PermissionScope.SYSTEM,
  },
  {
    code: DYNAMIC_TABLES_TABLES_CREATE_PERMISSION,
    description: 'Create Dynamic Tables tables',
    scope: PermissionScope.TENANT,
  },
  {
    code: DYNAMIC_TABLES_TABLES_READ_PERMISSION,
    description: 'Read Dynamic Tables table metadata',
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
