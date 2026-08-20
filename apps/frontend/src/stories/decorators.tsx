import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ActorType, type AuthenticatedUserDto } from '@flexi/shared-types';
import { AuthContext, type AuthContextValue } from '../auth/AuthContext';

/**
 * Shared story scaffolding.
 *
 * Shell components (`Sidebar`, `TopNav`, `Layout`) and the pages all read
 * from React Router and the auth context, so mounting them in isolation
 * needs both. The real `AuthProvider` cannot be used here: it bootstraps by
 * calling the backend, which is not running behind Storybook, so it would
 * always settle on a signed-out session and `TopNav` would render without
 * the user block it exists to show. `MockAuthProvider` fills the context
 * directly with a fixed session instead.
 */

export const MOCK_USER: AuthenticatedUserDto = {
  authAccountId: 'auth_01HZX0STORYBOOK',
  actorType: ActorType.TENANT,
  tenantId: 'acme',
  tenantUserId: 'usr_01HZX0STORYBOOK',
  email: 'linh.tran@acme.example',
  name: 'Linh Tran',
  roles: ['tenant-admin'],
  permissions: ['dynamic-tables:read', 'dynamic-tables:write'],
};

export interface MockAuthProviderProps {
  /** Pass `null` to render the signed-out variant of a component. */
  user?: AuthenticatedUserDto | null;
  children: ReactNode;
}

export function MockAuthProvider({
  user = MOCK_USER,
  children,
}: MockAuthProviderProps) {
  const value: AuthContextValue = {
    accessToken: user ? 'storybook-access-token' : null,
    currentUser: user,
    loading: false,
    // Stories exercise layout, not the auth flow -- these resolve so a
    // clicked Log out button is a no-op instead of an unhandled rejection.
    login: async () => {},
    logout: async () => {},
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export interface AppShellDecoratorOptions {
  /** Route the `MemoryRouter` starts on; drives active nav + breadcrumb. */
  route?: string;
  user?: AuthenticatedUserDto | null;
}

/**
 * Router + auth context in one decorator, since virtually every story in
 * this app needs both.
 */
export function withAppContext({
  route = '/',
  user = MOCK_USER,
}: AppShellDecoratorOptions = {}) {
  return function AppContextDecorator(Story: () => ReactNode) {
    return (
      <MemoryRouter initialEntries={[route]}>
        <MockAuthProvider user={user}>
          <Story />
        </MockAuthProvider>
      </MemoryRouter>
    );
  };
}
