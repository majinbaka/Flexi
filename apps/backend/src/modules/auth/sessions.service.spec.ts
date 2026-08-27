import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  ActorType,
  AuthAuditEvent,
  AuthenticatedUserDto,
  SYSTEM_SESSION_MANAGE_PERMISSION,
  SYSTEM_USER_MANAGE_PERMISSION,
  TENANT_SESSION_MANAGE_PERMISSION,
  TENANT_USER_MANAGE_PERMISSION,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthAuditService } from './auth-audit.service';
import { SessionsService } from './sessions.service';

const TENANT_ID = 'tenant_1';
const CALLER_ACCOUNT_ID = 'auth_caller';
const OTHER_ACCOUNT_ID = 'auth_other';
const CURRENT_SESSION_ID = 'session_current';

interface PrismaMock {
  refreshToken: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
  };
  tenantUser: { findFirst: jest.Mock };
  systemUser: { findFirst: jest.Mock };
}

function createPrismaMock(): PrismaMock {
  return {
    refreshToken: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    tenantUser: { findFirst: jest.fn().mockResolvedValue(null) },
    systemUser: { findFirst: jest.fn().mockResolvedValue(null) },
  };
}

function tenantCaller(
  overrides: Partial<AuthenticatedUserDto> = {},
): AuthenticatedUserDto {
  return {
    authAccountId: CALLER_ACCOUNT_ID,
    actorType: ActorType.TENANT,
    tenantId: TENANT_ID,
    tenantUserId: 'tu_1',
    email: 'caller@example.com',
    name: 'Caller',
    roles: ['TENANT_ADMIN'],
    permissions: [TENANT_SESSION_MANAGE_PERMISSION],
    sessionId: CURRENT_SESSION_ID,
    ...overrides,
  };
}

function systemCaller(
  overrides: Partial<AuthenticatedUserDto> = {},
): AuthenticatedUserDto {
  return {
    authAccountId: CALLER_ACCOUNT_ID,
    actorType: ActorType.SYSTEM,
    systemUserId: 'su_1',
    email: 'root@example.com',
    name: 'Root',
    roles: ['SUPER_ADMIN'],
    permissions: [SYSTEM_SESSION_MANAGE_PERMISSION],
    sessionId: CURRENT_SESSION_ID,
    ...overrides,
  };
}

describe('SessionsService', () => {
  let prisma: PrismaMock;
  let authAuditService: { record: jest.Mock };
  let service: SessionsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    authAuditService = { record: jest.fn().mockResolvedValue(undefined) };
    service = new SessionsService(
      prisma as unknown as PrismaService,
      authAuditService as unknown as AuthAuditService,
    );
  });

  describe('listSessions', () => {
    it('returns only the caller`s live sessions, flagging the current one', async () => {
      const createdAt = new Date('2026-08-20T10:00:00.000Z');
      const expiresAt = new Date('2026-08-27T10:00:00.000Z');
      prisma.refreshToken.findMany.mockResolvedValue([
        { id: CURRENT_SESSION_ID, createdAt, expiresAt },
        { id: 'session_other_device', createdAt, expiresAt },
      ]);

      await expect(service.listSessions(tenantCaller())).resolves.toEqual({
        sessions: [
          {
            id: CURRENT_SESSION_ID,
            createdAt: createdAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            current: true,
          },
          {
            id: 'session_other_device',
            createdAt: createdAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            current: false,
          },
        ],
      });

      expect(prisma.refreshToken.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            authAccountId: CALLER_ACCOUNT_ID,
            revokedAt: null,
            expiresAt: { gt: expect.any(Date) },
          },
        }),
      );
    });

    /**
     * The whole point of the endpoint is that a holder can recognise and
     * kill a session -- which needs its id and timestamps, never the token
     * or its hash.
     */
    it('never selects the token or its hash', async () => {
      await service.listSessions(tenantCaller());

      const [{ select }] = prisma.refreshToken.findMany.mock.calls[0];
      expect(select).toEqual({ id: true, createdAt: true, expiresAt: true });
    });

    it('flags nothing as current when the token predates session management', async () => {
      const createdAt = new Date();
      const expiresAt = new Date(Date.now() + 1000);
      prisma.refreshToken.findMany.mockResolvedValue([
        { id: CURRENT_SESSION_ID, createdAt, expiresAt },
      ]);

      const result = await service.listSessions(
        tenantCaller({ sessionId: undefined }),
      );

      expect(result.sessions[0].current).toBe(false);
    });
  });

  describe('revokeSession', () => {
    it('revokes the caller`s own session', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'session_a',
        authAccountId: CALLER_ACCOUNT_ID,
      });

      await expect(
        service.revokeSession('session_a', tenantCaller()),
      ).resolves.toEqual({ revokedCount: 1 });

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'session_a', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          event: AuthAuditEvent.SESSION_REVOKED,
          subjectAuthAccountId: CALLER_ACCOUNT_ID,
          actorAuthAccountId: null,
          metadata: { revokedCount: 1, self: true },
        }),
      );
    });

    /**
     * `revokedAt: null` in the WHERE clause makes a repeat call report zero
     * rather than resurrecting and re-revoking the row.
     */
    it('is idempotent for an already-revoked session', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'session_a',
        authAccountId: CALLER_ACCOUNT_ID,
      });
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.revokeSession('session_a', tenantCaller()),
      ).resolves.toEqual({ revokedCount: 0 });
    });

    it('rejects a caller without the session-manage permission', async () => {
      await expect(
        service.revokeSession('session_a', tenantCaller({ permissions: [] })),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
    });

    it('requires the SYSTEM-scope code from a SystemUser', async () => {
      await expect(
        service.revokeSession(
          'session_a',
          systemCaller({ permissions: [TENANT_SESSION_MANAGE_PERMISSION] }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('reports an unknown session id as not found', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(
        service.revokeSession('session_missing', tenantCaller()),
      ).rejects.toThrow(NotFoundException);
    });

    /**
     * Somebody else's session answers SESSION_NOT_FOUND rather than
     * FORBIDDEN, so the endpoint cannot be used to probe which session ids
     * exist on other accounts.
     */
    it('hides another account`s session behind SESSION_NOT_FOUND', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'session_b',
        authAccountId: OTHER_ACCOUNT_ID,
      });

      await expect(
        service.revokeSession('session_b', tenantCaller()),
      ).rejects.toMatchObject({
        response: { error: 'SESSION_NOT_FOUND' },
      });
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('lets a tenant admin revoke a session of their own tenant`s user', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'session_b',
        authAccountId: OTHER_ACCOUNT_ID,
      });
      prisma.tenantUser.findFirst.mockResolvedValue({ id: 'tu_2' });

      await expect(
        service.revokeSession(
          'session_b',
          tenantCaller({
            permissions: [
              TENANT_SESSION_MANAGE_PERMISSION,
              TENANT_USER_MANAGE_PERMISSION,
            ],
          }),
        ),
      ).resolves.toEqual({ revokedCount: 1 });

      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            authAccountId: OTHER_ACCOUNT_ID,
            tenantId: TENANT_ID,
          },
        }),
      );
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectAuthAccountId: OTHER_ACCOUNT_ID,
          actorAuthAccountId: CALLER_ACCOUNT_ID,
          metadata: { revokedCount: 1, self: false },
        }),
      );
    });

    /**
     * The tenant filter on the lookup is what stops an admin of tenant A
     * reaching into tenant B: no matching TenantUser, so the session stays
     * invisible.
     */
    it('stops a tenant admin from reaching another tenant', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'session_b',
        authAccountId: OTHER_ACCOUNT_ID,
      });
      prisma.tenantUser.findFirst.mockResolvedValue(null);

      await expect(
        service.revokeSession(
          'session_b',
          tenantCaller({
            permissions: [
              TENANT_SESSION_MANAGE_PERMISSION,
              TENANT_USER_MANAGE_PERMISSION,
            ],
          }),
        ),
      ).rejects.toMatchObject({ response: { error: 'SESSION_NOT_FOUND' } });
    });

    it('lets a system admin revoke another SystemUser`s session', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'session_b',
        authAccountId: OTHER_ACCOUNT_ID,
      });
      prisma.systemUser.findFirst.mockResolvedValue({ id: 'su_2' });

      await expect(
        service.revokeSession(
          'session_b',
          systemCaller({
            permissions: [
              SYSTEM_SESSION_MANAGE_PERMISSION,
              SYSTEM_USER_MANAGE_PERMISSION,
            ],
          }),
        ),
      ).resolves.toEqual({ revokedCount: 1 });
    });
  });

  describe('revokeAllSessions', () => {
    it('revokes every live session of the calling account', async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 4 });

      await expect(
        service.revokeAllSessions({}, tenantCaller()),
      ).resolves.toEqual({ revokedCount: 4 });

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { authAccountId: CALLER_ACCOUNT_ID, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          event: AuthAuditEvent.ALL_SESSIONS_REVOKED,
          metadata: { revokedCount: 4, keptCurrent: false },
        }),
      );
    });

    it('spares the requesting session when keepCurrent is set', async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 3 });

      await expect(
        service.revokeAllSessions({ keepCurrent: true }, tenantCaller()),
      ).resolves.toEqual({ revokedCount: 3 });

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: {
          authAccountId: CALLER_ACCOUNT_ID,
          revokedAt: null,
          id: { not: CURRENT_SESSION_ID },
        },
        data: { revokedAt: expect.any(Date) },
      });
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { revokedCount: 3, keptCurrent: true },
        }),
      );
    });

    /**
     * A token minted before session management landed names no session, so
     * there is nothing to spare. Revoking everything is the safe reading of
     * "revoke all" -- and such a token is at most fifteen minutes old.
     */
    it('revokes everything when keepCurrent is asked for but unidentifiable', async () => {
      await service.revokeAllSessions(
        { keepCurrent: true },
        tenantCaller({ sessionId: undefined }),
      );

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { authAccountId: CALLER_ACCOUNT_ID, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ keptCurrent: false }),
        }),
      );
    });

    /**
     * It can only ever act on the caller's own account, so there is nobody
     * to authorise it against -- a valid token is the whole requirement.
     */
    it('needs no permission beyond a valid token', async () => {
      await expect(
        service.revokeAllSessions({}, tenantCaller({ permissions: [] })),
      ).resolves.toEqual({ revokedCount: 1 });
    });
  });
});
