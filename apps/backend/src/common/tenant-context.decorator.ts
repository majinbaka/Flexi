import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

/**
 * Parameter decorator that extracts the `x-tenant-id` header, if present.
 *
 * This is intentionally dumb: it does not validate that the tenant exists,
 * does not enforce that the header is present, and does not check the
 * requesting user's membership in the tenant. Real tenant resolution/
 * enforcement (guard, middleware, RLS policies, etc.) is deferred --
 * see deferred-work.md, "multi-tenant data/config/role isolation".
 */
export const TenantContext = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const header = request.headers['x-tenant-id'];
    return Array.isArray(header) ? header[0] : header;
  },
);
