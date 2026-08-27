import { createHash } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import {
  ActorType,
  AuthAuditEvent,
  AuthenticatedUserDto,
  TENANT_USER_INVITE_PERMISSION,
  USER_INVITE_TTL_HOURS,
  UserInviteStatus,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailDeliveryService } from '../../mail/email-delivery.service';
import { AuthAuditService } from '../auth/auth-audit.service';
import { TenantUserDirectoryService } from './tenant-user-directory.service';
import { UserQuotaService } from './user-quota.service';
import { UserInviteService } from './user-invite.service';

const TENANT_ID = 'tenant_1';
const ADMIN_ACCOUNT_ID = 'auth_admin';
const ADMIN_USER_ID = 'tu_admin';
const ROLE_ID = 'role_editor';
const INVITE_ID = 'inv_1';
const INVITED_USER_ID = 'tu_invited';
const INVITED_ACCOUNT_ID = 'auth_invited';
const EMAIL = 'invitee@example.com';
const VALID_PASSWORD = 'Str0ng!Password';
const TOKEN = 'raw-invite-token';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function futureDate(hours = USER_INVITE_TTL_HOURS): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

interface PrismaMock {
  tenant: { findFirst: jest.Mock };
  role: { findFirst: jest.Mock };
  authAccount: { create: jest.Mock; update: jest.Mock };
  tenantUser: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  userInvite: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    updateMany: jest.Mock;
  };
  $transaction: jest.Mock;
}

function inviteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVITE_ID,
    tenantId: TENANT_ID,
    email: EMAIL,
    roleId: ROLE_ID,
    tenantUserId: INVITED_USER_ID,
    status: UserInviteStatus.PENDING,
    expiresAt: futureDate(),
    usedAt: null,
    revokedAt: null,
    invitedById: ADMIN_USER_ID,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    role: { name: 'Editor' },
    ...overrides,
  };
}

function createPrismaMock(): PrismaMock {
  let sequence = 0;

  const prisma: PrismaMock = {
    tenant: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: TENANT_ID, name: 'Acme Co' }),
    },
    role: { findFirst: jest.fn().mockResolvedValue({ id: ROLE_ID }) },
    authAccount: {
      create: jest
        .fn()
        .mockImplementation(() => ({ id: `auth_new_${++sequence}` })),
      update: jest.fn().mockResolvedValue({}),
    },
    tenantUser: {
      // No existing member: every address is free unless a test says so.
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(() => ({ id: `tu_new_${++sequence}` })),
      update: jest.fn().mockResolvedValue({}),
    },
    userInvite: {
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          inviteRow({ ...data, id: `inv_new_${++sequence}` }),
        ),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn().mockResolvedValue(inviteRow()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(),
  };

  prisma.$transaction.mockImplementation(
    (callback: (tx: PrismaMock) => unknown) => callback(prisma),
  );

  return prisma;
}

function tenantAdmin(
  overrides: Partial<AuthenticatedUserDto> = {},
): AuthenticatedUserDto {
  return {
    authAccountId: ADMIN_ACCOUNT_ID,
    actorType: ActorType.TENANT,
    tenantId: TENANT_ID,
    tenantUserId: ADMIN_USER_ID,
    email: 'admin@example.com',
    name: 'Admin',
    roles: ['TENANT_ADMIN'],
    permissions: [TENANT_USER_INVITE_PERMISSION],
    ...overrides,
  };
}

describe('UserInviteService', () => {
  let prisma: PrismaMock;
  let userQuotaService: {
    assertSeatsAvailable: jest.Mock;
    getSeatUsage: jest.Mock;
  };
  let emailDeliveryService: {
    sendUserInvite: jest.Mock;
    createAcceptInviteUrl: jest.Mock;
  };
  let authAuditService: { record: jest.Mock };
  let service: UserInviteService;

  beforeEach(() => {
    prisma = createPrismaMock();
    userQuotaService = {
      assertSeatsAvailable: jest.fn().mockResolvedValue({
        usedSeats: 1,
        maxUsers: 10,
        remainingSeats: 9,
        unlimited: false,
      }),
      getSeatUsage: jest.fn().mockResolvedValue({
        usedSeats: 3,
        maxUsers: 10,
        remainingSeats: 7,
        unlimited: false,
      }),
    };
    emailDeliveryService = {
      sendUserInvite: jest.fn().mockResolvedValue({ delivered: true }),
      createAcceptInviteUrl: jest
        .fn()
        .mockImplementation(
          (token: string) =>
            `https://app.example.com/accept-invite?token=${token}`,
        ),
    };
    authAuditService = { record: jest.fn().mockResolvedValue(undefined) };

    service = new UserInviteService(
      prisma as unknown as PrismaService,
      userQuotaService as unknown as UserQuotaService,
      new TenantUserDirectoryService(prisma as unknown as PrismaService),
      emailDeliveryService as unknown as EmailDeliveryService,
      authAuditService as unknown as AuthAuditService,
    );
  });

  describe('createInvites', () => {
    it('creates one inactive membership and one invite per address', async () => {
      const result = await service.createInvites(
        {
          emails: ['First@Example.com', 'second@example.com'],
          roleId: ROLE_ID,
        },
        tenantAdmin(),
      );

      expect(result.invites).toHaveLength(2);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.tenantUser.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            status: 'pending_invite',
            isActive: false,
          }),
        }),
      );
      // The address is normalized on the way in, or nobody could log in
      // with it afterwards.
      expect(prisma.authAccount.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'first@example.com' }),
        }),
      );
      expect(result.seatUsage).toEqual(
        expect.objectContaining({ usedSeats: 3, remainingSeats: 7 }),
      );
    });

    /**
     * The whole point of the batch check: five invites into three free
     * seats create nothing at all rather than the first three.
     */
    it('checks the quota for the whole batch before writing anything', async () => {
      userQuotaService.assertSeatsAvailable.mockRejectedValue(
        new BadRequestException({
          error: 'QUOTA_EXCEEDED',
          message: 'no seats',
        }),
      );

      await expect(
        service.createInvites(
          { emails: ['a@example.com', 'b@example.com', 'c@example.com'] },
          tenantAdmin(),
        ),
      ).rejects.toMatchObject({ response: { error: 'QUOTA_EXCEEDED' } });

      expect(userQuotaService.assertSeatsAvailable).toHaveBeenCalledWith(
        TENANT_ID,
        3,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.authAccount.create).not.toHaveBeenCalled();
      expect(prisma.userInvite.create).not.toHaveBeenCalled();
    });

    /**
     * Caught up front rather than halfway through the transaction, where
     * the second copy would collide with the membership the first had just
     * created and be reported as an existing member.
     */
    it('rejects a batch naming the same address twice', async () => {
      await expect(
        service.createInvites(
          { emails: ['dup@example.com', 'DUP@example.com'] },
          tenantAdmin(),
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('fails the whole batch when one address already belongs to the tenant', async () => {
      prisma.tenantUser.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'tu_existing',
          authAccountId: 'auth_existing',
          status: 'active',
        });

      const attempt = service.createInvites(
        { emails: ['fresh@example.com', 'taken@example.com'] },
        tenantAdmin(),
      );

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toMatchObject({
        response: { error: 'EMAIL_ALREADY_EXISTS' },
      });

      // The conflict is raised inside the transaction, so the row written
      // for the address before it never commits.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.userInvite.create).toHaveBeenCalledTimes(1);
    });

    /**
     * The raw token leaves the server exactly twice -- in this response and
     * in the email. What is persisted is its SHA-256 hash, so nothing can
     * read it back afterwards.
     */
    it('persists only a hash and returns the raw token once', async () => {
      const { invites } = await service.createInvites(
        { emails: [EMAIL] },
        tenantAdmin(),
      );

      const [invite] = invites;
      const [{ data }] = prisma.userInvite.create.mock.calls[0] as [
        { data: { tokenHash: string; expiresAt: Date; status: string } },
      ];

      expect(data.tokenHash).toBe(sha256(invite.inviteToken));
      expect(data.tokenHash).not.toBe(invite.inviteToken);
      expect(data.status).toBe(UserInviteStatus.PENDING);
      expect(JSON.stringify(invite)).not.toContain(data.tokenHash);
      expect(invite.acceptUrl).toContain(
        `accept-invite?token=${invite.inviteToken}`,
      );
    });

    it('expires the token 72 hours out', async () => {
      const before = Date.now();
      await service.createInvites({ emails: [EMAIL] }, tenantAdmin());

      const [{ data }] = prisma.userInvite.create.mock.calls[0] as [
        { data: { expiresAt: Date } },
      ];
      const ttlMs = data.expiresAt.getTime() - before;

      expect(ttlMs).toBeGreaterThan((USER_INVITE_TTL_HOURS - 1) * 3_600_000);
      expect(ttlMs).toBeLessThanOrEqual(
        USER_INVITE_TTL_HOURS * 3_600_000 + 1_000,
      );
    });

    it('never puts the token in the audit trail', async () => {
      const { invites } = await service.createInvites(
        { emails: [EMAIL] },
        tenantAdmin(),
      );

      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          event: AuthAuditEvent.USER_INVITE_SENT,
          tenantId: TENANT_ID,
          actorAuthAccountId: ADMIN_ACCOUNT_ID,
        }),
      );
      expect(JSON.stringify(authAuditService.record.mock.calls)).not.toContain(
        invites[0].inviteToken,
      );
    });

    it('mails the invitation and reports a failed delivery without failing', async () => {
      emailDeliveryService.sendUserInvite.mockResolvedValue({
        delivered: false,
        errorCode: 'SMTP_NOT_CONFIGURED',
      });

      const { invites } = await service.createInvites(
        { emails: [EMAIL] },
        tenantAdmin(),
      );

      expect(invites[0].emailDelivered).toBe(false);
      expect(emailDeliveryService.sendUserInvite).toHaveBeenCalledWith(
        EMAIL,
        'Acme Co',
        invites[0].inviteToken,
        USER_INVITE_TTL_HOURS,
      );
    });

    it('rejects a role that does not belong to the tenant', async () => {
      prisma.role.findFirst.mockResolvedValue(null);

      await expect(
        service.createInvites(
          { emails: [EMAIL], roleId: 'role_of_another_tenant' },
          tenantAdmin(),
        ),
      ).rejects.toMatchObject({ response: { error: 'VALIDATION_ERROR' } });

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses a caller who is not inside a tenant', async () => {
      await expect(
        service.createInvites(
          { emails: [EMAIL] },
          tenantAdmin({ actorType: ActorType.SYSTEM, tenantId: undefined }),
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(userQuotaService.assertSeatsAvailable).not.toHaveBeenCalled();
    });
  });

  describe('listInvites', () => {
    it('reports an elapsed pending invite as expired and returns no token', async () => {
      prisma.userInvite.findMany.mockResolvedValue([
        inviteRow({ expiresAt: futureDate(-1) }),
        inviteRow({ id: 'inv_2', status: UserInviteStatus.USED }),
      ]);

      const invites = await service.listInvites(tenantAdmin());

      expect(invites[0].status).toBe(UserInviteStatus.EXPIRED);
      expect(invites[1].status).toBe(UserInviteStatus.USED);
      expect(invites[0]).not.toHaveProperty('inviteToken');
      expect(invites[0]).not.toHaveProperty('tokenHash');
      expect(prisma.userInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: TENANT_ID } }),
      );
    });
  });

  describe('resendInvite', () => {
    it('retires the old invite and issues a fresh token to the same address', async () => {
      prisma.userInvite.findFirst.mockResolvedValue(inviteRow());

      const result = await service.resendInvite(INVITE_ID, tenantAdmin());

      expect(prisma.userInvite.updateMany).toHaveBeenCalledWith({
        where: { id: INVITE_ID, status: UserInviteStatus.PENDING },
        data: {
          status: UserInviteStatus.REVOKED,
          revokedAt: expect.any(Date),
        },
      });

      const [{ data }] = prisma.userInvite.create.mock.calls[0] as [
        { data: { tokenHash: string; tenantUserId: string; email: string } },
      ];
      expect(data.tokenHash).toBe(sha256(result.inviteToken));
      expect(data.tenantUserId).toBe(INVITED_USER_ID);
      expect(data.email).toBe(EMAIL);
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ event: AuthAuditEvent.USER_INVITE_RESENT }),
      );
    });

    /**
     * Expiry already freed the seat, so resending claims one again -- and a
     * tenant that has filled up in the meantime cannot have it.
     */
    it('re-checks the quota only when the invite had already expired', async () => {
      prisma.userInvite.findFirst.mockResolvedValue(inviteRow());
      await service.resendInvite(INVITE_ID, tenantAdmin());
      expect(userQuotaService.assertSeatsAvailable).not.toHaveBeenCalled();

      prisma.userInvite.findFirst.mockResolvedValue(
        inviteRow({ expiresAt: futureDate(-1) }),
      );
      await service.resendInvite(INVITE_ID, tenantAdmin());
      expect(userQuotaService.assertSeatsAvailable).toHaveBeenCalledWith(
        TENANT_ID,
        1,
      );
    });

    it('refuses to resend an invite that was already redeemed', async () => {
      prisma.userInvite.findFirst.mockResolvedValue(
        inviteRow({ status: UserInviteStatus.USED, usedAt: new Date() }),
      );

      await expect(
        service.resendInvite(INVITE_ID, tenantAdmin()),
      ).rejects.toMatchObject({ response: { error: 'INVITE_NOT_PENDING' } });

      expect(prisma.userInvite.create).not.toHaveBeenCalled();
    });

    /**
     * The tenant filter on the lookup is the isolation boundary: another
     * tenant's invite does not resolve, so the route reads as missing
     * rather than forbidden and cannot be used to discover ids elsewhere.
     */
    it('cannot reach an invite of another tenant', async () => {
      prisma.userInvite.findFirst.mockResolvedValue(null);

      await expect(
        service.resendInvite(INVITE_ID, tenantAdmin()),
      ).rejects.toMatchObject({ response: { error: 'INVITE_NOT_FOUND' } });

      expect(prisma.userInvite.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: INVITE_ID, tenantId: TENANT_ID },
        }),
      );
    });
  });

  describe('revokeInvite', () => {
    it('revokes the invite, soft-deletes the membership and frees the seat', async () => {
      prisma.userInvite.findFirst.mockResolvedValue(inviteRow());
      prisma.userInvite.findUniqueOrThrow.mockResolvedValue(
        inviteRow({
          status: UserInviteStatus.REVOKED,
          revokedAt: new Date(),
        }),
      );

      const result = await service.revokeInvite(INVITE_ID, tenantAdmin());

      expect(result.status).toBe(UserInviteStatus.REVOKED);
      expect(prisma.tenantUser.update).toHaveBeenCalledWith({
        where: { id: INVITED_USER_ID },
        data: { status: 'deleted', isActive: false },
      });
      // Any second live invite for the same person would otherwise keep
      // both the seat and a redeemable token alive.
      expect(prisma.userInvite.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantUserId: INVITED_USER_ID,
            id: { not: INVITE_ID },
            status: UserInviteStatus.PENDING,
          }),
        }),
      );
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ event: AuthAuditEvent.USER_INVITE_REVOKED }),
      );
    });

    it('changes nothing when the invite is already revoked', async () => {
      prisma.userInvite.findFirst.mockResolvedValue(
        inviteRow({
          status: UserInviteStatus.REVOKED,
          revokedAt: new Date(),
        }),
      );

      await expect(
        service.revokeInvite(INVITE_ID, tenantAdmin()),
      ).resolves.toMatchObject({ status: UserInviteStatus.REVOKED });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
    });

    /** Removing an active member is user deletion, not invite management. */
    it('refuses to revoke a redeemed invite', async () => {
      prisma.userInvite.findFirst.mockResolvedValue(
        inviteRow({ status: UserInviteStatus.USED, usedAt: new Date() }),
      );

      await expect(
        service.revokeInvite(INVITE_ID, tenantAdmin()),
      ).rejects.toMatchObject({ response: { error: 'INVITE_NOT_PENDING' } });

      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
    });
  });

  describe('redeemInvite', () => {
    function liveInvite(overrides: Record<string, unknown> = {}) {
      return {
        id: INVITE_ID,
        tenantId: TENANT_ID,
        email: EMAIL,
        roleId: ROLE_ID,
        tenantUserId: INVITED_USER_ID,
        status: UserInviteStatus.PENDING,
        expiresAt: futureDate(),
        tenant: { status: 'ACTIVE' },
        ...overrides,
      };
    }

    function redeemBody(overrides: Record<string, string> = {}) {
      return {
        token: TOKEN,
        fullName: 'Invited Person',
        password: VALID_PASSWORD,
        confirmPassword: VALID_PASSWORD,
        ...overrides,
      };
    }

    beforeEach(() => {
      prisma.userInvite.findUnique.mockResolvedValue(liveInvite());
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: INVITED_USER_ID,
        authAccountId: INVITED_ACCOUNT_ID,
      });
    });

    it('sets the password, activates the membership and grants the invited role', async () => {
      await expect(service.redeemInvite(redeemBody())).resolves.toEqual({
        tenantId: TENANT_ID,
        userId: INVITED_USER_ID,
        email: EMAIL,
        status: 'active',
      });

      // Looked up by hash: the raw token never reaches a query.
      expect(prisma.userInvite.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: sha256(TOKEN) } }),
      );

      const [{ data: accountData }] = prisma.authAccount.update.mock.calls[0];
      await expect(
        bcrypt.compare(VALID_PASSWORD, accountData.passwordHash),
      ).resolves.toBe(true);
      expect(accountData.mustChangePassword).toBe(false);

      expect(prisma.tenantUser.update).toHaveBeenCalledWith({
        where: { id: INVITED_USER_ID },
        data: {
          name: 'Invited Person',
          status: 'active',
          isActive: true,
          roles: { connect: { id: ROLE_ID } },
        },
      });
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          event: AuthAuditEvent.USER_INVITE_REDEEMED,
          subjectAuthAccountId: INVITED_ACCOUNT_ID,
        }),
      );
    });

    it('consumes the invite conditionally and revokes its siblings', async () => {
      await service.redeemInvite(redeemBody());

      expect(prisma.userInvite.updateMany).toHaveBeenNthCalledWith(1, {
        where: {
          id: INVITE_ID,
          status: UserInviteStatus.PENDING,
          expiresAt: { gt: expect.any(Date) },
        },
        data: { status: UserInviteStatus.USED, usedAt: expect.any(Date) },
      });
      expect(prisma.userInvite.updateMany).toHaveBeenNthCalledWith(2, {
        where: {
          tenantUserId: INVITED_USER_ID,
          id: { not: INVITE_ID },
          status: UserInviteStatus.PENDING,
        },
        data: {
          status: UserInviteStatus.REVOKED,
          revokedAt: expect.any(Date),
        },
      });
    });

    /**
     * Unknown, expired, revoked, already used and racing redemptions all
     * answer the same 401, so the public endpoint cannot be used to probe
     * which invites exist.
     */
    it.each([
      ['unknown', null],
      ['expired', liveInvite({ expiresAt: futureDate(-1) })],
      ['revoked', liveInvite({ status: UserInviteStatus.REVOKED })],
      ['already used', liveInvite({ status: UserInviteStatus.USED })],
      ['without a membership', liveInvite({ tenantUserId: null })],
      ['into a suspended tenant', liveInvite({ tenant: { status: 'FAILED' } })],
    ])('answers the same 401 for a %s token', async (_label, invite) => {
      prisma.userInvite.findUnique.mockResolvedValue(invite);

      await expect(service.redeemInvite(redeemBody())).rejects.toMatchObject({
        status: 401,
        response: { error: 'INVITE_TOKEN_EXPIRED' },
      });

      expect(prisma.authAccount.update).not.toHaveBeenCalled();
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
    });

    /**
     * The conditional consume is the concurrency guard: the request that
     * updates no row is a replay of one that already succeeded, and gets
     * the same opaque answer.
     */
    it('loses a race without activating anything', async () => {
      prisma.userInvite.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.redeemInvite(redeemBody())).rejects.toThrow(
        UnauthorizedException,
      );

      expect(prisma.authAccount.update).not.toHaveBeenCalled();
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
    });

    it('answers the same 401 when the membership was deleted underneath it', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);

      await expect(service.redeemInvite(redeemBody())).rejects.toMatchObject({
        response: { error: 'INVITE_TOKEN_EXPIRED' },
      });
    });

    it('rejects a password that breaks the policy before reading anything', async () => {
      await expect(
        service.redeemInvite(
          redeemBody({ password: 'weak', confirmPassword: 'weak' }),
        ),
      ).rejects.toMatchObject({
        response: { error: 'PASSWORD_POLICY_VIOLATION' },
      });

      expect(prisma.userInvite.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a confirmation that does not match', async () => {
      await expect(
        service.redeemInvite(
          redeemBody({ confirmPassword: `${VALID_PASSWORD}x` }),
        ),
      ).rejects.toMatchObject({ response: { error: 'VALIDATION_ERROR' } });

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a blank full name', async () => {
      await expect(
        service.redeemInvite(redeemBody({ fullName: '   ' })),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('leaves the role alone when the invite named none', async () => {
      prisma.userInvite.findUnique.mockResolvedValue(
        liveInvite({ roleId: null }),
      );

      await service.redeemInvite(redeemBody());

      expect(prisma.tenantUser.update).toHaveBeenCalledWith({
        where: { id: INVITED_USER_ID },
        data: {
          name: 'Invited Person',
          status: 'active',
          isActive: true,
        },
      });
    });
  });

  it('never exposes an invite token through a not-found lookup', async () => {
    prisma.userInvite.findFirst.mockResolvedValue(null);

    await expect(
      service.revokeInvite('inv_missing', tenantAdmin()),
    ).rejects.toThrow(NotFoundException);
  });
});
