import { useTranslation } from 'react-i18next';
import type { FeatureModule } from '@flexi/shared-types';
import { Badge, Card, Icon, PageHeader } from '../components/ui';
import { MODULE_NAV_ITEMS } from '../modules';

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
  const navItem = MODULE_NAV_ITEMS.find((item) => item.id === moduleId);

  return (
    <>
      <PageHeader
        title={label}
        description={t('placeholder.description', { module: label })}
        actions={
          <Badge tone="warning" icon="pending">
            {t('placeholder.status')}
          </Badge>
        }
      />

      <Card className="flex flex-col items-center gap-sm py-2xl text-center">
        <div className="w-12 h-12 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant">
          <Icon name={navItem?.icon ?? 'construction'} size={24} />
        </div>
        <p className="font-body-base text-body-base text-on-surface">
          {t('placeholder.notImplemented')}
        </p>
        <p className="font-code-sm text-code-sm text-on-surface-variant">
          {moduleId}
        </p>
      </Card>
    </>
  );
}
