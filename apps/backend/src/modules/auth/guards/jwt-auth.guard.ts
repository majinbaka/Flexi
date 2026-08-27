import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { Request } from 'express';
import { AuthenticatedUserDto } from '@flexi/shared-types';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccessTokenPayload } from '../auth.types';
import { resolveTenantSchema } from '../../../tenancy/resolve-tenant-schema';
import { TenancyClsStore } from '../../../tenancy/tenant-context';

const ACTIVE_TENANT_STATUS = 'ACTIVE';

/**
 * Authenticates a request from its `Authorization: Bearer <accessToken>`
 * header. On success, decodes the access token and sets `request.user` to
 * an AuthenticatedUserDto built entirely from the token's payload (no DB
 * round trip -- see Design Notes in spec-core-authentication.md).
 *
 * Reusable by any module: this guard does not care whether the caller is a
 * SystemUser or a TenantUser, it only cares that the token is valid.
 *
 * Also the sole place that populates the tenant-schema-routing CLS context
 * (see spec-schema-per-tenant-core.md): once the token is verified, a
 * present `tenantId` claim is used to set `tenantId`/`schema` on the CLS
 * store. This happens here rather than in `ClsModule`'s middleware `setup`
 * hook because Nest middleware runs *before* guards -- `request.user`
 * (and the verified claim it's built from) doesn't exist yet at that point.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly cls: ClsService<TenancyClsStore>,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUserDto }>();

    const token = this.extractToken(request);
    if (!token) {
      throw this.unauthorized();
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
        secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw this.unauthorized();
    }

    request.user = {
      authAccountId: payload.sub,
      actorType: payload.actorType,
      tenantId: payload.tenantId,
      tenantUserId: payload.tenantUserId,
      systemUserId: payload.systemUserId,
      email: payload.email,
      name: payload.name,
      roles: payload.roles,
      permissions: payload.permissions,
      sessionId: payload.sessionId,
      mustChangePassword: payload.mustChangePassword,
    };

    // Tenant identity for schema-routing comes ONLY from this
    // already-verified claim -- never re-derived from body/query/header.
    // A System actor's token carries no tenantId, so the CLS store simply
    // stays unset for it; TenantContext then throws if anything downstream
    // tries to read a schema for a non-tenant request.
    if (payload.tenantId) {
      const [activeTenant] = await this.prisma.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT "id"
          FROM "tenants"
          WHERE
            "id" = ${payload.tenantId}
            AND "status" = ${ACTIVE_TENANT_STATUS}
          LIMIT 1
        `,
      );
      if (!activeTenant) {
        throw this.unauthorized();
      }

      this.cls.set('tenantId', payload.tenantId);
      this.cls.set('schema', resolveTenantSchema(payload.tenantId));
      if (payload.tenantUserId) {
        this.cls.set('tenantUserId', payload.tenantUserId);
      }
    }

    return true;
  }

  private extractToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) {
      return undefined;
    }
    const [scheme, token] = header.split(' ');
    // RFC 7235: the auth scheme token is case-insensitive.
    return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException({
      error: 'UNAUTHORIZED',
      message: 'Missing or invalid access token',
    });
  }
}
