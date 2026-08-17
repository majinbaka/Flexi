import { createHash, randomUUID } from 'crypto';
import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import {
  ActorType,
  AuthenticatedUserDto,
  AuthTokensDto,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { AccessTokenPayload, RefreshTokenPayload } from './auth.types';

/** Permission required to call GET /api/auth/me as a TenantUser. */
const TENANT_ME_PERMISSION = 'auth.me.read';
/** Permission required to call GET /api/auth/me as a SystemUser. */
const SYSTEM_ME_PERMISSION = 'system.me.read';

/**
 * Fixed, well-formed bcrypt hash (not a real credential) run through
 * `bcrypt.compare` on the "no such actor" login path so it costs the same
 * time as the "wrong password" path -- otherwise the two are distinguishable
 * by response time, letting a caller enumerate valid emails/tenants.
 */
const DUMMY_PASSWORD_HASH =
  '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

interface RoleWithPermissions {
  name: string;
  rolePermissions: Array<{ permission: { code: string } }>;
}

interface TenantUserRow {
  id: string;
  tenantId: string;
  authAccountId: string;
  name: string | null;
  isActive: boolean;
  authAccount: { email: string; passwordHash: string; isActive: boolean };
  roles: RoleWithPermissions[];
}

interface SystemUserRow {
  id: string;
  authAccountId: string;
  name: string | null;
  isActive: boolean;
  authAccount: { email: string; passwordHash: string; isActive: boolean };
  roles: RoleWithPermissions[];
}

/**
 * Actor resolved from an AuthAccount row, flattened for JWT issuance.
 * `tenantUserId`/`systemUserId` are mutually exclusive, matching the
 * SystemUser XOR TenantUser rule.
 */
interface ResolvedActor {
  authAccountId: string;
  passwordHash: string;
  isActive: boolean;
  actorType: ActorType;
  tenantId?: string;
  tenantUserId?: string;
  systemUserId?: string;
  email: string;
  name: string | null;
  roles: string[];
  permissions: string[];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Branches on whether `tenantId` (from the `x-tenant-id` header) is
   * present: present -> tenant login (AuthAccount backing a TenantUser of
   * that tenant); absent -> system login (AuthAccount backing a
   * SystemUser). See Boundaries in spec-core-authentication.md.
   */
  async login(dto: LoginDto, tenantId?: string): Promise<AuthTokensDto> {
    // Branch on header *presence*, not truthiness -- an empty-string
    // `x-tenant-id` must still route to tenant login (and fail there), not
    // silently fall through to system login.
    const actor =
      tenantId !== undefined
        ? await this.resolveTenantActor(dto.email, tenantId)
        : await this.resolveSystemActor(dto.email);

    if (!actor || !actor.isActive) {
      await bcrypt.compare(dto.password, DUMMY_PASSWORD_HASH);
      throw this.invalidCredentials();
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      actor.passwordHash,
    );
    if (!passwordMatches) {
      throw this.invalidCredentials();
    }

    return this.issueTokens(actor);
  }

  /**
   * Rotates a refresh token: the presented token is verified (signature +
   * expiry) and looked up by its hash; if valid, unrevoked and unexpired in
   * storage, the stored row is revoked and a brand-new access/refresh pair
   * is issued. Any failure (unknown signature, revoked, expired, unknown
   * hash) collapses to the same 401 INVALID_REFRESH_TOKEN -- no account
   * enumeration.
   */
  async refresh(dto: RefreshDto): Promise<AuthTokensDto> {
    let decoded: RefreshTokenPayload;
    try {
      decoded = await this.jwtService.verifyAsync<RefreshTokenPayload>(
        dto.refreshToken,
        { secret: this.configService.get<string>('JWT_REFRESH_SECRET') },
      );
    } catch {
      throw this.invalidRefreshToken();
    }

    const tokenHash = this.hashToken(dto.refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (
      !stored ||
      stored.revokedAt !== null ||
      stored.expiresAt.getTime() < Date.now() ||
      stored.authAccountId !== decoded.sub
    ) {
      throw this.invalidRefreshToken();
    }

    // Atomic, conditional revoke: the `revokedAt: null` in the WHERE clause
    // means two concurrent requests presenting the same token can't both
    // pass -- only one `updateMany` call actually flips a row from
    // unrevoked to revoked, so only one gets to issue a new token pair.
    const revoked = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) {
      throw this.invalidRefreshToken();
    }

    const actor = await this.resolveActorByAuthAccountId(stored.authAccountId);
    if (!actor || !actor.isActive) {
      throw this.invalidRefreshToken();
    }

    return this.issueTokens(actor);
  }

  /**
   * Revokes a refresh token belonging to the authenticated caller. Requires
   * both a valid access token (enforced by JwtAuthGuard upstream) and a
   * refresh token owned by that same AuthAccount.
   */
  async logout(
    dto: LogoutDto,
    currentUser: AuthenticatedUserDto,
  ): Promise<void> {
    const tokenHash = this.hashToken(dto.refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (
      !stored ||
      stored.revokedAt !== null ||
      stored.authAccountId !== currentUser.authAccountId
    ) {
      throw this.invalidRefreshToken();
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Actor-type-aware permission check for GET /api/auth/me: a TenantUser
   * needs `auth.me.read`, a SystemUser needs `system.me.read`. `request.user`
   * is already fully populated from the access token by JwtAuthGuard (no DB
   * read here) -- this only re-asserts the permission so the check is
   * unit-testable in isolation from the guard chain.
   */
  me(currentUser: AuthenticatedUserDto): AuthenticatedUserDto {
    const requiredPermission =
      currentUser.actorType === ActorType.TENANT
        ? TENANT_ME_PERMISSION
        : SYSTEM_ME_PERMISSION;

    if (!currentUser.permissions.includes(requiredPermission)) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: 'Insufficient permissions',
      });
    }

    return currentUser;
  }

  private async resolveTenantActor(
    email: string,
    tenantId: string,
  ): Promise<ResolvedActor | null> {
    const tenantUser = await this.prisma.tenantUser.findFirst({
      where: { tenantId, authAccount: { email } },
      include: {
        authAccount: true,
        roles: {
          include: { rolePermissions: { include: { permission: true } } },
        },
      },
    });

    return tenantUser ? this.mapTenantUserToActor(tenantUser) : null;
  }

  private async resolveSystemActor(
    email: string,
  ): Promise<ResolvedActor | null> {
    const systemUser = await this.prisma.systemUser.findFirst({
      where: { authAccount: { email } },
      include: {
        authAccount: true,
        roles: {
          include: { rolePermissions: { include: { permission: true } } },
        },
      },
    });

    return systemUser ? this.mapSystemUserToActor(systemUser) : null;
  }

  /**
   * Looks up which actor an AuthAccount backs (TenantUser XOR SystemUser --
   * service-layer-enforced, see Boundaries) for refresh-token rotation,
   * where the caller only has an authAccountId, not an email/tenant header.
   * Both tables are queried unconditionally (not short-circuited) so a data
   * integrity violation of the XOR invariant is caught rather than silently
   * resolved to whichever table happened to be checked first.
   */
  private async resolveActorByAuthAccountId(
    authAccountId: string,
  ): Promise<ResolvedActor | null> {
    const include = {
      authAccount: true,
      roles: {
        include: { rolePermissions: { include: { permission: true } } },
      },
    } as const;

    const [tenantUser, systemUser] = await Promise.all([
      this.prisma.tenantUser.findFirst({ where: { authAccountId }, include }),
      this.prisma.systemUser.findFirst({ where: { authAccountId }, include }),
    ]);

    if (tenantUser && systemUser) {
      throw new InternalServerErrorException(
        `Data integrity violation: AuthAccount ${authAccountId} backs both a TenantUser and a SystemUser.`,
      );
    }

    if (tenantUser) {
      return this.mapTenantUserToActor(tenantUser);
    }
    if (systemUser) {
      return this.mapSystemUserToActor(systemUser);
    }
    return null;
  }

  private mapTenantUserToActor(tenantUser: TenantUserRow): ResolvedActor {
    return {
      authAccountId: tenantUser.authAccountId,
      passwordHash: tenantUser.authAccount.passwordHash,
      isActive: tenantUser.authAccount.isActive && tenantUser.isActive,
      actorType: ActorType.TENANT,
      tenantId: tenantUser.tenantId,
      tenantUserId: tenantUser.id,
      email: tenantUser.authAccount.email,
      name: tenantUser.name,
      roles: tenantUser.roles.map((role) => role.name),
      permissions: this.flattenPermissions(tenantUser.roles),
    };
  }

  private mapSystemUserToActor(systemUser: SystemUserRow): ResolvedActor {
    return {
      authAccountId: systemUser.authAccountId,
      passwordHash: systemUser.authAccount.passwordHash,
      isActive: systemUser.authAccount.isActive && systemUser.isActive,
      actorType: ActorType.SYSTEM,
      systemUserId: systemUser.id,
      email: systemUser.authAccount.email,
      name: systemUser.name,
      roles: systemUser.roles.map((role) => role.name),
      permissions: this.flattenPermissions(systemUser.roles),
    };
  }

  private flattenPermissions(
    roles: Array<{
      rolePermissions: Array<{ permission: { code: string } }>;
    }>,
  ): string[] {
    const codes = new Set<string>();
    for (const role of roles) {
      for (const rolePermission of role.rolePermissions) {
        codes.add(rolePermission.permission.code);
      }
    }
    return Array.from(codes);
  }

  private async issueTokens(actor: ResolvedActor): Promise<AuthTokensDto> {
    const accessExpiresIn = this.configService.get<string>(
      'JWT_ACCESS_EXPIRES_IN',
      '15m',
    );

    const payload: AccessTokenPayload = {
      sub: actor.authAccountId,
      actorType: actor.actorType,
      tenantId: actor.tenantId,
      tenantUserId: actor.tenantUserId,
      systemUserId: actor.systemUserId,
      email: actor.email,
      name: actor.name,
      roles: actor.roles,
      permissions: actor.permissions,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: accessExpiresIn,
    });

    const refreshToken = await this.issueRefreshToken(actor.authAccountId);

    return {
      accessToken,
      refreshToken,
      expiresIn: this.durationToSeconds(accessExpiresIn),
    };
  }

  private async issueRefreshToken(authAccountId: string): Promise<string> {
    const refreshExpiresIn = this.configService.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
      '7d',
    );

    const payload: RefreshTokenPayload = {
      sub: authAccountId,
      jti: randomUUID(),
    };

    const token = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: refreshExpiresIn,
    });

    const expiresAt = new Date(
      Date.now() + this.durationToSeconds(refreshExpiresIn) * 1000,
    );

    await this.prisma.refreshToken.create({
      data: {
        authAccountId,
        tokenHash: this.hashToken(token),
        expiresAt,
      },
    });

    return token;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Parses a jsonwebtoken-style duration string (e.g. "15m", "7d", "30s",
   * "1h") into whole seconds, for AuthTokensDto.expiresIn and refresh-token
   * expiresAt storage. Falls back to treating a bare numeric string as
   * seconds.
   */
  private durationToSeconds(value: string): number {
    const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(value.trim());
    if (!match) {
      throw new Error(`Invalid JWT expiry duration: "${value}"`);
    }

    const amount = Number(match[1]);
    const unit = (match[2] ?? 's').toLowerCase();
    const unitSeconds: Record<string, number> = {
      s: 1,
      m: 60,
      h: 60 * 60,
      d: 60 * 60 * 24,
    };

    return amount * unitSeconds[unit];
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException({
      error: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password',
    });
  }

  private invalidRefreshToken(): UnauthorizedException {
    return new UnauthorizedException({
      error: 'INVALID_REFRESH_TOKEN',
      message: 'Invalid or expired refresh token',
    });
  }
}
