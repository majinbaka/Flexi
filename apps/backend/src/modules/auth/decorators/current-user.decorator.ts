import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUserDto } from '@flexi/shared-types';

/**
 * Parameter decorator that reads the caller resolved by JwtAuthGuard off
 * `request.user`. Follows the existing TenantContext param-decorator
 * pattern (apps/backend/src/common/tenant-context.decorator.ts).
 *
 * Only meaningful behind JwtAuthGuard -- if no guard ran, `request.user` is
 * undefined and this returns undefined.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUserDto | undefined => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUserDto }>();
    return request.user;
  },
);
