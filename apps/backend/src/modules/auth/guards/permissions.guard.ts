import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AuthenticatedUserDto } from '@flexi/shared-types';
import { PERMISSIONS_METADATA_KEY } from '../decorators/require-permissions.decorator';

/**
 * Authorizes a request whose `request.user` was already set by
 * JwtAuthGuard (always run PermissionsGuard after it). Requires the
 * caller's `request.user.permissions` to include ALL permission codes
 * attached via @RequirePermissions() on the route.
 *
 * Reads request.user.permissions regardless of actorType -- the mechanism
 * doesn't change whether the caller is a SystemUser or a TenantUser, only
 * the payload's shape (which fields besides permissions are populated)
 * does. Routes with no @RequirePermissions() metadata are allowed through
 * unchecked (authentication-only).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUserDto }>();
    const grantedPermissions = request.user?.permissions ?? [];

    const hasAll = requiredPermissions.every((code) =>
      grantedPermissions.includes(code),
    );

    if (!hasAll) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: 'Insufficient permissions',
      });
    }

    return true;
  }
}
