import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import {
  ActorType,
  AuthAuditEvent,
  AuthenticatedUserDto,
  SYSTEM_ACCOUNT_RESET_PASSWORD_PERMISSION,
  SYSTEM_USER_MANAGE_PERMISSION,
  TENANT_ACCOUNT_RESET_PASSWORD_PERMISSION,
  TENANT_USER_MANAGE_PERMISSION,
  validatePasswordStrength,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailDeliveryService } from '../../mail/email-delivery.service';
import { AuthAuditService } from '../auth/auth-audit.service';
import { AccountLifecycleService } from './account-lifecycle.service';

const TENANT_ID = 'tenant_1';
const ADMIN_ACCOUNT_ID = 'auth_admin';
const TARGET_USER_ID = 'tu_target';
const TARGET_ACCOUNT_ID = 'auth_target';
const TARGET_EMAIL = 'target@example.com';

interface PrismaMock {
  tenantUser: { findFirst: jest.Mock; update: jest.Mock };
  systemUser: { findFirst: jest.Mock; update: jest.Mock };
  authAccount: { update: jest.Mock };
  refreshToken: { updateMany: jest.Mock };
  passwordResetOtp: { updateMany: jest.Mock };
  $transaction: jest.Mock;
}

function createPrismaMock(): PrismaMock {
  const prisma: PrismaMock = {
    tenantUser: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    systemUser: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    authAccount: { update: jest.fn().mockResolvedValue({}) },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    passwordResetOtp: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
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
    tenantUserId: 'tu_admin',
    email: 'admin@example.com',
    name: 'Admin',
    roles: ['TENANT_ADMIN'],
    permissions: [
      TENANT_USER_MANAGE_PERMISSION,
      TENANT_ACCOUNT_RESET_PASSWORD_PERMISSION,
    ],
    ...overrides,
  };
}

function systemAdmin(
  overrides: Partial<AuthenticatedUserDto> = {},
): AuthenticatedUserDto {
  return {
    authAccountId: ADMIN_ACCOUNT_ID,
    actorType: ActorType.SYSTEM,
    systemUserId: 'su_admin',
    email: 'root@example.com',
    name: 'Root',
    roles: ['SUPER_ADMIN'],
    permissions: [
      SYSTEM_USER_MANAGE_PERMISSION,
      SYSTEM_ACCOUNT_RESET_PASSWORD_PERMISSION,
    ],
    ...overrides,
  };
}

function tenantTargetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_USER_ID,
    tenantId: TENANT_ID,
    authAccountId: TARGET_ACCOUNT_ID,
    isActive: true,
    authAccount: { email: TARGET_EMAIL },
    ...overrides,
  };
}

describe('AccountLifecycleService', () => {
  let prisma: PrismaMock;
  let emailDeliveryService: { sendTemporaryPassword: jest.Mock };
  let authAuditService: { record: jest.Mock };
  let service: AccountLifecycleService;

  beforeEach(() => {
    prisma = createPrismaMock();
    emailDeliveryService = {
      sendTemporaryPassword: jest.fn().mockResolvedValue({ delivered: true }),
    };
    authAuditService = { record: jest.fn().mockResolvedValue(undefined) };
    service = new AccountLifecycleService(
      prisma as unknown as PrismaService,
      emailDeliveryService as unknown as EmailDeliveryService,
      authAuditService as unknown as AuthAuditService,
    );
  });

  describe('deactivate', () => {
    it('marks the actor inactive and revokes every live session', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantTargetRow());

      await expect(
        service.deactivate(TARGET_USER_ID, tenantAdmin()),
      ).resolves.toEqual({
        userId: TARGET_USER_ID,
        actorType: ActorType.TENANT,
        isActive: false,
        revokedSessionCount: 2,
      });

      expect(prisma.tenantUser.update).toHaveBeenCalledWith({
        where: { id: TARGET_USER_ID },
        data: { isActive: false },
      });
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { authAccountId: TARGET_ACCOUNT_ID, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          event: AuthAuditEvent.ACCOUNT_DEACTIVATED,
          subjectAuthAccountId: TARGET_ACCOUNT_ID,
          actorAuthAccountId: ADMIN_ACCOUNT_ID,
        }),
      );
    });

    /**
     * Deactivating yourself removes the very permission you just used, with
     * no way back short of another admin.
     */
    it('refuses to deactivate the calling account', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        tenantTargetRow({ authAccountId: ADMIN_ACCOUNT_ID }),
      );

      await expect(
        service.deactivate(TARGET_USER_ID, tenantAdmin()),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a caller without the user-manage permission', async () => {
      await expect(
        service.deactivate(TARGET_USER_ID, tenantAdmin({ permissions: [] })),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.tenantUser.findFirst).not.toHaveBeenCalled();
    });

    it('requires the SYSTEM-scope code from a SystemUser', async () => {
      await expect(
        service.deactivate(
          TARGET_USER_ID,
          systemAdmin({ permissions: [TENANT_USER_MANAGE_PERMISSION] }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    /**
     * The tenant filter on the lookup is the isolation boundary: a user of
     * another tenant simply does not resolve, so it reads as missing rather
     * than forbidden and the route cannot be used to discover ids
     * elsewhere.
     */
    it('cannot reach a user of another tenant', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);

      await expect(
        service.deactivate(TARGET_USER_ID, tenantAdmin()),
      ).rejects.toMatchObject({ response: { error: 'USER_NOT_FOUND' } });

      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TARGET_USER_ID, tenantId: TENANT_ID },
        }),
      );
    });

    it('resolves a SystemUser for a system caller', async () => {
      prisma.systemUser.findFirst.mockResolvedValue({
        id: 'su_target',
        authAccountId: TARGET_ACCOUNT_ID,
        isActive: true,
        authAccount: { email: TARGET_EMAIL },
      });

      await expect(
        service.deactivate('su_target', systemAdmin()),
      ).resolves.toMatchObject({ actorType: ActorType.SYSTEM });

      expect(prisma.systemUser.update).toHaveBeenCalledWith({
        where: { id: 'su_target' },
        data: { isActive: false },
      });
      expect(prisma.tenantUser.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('activate', () => {
    it('marks the actor active and revokes nothing', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        tenantTargetRow({ isActive: false }),
      );

      await expect(
        service.activate(TARGET_USER_ID, tenantAdmin()),
      ).resolves.toEqual({
        userId: TARGET_USER_ID,
        actorType: ActorType.TENANT,
        isActive: true,
        revokedSessionCount: 0,
      });

      expect(prisma.tenantUser.update).toHaveBeenCalledWith({
        where: { id: TARGET_USER_ID },
        data: { isActive: true },
      });
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          event: AuthAuditEvent.ACCOUNT_ACTIVATED,
        }),
      );
    });

    it('rejects a caller without the user-manage permission', async () => {
      await expect(
        service.activate(TARGET_USER_ID, tenantAdmin({ permissions: [] })),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('forceResetPassword', () => {
    beforeEach(() => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantTargetRow());
    });

    it('scrambles the password, raises the flag and revokes every session', async () => {
      await expect(
        service.forceResetPassword(TARGET_USER_ID, {}, tenantAdmin()),
      ).resolves.toEqual({
        userId: TARGET_USER_ID,
        mustChangePassword: true,
        revokedSessionCount: 2,
        emailDelivered: true,
      });

      const [{ where, data }] = prisma.authAccount.update.mock.calls[0];
      expect(where).toEqual({ id: TARGET_ACCOUNT_ID });
      expect(data.mustChangePassword).toBe(true);
      expect(data.passwordHash).toMatch(/^\$2[aby]\$/);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { authAccountId: TARGET_ACCOUNT_ID, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('emails a temporary password that satisfies the password policy', async () => {
      await service.forceResetPassword(TARGET_USER_ID, {}, tenantAdmin());

      const [email, temporaryPassword] =
        emailDeliveryService.sendTemporaryPassword.mock.calls[0];
      expect(email).toBe(TARGET_EMAIL);
      expect(validatePasswordStrength(temporaryPassword)).toEqual([]);

      // The hash stored is of the password that was actually mailed.
      const [{ data }] = prisma.authAccount.update.mock.calls[0];
      await expect(
        bcrypt.compare(temporaryPassword, data.passwordHash),
      ).resolves.toBe(true);
    });

    /**
     * The temporary password leaves the server only through the mail
     * transport, so the administrator who triggered the reset cannot read
     * the credential they just created for somebody else.
     */
    it('keeps the temporary password out of the response and the audit row', async () => {
      const result = await service.forceResetPassword(
        TARGET_USER_ID,
        {},
        tenantAdmin(),
      );

      const [, temporaryPassword] =
        emailDeliveryService.sendTemporaryPassword.mock.calls[0];
      expect(JSON.stringify(result)).not.toContain(temporaryPassword);
      expect(JSON.stringify(authAuditService.record.mock.calls)).not.toContain(
        temporaryPassword,
      );
    });

    /**
     * A self-service code was issued against the password this call has
     * just replaced, so it must not survive it.
     */
    it('burns any outstanding self-service reset code', async () => {
      await service.forceResetPassword(TARGET_USER_ID, {}, tenantAdmin());

      expect(prisma.passwordResetOtp.updateMany).toHaveBeenCalledWith({
        where: { authAccountId: TARGET_ACCOUNT_ID, consumedAt: null },
        data: { consumedAt: expect.any(Date) },
      });
    });

    /**
     * With `sendEmail: false` the credential is still invalidated -- that
     * is the point of the operation -- but nothing is mailed, so the holder
     * recovers through the ordinary forgot-password flow.
     */
    it('still scrambles the password when sendEmail is false', async () => {
      await expect(
        service.forceResetPassword(
          TARGET_USER_ID,
          { sendEmail: false },
          tenantAdmin(),
        ),
      ).resolves.toMatchObject({ emailDelivered: false });

      expect(emailDeliveryService.sendTemporaryPassword).not.toHaveBeenCalled();
      expect(prisma.authAccount.update).toHaveBeenCalledTimes(1);
    });

    it('reports a failed delivery without failing the reset', async () => {
      emailDeliveryService.sendTemporaryPassword.mockResolvedValue({
        delivered: false,
        errorCode: 'SMTP_NOT_CONFIGURED',
      });

      await expect(
        service.forceResetPassword(TARGET_USER_ID, {}, tenantAdmin()),
      ).resolves.toMatchObject({
        mustChangePassword: true,
        emailDelivered: false,
      });
    });

    it('rejects a caller without the reset-password permission', async () => {
      await expect(
        service.forceResetPassword(
          TARGET_USER_ID,
          {},
          tenantAdmin({ permissions: [TENANT_USER_MANAGE_PERMISSION] }),
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.authAccount.update).not.toHaveBeenCalled();
    });

    it('cannot reach a user of another tenant', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);

      await expect(
        service.forceResetPassword(TARGET_USER_ID, {}, tenantAdmin()),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
