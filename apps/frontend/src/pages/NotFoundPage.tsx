import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/**
 * Catch-all (`path="*"`) route, rendered inside the shared Layout so the
 * sidebar stays usable when a user lands on an unmatched path.
 */
export function NotFoundPage() {
  const { t } = useTranslation();

  return (
    <div>
      <h1>{t('notFound.title')}</h1>
      <p>{t('notFound.subtitle')}</p>
      <p>
        <Link to="/">{t('notFound.backHome')}</Link>
      </p>
    </div>
  );
}
