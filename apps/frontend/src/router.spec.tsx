import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  ActorType,
  DYNAMIC_TABLES_TABLES_READ_PERMISSION,
  SYSTEM_TENANTS_ONBOARD_PERMISSION,
  SYSTEM_TENANTS_READ_PERMISSION,
  type AuthenticatedUserDto,
} from '@flexi/shared-types';
import i18n from './i18n';
import { AuthContext, type AuthContextValue } from './auth/AuthContext';
import { AppRoutes } from './router';

const systemReader: AuthenticatedUserDto = {
  authAccountId: 'auth_system_reader',
  actorType: ActorType.SYSTEM,
  systemUserId: 'system_reader',
  email: 'reader@flexi.test',
  name: 'System Reader',
  roles: ['PlatformViewer'],
  permissions: [SYSTEM_TENANTS_READ_PERMISSION],
};

const tenantUser: AuthenticatedUserDto = {
  authAccountId: 'auth_tenant_user',
  actorType: ActorType.TENANT,
  tenantId: 'tenant_acme',
  tenantUserId: 'tenant_user',
  email: 'user@acme.test',
  name: 'Tenant User',
  roles: ['Member'],
  permissions: [DYNAMIC_TABLES_TABLES_READ_PERMISSION],
};

const systemOnboarder: AuthenticatedUserDto = {
  ...systemReader,
  authAccountId: 'auth_system_onboarder',
  systemUserId: 'system_onboarder',
  permissions: [SYSTEM_TENANTS_ONBOARD_PERMISSION],
};

function renderRoute(path: string, user: AuthenticatedUserDto) {
  const auth: AuthContextValue = {
    accessToken: 'test-access-token',
    currentUser: user,
    loading: false,
    login: async () => {},
    logout: async () => {},
  };

  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={auth}>
        <AppRoutes />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('AppRoutes authorization', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('shows only System tenant administration navigation to a System reader', () => {
    renderRoute('/', systemReader);

    expect(screen.getAllByRole('link', { name: 'Tenants' })).not.toHaveLength(
      0,
    );
    expect(
      screen.queryByRole('link', { name: 'Dynamic Tables' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Workflows' }),
    ).not.toBeInTheDocument();
  });

  it('shows only Dynamic Tables navigation to a Tenant actor', () => {
    renderRoute('/', tenantUser);

    expect(
      screen.getAllByRole('link', { name: 'Dynamic Tables' }),
    ).not.toHaveLength(0);
    expect(
      screen.queryByRole('link', { name: 'Tenants' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Workflows' }),
    ).not.toBeInTheDocument();
  });

  it('renders PermissionDenied for a System actor using the tenant route directly', () => {
    renderRoute('/dynamic-tables', systemReader);

    expect(
      screen.getByRole('heading', { name: 'Permission denied' }),
    ).toBeInTheDocument();
  });

  it('requires the Dynamic Tables read permission at its direct URL', () => {
    renderRoute('/dynamic-tables', { ...tenantUser, permissions: [] });

    expect(
      screen.getByRole('heading', { name: 'Permission denied' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(DYNAMIC_TABLES_TABLES_READ_PERMISSION),
    ).toBeInTheDocument();
  });

  it('renders PermissionDenied for a Tenant actor using System routes directly', () => {
    renderRoute('/tenants', tenantUser);

    expect(
      screen.getByRole('heading', { name: 'Permission denied' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(SYSTEM_TENANTS_READ_PERMISSION),
    ).toBeInTheDocument();
  });

  it('uses the onboarding permission for its direct URL guard', () => {
    renderRoute('/tenants/onboard', systemReader);

    expect(
      screen.getByRole('heading', { name: 'Permission denied' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(SYSTEM_TENANTS_ONBOARD_PERMISSION),
    ).toBeInTheDocument();
  });

  it('uses the tenant-read permission for a direct provisioning status URL', () => {
    renderRoute('/tenants/onboarding-attempts/attempt-1', systemOnboarder);

    expect(
      screen.getByRole('heading', { name: 'Permission denied' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(SYSTEM_TENANTS_READ_PERMISSION),
    ).toBeInTheDocument();
  });

  it('keeps planned module URLs as not-found routes', () => {
    renderRoute('/workflows', tenantUser);

    expect(
      screen.getByRole('heading', { name: 'Page not found' }),
    ).toBeInTheDocument();
  });
});
