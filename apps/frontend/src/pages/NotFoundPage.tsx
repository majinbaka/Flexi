import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Icon } from '../components/ui';

/**
 * Catch-all (`path="*"`) route, rendered inside the shared Layout so the
 * sidebar stays usable when a user lands on an unmatched path.
 */
export function NotFoundPage() {
  const { t } = useTranslation();

  return (
    <Card className="flex flex-col items-center gap-sm py-2xl text-center">
      <div className="w-12 h-12 rounded-lg bg-error-container flex items-center justify-center text-on-error-container">
        <Icon name="error" size={24} />
      </div>
      <h1 className="font-headline-md text-headline-md text-on-surface">
        {t('notFound.title')}
      </h1>
      <p className="font-body-base text-body-base text-on-surface-variant">
        {t('notFound.subtitle')}
      </p>
      <Link
        to="/"
        className="font-body-sm text-body-sm font-medium text-primary hover:underline"
      >
        {t('notFound.backHome')}
      </Link>
    </Card>
  );
}
