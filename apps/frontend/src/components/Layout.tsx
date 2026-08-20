import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Sidebar } from './Sidebar';
import { TopNav } from './TopNav';

/**
 * App shell for every authenticated route: fixed sidebar and top bar with
 * the routed page in the remaining canvas.
 *
 * The sidebar is always visible from `md` up; below that it slides in as a
 * drawer, so this owns the open state and the scrim that dismisses it.
 */
export function Layout() {
  const { t } = useTranslation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background text-on-background">
      <Sidebar open={sidebarOpen} onNavigate={() => setSidebarOpen(false)} />
      <TopNav onToggleSidebar={() => setSidebarOpen((open) => !open)} />

      {sidebarOpen && (
        <button
          type="button"
          aria-label={t('nav.closeSidebar')}
          onClick={() => setSidebarOpen(false)}
          className="md:hidden fixed inset-0 z-40 bg-inverse-surface/40 backdrop-blur-sm"
        />
      )}

      <main className="md:ml-64 pt-16 min-h-screen">
        <div className="flex flex-col gap-lg p-lg md:p-xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
