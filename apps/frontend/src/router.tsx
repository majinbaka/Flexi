import { Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Layout } from './components/Layout';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { AdminLoginPage } from './pages/AdminLoginPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { TenantsPage } from './pages/TenantsPage';
import { TenantOnboardingPage } from './pages/TenantOnboardingPage';
import { NotFoundPage } from './pages/NotFoundPage';
import {
  MODULE_NAV_ITEMS,
  TENANT_ONBOARDING_ACCESS,
  hasAccess,
  type AccessMetadata,
} from './modules';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { useAuth } from './auth/AuthContext';
import { PermissionDeniedPage } from './pages/PermissionDeniedPage';

function AccessRoute({
  access,
  children,
}: {
  access: AccessMetadata;
  children: ReactNode;
}) {
  const { currentUser } = useAuth();

  if (!hasAccess(currentUser, access)) {
    return (
      <PermissionDeniedPage permissionCode={access.requiredPermissions[0]} />
    );
  }

  return children;
}

/**
 * Route table: `/login` and `/admin/login` are public siblings (tenant vs.
 * System Admin login -- same auth machinery, `/admin/login` omits
 * `x-tenant-id`); the authenticated tree is protected both by session and
 * by the access metadata shared with navigation. Planned/stub modules have
 * no route at all; Dynamic Tables is the one tenant MVP surface retained
 * until its catalog page replaces the explicit implementation-status view.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<Layout />}>
          <Route index element={<HomePage />} />
          {MODULE_NAV_ITEMS.map((item) => (
            <Route
              key={item.id}
              path={item.id}
              element={
                <AccessRoute access={item}>
                  {item.id === 'tenants' ? (
                    <TenantsPage />
                  ) : (
                    <PlaceholderPage moduleId={item.id} />
                  )}
                </AccessRoute>
              }
            />
          ))}
          <Route
            path="tenants/onboard"
            element={
              <AccessRoute access={TENANT_ONBOARDING_ACCESS}>
                <TenantOnboardingPage />
              </AccessRoute>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
