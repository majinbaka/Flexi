import {
  ActorType,
  DYNAMIC_TABLES_TABLES_READ_PERMISSION,
  DYNAMIC_TABLES_ROWS_READ_PERMISSION,
  SYSTEM_TENANTS_ONBOARD_PERMISSION,
  SYSTEM_TENANTS_READ_PERMISSION,
  TENANT_SETTINGS_MANAGE_PERMISSION,
  TENANT_USER_READ_PERMISSION,
  type AuthenticatedUserDto,
  type FeatureModule,
} from '@flexi/shared-types';

/**
 * What a navigation entry can be keyed by.
 *
 * `users` is deliberately *not* a `FeatureModule`. That list is the
 * canonical set of eleven backend feature areas shared with `AppModule`,
 * and `apps/backend/test/app.e2e-spec.ts` sweeps it expecting every id but
 * `auth` to answer the not-implemented envelope. Users administration is
 * already a real, guarded API (`/api/users`, `/api/users/invites`,
 * `/api/tenant-settings`), so adding it there would assert a twelfth stub
 * module that does not exist and break that sweep. It is a navigation
 * destination, which is exactly what this type says.
 */
export type NavItemId = FeatureModule | 'users';

export interface AccessMetadata {
  /** Actor types allowed to enter this part of the product. */
  audience: readonly ActorType[];
  /** Every permission required in addition to the actor audience. */
  requiredPermissions: readonly string[];
}

export interface ModuleNavItem extends AccessMetadata {
  id: NavItemId;
  path: string;
  /** i18next key under the "modules" namespace, resolved in Sidebar/PlaceholderPage. */
  labelKey: string;
  /** Material Symbols Outlined ligature shown beside the label in the sidebar. */
  icon: string;
}

/**
 * Material Symbols glyph per feature area, following the icon vocabulary of
 * the Stitch design system screens. Keyed by module id so adding a module to
 * FEATURE_MODULES surfaces a missing icon as a type error here rather than a
 * blank space in the sidebar.
 */
const MODULE_ICONS: Record<NavItemId, string> = {
  users: 'group',
  auth: 'lock',
  tenants: 'apartment',
  'dynamic-tables': 'database',
  workflows: 'account_tree',
  pages: 'web',
  'cron-jobs': 'schedule',
  'mail-templates': 'mail',
  wiki: 'book',
  i18n: 'translate',
  settings: 'settings',
  logs: 'receipt_long',
};

/**
 * Navigation and routes deliberately expose only MVP-ready product areas.
 * The remaining FeatureModule values describe planned backend areas, not
 * available frontend features, and must not be advertised as usable UI.
 */
export const MODULE_NAV_ITEMS: readonly ModuleNavItem[] = [
  {
    id: 'users',
    path: '/users',
    labelKey: 'modules.users',
    icon: MODULE_ICONS.users,
    audience: [ActorType.TENANT],
    requiredPermissions: [TENANT_USER_READ_PERMISSION],
  },
  {
    id: 'tenants',
    path: '/tenants',
    labelKey: 'modules.tenants',
    icon: MODULE_ICONS.tenants,
    audience: [ActorType.SYSTEM],
    requiredPermissions: [SYSTEM_TENANTS_READ_PERMISSION],
  },
  {
    id: 'dynamic-tables',
    path: '/dynamic-tables',
    labelKey: 'modules.dynamic-tables',
    icon: MODULE_ICONS['dynamic-tables'],
    audience: [ActorType.TENANT],
    requiredPermissions: [DYNAMIC_TABLES_TABLES_READ_PERMISSION],
  },
];

/** Access metadata for a sub-route that is intentionally not a nav item. */
export const TENANT_ONBOARDING_ACCESS: AccessMetadata = {
  audience: [ActorType.SYSTEM],
  requiredPermissions: [SYSTEM_TENANTS_ONBOARD_PERMISSION],
};

/** The status endpoint is a read-only System administration surface. */
export const TENANT_PROVISIONING_ACCESS: AccessMetadata = {
  audience: [ActorType.SYSTEM],
  requiredPermissions: [SYSTEM_TENANTS_READ_PERMISSION],
};

/**
 * The self-registration policy screen, a sub-route of `/users` rather than
 * a nav item of its own.
 *
 * `PATCH /api/tenant-settings` accepts a system caller holding
 * `system.settings.manage` too, but every other control on the Users
 * screens is tenant-only (seats, invites, approval), so the whole area is
 * scoped to tenant actors and this route follows it.
 */
export const USERS_SETTINGS_ACCESS: AccessMetadata = {
  audience: [ActorType.TENANT],
  requiredPermissions: [TENANT_SETTINGS_MANAGE_PERMISSION],
};

/** Row browsing requires table metadata as well as the row-read capability. */
export const DYNAMIC_TABLE_ROWS_ACCESS: AccessMetadata = {
  audience: [ActorType.TENANT],
  requiredPermissions: [
    DYNAMIC_TABLES_TABLES_READ_PERMISSION,
    DYNAMIC_TABLES_ROWS_READ_PERMISSION,
  ],
};

export function hasAccess(
  user: AuthenticatedUserDto | null | undefined,
  access: AccessMetadata,
): boolean {
  return Boolean(
    user &&
    access.audience.includes(user.actorType) &&
    access.requiredPermissions.every((permission) =>
      user.permissions.includes(permission),
    ),
  );
}

export function getAccessibleModuleNavItems(
  user: AuthenticatedUserDto | null | undefined,
): readonly ModuleNavItem[] {
  return MODULE_NAV_ITEMS.filter((item) => hasAccess(user, item));
}
