import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { MODULE_NAV_ITEMS } from '../modules';
import { Button, Icon } from './ui';

export interface TopNavProps {
  /** Toggles the mobile sidebar drawer; hidden at `md` and above. */
  onToggleSidebar: () => void;
}

/**
 * Fixed header spanning the content column: breadcrumb on the left, and the
 * session controls (language, user, sign out) on the right -- these moved
 * here from the sidebar to match the Stitch shell.
 */
export function TopNav({ onToggleSidebar }: TopNavProps) {
  const { t, i18n } = useTranslation();
  const { currentUser, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const activeModule = MODULE_NAV_ITEMS.find(
    (item) => pathname === item.path || pathname.startsWith(`${item.path}/`),
  );
  const crumb = activeModule ? t(activeModule.labelKey) : t('nav.home');

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  // Two locales ship today, so the switcher toggles between them rather
  // than opening a picker. Revisit if a third locale is added.
  const nextLanguage = i18n.language === 'vi' ? 'en' : 'vi';

  return (
    <header className="fixed top-0 right-0 left-0 md:left-64 z-40 h-16 flex items-center justify-between px-lg bg-surface border-b border-outline-variant shadow-sm">
      <div className="flex items-center gap-md min-w-0">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('nav.toggleSidebar')}
          className="md:hidden p-xs rounded-full text-on-surface-variant hover:bg-surface-container hover:text-primary transition-colors"
        >
          <Icon name="menu" size={24} />
        </button>

        <nav
          aria-label={t('nav.breadcrumb')}
          className="flex items-center gap-xs text-body-sm font-body-sm text-on-surface-variant min-w-0"
        >
          <span>{t('app.title')}</span>
          <Icon name="chevron_right" size={16} />
          <span className="text-on-surface font-medium truncate">{crumb}</span>
        </nav>
      </div>

      <div className="flex items-center gap-sm">
        <button
          type="button"
          onClick={() => void i18n.changeLanguage(nextLanguage)}
          aria-label={t('nav.switchLanguage', {
            language: nextLanguage.toUpperCase(),
          })}
          className="flex items-center gap-xs px-2 py-1 rounded-full text-body-sm font-body-sm text-on-surface-variant hover:bg-surface-container hover:text-primary transition-colors"
        >
          <Icon name="translate" size={18} />
          <span className="uppercase">{i18n.language}</span>
        </button>

        <div className="flex items-center gap-sm border-l border-outline-variant pl-md">
          {currentUser && (
            <span className="hidden sm:block text-body-sm font-body-sm text-on-surface-variant truncate max-w-[12rem]">
              {currentUser.name ?? currentUser.email}
            </span>
          )}

          <Button
            variant="secondary"
            size="sm"
            icon="logout"
            onClick={handleLogout}
          >
            <span className="hidden sm:inline">{t('auth.logout')}</span>
          </Button>
        </div>
      </div>
    </header>
  );
}
