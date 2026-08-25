import { InternalServerErrorException } from '@nestjs/common';
import { FirstAdminService } from './first-admin.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('FirstAdminService', () => {
  const tenantId = 'tenant1';
  const firstAdminEmail = 'admin@acme.example';

  function buildTx() {
    return {
      tenantUser: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'tenant-user-1',
          tenantId,
          authAccountId: 'auth-account-1',
          status: 'pending_setup',
        }),
        update: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
      },
      systemUser: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      authAccount: {
        create: jest.fn().mockResolvedValue({
          id: 'auth-account-1',
          email: firstAdminEmail,
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      role: {
        upsert: jest.fn().mockResolvedValue({
          id: 'role-1',
          tenantId,
          name: 'TENANT_ADMIN',
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      permission: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'perm-1' }, { id: 'perm-2' }]),
      },
      rolePermission: {
        upsert: jest.fn().mockResolvedValue(undefined),
      },
    };
  }

  function buildService() {
    const tx = buildTx();
    const prisma = {
      $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
        callback(tx),
      ),
      // deactivate() reads ids via `this.prisma` (not `tx`) before the
      // transaction runs, so it can report whatever it found even if the
      // subsequent delete then fails.
      role: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      tenantUser: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new FirstAdminService(prisma as unknown as PrismaService);

    return { service, prisma, tx };
  }

  it('creates exactly one AuthAccount and one TenantUser, starting in pending_setup status', async () => {
    const { service, tx } = buildService();

    await service.assign(tenantId, firstAdminEmail);

    expect(tx.systemUser.findFirst).toHaveBeenCalledWith({
      where: { authAccount: { email: firstAdminEmail } },
      select: { id: true },
    });
    expect(tx.authAccount.create).toHaveBeenCalledTimes(1);
    expect(tx.authAccount.create).toHaveBeenCalledWith({
      data: {
        email: firstAdminEmail,
        passwordHash: expect.any(String),
      },
    });
    // Placeholder password is a real bcrypt hash, never blank/guessable.
    const createArgs = tx.authAccount.create.mock.calls[0][0];
    expect(createArgs.data.passwordHash).not.toBe('');
    expect(createArgs.data.passwordHash).toMatch(/^\$2[aby]\$/);

    expect(tx.tenantUser.create).toHaveBeenCalledTimes(1);
    expect(tx.tenantUser.create).toHaveBeenCalledWith({
      data: {
        tenantId,
        authAccountId: 'auth-account-1',
        status: 'pending_setup',
      },
    });
  });

  it('ensures the TENANT_ADMIN role exists with tenant-scoped permissions only and assigns it', async () => {
    const { service, tx } = buildService();

    await service.assign(tenantId, firstAdminEmail);

    expect(tx.role.upsert).toHaveBeenCalledWith({
      where: { tenantId_name: { tenantId, name: 'TENANT_ADMIN' } },
      update: {},
      create: expect.objectContaining({
        tenantId,
        name: 'TENANT_ADMIN',
      }),
    });

    expect(tx.permission.findMany).toHaveBeenCalledWith({
      where: { scope: 'TENANT' },
      select: { id: true },
    });
    expect(tx.rolePermission.upsert).toHaveBeenCalledTimes(2);
    expect(tx.rolePermission.upsert).toHaveBeenCalledWith({
      where: {
        roleId_permissionId: { roleId: 'role-1', permissionId: 'perm-1' },
      },
      update: {},
      create: { roleId: 'role-1', permissionId: 'perm-1' },
    });

    expect(tx.tenantUser.update).toHaveBeenCalledWith({
      where: { id: 'tenant-user-1' },
      data: { roles: { connect: [{ id: 'role-1' }] } },
    });
  });

  it('retry: reuses the existing TenantUser/AuthAccount/Role rather than creating duplicates', async () => {
    const { service, tx } = buildService();
    (tx.tenantUser.findFirst as jest.Mock).mockResolvedValue({
      id: 'tenant-user-1',
      tenantId,
      authAccountId: 'auth-account-1',
      status: 'pending_setup',
    });

    await service.assign(tenantId, firstAdminEmail);

    expect(tx.authAccount.create).not.toHaveBeenCalled();
    expect(tx.tenantUser.create).not.toHaveBeenCalled();
    expect(tx.systemUser.findFirst).not.toHaveBeenCalled();
    // Role is still ensured via upsert (idempotent by natural key) and
    // reassigned (idempotent connect) even on replay.
    expect(tx.role.upsert).toHaveBeenCalledTimes(1);
    expect(tx.tenantUser.update).toHaveBeenCalledWith({
      where: { id: 'tenant-user-1' },
      data: { roles: { connect: [{ id: 'role-1' }] } },
    });
  });

  it('rejects when the target AuthAccount would back a SystemUser', async () => {
    const { service, tx } = buildService();
    (tx.systemUser.findFirst as jest.Mock).mockResolvedValue({
      id: 'system-user-1',
    });

    await expect(service.assign(tenantId, firstAdminEmail)).rejects.toThrow(
      InternalServerErrorException,
    );

    expect(tx.authAccount.create).not.toHaveBeenCalled();
    expect(tx.tenantUser.create).not.toHaveBeenCalled();
  });

  it('propagates a mid-transaction error so the whole transaction rolls back', async () => {
    const { service, prisma, tx } = buildService();
    (tx.role.upsert as jest.Mock).mockRejectedValueOnce(
      new Error('connection terminated unexpectedly'),
    );

    await expect(service.assign(tenantId, firstAdminEmail)).rejects.toThrow(
      'connection terminated unexpectedly',
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Role assignment never happens once the role upsert itself fails.
    expect(tx.tenantUser.update).not.toHaveBeenCalled();
  });

  describe('deactivate() (Story 2.6 compensation)', () => {
    it('removes the TenantUser, its AuthAccount, and the TENANT_ADMIN role, returning their ids', async () => {
      const { service, prisma, tx } = buildService();
      (prisma.tenantUser.findFirst as jest.Mock).mockResolvedValue({
        id: 'tenant-user-1',
        authAccountId: 'auth-account-1',
      });
      (prisma.role.findUnique as jest.Mock).mockResolvedValue({
        id: 'role-1',
      });

      const result = await service.deactivate(tenantId);

      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith({
        where: { tenantId },
        select: { id: true, authAccountId: true },
      });
      expect(prisma.role.findUnique).toHaveBeenCalledWith({
        where: { tenantId_name: { tenantId, name: 'TENANT_ADMIN' } },
        select: { id: true },
      });
      expect(tx.tenantUser.delete).toHaveBeenCalledWith({
        where: { id: 'tenant-user-1' },
      });
      expect(tx.authAccount.deleteMany).toHaveBeenCalledWith({
        where: { id: 'auth-account-1' },
      });
      expect(tx.role.deleteMany).toHaveBeenCalledWith({
        where: { tenantId, name: 'TENANT_ADMIN' },
      });

      // Ids found before the delete are returned -- used by callers to
      // report exact identifiers in a compensation-failure audit record.
      expect(result).toEqual({
        tenantUserId: 'tenant-user-1',
        authAccountId: 'auth-account-1',
        roleId: 'role-1',
      });
    });

    it('is idempotent: a safe no-op returning an empty id set when no First Admin actor or role exists for the tenant', async () => {
      const { service, tx } = buildService();

      const result = await service.deactivate(tenantId);

      expect(tx.tenantUser.delete).not.toHaveBeenCalled();
      expect(tx.authAccount.deleteMany).not.toHaveBeenCalled();
      // The role is still targeted for removal even if no actor was ever
      // created (e.g. the failure happened before assign() ran but after a
      // stray role bootstrap) -- deleteMany matching zero rows is safe.
      expect(tx.role.deleteMany).toHaveBeenCalledWith({
        where: { tenantId, name: 'TENANT_ADMIN' },
      });
      expect(result).toEqual({});
    });

    it('reports the role id found even when no TenantUser exists', async () => {
      const { service, prisma } = buildService();
      (prisma.role.findUnique as jest.Mock).mockResolvedValue({
        id: 'role-1',
      });

      const result = await service.deactivate(tenantId);

      expect(result).toEqual({ roleId: 'role-1' });
    });

    it('runs entirely inside one prisma.$transaction', async () => {
      const { service, prisma } = buildService();

      await service.deactivate(tenantId);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});
