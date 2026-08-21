import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MODULE_NAV_ITEMS } from '../modules';
import { Card, Icon, PageHeader } from '../components/ui';

/**
 * Index route: the module directory. Each feature area gets a card linking
 * to its route, so the landing page doubles as navigation while the modules
 * themselves are still stubs.
 */
export function HomePage() {
  const { t } = useTranslation();

  return (
    <>
      <PageHeader title={t('home.welcome')} description={t('home.subtitle')} />

      <div className="grid gap-md grid-cols-[repeat(auto-fit,minmax(260px,1fr))]">
        {MODULE_NAV_ITEMS.map((item) => (
          <Link
            key={item.id}
            to={item.path}
            className="rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Card className="h-full transition-colors hover:border-primary hover:bg-surface-container-low">
              <div className="flex items-start gap-sm">
                <div className="w-10 h-10 shrink-0 rounded-lg bg-primary-fixed flex items-center justify-center text-on-primary-fixed">
                  <Icon name={item.icon} />
                </div>
                <div className="min-w-0">
                  <p className="font-body-base text-body-base font-semibold text-on-surface">
                    {t(item.labelKey)}
                  </p>
                  <p className="font-code-sm text-code-sm text-on-surface-variant truncate">
                    {item.path}
                  </p>
                </div>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
