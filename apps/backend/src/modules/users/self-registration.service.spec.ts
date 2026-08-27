import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import {
  AuthAuditEvent,
  TENANT_USER_MANAGE_PERMISSION,
  TenantUserStatus,
  USER_ERROR_CODES,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailDeliveryService } from '../../mail/email-delivery.service';
import { AuthAuditService } from '../auth/auth-audit.service';
import { SelfRegistrationService } from './self-registration.service';
import {
  EffectiveTenantSettings,
  TenantSettingsService,
} from './tenant-settings.service';
import { TenantUserDirectoryService } from './tenant-user-directory.service';
import { UserQuotaService } from './user-quota.service';

const TENANT_ID = 'tenant_1';
const TENANT_NAME = 'Acme Co';
const ROLE_ID = 'role_member';
const EMAIL = 'new@acme.com';
const VALID_PASSWORD = 'Str0ng!Password';

function body(overrides: Record<string, string> = {}) {
  return {
    email: EMAIL,
    fullName: 'New Person',
    password: VALID_PASSWORD,
    confirmPassword: VALID_PASSWORD,
    ...overrides,
  };
}

function effectiveSettings(
  overrides: Partial<EffectiveTenantSettings> = {},
): EffectiveTenantSettings {
  return {
    tenantId: TENANT_ID,
    allowSelfRegistration: true,
    allowSystemImpersonation: false,
    allowedEmailDomains: [],
    defaultRoleId: ROLE_ID,
    defaultRoleName: 'Member',
    requireApproval: false,
    configured: true,
    updatedAt: new Date('2026-08-20T10:00:00.000Z'),
    ...overrides,
  };
}

interface PrismaMock {
  tenant: { findFirst: jest.Mock };
  authAccount: { create: jest.Mock };
  tenantUser: { create: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock };
  $transaction: jest.Mock;
}

function createPrismaMock(): PrismaMock {
  const prisma: PrismaMock = {
    tenant: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: TENANT_ID, name: TENANT_NAME }),
    },
    authAccount: { create: jest.fn().mockResolvedValue({ id: 'auth_new' }) },
    tenantUser: {
      create: jest.fn().mockResolvedValue({ id: 'tu_new' }),
      // No existing member: the address is free unless a test says so.
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest
        .fn()
        .mockResolvedValue([
          { authAccount: { email: 'admin@acme.com' } },
          { authAccount: { email: 'owner@acme.com' } },
        ]),
    },
    $transaction: jest.fn(),
  };

  prisma.$transaction.mockImplementation(
    (callback: (tx: PrismaMock) => unknown) => callback(prisma),
  );

  return prisma;
}

describe('SelfRegistrationService', () => {
  let prisma: PrismaMock;
  let settings: jest.Mocked<TenantSettingsService>;
  let quota: jest.Mocked<UserQuotaService>;
  let directory: TenantUserDirectoryService;
  let mail: jest.Mocked<EmailDeliveryService>;
  let audit: jest.Mocked<AuthAuditService>;
  let service: SelfRegistrationService;

  beforeEach(() => {
    // Warnings about misconfigured tenants are expected in several cases
    // here and would otherwise be noise in the test output.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    prisma = createPrismaMock();
    settings = {
      resolveEffectiveSettings: jest
        .fn()
        .mockResolvedValue(effectiveSettings()),
    } as unknown as jest.Mocked<TenantSettingsService>;
    quota = {
      assertSeatsAvailable: jest.fn().mockResolvedValue({
        usedSeats: 1,
        maxUsers: 10,
        remainingSeats: 9,
        unlimited: false,
      }),
    } as unknown as jest.Mocked<UserQuotaService>;
    // The real one: normalization and the conflict rule are the behaviour
    // under test here, not a collaborator to be stubbed out.
    directory = new TenantUserDirectoryService(
      prisma as unknown as PrismaService,
    );
    mail = {
      sendSelfRegistrationWelcome: jest
        .fn()
        .mockResolvedValue({ delivered: true }),
      sendSelfRegistrationPendingApproval: jest
        .fn()
        .mockResolvedValue({ delivered: true }),
    } as unknown as jest.Mocked<EmailDeliveryService>;
    audit = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuthAuditService>;

    service = new SelfRegistrationService(
      prisma as unknown as PrismaService,
      settings,
      quota,
      directory,
      mail,
      audit,
    );
  });

  /** Nothing in this suite may create a user unless it says so. */
  function expectNothingCreated(): void {
    expect(prisma.authAccount.create).not.toHaveBeenCalled();
    expect(prisma.tenantUser.create).not.toHaveBeenCalled();
  }

  describe('tenant resolution', () => {
    it('requires the x-tenant-id header', async () => {
      await expect(service.register(body())).rejects.toThrow(
        BadRequestException,
      );
      expectNothingCreated();
    });

    it('treats a blank header as missing', async () => {
      await expect(service.register(body(), '   ')).rejects.toThrow(
        BadRequestException,
      );
    });

    /**
     * An unknown or suspended tenant answers exactly what a tenant with
     * registration switched off answers, so the endpoint cannot be used to
     * find out which tenants exist.
     */
    it('answers SELF_REG_DISABLED for a tenant that is unknown or not active', async () => {
      prisma.tenant.findFirst.mockResolvedValue(null);

      await expect(service.register(body(), TENANT_ID)).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.SELF_REG_DISABLED },
      });
      // One lookup covers both cases: a suspended tenant does not match
      // the status filter, so it is as invisible here as a missing one.
      expect(prisma.tenant.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TENANT_ID, status: 'ACTIVE' },
        }),
      );
      expect(settings.resolveEffectiveSettings).not.toHaveBeenCalled();
      expectNothingCreated();
    });
  });

  describe('check order', () => {
    it('answers SELF_REG_DISABLED when the toggle is off', async () => {
      settings.resolveEffectiveSettings.mockResolvedValue(
        effectiveSettings({ allowSelfRegistration: false }),
      );

      await expect(service.register(body(), TENANT_ID)).rejects.toThrow(
        ForbiddenException,
      );
      expectNothingCreated();
    });

    /**
     * The acceptance criterion: the toggle dominates. A tenant that is
     * closed gives up nothing about its policy -- not even which domains
     * it would have accepted.
     */
    it('answers SELF_REG_DISABLED, not DOMAIN_NOT_ALLOWED, when both fail', async () => {
      settings.resolveEffectiveSettings.mockResolvedValue(
        effectiveSettings({
          allowSelfRegistration: false,
          allowedEmailDomains: ['acme.com'],
        }),
      );

      await expect(
        service.register(body({ email: 'outsider@evil.example' }), TENANT_ID),
      ).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.SELF_REG_DISABLED },
      });
      expect(quota.assertSeatsAvailable).not.toHaveBeenCalled();
    });

    /**
     * Fail closed. An enabled toggle with no default role would otherwise
     * admit strangers holding no permissions at all -- which is still a
     * stranger inside the tenant.
     */
    it('answers SELF_REG_DISABLED when enabled with no default role', async () => {
      settings.resolveEffectiveSettings.mockResolvedValue(
        effectiveSettings({ defaultRoleId: null, defaultRoleName: null }),
      );

      await expect(service.register(body(), TENANT_ID)).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.SELF_REG_DISABLED },
      });
      expectNothingCreated();
    });

    it('answers DOMAIN_NOT_ALLOWED before touching the quota', async () => {
      settings.resolveEffectiveSettings.mockResolvedValue(
        effectiveSettings({ allowedEmailDomains: ['acme.com'] }),
      );

      await expect(
        service.register(body({ email: 'outsider@evil.example' }), TENANT_ID),
      ).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.DOMAIN_NOT_ALLOWED },
      });
      expect(quota.assertSeatsAvailable).not.toHaveBeenCalled();
      expectNothingCreated();
    });

    it('accepts an address inside the whitelist, case and spacing aside', async () => {
      settings.resolveEffectiveSettings.mockResolvedValue(
        effectiveSettings({ allowedEmailDomains: ['acme.com'] }),
      );

      await expect(
        service.register(body({ email: '  New@ACME.com ' }), TENANT_ID),
      ).resolves.toEqual(expect.objectContaining({ email: EMAIL }));
    });

    /** An empty whitelist narrows nothing; the toggle is what closes a tenant. */
    it('accepts any domain when the whitelist is empty', async () => {
      await expect(
        service.register(
          body({ email: 'someone@elsewhere.example' }),
          TENANT_ID,
        ),
      ).resolves.toEqual(
        expect.objectContaining({ email: 'someone@elsewhere.example' }),
      );
    });

    it('creates nothing when the quota is full', async () => {
      quota.assertSeatsAvailable.mockRejectedValue(
        new BadRequestException({
          error: USER_ERROR_CODES.QUOTA_EXCEEDED,
          message: 'full',
        }),
      );

      await expect(service.register(body(), TENANT_ID)).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.QUOTA_EXCEEDED },
      });
      expectNothingCreated();
    });

    /**
     * Body validation runs only once the tenant has agreed to hear the
     * request at all, so a closed tenant answers `SELF_REG_DISABLED` even
     * to a caller whose password would have been rejected anyway.
     */
    it('checks the tenant policy before the password policy', async () => {
      settings.resolveEffectiveSettings.mockResolvedValue(
        effectiveSettings({ allowSelfRegistration: false }),
      );

      await expect(
        service.register(
          body({ password: 'weak', confirmPassword: 'weak' }),
          TENANT_ID,
        ),
      ).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.SELF_REG_DISABLED },
      });
    });
  });

  describe('body validation', () => {
    it('rejects a password that breaks the policy', async () => {
      await expect(
        service.register(
          body({ password: 'weak', confirmPassword: 'weak' }),
          TENANT_ID,
        ),
      ).rejects.toThrow(BadRequestException);
      expectNothingCreated();
    });

    it('rejects a confirmation that does not match', async () => {
      await expect(
        service.register(
          body({ confirmPassword: `${VALID_PASSWORD}x` }),
          TENANT_ID,
        ),
      ).rejects.toThrow(BadRequestException);
      expectNothingCreated();
    });

    it('rejects a blank full name', async () => {
      await expect(
        service.register(body({ fullName: '   ' }), TENANT_ID),
      ).rejects.toThrow(BadRequestException);
      expectNothingCreated();
    });

    it('rejects an address already used in this tenant', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'tu_existing',
        authAccountId: 'auth_existing',
        status: 'active',
      });

      await expect(service.register(body(), TENANT_ID)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.authAccount.create).not.toHaveBeenCalled();
    });
  });

  describe('creation', () => {
    it('creates an active member and welcomes them when no approval is required', async () => {
      await expect(service.register(body(), TENANT_ID)).resolves.toEqual({
        tenantId: TENANT_ID,
        userId: 'tu_new',
        email: EMAIL,
        status: TenantUserStatus.ACTIVE,
        requiresApproval: false,
      });

      expect(prisma.tenantUser.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            authAccountId: 'auth_new',
            name: 'New Person',
            status: TenantUserStatus.ACTIVE,
            isActive: true,
            roles: { connect: { id: ROLE_ID } },
          }),
        }),
      );
      expect(mail.sendSelfRegistrationWelcome).toHaveBeenCalledWith(
        EMAIL,
        TENANT_NAME,
      );
      expect(mail.sendSelfRegistrationPendingApproval).not.toHaveBeenCalled();
    });

    it('creates a pending member and tells the approvers when approval is required', async () => {
      settings.resolveEffectiveSettings.mockResolvedValue(
        effectiveSettings({ requireApproval: true }),
      );

      await expect(service.register(body(), TENANT_ID)).resolves.toEqual(
        expect.objectContaining({
          status: TenantUserStatus.PENDING_APPROVAL,
          requiresApproval: true,
        }),
      );

      expect(prisma.tenantUser.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: TenantUserStatus.PENDING_APPROVAL,
            isActive: false,
          }),
        }),
      );
      expect(mail.sendSelfRegistrationPendingApproval).toHaveBeenCalledWith(
        ['admin@acme.com', 'owner@acme.com'],
        TENANT_NAME,
        EMAIL,
      );
      expect(mail.sendSelfRegistrationWelcome).not.toHaveBeenCalled();
    });

    /**
     * Who can approve is read from the permission catalog, not from a role
     * name: a tenant that renamed or split its admin role still gets told.
     */
    it('addresses the notice to active holders of tenant.user.manage', async () => {
      settings.resolveEffectiveSettings.mockResolvedValue(
        effectiveSettings({ requireApproval: true }),
      );

      await service.register(body(), TENANT_ID);

      expect(prisma.tenantUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: TENANT_ID,
            status: TenantUserStatus.ACTIVE,
            isActive: true,
            roles: {
              some: {
                rolePermissions: {
                  some: {
                    permission: { code: TENANT_USER_MANAGE_PERMISSION },
                  },
                },
              },
            },
          }),
        }),
      );
    });

    it('still registers when there is nobody to notify', async () => {
      settings.resolveEffectiveSettings.mockResolvedValue(
        effectiveSettings({ requireApproval: true }),
      );
      prisma.tenantUser.findMany.mockResolvedValue([]);

      await expect(service.register(body(), TENANT_ID)).resolves.toEqual(
        expect.objectContaining({ status: TenantUserStatus.PENDING_APPROVAL }),
      );
      expect(mail.sendSelfRegistrationPendingApproval).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ emailDelivered: false }),
        }),
      );
    });

    /**
     * The account exists either way: unwinding a committed registration
     * because an SMTP server was briefly unreachable would be worse than a
     * message that has to be sent again.
     */
    it('does not fail the registration when the mail does not go out', async () => {
      mail.sendSelfRegistrationWelcome.mockResolvedValue({
        delivered: false,
        errorCode: 'SMTP_TIMEOUT',
      });

      await expect(service.register(body(), TENANT_ID)).resolves.toEqual(
        expect.objectContaining({ status: TenantUserStatus.ACTIVE }),
      );
    });

    it('stores the password as a hash, never in the clear', async () => {
      await service.register(body(), TENANT_ID);

      const [{ data }] = prisma.authAccount.create.mock.calls[0];
      expect(data.email).toBe(EMAIL);
      expect(data.passwordHash).not.toBe(VALID_PASSWORD);
      await expect(
        bcrypt.compare(VALID_PASSWORD, data.passwordHash as string),
      ).resolves.toBe(true);
    });

    it('records one audit row per registration, with no credential in it', async () => {
      await service.register(body(), TENANT_ID);

      expect(audit.record).toHaveBeenCalledTimes(1);
      const [entry] = audit.record.mock.calls[0];
      expect(entry).toEqual(
        expect.objectContaining({
          event: AuthAuditEvent.USER_SELF_REGISTERED,
          tenantId: TENANT_ID,
          subjectAuthAccountId: 'auth_new',
          metadata: expect.objectContaining({
            userId: 'tu_new',
            email: EMAIL,
            status: TenantUserStatus.ACTIVE,
            requiresApproval: false,
            roleId: ROLE_ID,
            emailDelivered: true,
          }),
        }),
      );
      // Self-service: the subject is the actor, so there is nobody else to
      // name -- and the password never reaches the trail.
      expect(entry.actorAuthAccountId).toBeUndefined();
      expect(JSON.stringify(entry)).not.toContain(VALID_PASSWORD);
    });
  });
});
