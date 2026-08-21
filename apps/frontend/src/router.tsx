import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { AdminLoginPage } from './pages/AdminLoginPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { TenantsPage } from './pages/TenantsPage';
import { TenantOnboardingPage } from './pages/TenantOnboardingPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { MODULE_NAV_ITEMS } from './modules';
import { ProtectedRoute } from './auth/ProtectedRoute';

/**
 * Route table: `/login` and `/admin/login` are public siblings (tenant vs.
 * System Admin login -- same auth machinery, `/admin/login` omits
 * `x-tenant-id`); everything else is one path per module (plus the home
 * index route), each rendering a placeholder page inside the shared
 * sidebar Layout, gated by ProtectedRoute (no valid access token ->
 * redirect to `/login`). A catch-all route covers any unmatched path so
 * navigating there renders NotFoundPage instead of a blank screen.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="tenants" element={<TenantsPage />} />
          <Route path="tenants/onboard" element={<TenantOnboardingPage />} />
          {MODULE_NAV_ITEMS.filter((item) => item.id !== 'tenants').map(
            (item) => (
              <Route
                key={item.id}
                path={item.id}
                element={<PlaceholderPage moduleId={item.id} />}
              />
            ),
          )}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
