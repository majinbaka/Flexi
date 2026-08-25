import { NotFoundException } from '@nestjs/common';
import { SetupLinkService } from './setup-link.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('SetupLinkService', () => {
  const tenantId = 'tenant1';

  function buildTx() {
    return {
      tenantUser: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tenant-user-1' }),
      },
      setupToken: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({
          id: 'setup-token-1',
          tenantId,
          tokenHash: 'hash',
          expiresAt: new Date(),
        }),
      },
    };
  }

  function buildService() {
    const tx = buildTx();
    const prisma = {
      $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
        callback(tx),
      ),
      setupToken: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const service = new SetupLinkService(prisma as unknown as PrismaService);

    return { service, prisma, tx };
  }

  it('generates a fresh raw token and persists only its hash with a 24h expiry', async () => {
    const { service, tx } = buildService();
    const before = Date.now();

    const result = await service.generate(tenantId);

    expect(tx.tenantUser.findFirst).toHaveBeenCalledWith({
      where: { tenantId },
      select: { id: true },
    });
    expect(tx.setupToken.create).toHaveBeenCalledTimes(1);
    const createArgs = tx.setupToken.create.mock.calls[0][0];
    expect(createArgs.data.tenantId).toBe(tenantId);
    expect(createArgs.data.tokenHash).toEqual(expect.any(String));
    // The raw token is never part of the persisted row.
    expect(createArgs.data).not.toHaveProperty('setupToken');
    expect(createArgs.data).not.toHaveProperty('token');
    expect(Object.values(createArgs.data)).not.toContain(result.setupToken);

    // Raw token returned once, in-memory -- base64url, non-empty.
    expect(result.setupToken).toEqual(expect.any(String));
    expect(result.setupToken.length).toBeGreaterThan(0);

    // Hash is a SHA-256 hex digest of the returned raw token.
    const { createHash } = await import('crypto');
    expect(createArgs.data.tokenHash).toBe(
      createHash('sha256').update(result.setupToken).digest('hex'),
    );

    // Expiry is ~24h from now.
    const expectedExpiry = before + 24 * 60 * 60 * 1000;
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(
      expectedExpiry - 5000,
    );
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(
      expectedExpiry + 5000,
    );
  });

  it('revokes every non-revoked SetupToken for the tenant before minting a new one (regeneration always rotates)', async () => {
    const { service, tx } = buildService();

    await service.generate(tenantId);

    expect(tx.setupToken.updateMany).toHaveBeenCalledWith({
      where: { tenantId, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });

    // Revoke must happen before the new token is created.
    const updateManyOrder =
      tx.setupToken.updateMany.mock.invocationCallOrder[0];
    const createOrder = tx.setupToken.create.mock.invocationCallOrder[0];
    expect(updateManyOrder).toBeLessThan(createOrder);
  });

  it('rejects with NotFoundException when no TenantUser exists yet for the tenant, and creates no token', async () => {
    const { service, tx } = buildService();
    (tx.tenantUser.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(service.generate(tenantId)).rejects.toThrow(NotFoundException);

    expect(tx.setupToken.updateMany).not.toHaveBeenCalled();
    expect(tx.setupToken.create).not.toHaveBeenCalled();
  });

  it('runs entirely inside one prisma.$transaction', async () => {
    const { service, prisma } = buildService();

    await service.generate(tenantId);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('mints a different raw token on each call (no reuse across invocations)', async () => {
    const { service } = buildService();

    const first = await service.generate(tenantId);
    const second = await service.generate(tenantId);

    expect(first.setupToken).not.toBe(second.setupToken);
  });

  describe('revokeAll() (Story 2.6 compensation)', () => {
    it('revokes every non-revoked SetupToken for the tenant', async () => {
      const { service, prisma } = buildService();

      await service.revokeAll(tenantId);

      expect(prisma.setupToken.updateMany).toHaveBeenCalledWith({
        where: { tenantId, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('is idempotent: matching zero rows resolves without error when no non-revoked tokens exist', async () => {
      const { service, prisma } = buildService();
      (prisma.setupToken.updateMany as jest.Mock).mockResolvedValue({
        count: 0,
      });

      await expect(service.revokeAll(tenantId)).resolves.toBeUndefined();
    });

    it('never deletes SetupToken rows -- only marks them revoked', async () => {
      const { service, prisma } = buildService();

      await service.revokeAll(tenantId);

      expect(prisma.setupToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ delete: expect.anything() }),
        }),
      );
    });
  });
});
