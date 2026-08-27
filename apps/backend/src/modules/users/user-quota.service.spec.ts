import { BadRequestException } from '@nestjs/common';
import {
  TenantUserStatus,
  USER_ERROR_CODES,
  UserInviteStatus,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { UNLIMITED_SEATS, UserQuotaService } from './user-quota.service';

const TENANT_ID = 'tenant_1';

interface PrismaMock {
  tenant: { findUnique: jest.Mock };
  tenantUser: { count: jest.Mock };
}

/**
 * `usedSeats()` issues two counts against `tenantUser`: the
 * seat-holding-status count first, the live-invite count second. The mock
 * answers them in that order.
 */
function createPrismaMock(
  maxUsers: number,
  occupied: number,
  invited = 0,
): PrismaMock {
  return {
    tenant: { findUnique: jest.fn().mockResolvedValue({ maxUsers }) },
    tenantUser: {
      count: jest
        .fn()
        .mockResolvedValueOnce(occupied)
        .mockResolvedValueOnce(invited),
    },
  };
}

function createService(prisma: PrismaMock): UserQuotaService {
  return new UserQuotaService(prisma as unknown as PrismaService);
}

describe('UserQuotaService', () => {
  describe('usedSeats', () => {
    it('counts active, pending_setup, pending_approval and locked members', async () => {
      const prisma = createPrismaMock(10, 4);

      await expect(createService(prisma).usedSeats(TENANT_ID)).resolves.toBe(4);

      expect(prisma.tenantUser.count).toHaveBeenNthCalledWith(1, {
        where: {
          tenantId: TENANT_ID,
          status: {
            in: [
              TenantUserStatus.ACTIVE,
              TenantUserStatus.PENDING_SETUP,
              TenantUserStatus.PENDING_APPROVAL,
              TenantUserStatus.LOCKED,
            ],
          },
        },
      });
    });

    it('counts an invited member only while their invite is live', async () => {
      const prisma = createPrismaMock(10, 2, 3);

      await expect(createService(prisma).usedSeats(TENANT_ID)).resolves.toBe(5);

      const inviteQuery = prisma.tenantUser.count.mock.calls[1][0] as {
        where: {
          status: string;
          invites: { some: { status: string; expiresAt: { gt: Date } } };
        };
      };
      expect(inviteQuery.where.status).toBe(TenantUserStatus.PENDING_INVITE);
      expect(inviteQuery.where.invites.some.status).toBe(
        UserInviteStatus.PENDING,
      );
      expect(inviteQuery.where.invites.some.expiresAt.gt).toBeInstanceOf(Date);
    });

    it('never counts deleted members -- their seat is free', async () => {
      const prisma = createPrismaMock(10, 0, 0);

      await expect(createService(prisma).usedSeats(TENANT_ID)).resolves.toBe(0);

      const statuses = (
        prisma.tenantUser.count.mock.calls[0][0] as {
          where: { status: { in: string[] } };
        }
      ).where.status.in;
      expect(statuses).not.toContain(TenantUserStatus.DELETED);
      expect(statuses).not.toContain(TenantUserStatus.PENDING_INVITE);
    });
  });

  describe('assertSeatsAvailable', () => {
    it('allows the request that fills the last seat', async () => {
      const service = createService(createPrismaMock(5, 4));

      await expect(
        service.assertSeatsAvailable(TENANT_ID),
      ).resolves.toMatchObject({
        usedSeats: 4,
        maxUsers: 5,
        remainingSeats: 1,
        unlimited: false,
      });
    });

    it('refuses the request one past the limit', async () => {
      const service = createService(createPrismaMock(5, 5));

      await expect(service.assertSeatsAvailable(TENANT_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('reports QUOTA_EXCEEDED so the frontend can branch on the code', async () => {
      const service = createService(createPrismaMock(5, 5));

      await expect(
        service.assertSeatsAvailable(TENANT_ID),
      ).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.QUOTA_EXCEEDED },
      });
    });

    it('refuses a whole batch that does not fit, rather than the part that does', async () => {
      const service = createService(createPrismaMock(5, 3));

      await expect(service.assertSeatsAvailable(TENANT_ID, 3)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('allows a batch that exactly fills the remaining seats', async () => {
      const service = createService(createPrismaMock(5, 3));

      await expect(
        service.assertSeatsAvailable(TENANT_ID, 2),
      ).resolves.toMatchObject({ remainingSeats: 2 });
    });

    it('skips the check entirely when maxUsers is -1', async () => {
      const service = createService(createPrismaMock(UNLIMITED_SEATS, 9000));

      await expect(
        service.assertSeatsAvailable(TENANT_ID, 500),
      ).resolves.toMatchObject({
        usedSeats: 9000,
        remainingSeats: null,
        unlimited: true,
      });
    });

    it('refuses everything when maxUsers is 0', async () => {
      const service = createService(createPrismaMock(0, 0));

      await expect(service.assertSeatsAvailable(TENANT_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('treats a missing tenant as unlimited rather than as a quota failure', async () => {
      const prisma = createPrismaMock(0, 0);
      prisma.tenant.findUnique.mockResolvedValue(null);

      await expect(
        createService(prisma).assertSeatsAvailable(TENANT_ID),
      ).resolves.toMatchObject({ unlimited: true });
    });
  });

  describe('getSeatUsage', () => {
    it('clamps remainingSeats at zero for an over-quota tenant', async () => {
      const service = createService(createPrismaMock(3, 5));

      await expect(service.getSeatUsage(TENANT_ID)).resolves.toMatchObject({
        usedSeats: 5,
        maxUsers: 3,
        remainingSeats: 0,
      });
    });
  });
});
