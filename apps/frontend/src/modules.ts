import {
  ActorType,
  DYNAMIC_TABLES_TABLES_READ_PERMISSION,
  DYNAMIC_TABLES_ROWS_READ_PERMISSION,
  SYSTEM_TENANTS_ONBOARD_PERMISSION,
  SYSTEM_TENANTS_READ_PERMISSION,
  type AuthenticatedUserDto,
  type FeatureModule,
} from '@flexi/shared-types';

export interface AccessMetadata {
  /** Actor types allowed to enter this part of the product. */
  audience: readonly ActorType[];
  /** Every permission required in addition to the actor audience. */
  requiredPermissions: readonly string[];
}

export interface ModuleNavItem extends AccessMetadata {
  id: FeatureModule;
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
const MODULE_ICONS: Record<FeatureModule, string> = {
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
