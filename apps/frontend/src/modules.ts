import { FEATURE_MODULES, type FeatureModule } from '@flexi/shared-types';

export interface ModuleNavItem {
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
 * Single source of truth for the sidebar nav + route table: one entry per
 * planned feature area, sharing the canonical id list with the backend
 * (see @flexi/shared-types#FEATURE_MODULES, which matches the 11 stub
 * NestJS modules registered in AppModule).
 */
export const MODULE_NAV_ITEMS: ModuleNavItem[] = FEATURE_MODULES.map((id) => ({
  id,
  path: `/${id}`,
  labelKey: `modules.${id}`,
  icon: MODULE_ICONS[id],
}));
