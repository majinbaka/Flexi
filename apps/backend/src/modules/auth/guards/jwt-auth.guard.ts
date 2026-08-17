import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthenticatedUserDto } from '@flexi/shared-types';
import { AccessTokenPayload } from '../auth.types';

/**
 * Authenticates a request from its `Authorization: Bearer <accessToken>`
 * header. On success, decodes the access token and sets `request.user` to
 * an AuthenticatedUserDto built entirely from the token's payload (no DB
 * round trip -- see Design Notes in spec-core-authentication.md).
 *
 * Reusable by any module: this guard does not care whether the caller is a
 * SystemUser or a TenantUser, it only cares that the token is valid.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
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
    };

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
