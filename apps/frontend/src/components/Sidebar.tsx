import type { CSSProperties } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MODULE_NAV_ITEMS } from '../modules';

const linkStyle: CSSProperties = {
  display: 'block',
  padding: '0.5rem 0.75rem',
  borderRadius: 6,
  color: 'inherit',
  textDecoration: 'none',
};

export function Sidebar() {
  const { t, i18n } = useTranslation();

  return (
    <aside
      style={{
        width: 220,
        flexShrink: 0,
        borderRight: '1px solid #333',
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: '1rem', fontSize: '1.1rem' }}>{t('app.title')}</div>

      <NavLink
        to="/"
        end
        style={({ isActive }) => ({ ...linkStyle, background: isActive ? '#2b2b2b' : 'transparent' })}
      >
        {t('nav.home')}
      </NavLink>

      <nav style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        {MODULE_NAV_ITEMS.map((item) => (
          <NavLink
            key={item.id}
            to={item.path}
            style={({ isActive }) => ({ ...linkStyle, background: isActive ? '#2b2b2b' : 'transparent' })}
          >
            {t(item.labelKey)}
          </NavLink>
        ))}
      </nav>

      <div style={{ marginTop: 'auto', display: 'flex', gap: '0.5rem', paddingTop: '1rem' }}>
        <button type="button" onClick={() => i18n.changeLanguage('en')} disabled={i18n.language === 'en'}>
          EN
        </button>
        <button type="button" onClick={() => i18n.changeLanguage('vi')} disabled={i18n.language === 'vi'}>
          VI
        </button>
      </div>
    </aside>
  );
}
