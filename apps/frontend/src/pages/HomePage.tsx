import { useTranslation } from 'react-i18next';

export function HomePage() {
  const { t } = useTranslation();

  return (
    <div>
      <h1>{t('home.welcome')}</h1>
      <p>{t('home.subtitle')}</p>
    </div>
  );
}
