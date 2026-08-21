import { useTranslation } from 'react-i18next';
import { Button, Card, Icon, PageHeader } from '../components/ui';

export interface PermissionDeniedPageProps {
  titleKey?: string;
  descriptionKey?: string;
  permissionCode?: string;
  action?: {
    labelKey: string;
    onClick: () => void;
  };
}

export function PermissionDeniedPage({
  titleKey = 'permissionDenied.title',
  descriptionKey = 'permissionDenied.description',
  permissionCode,
  action,
}: PermissionDeniedPageProps) {
  const { t } = useTranslation();

  return (
    <>
      <PageHeader
        title={t(titleKey)}
        description={t(descriptionKey)}
        actions={
          action ? (
            <Button
              variant="secondary"
              icon="arrow_back"
              onClick={action.onClick}
            >
              {t(action.labelKey)}
            </Button>
          ) : undefined
        }
      />

      <Card className="flex flex-col items-center gap-sm py-2xl text-center">
        <div className="w-12 h-12 rounded-lg bg-error-container flex items-center justify-center text-on-error-container">
          <Icon name="lock" size={24} />
        </div>
        <p className="font-body-base text-body-base text-on-surface">
          {t('permissionDenied.body')}
        </p>
        {permissionCode && (
          <p className="font-code-sm text-code-sm text-on-surface-variant">
            {permissionCode}
          </p>
        )}
      </Card>
    </>
  );
}
