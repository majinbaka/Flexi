import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ActorType,
  AuthAuditEvent,
  AuthenticatedUserDto,
  SYSTEM_USER_MANAGE_PERMISSION,
  SYSTEM_USER_READ_PERMISSION,
  TENANT_USER_MANAGE_PERMISSION,
  TENANT_USER_READ_PERMISSION,
  TenantUserStatus,
  USER_ERROR_CODES,
  USER_LIST_MAX_PAGE_SIZE,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailDeliveryService } from '../../mail/email-delivery.service';
import { AuthAuditService } from '../auth/auth-audit.service';
import { AccountLifecycleService } from './account-lifecycle.service';
import { TenantUserDirectoryService } from './tenant-user-directory.service';
import { UserQuotaService } from './user-quota.service';
import { UsersAdminService } from './users-admin.service';

const TENANT_ID = 'tenant_1';
const OTHER_TENANT_ID = 'tenant_2';
const ADMIN_ACCOUNT_ID = 'auth_admin';
const ADMIN_USER_ID = 'tu_admin';
const TARGET_USER_ID = 'tu_target';
const TARGET_ACCOUNT_ID = 'auth_target';
const TARGET_EMAIL = 'target@example.com';
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const UPDATED_AT = new Date('2026-02-01T00:00:00.000Z');

interface PrismaMock {
  tenantUser: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  systemUser: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
  };
  authAccount: { create: jest.Mock };
  role: { findFirst: jest.Mock };
  $transaction: jest.Mock;
}

function createPrismaMock(): PrismaMock {
  const prisma: PrismaMock = {
    tenantUser: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
    },
    systemUser: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
    },
    authAccount: { create: jest.fn().mockResolvedValue({ id: 'auth_new' }) },
    role: { findFirst: jest.fn().mockResolvedValue(null) },
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
    permissions: [TENANT_USER_READ_PERMISSION, TENANT_USER_MANAGE_PERMISSION],
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
    permissions: [SYSTEM_USER_READ_PERMISSION, SYSTEM_USER_MANAGE_PERMISSION],
    ...overrides,
  };
}

function tenantUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_USER_ID,
    tenantId: TENANT_ID,
    authAccountId: TARGET_ACCOUNT_ID,
    name: 'Target Person',
    status: TenantUserStatus.ACTIVE,
    isActive: true,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    authAccount: { email: TARGET_EMAIL, mustChangePassword: false },
    roles: [{ id: 'role_member', name: 'Member' }],
    ...overrides,
  };
}

/** The shape `resolveTenantTarget` selects: the row plus its tenant name. */
function tenantUserRowWithTenant(overrides: Record<string, unknown> = {}) {
  return { ...tenantUserRow(overrides), tenant: { name: 'Acme' } };
}

function systemUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'su_target',
    authAccountId: 'auth_system_target',
    name: 'System Person',
    isActive: true,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    authAccount: { email: 'system@example.com', mustChangePassword: true },
    roles: [{ id: 'role_platform', name: 'Platform Ops' }],
    ...overrides,
  };
}

describe('UsersAdminService', () => {
  let prisma: PrismaMock;
  let accountLifecycleService: { revokeLiveSessions: jest.Mock };
  let userQuotaService: {
    assertSeatsAvailable: jest.Mock;
    getSeatUsage: jest.Mock;
  };
  let tenantUserDirectoryService: {
    normalizeEmail: jest.Mock;
    assertEmailAvailable: jest.Mock;
  };
  let emailDeliveryService: {
    sendTemporaryPassword: jest.Mock;
    sendSelfRegistrationWelcome: jest.Mock;
  };
  let authAuditService: { record: jest.Mock };
  let service: UsersAdminService;

  beforeEach(() => {
    prisma = createPrismaMock();
    accountLifecycleService = { revokeLiveSessions: jest.fn() };
    userQuotaService = {
      assertSeatsAvailable: jest.fn().mockResolvedValue({
        usedSeats: 1,
        maxUsers: 10,
        remainingSeats: 9,
        unlimited: false,
      }),
      getSeatUsage: jest.fn().mockResolvedValue({
        usedSeats: 2,
        maxUsers: 10,
        remainingSeats: 8,
        unlimited: false,
      }),
    };
    tenantUserDirectoryService = {
      normalizeEmail: jest.fn((email: string) => email.trim().toLowerCase()),
      assertEmailAvailable: jest.fn().mockResolvedValue(undefined),
    };
    emailDeliveryService = {
      sendTemporaryPassword: jest.fn().mockResolvedValue({ delivered: true }),
      sendSelfRegistrationWelcome: jest
        .fn()
        .mockResolvedValue({ delivered: true }),
    };
    authAuditService = { record: jest.fn().mockResolvedValue(undefined) };

    service = new UsersAdminService(
      prisma as unknown as PrismaService,
      accountLifecycleService as unknown as AccountLifecycleService,
      userQuotaService as unknown as UserQuotaService,
      tenantUserDirectoryService as unknown as TenantUserDirectoryService,
      emailDeliveryService as unknown as EmailDeliveryService,
      authAuditService as unknown as AuthAuditService,
    );
  });

  /** Nothing derived from a credential may reach a response. */
  function expectNoSecrets(payload: object): void {
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('tokenHash');
    expect(serialized).not.toContain('password');
  }

  describe('listUsers', () => {
    it('scopes a tenant caller to their own tenant and hides deleted users', async () => {
      prisma.tenantUser.findMany.mockResolvedValue([tenantUserRow()]);
      prisma.tenantUser.count.mockResolvedValue(1);

      const result = await service.listUsers({}, tenantAdmin());

      expect(prisma.tenantUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId: TENANT_ID,
            status: { not: TenantUserStatus.DELETED },
          },
          skip: 0,
          take: 20,
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(result.meta).toEqual({ total: 1, page: 1, pageSize: 20 });
      expect(result.items[0]).toEqual({
        id: TARGET_USER_ID,
        actorType: ActorType.TENANT,
        tenantId: TENANT_ID,
        authAccountId: TARGET_ACCOUNT_ID,
        email: TARGET_EMAIL,
        fullName: 'Target Person',
        status: TenantUserStatus.ACTIVE,
        isActive: true,
        roles: [{ id: 'role_member', name: 'Member' }],
        createdAt: CREATED_AT.toISOString(),
        updatedAt: UPDATED_AT.toISOString(),
      });
      expectNoSecrets(result);
    });

    it('asks for deleted users only when the filter names them', async () => {
      await service.listUsers(
        { status: TenantUserStatus.DELETED },
        tenantAdmin(),
      );

      expect(prisma.tenantUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: TENANT_ID, status: TenantUserStatus.DELETED },
        }),
      );
    });

    it('filters by role and searches name or email, wildcards escaped', async () => {
      await service.listUsers(
        { roleId: 'role_member', keyword: '50%_off' },
        tenantAdmin(),
      );

      const { where } = prisma.tenantUser.findMany.mock.calls[0][0];
      expect(where.roles).toEqual({ some: { id: 'role_member' } });
      expect(where.OR).toEqual([
        { name: { contains: '50\\%\\_off', mode: 'insensitive' } },
        {
          authAccount: {
            email: { contains: '50\\%\\_off', mode: 'insensitive' },
          },
        },
      ]);
    });

    it('clamps pageSize and rejects a non-positive page', async () => {
      await service.listUsers({ pageSize: 5000, page: 3 }, tenantAdmin());

      expect(prisma.tenantUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: USER_LIST_MAX_PAGE_SIZE,
          skip: 2 * USER_LIST_MAX_PAGE_SIZE,
        }),
      );

      await expect(
        service.listUsers({ page: 0 }, tenantAdmin()),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.listUsers({ pageSize: 1.5 }, tenantAdmin()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a status outside the lifecycle enum', async () => {
      await expect(
        service.listUsers(
          { status: 'suspended' as TenantUserStatus },
          tenantAdmin(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tenantUser.findMany).not.toHaveBeenCalled();
    });

    it('lists SystemUsers for a system caller and never TenantUsers', async () => {
      prisma.systemUser.findMany.mockResolvedValue([systemUserRow()]);
      prisma.systemUser.count.mockResolvedValue(1);

      const result = await service.listUsers({}, systemAdmin());

      expect(prisma.tenantUser.findMany).not.toHaveBeenCalled();
      expect(result.items[0]).toEqual(
        expect.objectContaining({
          actorType: ActorType.SYSTEM,
          tenantId: null,
          // A SystemUser has no lifecycle status at all.
          status: null,
          isActive: true,
        }),
      );
      expectNoSecrets(result);
    });

    it('refuses a status filter from a system caller rather than dropping it', async () => {
      await expect(
        service.listUsers({ status: TenantUserStatus.ACTIVE }, systemAdmin()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.systemUser.findMany).not.toHaveBeenCalled();
    });

    it('requires the read permission of the caller own scope', async () => {
      await expect(
        service.listUsers({}, tenantAdmin({ permissions: [] })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // The SYSTEM spelling does not satisfy a tenant caller.
      await expect(
        service.listUsers(
          {},
          tenantAdmin({ permissions: [SYSTEM_USER_READ_PERMISSION] }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('getUser', () => {
    it('returns the detail of a user of the caller tenant', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRow());

      const user = await service.getUser(TARGET_USER_ID, tenantAdmin());

      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TARGET_USER_ID, tenantId: TENANT_ID },
        }),
      );
      expect(user).toEqual(
        expect.objectContaining({
          id: TARGET_USER_ID,
          email: TARGET_EMAIL,
          mustChangePassword: false,
        }),
      );
      expectNoSecrets(user);
    });

    it('answers 404, not 403, for a user of another tenant', async () => {
      // The tenant is part of the WHERE clause, so another tenant's user
      // simply does not match -- there is nothing to compare afterwards.
      prisma.tenantUser.findFirst.mockResolvedValue(null);

      await expect(
        service.getUser('tu_of_other_tenant', tenantAdmin()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tu_of_other_tenant', tenantId: TENANT_ID },
        }),
      );
    });
  });

  describe('updateUser', () => {
    it('renames without touching roles and audits the edit', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRow());
      prisma.tenantUser.update.mockResolvedValue(
        tenantUserRow({ name: 'New Name' }),
      );

      const user = await service.updateUser(
        TARGET_USER_ID,
        { fullName: '  New Name  ' },
        tenantAdmin(),
      );

      expect(prisma.tenantUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TARGET_USER_ID },
          data: { name: 'New Name' },
        }),
      );
      expect(user.fullName).toBe('New Name');
      expect(authAuditService.record).toHaveBeenCalledTimes(1);
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ event: AuthAuditEvent.USER_UPDATED }),
      );
    });

    it('replaces the role set and records the privilege change separately', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRow());
      prisma.role.findFirst.mockResolvedValue({ id: 'role_admin' });
      prisma.tenantUser.update.mockResolvedValue(
        tenantUserRow({ roles: [{ id: 'role_admin', name: 'Admin' }] }),
      );

      await service.updateUser(
        TARGET_USER_ID,
        { roleId: 'role_admin' },
        tenantAdmin(),
      );

      expect(prisma.role.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'role_admin', tenantId: TENANT_ID },
        }),
      );
      expect(prisma.tenantUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { roles: { set: [{ id: 'role_admin' }] } },
        }),
      );
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          event: AuthAuditEvent.USER_ROLE_CHANGED,
          metadata: expect.objectContaining({
            previousRoleId: 'role_member',
            roleId: 'role_admin',
          }),
        }),
      );
    });

    it('clears every role when roleId is null', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRow());
      prisma.tenantUser.update.mockResolvedValue(tenantUserRow({ roles: [] }));

      await service.updateUser(TARGET_USER_ID, { roleId: null }, tenantAdmin());

      expect(prisma.role.findFirst).not.toHaveBeenCalled();
      expect(prisma.tenantUser.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { roles: { set: [] } } }),
      );
    });

    it('refuses a role that belongs to another tenant', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRow());
      // Scoped lookup: a role of tenant_2 does not match tenant_1.
      prisma.role.findFirst.mockResolvedValue(null);

      await expect(
        service.updateUser(
          TARGET_USER_ID,
          { roleId: 'role_of_other_tenant' },
          tenantAdmin(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
    });

    it('refuses a Tenant Admin changing their own role, but allows a rename', async () => {
      const selfRow = tenantUserRow({
        id: ADMIN_USER_ID,
        authAccountId: ADMIN_ACCOUNT_ID,
      });
      prisma.tenantUser.findFirst.mockResolvedValue(selfRow);
      prisma.tenantUser.update.mockResolvedValue(selfRow);

      await expect(
        service.updateUser(
          ADMIN_USER_ID,
          { roleId: 'role_admin' },
          tenantAdmin(),
        ),
      ).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.CANNOT_CHANGE_OWN_ROLE },
      });
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();

      await service.updateUser(
        ADMIN_USER_ID,
        { fullName: 'Renamed Admin' },
        tenantAdmin(),
      );
      expect(prisma.tenantUser.update).toHaveBeenCalledTimes(1);
    });

    it('refuses an empty body rather than writing nothing and auditing it', async () => {
      await expect(
        service.updateUser(TARGET_USER_ID, {}, tenantAdmin()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tenantUser.findFirst).not.toHaveBeenCalled();
    });

    it('refuses to edit a deleted membership', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        tenantUserRow({ status: TenantUserStatus.DELETED }),
      );

      await expect(
        service.updateUser(TARGET_USER_ID, { fullName: 'X' }, tenantAdmin()),
      ).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.INVALID_STATUS_TRANSITION },
      });
    });

    it('answers 404 for a user of another tenant', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);

      await expect(
        service.updateUser(
          'tu_of_other_tenant',
          { fullName: 'X' },
          tenantAdmin(),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updates a SystemUser against system roles for a system caller', async () => {
      prisma.systemUser.findFirst.mockResolvedValue(systemUserRow());
      prisma.role.findFirst.mockResolvedValue({ id: 'role_platform_admin' });
      prisma.systemUser.update.mockResolvedValue(systemUserRow());

      await service.updateUser(
        'su_target',
        { roleId: 'role_platform_admin' },
        systemAdmin(),
      );

      // `Role.tenantId === null` is what makes a role system-level.
      expect(prisma.role.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'role_platform_admin', tenantId: null },
        }),
      );
      expect(prisma.systemUser.update).toHaveBeenCalled();
    });

    it('requires the manage permission of the caller own scope', async () => {
      await expect(
        service.updateUser(
          TARGET_USER_ID,
          { fullName: 'X' },
          tenantAdmin({ permissions: [TENANT_USER_READ_PERMISSION] }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('directCreate', () => {
    const body = {
      email: '  New.Person@Example.COM ',
      fullName: '  New Person  ',
    };

    beforeEach(() => {
      prisma.tenantUser.create.mockResolvedValue(
        tenantUserRow({
          id: 'tu_new',
          authAccountId: 'auth_new',
          name: 'New Person',
          authAccount: {
            email: 'new.person@example.com',
            mustChangePassword: true,
          },
          roles: [],
        }),
      );
    });

    it('creates an active seat with a mailed temporary password', async () => {
      const result = await service.directCreate(body, tenantAdmin());

      expect(prisma.authAccount.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'new.person@example.com',
            mustChangePassword: true,
          }),
        }),
      );
      expect(prisma.tenantUser.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            name: 'New Person',
            status: TenantUserStatus.ACTIVE,
            isActive: true,
          }),
        }),
      );
      expect(emailDeliveryService.sendTemporaryPassword).toHaveBeenCalledWith(
        'new.person@example.com',
        expect.any(String),
      );
      expect(result.emailDelivered).toBe(true);
      expect(result.seatUsage.usedSeats).toBe(2);
      expect(result.user.mustChangePassword).toBe(true);
      expectNoSecrets(result);
    });

    it('never puts the generated password in the response or an audit row', async () => {
      const result = await service.directCreate(body, tenantAdmin());

      const [, temporaryPassword] =
        emailDeliveryService.sendTemporaryPassword.mock.calls[0];
      expect(JSON.stringify(result)).not.toContain(temporaryPassword);
      expect(JSON.stringify(authAuditService.record.mock.calls)).not.toContain(
        temporaryPassword,
      );
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ event: AuthAuditEvent.USER_DIRECT_CREATED }),
      );
    });

    it('checks the shared quota before writing anything', async () => {
      userQuotaService.assertSeatsAvailable.mockRejectedValue(
        new BadRequestException({ error: USER_ERROR_CODES.QUOTA_EXCEEDED }),
      );

      await expect(
        service.directCreate(body, tenantAdmin()),
      ).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.QUOTA_EXCEEDED },
      });
      expect(userQuotaService.assertSeatsAvailable).toHaveBeenCalledWith(
        TENANT_ID,
        1,
      );
      expect(prisma.authAccount.create).not.toHaveBeenCalled();
      expect(prisma.tenantUser.create).not.toHaveBeenCalled();
    });

    it('asserts email uniqueness inside the transaction that writes the user', async () => {
      await service.directCreate(body, tenantAdmin());

      expect(
        tenantUserDirectoryService.assertEmailAvailable,
      ).toHaveBeenCalledWith(TENANT_ID, 'new.person@example.com', prisma);
    });

    it('creates nothing when the address already belongs to the tenant', async () => {
      tenantUserDirectoryService.assertEmailAvailable.mockRejectedValue(
        new BadRequestException({
          error: USER_ERROR_CODES.EMAIL_ALREADY_EXISTS,
        }),
      );

      await expect(
        service.directCreate(body, tenantAdmin()),
      ).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.EMAIL_ALREADY_EXISTS },
      });
      expect(prisma.tenantUser.create).not.toHaveBeenCalled();
    });

    it('refuses a system caller: creating a SystemUser is not this flow', async () => {
      await expect(
        service.directCreate(body, systemAdmin()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(userQuotaService.assertSeatsAvailable).not.toHaveBeenCalled();
    });

    it('refuses a role from outside the tenant', async () => {
      prisma.role.findFirst.mockResolvedValue(null);

      await expect(
        service.directCreate(
          { ...body, roleId: 'role_of_other_tenant' },
          tenantAdmin(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tenantUser.create).not.toHaveBeenCalled();
    });

    it('reports a failed delivery instead of failing the creation', async () => {
      emailDeliveryService.sendTemporaryPassword.mockResolvedValue({
        delivered: false,
        errorCode: 'SMTP_NOT_CONFIGURED',
      });

      const result = await service.directCreate(body, tenantAdmin());

      expect(result.emailDelivered).toBe(false);
      expect(result.user.id).toBe('tu_new');
    });
  });

  describe('approveUser', () => {
    it('moves pending_approval to active and lets the account log in', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        tenantUserRowWithTenant({
          status: TenantUserStatus.PENDING_APPROVAL,
          isActive: false,
        }),
      );
      prisma.tenantUser.update.mockResolvedValue(tenantUserRow());

      const result = await service.approveUser(TARGET_USER_ID, tenantAdmin());

      expect(prisma.tenantUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TARGET_USER_ID },
          data: { status: TenantUserStatus.ACTIVE, isActive: true },
        }),
      );
      expect(
        emailDeliveryService.sendSelfRegistrationWelcome,
      ).toHaveBeenCalledWith(TARGET_EMAIL, 'Acme');
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ event: AuthAuditEvent.USER_APPROVED }),
      );
      expect(result.revokedSessionCount).toBe(0);
      expect(result.user.isActive).toBe(true);
    });

    it.each([
      TenantUserStatus.ACTIVE,
      TenantUserStatus.PENDING_INVITE,
      TenantUserStatus.LOCKED,
    ])('refuses to approve a %s user loudly', async (status) => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        tenantUserRowWithTenant({ status }),
      );

      await expect(
        service.approveUser(TARGET_USER_ID, tenantAdmin()),
      ).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.INVALID_STATUS_TRANSITION },
      });
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
    });

    it('answers 404 for a user of another tenant', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);

      await expect(
        service.approveUser('tu_of_other_tenant', tenantAdmin()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tu_of_other_tenant', tenantId: TENANT_ID },
        }),
      );
    });

    it('refuses a system caller', async () => {
      await expect(
        service.approveUser(TARGET_USER_ID, systemAdmin()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('lockUser', () => {
    beforeEach(() => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRowWithTenant());
      prisma.tenantUser.update.mockResolvedValue(
        tenantUserRow({ status: TenantUserStatus.LOCKED, isActive: false }),
      );
      accountLifecycleService.revokeLiveSessions.mockResolvedValue(3);
    });

    it('clears isActive in the same write as the status and revokes sessions', async () => {
      const result = await service.lockUser(TARGET_USER_ID, tenantAdmin());

      expect(prisma.tenantUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TARGET_USER_ID },
          // One statement: a lock that moved only `status` would leave a
          // locked user still able to authenticate.
          data: { status: TenantUserStatus.LOCKED, isActive: false },
        }),
      );
      // Reused rather than re-implemented, and inside the same transaction
      // as the write it accompanies.
      expect(accountLifecycleService.revokeLiveSessions).toHaveBeenCalledWith(
        prisma,
        TARGET_ACCOUNT_ID,
        expect.any(Date),
      );
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(result.revokedSessionCount).toBe(3);
      expect(result.user.status).toBe(TenantUserStatus.LOCKED);
      expect(result.user.isActive).toBe(false);
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          event: AuthAuditEvent.USER_LOCKED,
          metadata: expect.objectContaining({ revokedSessionCount: 3 }),
        }),
      );
    });

    it('refuses an administrator locking themselves out', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        tenantUserRowWithTenant({
          id: ADMIN_USER_ID,
          authAccountId: ADMIN_ACCOUNT_ID,
        }),
      );

      await expect(
        service.lockUser(ADMIN_USER_ID, tenantAdmin()),
      ).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.CANNOT_LOCK_SELF },
      });
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
    });

    it.each([
      TenantUserStatus.LOCKED,
      TenantUserStatus.PENDING_APPROVAL,
      TenantUserStatus.PENDING_INVITE,
    ])('refuses to lock a %s user loudly', async (status) => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        tenantUserRowWithTenant({ status }),
      );

      await expect(
        service.lockUser(TARGET_USER_ID, tenantAdmin()),
      ).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.INVALID_STATUS_TRANSITION },
      });
      expect(accountLifecycleService.revokeLiveSessions).not.toHaveBeenCalled();
    });

    it('refuses to touch a deleted membership at all', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        tenantUserRowWithTenant({ status: TenantUserStatus.DELETED }),
      );

      await expect(
        service.lockUser(TARGET_USER_ID, tenantAdmin()),
      ).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.INVALID_STATUS_TRANSITION },
      });
    });

    it('answers 404 for a user of another tenant', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);

      await expect(
        service.lockUser('tu_of_other_tenant', tenantAdmin()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('requires tenant.user.manage', async () => {
      await expect(
        service.lockUser(
          TARGET_USER_ID,
          tenantAdmin({ permissions: [TENANT_USER_READ_PERMISSION] }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('unlockUser', () => {
    it('restores status and isActive together', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        tenantUserRowWithTenant({
          status: TenantUserStatus.LOCKED,
          isActive: false,
        }),
      );
      prisma.tenantUser.update.mockResolvedValue(tenantUserRow());

      const result = await service.unlockUser(TARGET_USER_ID, tenantAdmin());

      expect(prisma.tenantUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: TenantUserStatus.ACTIVE, isActive: true },
        }),
      );
      expect(result.user.isActive).toBe(true);
      expect(result.revokedSessionCount).toBe(0);
      expect(authAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ event: AuthAuditEvent.USER_UNLOCKED }),
      );
    });

    it('refuses to unlock a user who is not locked', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(tenantUserRowWithTenant());

      await expect(
        service.unlockUser(TARGET_USER_ID, tenantAdmin()),
      ).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.INVALID_STATUS_TRANSITION },
      });
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
    });

    it('answers 404 across the tenant boundary', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);

      await expect(
        service.unlockUser(`${OTHER_TENANT_ID}_user`, tenantAdmin()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
