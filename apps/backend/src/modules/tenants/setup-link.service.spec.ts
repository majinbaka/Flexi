import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import * as bcrypt from 'bcryptjs';
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

  describe('redeem()', () => {
    const rawToken = 'a-valid-setup-token';
    const password = 'First-admin-password';

    function buildRedeemService(options?: {
      setupToken?: {
        id: string;
        tenantId: string;
        expiresAt: Date;
        revokedAt: Date | null;
        usedAt: Date | null;
      } | null;
      tenantUser?: { id: string; authAccountId: string } | null;
      consumeCount?: number;
    }) {
      const setupToken =
        options?.setupToken === undefined
          ? {
              id: 'setup-token-1',
              tenantId,
              expiresAt: new Date(Date.now() + 60_000),
              revokedAt: null,
              usedAt: null,
            }
          : options.setupToken;
      const tx = {
        setupToken: {
          findUnique: jest.fn().mockResolvedValue(setupToken),
          updateMany: jest
            .fn()
            .mockResolvedValueOnce({ count: options?.consumeCount ?? 1 })
            .mockResolvedValue({ count: 1 }),
        },
        tenantUser: {
          findFirst: jest
            .fn()
            .mockResolvedValue(
              options?.tenantUser === undefined
                ? { id: 'tenant-user-1', authAccountId: 'auth-account-1' }
                : options.tenantUser,
            ),
          update: jest.fn().mockResolvedValue({ id: 'tenant-user-1' }),
        },
        authAccount: {
          update: jest.fn().mockResolvedValue({ id: 'auth-account-1' }),
        },
      };
      const prisma = {
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
          callback(tx),
        ),
      };

      return {
        service: new SetupLinkService(prisma as unknown as PrismaService),
        tx,
        prisma,
      };
    }

    async function expectOpaqueInvalidTokenError(
      operation: Promise<unknown>,
    ): Promise<void> {
      await expect(operation).rejects.toMatchObject({
        response: {
          error: 'INVALID_SETUP_TOKEN',
          message: 'The setup link is invalid or has expired.',
        },
      });
    }

    it('hashes the supplied password, activates the pending First Admin, consumes the token, and revokes siblings atomically', async () => {
      const { service, tx, prisma } = buildRedeemService();

      await service.redeem({ token: rawToken, password });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.setupToken.findUnique).toHaveBeenCalledWith({
        where: {
          tokenHash: createHash('sha256').update(rawToken).digest('hex'),
        },
        select: {
          id: true,
          tenantId: true,
          expiresAt: true,
          revokedAt: true,
          usedAt: true,
        },
      });
      expect(tx.setupToken.updateMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'setup-token-1',
            revokedAt: null,
            usedAt: null,
          }),
          data: { usedAt: expect.any(Date) },
        }),
      );
      expect(tx.authAccount.update).toHaveBeenCalledWith({
        where: { id: 'auth-account-1' },
        data: { passwordHash: expect.any(String) },
      });
      const passwordHash =
        tx.authAccount.update.mock.calls[0][0].data.passwordHash;
      await expect(bcrypt.compare(password, passwordHash)).resolves.toBe(true);
      expect(tx.tenantUser.update).toHaveBeenCalledWith({
        where: { id: 'tenant-user-1' },
        data: { status: 'active' },
      });
      expect(tx.setupToken.updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: {
            tenantId,
            id: { not: 'setup-token-1' },
            revokedAt: null,
            usedAt: null,
          },
          data: { revokedAt: expect.any(Date) },
        }),
      );
    });

    it.each([
      ['unknown', null],
      [
        'expired',
        {
          id: 'expired-token',
          tenantId,
          expiresAt: new Date(Date.now() - 1),
          revokedAt: null,
          usedAt: null,
        },
      ],
      [
        'revoked',
        {
          id: 'revoked-token',
          tenantId,
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: new Date(),
          usedAt: null,
        },
      ],
      [
        'previously used',
        {
          id: 'used-token',
          tenantId,
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
          usedAt: new Date(),
        },
      ],
    ])(
      'rejects a %s token with the same opaque error',
      async (_kind, token) => {
        const { service, tx } = buildRedeemService({ setupToken: token });

        await expectOpaqueInvalidTokenError(
          service.redeem({ token: rawToken, password }),
        );

        expect(tx.tenantUser.findFirst).not.toHaveBeenCalled();
        expect(tx.authAccount.update).not.toHaveBeenCalled();
        expect(tx.tenantUser.update).not.toHaveBeenCalled();
        expect(tx.setupToken.updateMany).not.toHaveBeenCalled();
      },
    );

    it('rejects a token that was consumed by a concurrent redemption without changing the account', async () => {
      const { service, tx } = buildRedeemService({ consumeCount: 0 });

      await expectOpaqueInvalidTokenError(
        service.redeem({ token: rawToken, password }),
      );

      expect(tx.authAccount.update).not.toHaveBeenCalled();
      expect(tx.tenantUser.update).not.toHaveBeenCalled();
    });

    it('allows only one concurrent redemption to consume the same token', async () => {
      const { service, tx } = buildRedeemService();
      let isAvailable = true;
      (tx.setupToken.updateMany as jest.Mock)
        .mockReset()
        .mockImplementation(
          (args: { data: { usedAt?: Date; revokedAt?: Date } }) => {
            if (args.data.usedAt) {
              const count = isAvailable ? 1 : 0;
              isAvailable = false;
              return Promise.resolve({ count });
            }

            return Promise.resolve({ count: 1 });
          },
        );

      const results = await Promise.allSettled([
        service.redeem({ token: rawToken, password }),
        service.redeem({ token: rawToken, password }),
      ]);

      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      expect(tx.authAccount.update).toHaveBeenCalledTimes(1);
      expect(tx.tenantUser.update).toHaveBeenCalledTimes(1);
    });

    it('validates password input without examining the setup token', async () => {
      const { service, tx } = buildRedeemService();

      await expect(
        service.redeem({ token: rawToken, password: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(tx.setupToken.findUnique).not.toHaveBeenCalled();
    });
  });
});
