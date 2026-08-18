import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthContext';

/**
 * Gates the `<Layout>` route tree in router.tsx. Renders nothing while
 * the boot-time silent refresh is still in flight (avoids a login-page
 * flash for a valid returning session), then either the nested routes
 * (`<Outlet/>`) or a redirect to `/login`.
 *
 * Authenticated-vs-not only -- no per-route RBAC gating here (see spec
 * Boundaries "Never").
 */
export function ProtectedRoute() {
  const { accessToken, loading } = useAuth();

  if (loading) {
    return null;
  }

  if (!accessToken) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
