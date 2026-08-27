import { BadRequestException } from '@nestjs/common';
import {
  ActorType,
  AuthAuditEvent,
  AuthenticatedUserDto,
  TENANT_USER_MANAGE_PERMISSION,
  TenantUserStatus,
  USER_ERROR_CODES,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext } from '../../tenancy/tenant-context';
import { TenantKnexService } from '../../tenancy/tenant-knex.service';
import { AccountLifecycleService } from './account-lifecycle.service';
import { UserDeletionService } from './user-deletion.service';

const source = {
  id: 'user_source',
  tenantId: 'tenant_1',
  authAccountId: 'auth_source',
  status: TenantUserStatus.ACTIVE,
  isActive: true,
};
const target = {
  id: 'user_target',
  tenantId: 'tenant_1',
  authAccountId: 'auth_target',
  status: TenantUserStatus.ACTIVE,
  isActive: true,
};
const caller: AuthenticatedUserDto = {
  authAccountId: 'auth_admin',
  actorType: ActorType.TENANT,
  tenantId: 'tenant_1',
  tenantUserId: 'user_admin',
  email: 'admin@example.com',
  name: 'Admin',
  roles: ['TENANT_ADMIN'],
  permissions: [TENANT_USER_MANAGE_PERMISSION],
};

describe('UserDeletionService', () => {
  function buildService() {
    const prisma = {
      tenantUser: { findFirst: jest.fn(), update: jest.fn() },
      authAuditLog: { create: jest.fn().mockResolvedValue(undefined) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      (fn: (tx: typeof prisma) => unknown) => fn(prisma),
    );
    const tenantKnexService = { transaction: jest.fn() };
    const accountLifecycleService = {
      revokeLiveSessions: jest.fn().mockResolvedValue(2),
    };
    const service = new UserDeletionService(
      prisma as unknown as PrismaService,
      tenantKnexService as unknown as TenantKnexService,
      { schema: 'tenant_tenant_1' } as TenantContext,
      accountLifecycleService as unknown as AccountLifecycleService,
    );
    return { service, prisma, tenantKnexService, accountLifecycleService };
  }

  it('soft-deletes, revokes every live refresh token, and audits in one Prisma transaction', async () => {
    const { service, prisma, accountLifecycleService } = buildService();
    prisma.tenantUser.findFirst.mockResolvedValue(source);
    prisma.tenantUser.update.mockResolvedValue(undefined);

    await expect(
      service.deleteUser(source.id, 'soft', undefined, caller),
    ).resolves.toEqual({
      userId: source.id,
      mode: 'soft',
      revokedSessionCount: 2,
      transferredRecordCount: 0,
    });
    expect(prisma.tenantUser.update).toHaveBeenCalledWith({
      where: { id: source.id },
      data: { status: TenantUserStatus.DELETED, isActive: false },
    });
    expect(accountLifecycleService.revokeLiveSessions).toHaveBeenCalledWith(
      prisma,
      source.authAccountId,
      expect.any(Date),
    );
    expect(prisma.authAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: AuthAuditEvent.USER_SOFT_DELETED,
        }),
      }),
    );
  });

  it('refuses self deletion before any mutation', async () => {
    const { service, prisma, tenantKnexService } = buildService();
    prisma.tenantUser.findFirst.mockResolvedValue({
      ...source,
      authAccountId: caller.authAccountId,
    });

    await expect(
      service.deleteUser(source.id, 'hard', undefined, caller),
    ).rejects.toMatchObject({
      response: { error: USER_ERROR_CODES.CANNOT_DELETE_SELF },
    });
    expect(tenantKnexService.transaction).not.toHaveBeenCalled();
  });

  it('refuses an inactive transfer target before any transaction changes state', async () => {
    const { service, prisma, tenantKnexService } = buildService();
    prisma.tenantUser.findFirst
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(null);

    await expect(
      service.deleteUser(source.id, 'hard', target.id, caller),
    ).rejects.toMatchObject({
      response: { error: USER_ERROR_CODES.INVALID_TARGET_USER },
    });
    expect(tenantKnexService.transaction).not.toHaveBeenCalled();
  });

  it('rolls the single database transaction back when owned data has no target', async () => {
    const { service, prisma, tenantKnexService } = buildService();
    prisma.tenantUser.findFirst.mockResolvedValue(source);
    const sourceFirst = jest
      .fn()
      .mockResolvedValue([
        { id: source.id, authAccountId: source.authAccountId },
      ]);
    const publicDb = {
      table: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          whereNot: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({ forUpdate: sourceFirst }),
            }),
          }),
        }),
      }),
    };
    const tenantDb = {
      table: jest.fn((name: string) => {
        if (name === '_meta_tables') {
          return {
            select: jest.fn().mockResolvedValue([
              {
                id: 'table_1',
                name: 'orders',
                owner_column: 'owner_user_id',
              },
            ]),
          };
        }
        return {
          where: jest.fn().mockReturnValue({
            count: jest.fn().mockResolvedValue([{ count: '1' }]),
          }),
        };
      }),
    };
    tenantKnexService.transaction.mockImplementation(
      (
        fn: (trx: {
          withSchema: (schema: string) => unknown;
          schema: {
            withSchema: () => { hasTable: jest.Mock; hasColumn: jest.Mock };
          };
        }) => unknown,
      ) =>
        fn({
          withSchema: (schema) => (schema === 'public' ? publicDb : tenantDb),
          schema: {
            withSchema: () => ({
              hasTable: jest.fn().mockResolvedValue(true),
              hasColumn: jest.fn().mockResolvedValue(true),
            }),
          },
        }),
    );

    await expect(
      service.deleteUser(source.id, 'hard', undefined, caller),
    ).rejects.toThrow(BadRequestException);
    expect(tenantKnexService.transaction).toHaveBeenCalledTimes(1);
  });
});
