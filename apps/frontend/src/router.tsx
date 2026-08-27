import { lazy, Suspense, type ReactNode } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Layout } from './components/Layout';
import {
  MODULE_NAV_ITEMS,
  TENANT_ONBOARDING_ACCESS,
  TENANT_PROVISIONING_ACCESS,
  DYNAMIC_TABLE_ROWS_ACCESS,
  hasAccess,
  type AccessMetadata,
} from './modules';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { useAuth } from './auth/AuthContext';

const HomePage = lazy(() =>
  import('./pages/HomePage').then(({ HomePage: Page }) => ({ default: Page })),
);
const LoginPage = lazy(() =>
  import('./pages/LoginPage').then(({ LoginPage: Page }) => ({
    default: Page,
  })),
);
const AdminLoginPage = lazy(() =>
  import('./pages/AdminLoginPage').then(({ AdminLoginPage: Page }) => ({
    default: Page,
  })),
);
const SetupAccountPage = lazy(() =>
  import('./pages/SetupAccountPage').then(({ SetupAccountPage: Page }) => ({
    default: Page,
  })),
);
const ForgotPasswordPage = lazy(() =>
  import('./pages/ForgotPasswordPage').then(({ ForgotPasswordPage: Page }) => ({
    default: Page,
  })),
);
const ResetPasswordPage = lazy(() =>
  import('./pages/ResetPasswordPage').then(({ ResetPasswordPage: Page }) => ({
    default: Page,
  })),
);
const ChangePasswordPage = lazy(() =>
  import('./pages/ChangePasswordPage').then(({ ChangePasswordPage: Page }) => ({
    default: Page,
  })),
);
const PlaceholderPage = lazy(() =>
  import('./pages/PlaceholderPage').then(({ PlaceholderPage: Page }) => ({
    default: Page,
  })),
);
const TenantsPage = lazy(() =>
  import('./pages/TenantsPage').then(({ TenantsPage: Page }) => ({
    default: Page,
  })),
);
const TenantOnboardingPage = lazy(() =>
  import('./pages/TenantOnboardingPage').then(
    ({ TenantOnboardingPage: Page }) => ({
      default: Page,
    }),
  ),
);
const TenantProvisioningPage = lazy(() =>
  import('./pages/TenantProvisioningPage').then(
    ({ TenantProvisioningPage: Page }) => ({ default: Page }),
  ),
);
const DynamicTablesPage = lazy(() =>
  import('./pages/DynamicTablesPage').then(({ DynamicTablesPage: Page }) => ({
    default: Page,
  })),
);
const DynamicTableRowsPage = lazy(() =>
  import('./pages/DynamicTableRowsPage').then(
    ({ DynamicTableRowsPage: Page }) => ({ default: Page }),
  ),
);
const NotFoundPage = lazy(() =>
  import('./pages/NotFoundPage').then(({ NotFoundPage: Page }) => ({
    default: Page,
  })),
);
const PermissionDeniedPage = lazy(() =>
  import('./pages/PermissionDeniedPage').then(
    ({ PermissionDeniedPage: Page }) => ({
      default: Page,
    }),
  ),
);

function PageLoadingFallback() {
  const { t } = useTranslation();

  return (
    <div role="status" aria-live="polite" aria-busy="true">
      {t('app.loadingPage')}
    </div>
  );
}

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
 * Route table: `/login`, `/admin/login`, `/setup-account`,
 * `/forgot-password` and `/reset-password` are public siblings. The setup route claims a one-time First Admin link; the two
 * login routes use the same auth machinery, while `/admin/login` omits
 * `x-tenant-id`. The authenticated tree is protected both by session and
 * by the access metadata shared with navigation. Planned/stub modules have
 * no route at all. Dynamic Tables is the tenant MVP surface and its catalog
 * is protected by the same metadata that drives tenant navigation.
 */
export function AppRoutes() {
  return (
    <Suspense fallback={<PageLoadingFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/admin/login" element={<AdminLoginPage />} />
        <Route path="/setup-account" element={<SetupAccountPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route element={<ProtectedRoute />}>
          {/*
            Outside <Layout> deliberately: a holder under a force-reset is
            redirected here by ProtectedRoute and should see nothing but the
            form -- no navigation to the app they are not meant to be using
            yet.
          */}
          <Route path="/change-password" element={<ChangePasswordPage />} />
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
                    ) : item.id === 'dynamic-tables' ? (
                      <DynamicTablesPage />
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
            <Route
              path="dynamic-tables/:tableId/rows"
              element={
                <AccessRoute access={DYNAMIC_TABLE_ROWS_ACCESS}>
                  <DynamicTableRowsPage />
                </AccessRoute>
              }
            />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
