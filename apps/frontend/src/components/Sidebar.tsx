import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MODULE_NAV_ITEMS } from '../modules';
import { Icon } from './ui';

export interface SidebarProps {
  /** Whether the mobile drawer is open; ignored at `md` and above. */
  open?: boolean;
  /** Called after navigating, so the mobile drawer can close itself. */
  onNavigate?: () => void;
}

const LINK_BASE =
  'flex items-center gap-sm px-sm py-2 rounded font-body-base text-body-base transition-colors';
const LINK_ACTIVE =
  'bg-secondary-container text-on-secondary-container font-semibold';
const LINK_IDLE =
  'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface';

/**
 * Fixed 256px navigation rail carrying the brand block and one link per
 * feature module. Below `md` it becomes an off-canvas drawer driven by
 * `open` -- Layout renders the scrim and owns that state.
 */
export function Sidebar({ open = false, onNavigate }: SidebarProps) {
  const { t } = useTranslation();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `${LINK_BASE} ${isActive ? LINK_ACTIVE : LINK_IDLE}`;

  return (
    <aside
      className={[
        'fixed left-0 top-0 z-50 h-full w-64 flex flex-col p-md',
        'bg-surface border-r border-outline-variant',
        'transition-transform duration-300 md:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
      ].join(' ')}
    >
      <div className="flex items-center gap-sm mb-xl px-sm">
        <div className="w-10 h-10 rounded-lg bg-primary-container flex items-center justify-center text-on-primary-container shadow-sm">
          <Icon name="dataset" size={24} />
        </div>
        <div>
          <p className="font-display-lg text-[20px] font-bold text-primary leading-tight">
            {t('app.title')}
          </p>
          <p className="text-label-caps font-label-caps uppercase tracking-wider text-on-surface-variant">
            {t('app.tagline')}
          </p>
        </div>
      </div>

      <nav className="flex flex-col gap-xs overflow-y-auto">
        <NavLink to="/" end className={linkClass} onClick={onNavigate}>
          <Icon name="home" />
          <span>{t('nav.home')}</span>
        </NavLink>

        {MODULE_NAV_ITEMS.map((item) => (
          <NavLink
            key={item.id}
            to={item.path}
            className={linkClass}
            onClick={onNavigate}
          >
            <Icon name={item.icon} />
            <span>{t(item.labelKey)}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
