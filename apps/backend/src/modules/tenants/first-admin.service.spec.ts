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
      },
      systemUser: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      authAccount: {
        create: jest.fn().mockResolvedValue({
          id: 'auth-account-1',
          email: firstAdminEmail,
        }),
      },
      role: {
        upsert: jest.fn().mockResolvedValue({
          id: 'role-1',
          tenantId,
          name: 'TENANT_ADMIN',
        }),
      },
      permission: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'perm-1' },
          { id: 'perm-2' },
        ]),
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
      where: { roleId_permissionId: { roleId: 'role-1', permissionId: 'perm-1' } },
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
});
