import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import {
  AuthAuditEvent,
  PASSWORD_RESET_OTP_COOLDOWN_SECONDS,
  PASSWORD_RESET_OTP_MAX_ATTEMPTS,
  PASSWORD_RESET_OTP_TTL_SECONDS,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailDeliveryService } from '../../mail/email-delivery.service';
import { AuthAuditService } from './auth-audit.service';
import { PasswordResetService } from './password-reset.service';

const EMAIL = 'user@example.com';
const TENANT_ID = 'tenant_1';
const AUTH_ACCOUNT_ID = 'auth_1';
const STRONG_PASSWORD = 'Str0ng!Passphrase';

function hashOtp(otp: string): string {
  return createHash('sha256').update(otp).digest('hex');
}

interface PrismaMock {
  tenantUser: { findFirst: jest.Mock };
  systemUser: { findFirst: jest.Mock };
  authAccount: { update: jest.Mock };
  refreshToken: { updateMany: jest.Mock };
  passwordResetOtp: {
    findFirst: jest.Mock;
    create: jest.Mock;
    updateMany: jest.Mock;
  };
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
}

function createPrismaMock(): PrismaMock {
  const prisma: PrismaMock = {
    tenantUser: { findFirst: jest.fn().mockResolvedValue(null) },
    systemUser: { findFirst: jest.fn().mockResolvedValue(null) },
    authAccount: { update: jest.fn().mockResolvedValue({}) },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    passwordResetOtp: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ id: TENANT_ID }]),
    // The service only ever uses the interactive form, and every write it
    // performs inside one is on the same mock, so running the callback
    // against `prisma` itself faithfully reproduces the call sequence.
    $transaction: jest.fn(),
  };

  prisma.$transaction.mockImplementation(
    (callback: (tx: PrismaMock) => unknown) => callback(prisma),
  );

  return prisma;
}

/** A live TenantUser row shaped as `resolveActor`'s select expects. */
function tenantUserRow(overrides: Record<string, unknown> = {}) {
  return {
    authAccountId: AUTH_ACCOUNT_ID,
    tenantId: TENANT_ID,
    isActive: true,
    authAccount: { isActive: true },
    ...overrides,
  };
}

function liveOtpRow(otp: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'otp_1',
    authAccountId: AUTH_ACCOUNT_ID,
    otpHash: hashOtp(otp),
    expiresAt: new Date(Date.now() + PASSWORD_RESET_OTP_TTL_SECONDS * 1000),
    consumedAt: null,
    attemptCount: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('PasswordResetService', () => {
  let prisma: PrismaMock;
  let emailDeliveryService: { sendPasswordResetOtp: jest.Mock };
  let authAuditService: { record: jest.Mock };
  let service: PasswordResetService;

  beforeEach(() => {
    prisma = createPrismaMock();
    emailDeliveryService = {
      sendPasswordResetOtp: jest.fn().mockResolvedValue({ delivered: true }),
    };
    authAuditService = { record: jest.fn().mockResolvedValue(undefined) };

    service = new PasswordResetService(
      prisma as unknown as PrismaService,
      emailDeliveryService as unknown as EmailDeliveryService,
      authAuditService as unknown as AuthAuditService,
    );
  });

  /** The OTP email is dispatched without being awaited -- let it settle. */
  async function flushEmailDispatch(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  function auditedEvents(): string[] {
    return authAuditService.record.mock.calls.map(
      ([entry]: [{ event: string }]) => entry.event,
    );
  }

  describe('requestReset', () => {
    it('issues and emails a six-digit code for a live tenant account', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRow());

      await service.requestReset({ email: EMAIL }, TENANT_ID);
      await flushEmailDispatch();

      expect(prisma.passwordResetOtp.create).toHaveBeenCalledTimes(1);
      const [{ data }] = prisma.passwordResetOtp.create.mock.calls[0];
      expect(data.authAccountId).toBe(AUTH_ACCOUNT_ID);
      expect(data.otpHash).toMatch(/^[0-9a-f]{64}$/);

      const [, otp, ttlMinutes] =
        emailDeliveryService.sendPasswordResetOtp.mock.calls[0];
      expect(otp).toMatch(/^\d{6}$/);
      expect(ttlMinutes).toBe(PASSWORD_RESET_OTP_TTL_SECONDS / 60);
      // The stored hash is of the code that was actually emailed.
      expect(data.otpHash).toBe(hashOtp(otp));
    });

    it('never persists the raw code', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRow());

      await service.requestReset({ email: EMAIL }, TENANT_ID);
      await flushEmailDispatch();

      const [, otp] = emailDeliveryService.sendPasswordResetOtp.mock.calls[0];
      const persisted = JSON.stringify(
        prisma.passwordResetOtp.create.mock.calls,
      );
      const audited = JSON.stringify(authAuditService.record.mock.calls);

      expect(persisted).not.toContain(otp);
      expect(audited).not.toContain(otp);
    });

    it('consumes any outstanding code before issuing a new one', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRow());

      await service.requestReset({ email: EMAIL }, TENANT_ID);

      expect(prisma.passwordResetOtp.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { authAccountId: AUTH_ACCOUNT_ID, consumedAt: null },
          data: expect.objectContaining({ consumedAt: expect.any(Date) }),
        }),
      );
    });

    it('resolves silently and sends nothing for an unknown address', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);

      await expect(
        service.requestReset({ email: EMAIL }, TENANT_ID),
      ).resolves.toBeUndefined();
      await flushEmailDispatch();

      expect(prisma.passwordResetOtp.create).not.toHaveBeenCalled();
      expect(emailDeliveryService.sendPasswordResetOtp).not.toHaveBeenCalled();
      expect(authAuditService.record).not.toHaveBeenCalled();
    });

    it.each([
      ['a deactivated TenantUser', { isActive: false }],
      ['a deactivated AuthAccount', { authAccount: { isActive: false } }],
    ])('sends no code for %s', async (_label, overrides) => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRow(overrides));

      await service.requestReset({ email: EMAIL }, TENANT_ID);
      await flushEmailDispatch();

      expect(prisma.passwordResetOtp.create).not.toHaveBeenCalled();
      expect(emailDeliveryService.sendPasswordResetOtp).not.toHaveBeenCalled();
    });

    it('sends no code when the tenant is not ACTIVE', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRow());
      prisma.$queryRaw.mockResolvedValue([]);

      await service.requestReset({ email: EMAIL }, TENANT_ID);
      await flushEmailDispatch();

      expect(emailDeliveryService.sendPasswordResetOtp).not.toHaveBeenCalled();
    });

    it('suppresses a resend inside the cooldown window', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRow());
      prisma.passwordResetOtp.findFirst.mockResolvedValue({
        createdAt: new Date(
          Date.now() - (PASSWORD_RESET_OTP_COOLDOWN_SECONDS - 1) * 1000,
        ),
      });

      await service.requestReset({ email: EMAIL }, TENANT_ID);
      await flushEmailDispatch();

      expect(prisma.passwordResetOtp.create).not.toHaveBeenCalled();
      expect(emailDeliveryService.sendPasswordResetOtp).not.toHaveBeenCalled();
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          event: AuthAuditEvent.FORGOT_PASSWORD_REQUESTED,
          metadata: { outcome: 'THROTTLED_BY_COOLDOWN' },
        }),
      );
    });

    it('issues again once the cooldown has elapsed', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRow());
      prisma.passwordResetOtp.findFirst.mockResolvedValue({
        createdAt: new Date(
          Date.now() - (PASSWORD_RESET_OTP_COOLDOWN_SECONDS + 1) * 1000,
        ),
      });

      await service.requestReset({ email: EMAIL }, TENANT_ID);
      await flushEmailDispatch();

      expect(prisma.passwordResetOtp.create).toHaveBeenCalledTimes(1);
    });

    it('routes to a SystemUser when no tenant header is present', async () => {
      prisma.systemUser.findFirst.mockResolvedValue({
        authAccountId: AUTH_ACCOUNT_ID,
        isActive: true,
        authAccount: { isActive: true },
      });

      await service.requestReset({ email: EMAIL });
      await flushEmailDispatch();

      expect(prisma.tenantUser.findFirst).not.toHaveBeenCalled();
      expect(prisma.passwordResetOtp.create).toHaveBeenCalledTimes(1);
    });

    /**
     * An empty `x-tenant-id` must stay on the tenant branch and find
     * nothing, not fall through to a system lookup -- the same
     * presence-not-truthiness rule login follows.
     */
    it('treats an empty tenant header as a tenant lookup, not a system one', async () => {
      prisma.systemUser.findFirst.mockResolvedValue({
        authAccountId: AUTH_ACCOUNT_ID,
        isActive: true,
        authAccount: { isActive: true },
      });

      await service.requestReset({ email: EMAIL }, '');
      await flushEmailDispatch();

      expect(prisma.systemUser.findFirst).not.toHaveBeenCalled();
      expect(prisma.passwordResetOtp.create).not.toHaveBeenCalled();
    });

    it('normalises the address before looking the account up', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRow());

      await service.requestReset({ email: '  User@Example.COM ' }, TENANT_ID);

      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: TENANT_ID, authAccount: { email: EMAIL } },
        }),
      );
    });

    it('still resolves when the mail transport fails', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRow());
      emailDeliveryService.sendPasswordResetOtp.mockResolvedValue({
        delivered: false,
        errorCode: 'SMTP_NOT_CONFIGURED',
      });

      await expect(
        service.requestReset({ email: EMAIL }, TENANT_ID),
      ).resolves.toBeUndefined();
      await flushEmailDispatch();

      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            outcome: 'EMAIL_FAILED',
            errorCode: 'SMTP_NOT_CONFIGURED',
          },
        }),
      );
    });
  });

  describe('resetPassword', () => {
    const OTP = '123456';

    function arrangeLiveOtp(overrides: Record<string, unknown> = {}) {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRow());
      prisma.passwordResetOtp.findFirst.mockResolvedValue(
        liveOtpRow(OTP, overrides),
      );
    }

    it('sets the new password and consumes the code', async () => {
      arrangeLiveOtp();

      await service.resetPassword(
        { email: EMAIL, otp: OTP, newPassword: STRONG_PASSWORD },
        TENANT_ID,
      );

      const [{ where, data }] = prisma.authAccount.update.mock.calls[0];
      expect(where).toEqual({ id: AUTH_ACCOUNT_ID });
      expect(data.mustChangePassword).toBe(false);
      await expect(
        bcrypt.compare(STRONG_PASSWORD, data.passwordHash),
      ).resolves.toBe(true);

      expect(prisma.passwordResetOtp.updateMany).toHaveBeenCalledWith({
        where: { id: 'otp_1', consumedAt: null },
        data: { consumedAt: expect.any(Date) },
      });
    });

    it('revokes every live session for the account', async () => {
      arrangeLiveOtp();
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 3 });

      await service.resetPassword(
        { email: EMAIL, otp: OTP, newPassword: STRONG_PASSWORD },
        TENANT_ID,
      );

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { authAccountId: AUTH_ACCOUNT_ID, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          event: AuthAuditEvent.PASSWORD_RESET_SUCCESS,
          metadata: { revokedSessionCount: 3 },
        }),
      );
    });

    it('rejects a replayed code, because it is already consumed', async () => {
      arrangeLiveOtp();
      prisma.passwordResetOtp.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.resetPassword(
          { email: EMAIL, otp: OTP, newPassword: STRONG_PASSWORD },
          TENANT_ID,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.authAccount.update).not.toHaveBeenCalled();
    });

    it.each([
      ['a wrong code', { otp: '999999' }],
      ['a code of the wrong length', { otp: '12345' }],
      ['a non-numeric code', { otp: 'abcdef' }],
    ])('rejects %s with INVALID_OTP', async (_label, { otp }) => {
      arrangeLiveOtp();

      await expect(
        service.resetPassword(
          { email: EMAIL, otp, newPassword: STRONG_PASSWORD },
          TENANT_ID,
        ),
      ).rejects.toMatchObject({
        response: { error: 'INVALID_OTP' },
      });
      expect(prisma.authAccount.update).not.toHaveBeenCalled();
    });

    it('rejects an expired code and consumes it', async () => {
      arrangeLiveOtp({ expiresAt: new Date(Date.now() - 1000) });

      await expect(
        service.resetPassword(
          { email: EMAIL, otp: OTP, newPassword: STRONG_PASSWORD },
          TENANT_ID,
        ),
      ).rejects.toMatchObject({ response: { error: 'INVALID_OTP' } });

      expect(prisma.passwordResetOtp.updateMany).toHaveBeenCalledWith({
        where: { id: 'otp_1', consumedAt: null },
        data: { consumedAt: expect.any(Date) },
      });
      expect(auditedEvents()).toContain(AuthAuditEvent.PASSWORD_RESET_FAILED);
    });

    it('counts a wrong code against the attempt budget without burning it', async () => {
      arrangeLiveOtp({ attemptCount: 0 });

      await expect(
        service.resetPassword(
          { email: EMAIL, otp: '000000', newPassword: STRONG_PASSWORD },
          TENANT_ID,
        ),
      ).rejects.toMatchObject({ response: { error: 'INVALID_OTP' } });

      expect(prisma.passwordResetOtp.updateMany).toHaveBeenCalledWith({
        where: { id: 'otp_1', consumedAt: null, attemptCount: 0 },
        data: { attemptCount: 1 },
      });
    });

    it('burns the code once the attempt budget is spent', async () => {
      arrangeLiveOtp({ attemptCount: PASSWORD_RESET_OTP_MAX_ATTEMPTS - 1 });

      await expect(
        service.resetPassword(
          { email: EMAIL, otp: '000000', newPassword: STRONG_PASSWORD },
          TENANT_ID,
        ),
      ).rejects.toMatchObject({ response: { error: 'INVALID_OTP' } });

      expect(prisma.passwordResetOtp.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'otp_1',
          consumedAt: null,
          attemptCount: PASSWORD_RESET_OTP_MAX_ATTEMPTS - 1,
        },
        data: {
          attemptCount: PASSWORD_RESET_OTP_MAX_ATTEMPTS,
          consumedAt: expect.any(Date),
        },
      });
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            reason: 'ATTEMPT_BUDGET_SPENT',
          }),
        }),
      );
    });

    it('rejects with INVALID_OTP when no code is outstanding', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRow());
      prisma.passwordResetOtp.findFirst.mockResolvedValue(null);

      await expect(
        service.resetPassword(
          { email: EMAIL, otp: OTP, newPassword: STRONG_PASSWORD },
          TENANT_ID,
        ),
      ).rejects.toMatchObject({ response: { error: 'INVALID_OTP' } });
    });

    /**
     * An unknown address must be indistinguishable from a known one with no
     * live code -- same error, and the same reads on the way to it.
     */
    it('rejects an unknown address with the same error and the same reads', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);

      await expect(
        service.resetPassword(
          { email: EMAIL, otp: OTP, newPassword: STRONG_PASSWORD },
          TENANT_ID,
        ),
      ).rejects.toMatchObject({ response: { error: 'INVALID_OTP' } });

      expect(prisma.passwordResetOtp.findFirst).toHaveBeenCalledTimes(1);
    });

    it('rejects a deactivated account with INVALID_OTP', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        tenantUserRow({ isActive: false }),
      );
      prisma.passwordResetOtp.findFirst.mockResolvedValue(liveOtpRow(OTP));

      await expect(
        service.resetPassword(
          { email: EMAIL, otp: OTP, newPassword: STRONG_PASSWORD },
          TENANT_ID,
        ),
      ).rejects.toMatchObject({ response: { error: 'INVALID_OTP' } });
      expect(prisma.authAccount.update).not.toHaveBeenCalled();
    });

    /**
     * The policy is checked before anything is read, so a weak password
     * neither reveals whether the address exists nor costs an attempt.
     */
    it('rejects a weak password before touching the database', async () => {
      arrangeLiveOtp();

      await expect(
        service.resetPassword(
          { email: EMAIL, otp: OTP, newPassword: 'short' },
          TENANT_ID,
        ),
      ).rejects.toMatchObject({
        response: {
          error: 'PASSWORD_POLICY_VIOLATION',
          message: expect.arrayContaining(['TOO_SHORT', 'MISSING_SPECIAL']),
        },
      });

      expect(prisma.tenantUser.findFirst).not.toHaveBeenCalled();
      expect(prisma.passwordResetOtp.findFirst).not.toHaveBeenCalled();
    });

    it('never puts the code or the new password in an audit row', async () => {
      arrangeLiveOtp();

      await service.resetPassword(
        { email: EMAIL, otp: OTP, newPassword: STRONG_PASSWORD },
        TENANT_ID,
      );

      const audited = JSON.stringify(authAuditService.record.mock.calls);
      expect(audited).not.toContain(OTP);
      expect(audited).not.toContain(STRONG_PASSWORD);
    });
  });
});
