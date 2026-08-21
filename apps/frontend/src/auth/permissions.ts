import {
  ActorType,
  SYSTEM_TENANTS_ONBOARD_PERMISSION,
  type AuthenticatedUserDto,
} from '@flexi/shared-types';

export { SYSTEM_TENANTS_ONBOARD_PERMISSION };

export function canOnboardTenants(
  user: AuthenticatedUserDto | null | undefined,
): boolean {
  return (
    user?.actorType === ActorType.SYSTEM &&
    user.permissions.includes(SYSTEM_TENANTS_ONBOARD_PERMISSION)
  );
}
