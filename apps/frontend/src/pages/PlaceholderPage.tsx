import { useTranslation } from 'react-i18next';
import type { FeatureModule } from '@flexi/shared-types';

export interface PlaceholderPageProps {
  moduleId: FeatureModule;
}

/**
 * One instance of this renders per feature-area route (see router.tsx).
 * Mirrors the backend stub modules' `{ status: 'not-implemented' }` response --
 * this page has no data fetching or logic, just an identity marker per module.
 */
export function PlaceholderPage({ moduleId }: PlaceholderPageProps) {
  const { t } = useTranslation();
  const label = t(`modules.${moduleId}`);

  return (
    <div>
      <h1>{label}</h1>
      <p>{t('placeholder.notImplemented')}</p>
      <p style={{ color: '#888' }}>
        {t('placeholder.description', { module: label })}
      </p>
    </div>
  );
}
