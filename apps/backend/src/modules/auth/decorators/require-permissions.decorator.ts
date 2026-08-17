import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_METADATA_KEY = 'flexi:required-permissions';

/**
 * Marks a route as requiring the given permission codes. Read by
 * PermissionsGuard, which requires the caller's `request.user.permissions`
 * (set by JwtAuthGuard from the decoded token) to include ALL of them.
 *
 * Reusable across any module's guarded routes -- this spec only wires it
 * onto its own module's guard/decorator pair; it does not attach it to any
 * other module's stub controller.
 */
export const RequirePermissions = (
  ...codes: string[]
): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_METADATA_KEY, codes);
