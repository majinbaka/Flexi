import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ActorType,
  AUTH_ERROR_CODES,
  AuthAuditEvent,
  AuthenticatedUserDto,
  ListSessionsResponseDto,
  RevokeSessionsResponseDto,
  SYSTEM_SESSION_MANAGE_PERMISSION,
  SYSTEM_USER_MANAGE_PERMISSION,
  TENANT_SESSION_MANAGE_PERMISSION,
  TENANT_USER_MANAGE_PERMISSION,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthAuditService } from './auth-audit.service';
import { RevokeAllSessionsDto } from './dto/revoke-all-sessions.dto';

/**
 * Session inventory and revocation.
 *
 * A "session" is one `RefreshToken` row. Revoking it revokes nothing else:
 * the access token already in the holder's hands stays valid until it
 * expires, at most fifteen minutes later. That is a deliberate contract
 * decision, not an oversight -- the specification rules out a blacklist or
 * a Redis-backed revocation list, so the refresh token is the only thing
 * with server-side state to revoke.
 *
 * Permissions are resolved from `actorType` inside the service rather than
 * through a static `@RequirePermissions()` decorator, because a tenant Role
 * can never hold a SYSTEM-scope permission and vice versa -- so each
 * operation has a TENANT/SYSTEM pair of codes and only the request knows
 * which applies. `AuthService.me()` already picks between `auth.me.read`
 * and `system.me.read` the same way.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authAuditService: AuthAuditService,
  ) {}

  /**
   * Lists the caller's own live sessions. Carries no token and no token
   * hash -- recognising and killing a session needs only its id and its
   * timestamps.
   */
  async listSessions(
    currentUser: AuthenticatedUserDto,
  ): Promise<ListSessionsResponseDto> {
    const sessions = await this.prisma.refreshToken.findMany({
      where: {
        authAccountId: currentUser.authAccountId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, expiresAt: true },
    });

    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        current: session.id === currentUser.sessionId,
      })),
    };
  }

  /**
   * Revokes one session. The caller may always revoke their own; revoking
   * somebody else's additionally requires the actor-scoped user-management
   * permission and, for a tenant caller, that the target belongs to the
   * same tenant.
   *
   * Anything the caller is not allowed to touch answers `SESSION_NOT_FOUND`
   * rather than `FORBIDDEN`, so the endpoint cannot be used to probe which
   * session ids exist on other accounts.
   */
  async revokeSession(
    sessionId: string,
    currentUser: AuthenticatedUserDto,
  ): Promise<RevokeSessionsResponseDto> {
    this.assertCanManageSessions(currentUser);

    const session = await this.prisma.refreshToken.findUnique({
      where: { id: sessionId },
      select: { id: true, authAccountId: true },
    });

    if (!session) {
      throw this.sessionNotFound();
    }

    const isSelf = session.authAccountId === currentUser.authAccountId;
    if (
      !isSelf &&
      !(await this.canManageAccount(currentUser, session.authAccountId))
    ) {
      throw this.sessionNotFound();
    }

    // `revokedAt: null` in the WHERE clause makes this idempotent: revoking
    // an already-revoked session reports zero rather than resurrecting and
    // re-revoking it.
    const revoked = await this.prisma.refreshToken.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.authAuditService.record({
      event: AuthAuditEvent.SESSION_REVOKED,
      tenantId: currentUser.tenantId ?? null,
      subjectAuthAccountId: session.authAccountId,
      actorAuthAccountId: isSelf ? null : currentUser.authAccountId,
      metadata: { revokedCount: revoked.count, self: isSelf },
    });

    return { revokedCount: revoked.count };
  }

  /**
   * Revokes every live session of the calling account, optionally sparing
   * the one making the request.
   *
   * Needs no permission beyond a valid access token: it can only ever act
   * on the caller's own account, so there is nobody to authorise it
   * against.
   */
  async revokeAllSessions(
    dto: RevokeAllSessionsDto,
    currentUser: AuthenticatedUserDto,
  ): Promise<RevokeSessionsResponseDto> {
    // An access token minted before session management landed carries no
    // `sessionId`, so there is no way to tell which row to spare. Such a
    // token is at most fifteen minutes old, so this only applies inside a
    // deploy window -- and revoking everything is the safe reading of
    // "revoke all", not the surprising one.
    const keptSessionId = dto.keepCurrent ? currentUser.sessionId : undefined;

    const revoked = await this.prisma.refreshToken.updateMany({
      where: {
        authAccountId: currentUser.authAccountId,
        revokedAt: null,
        ...(keptSessionId ? { id: { not: keptSessionId } } : {}),
      },
      data: { revokedAt: new Date() },
    });

    await this.authAuditService.record({
      event: AuthAuditEvent.ALL_SESSIONS_REVOKED,
      tenantId: currentUser.tenantId ?? null,
      subjectAuthAccountId: currentUser.authAccountId,
      metadata: {
        revokedCount: revoked.count,
        keptCurrent: Boolean(keptSessionId),
      },
    });

    return { revokedCount: revoked.count };
  }

  private assertCanManageSessions(currentUser: AuthenticatedUserDto): void {
    const required =
      currentUser.actorType === ActorType.TENANT
        ? TENANT_SESSION_MANAGE_PERMISSION
        : SYSTEM_SESSION_MANAGE_PERMISSION;

    if (!currentUser.permissions.includes(required)) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: 'Insufficient permissions',
      });
    }
  }

  /**
   * Whether the caller may act on somebody else's account. Requires the
   * actor-scoped user-management permission, and -- for a tenant caller --
   * that the target is a TenantUser of the caller's own tenant, so an admin
   * of tenant A can never reach into tenant B.
   */
  private async canManageAccount(
    currentUser: AuthenticatedUserDto,
    targetAuthAccountId: string,
  ): Promise<boolean> {
    if (currentUser.actorType === ActorType.TENANT) {
      if (!currentUser.permissions.includes(TENANT_USER_MANAGE_PERMISSION)) {
        return false;
      }

      const target = await this.prisma.tenantUser.findFirst({
        where: {
          authAccountId: targetAuthAccountId,
          tenantId: currentUser.tenantId,
        },
        select: { id: true },
      });

      return Boolean(target);
    }

    if (!currentUser.permissions.includes(SYSTEM_USER_MANAGE_PERMISSION)) {
      return false;
    }

    const target = await this.prisma.systemUser.findFirst({
      where: { authAccountId: targetAuthAccountId },
      select: { id: true },
    });

    return Boolean(target);
  }

  private sessionNotFound(): NotFoundException {
    return new NotFoundException({
      error: AUTH_ERROR_CODES.SESSION_NOT_FOUND,
      message: 'No such session.',
    });
  }
}
