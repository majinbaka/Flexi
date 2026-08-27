import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';

/** Where a holder under an admin force-reset is sent, and the one authenticated route exempt from that redirect. */
const CHANGE_PASSWORD_PATH = '/change-password';

/**
 * Gates the `<Layout>` route tree in router.tsx. Renders nothing while
 * the boot-time silent refresh is still in flight (avoids a login-page
 * flash for a valid returning session), then either the nested routes
 * (`<Outlet/>`) or a redirect to `/login`.
 *
 * Authenticated-vs-not only -- no per-route RBAC gating here (see spec
 * Boundaries "Never").
 *
 * The one exception is `mustChangePassword`: an admin force-reset leaves
 * the holder able to authenticate (they must be, or they could not reach
 * the change-password endpoint at all) but with nothing else they should be
 * doing until they choose a password of their own. That is a session state,
 * not a permission, so it is gated here rather than through the
 * access metadata that drives navigation.
 */
export function ProtectedRoute() {
  const { accessToken, currentUser, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return null;
  }

  if (!accessToken) {
    return <Navigate to="/login" replace />;
  }

  if (
    currentUser?.mustChangePassword &&
    location.pathname !== CHANGE_PASSWORD_PATH
  ) {
    return <Navigate to={CHANGE_PASSWORD_PATH} replace />;
  }

  return <Outlet />;
}
