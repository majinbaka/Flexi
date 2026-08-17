import { FEATURE_MODULES, type FeatureModule } from '@flexi/shared-types';

export interface ModuleNavItem {
  id: FeatureModule;
  path: string;
  /** i18next key under the "modules" namespace, resolved in Sidebar/PlaceholderPage. */
  labelKey: string;
}

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
}));
