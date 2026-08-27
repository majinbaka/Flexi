import { ForbiddenException } from '@nestjs/common';
import { ActorType, AuthenticatedUserDto } from '@flexi/shared-types';

/**
 * A TENANT/SYSTEM pair of permission codes for one operation, in that
 * order.
 */
export type ScopedPermissionPair = [tenantCode: string, systemCode: string];

/**
 * Asserts the caller holds whichever spelling of a permission their actor
 * type uses.
 *
 * Every operation that both actor types can perform has a *pair* of codes
 * rather than one shared code, forced by the scope invariant
 * `Permission.scope` encodes: a tenant Role can never hold a SYSTEM
 * permission and vice versa, so a single code usable by both is not
 * representable. Only the request knows which one applies, which is why
 * this is a service-layer assertion rather than a static
 * `@RequirePermissions()` on the route -- exactly as `GET /api/auth/me`
 * picks between `auth.me.read` and `system.me.read`.
 *
 * Shared by `AccountLifecycleService` and `UsersAdminService` so the two
 * halves of user administration cannot drift into answering the same
 * situation two different ways.
 */
export function assertActorPermission(
  currentUser: AuthenticatedUserDto,
  [tenantCode, systemCode]: ScopedPermissionPair,
): void {
  const required =
    currentUser.actorType === ActorType.TENANT ? tenantCode : systemCode;

  if (!currentUser.permissions.includes(required)) {
    throw new ForbiddenException({
      error: 'FORBIDDEN',
      message: 'Insufficient permissions',
    });
  }
}
