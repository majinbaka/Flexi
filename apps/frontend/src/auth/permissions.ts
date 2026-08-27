import {
  ActorType,
  SYSTEM_TENANTS_READ_PERMISSION,
  SYSTEM_TENANTS_ONBOARD_PERMISSION,
  SYSTEM_TENANTS_SETUP_LINK_PERMISSION,
  TENANT_SETTINGS_MANAGE_PERMISSION,
  TENANT_USER_INVITE_PERMISSION,
  TENANT_USER_MANAGE_PERMISSION,
  TENANT_USER_READ_PERMISSION,
  type AuthenticatedUserDto,
} from '@flexi/shared-types';

export {
  SYSTEM_TENANTS_READ_PERMISSION,
  SYSTEM_TENANTS_ONBOARD_PERMISSION,
  SYSTEM_TENANTS_SETUP_LINK_PERMISSION,
  TENANT_SETTINGS_MANAGE_PERMISSION,
  TENANT_USER_INVITE_PERMISSION,
  TENANT_USER_MANAGE_PERMISSION,
  TENANT_USER_READ_PERMISSION,
};

function hasSystemPermission(
  user: AuthenticatedUserDto | null | undefined,
  permission: string,
): boolean {
  return (
    user?.actorType === ActorType.SYSTEM &&
    user.permissions.includes(permission)
  );
}

export function canReadTenants(
  user: AuthenticatedUserDto | null | undefined,
): boolean {
  return hasSystemPermission(user, SYSTEM_TENANTS_READ_PERMISSION);
}

export function canOnboardTenants(
  user: AuthenticatedUserDto | null | undefined,
): boolean {
  return hasSystemPermission(user, SYSTEM_TENANTS_ONBOARD_PERMISSION);
}

export function canRegenerateTenantSetupLinks(
  user: AuthenticatedUserDto | null | undefined,
): boolean {
  return hasSystemPermission(user, SYSTEM_TENANTS_SETUP_LINK_PERMISSION);
}

/**
 * Users administration.
 *
 * Every capability on the Users screens is tenant-scoped: `tenant.user.*`
 * has SYSTEM counterparts for reading and managing, but inviting, approving
 * and seat accounting exist only for a tenant, so the screens gate on the
 * tenant codes and a system actor never reaches them (see
 * `MODULE_NAV_ITEMS` in `modules.ts`).
 */
function hasTenantPermission(
  user: AuthenticatedUserDto | null | undefined,
  permission: string,
): boolean {
  return (
    user?.actorType === ActorType.TENANT &&
    user.permissions.includes(permission)
  );
}

export function canReadUsers(
  user: AuthenticatedUserDto | null | undefined,
): boolean {
  return hasTenantPermission(user, TENANT_USER_READ_PERMISSION);
}

export function canManageUsers(
  user: AuthenticatedUserDto | null | undefined,
): boolean {
  return hasTenantPermission(user, TENANT_USER_MANAGE_PERMISSION);
}

export function canInviteUsers(
  user: AuthenticatedUserDto | null | undefined,
): boolean {
  return hasTenantPermission(user, TENANT_USER_INVITE_PERMISSION);
}

export function canManageTenantSettings(
  user: AuthenticatedUserDto | null | undefined,
): boolean {
  return hasTenantPermission(user, TENANT_SETTINGS_MANAGE_PERMISSION);
}

/**
 * Whether this session is a support impersonation rather than the holder's
 * own. Read from the token claim the backend sets, never from anything the
 * user can toggle.
 */
export function isImpersonating(
  user: AuthenticatedUserDto | null | undefined,
): boolean {
  return Boolean(user?.impersonatedBy);
}
