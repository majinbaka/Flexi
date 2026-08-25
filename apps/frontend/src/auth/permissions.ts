import {
  ActorType,
  SYSTEM_TENANTS_READ_PERMISSION,
  SYSTEM_TENANTS_ONBOARD_PERMISSION,
  SYSTEM_TENANTS_SETUP_LINK_PERMISSION,
  type AuthenticatedUserDto,
} from '@flexi/shared-types';

export {
  SYSTEM_TENANTS_READ_PERMISSION,
  SYSTEM_TENANTS_ONBOARD_PERMISSION,
  SYSTEM_TENANTS_SETUP_LINK_PERMISSION,
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
