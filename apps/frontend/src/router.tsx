import { Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Layout } from './components/Layout';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { AdminLoginPage } from './pages/AdminLoginPage';
import { SetupAccountPage } from './pages/SetupAccountPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { TenantsPage } from './pages/TenantsPage';
import { TenantOnboardingPage } from './pages/TenantOnboardingPage';
import { TenantProvisioningPage } from './pages/TenantProvisioningPage';
import { NotFoundPage } from './pages/NotFoundPage';
import {
  MODULE_NAV_ITEMS,
  TENANT_ONBOARDING_ACCESS,
  TENANT_PROVISIONING_ACCESS,
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
 * Route table: `/login`, `/admin/login`, and `/setup-account` are public
 * siblings. The setup route claims a one-time First Admin link; the two
 * login routes use the same auth machinery, while `/admin/login` omits
 * `x-tenant-id`. The authenticated tree is protected both by session and
 * by the access metadata shared with navigation. Planned/stub modules have
 * no route at all; Dynamic Tables is the one tenant MVP surface retained
 * until its catalog page replaces the explicit implementation-status view.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route path="/setup-account" element={<SetupAccountPage />} />
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
          <Route
            path="tenants/onboarding-attempts/:attemptId"
            element={
              <AccessRoute access={TENANT_PROVISIONING_ACCESS}>
                <TenantProvisioningPage />
              </AccessRoute>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
