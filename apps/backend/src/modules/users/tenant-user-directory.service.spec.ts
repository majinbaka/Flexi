import { ConflictException } from '@nestjs/common';
import { TenantUserStatus, USER_ERROR_CODES } from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantUserDirectoryService } from './tenant-user-directory.service';

const TENANT_ID = 'tenant_1';

interface PrismaMock {
  tenantUser: { findFirst: jest.Mock };
}

function createPrismaMock(existing: unknown = null): PrismaMock {
  return { tenantUser: { findFirst: jest.fn().mockResolvedValue(existing) } };
}

function createService(prisma: PrismaMock): TenantUserDirectoryService {
  return new TenantUserDirectoryService(prisma as unknown as PrismaService);
}

describe('TenantUserDirectoryService', () => {
  describe('normalizeEmail', () => {
    it.each([
      ['  Admin@Acme.COM  ', 'admin@acme.com'],
      ['user@acme.com', 'user@acme.com'],
    ])('normalizes %s to %s', (input, expected) => {
      expect(createService(createPrismaMock()).normalizeEmail(input)).toBe(
        expected,
      );
    });
  });

  describe('findMemberByEmail', () => {
    it('looks the address up normalized, the way login resolves it', async () => {
      const prisma = createPrismaMock();

      await createService(prisma).findMemberByEmail(
        TENANT_ID,
        ' Target@Example.com ',
      );

      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith({
        where: {
          tenantId: TENANT_ID,
          status: { not: TenantUserStatus.DELETED },
          authAccount: { email: 'target@example.com' },
        },
        select: { id: true, authAccountId: true, status: true },
      });
    });

    it('runs inside the caller transaction when one is passed', async () => {
      const prisma = createPrismaMock();
      const tx = createPrismaMock();

      await createService(prisma).findMemberByEmail(
        TENANT_ID,
        'target@example.com',
        tx as unknown as PrismaService,
      );

      expect(tx.tenantUser.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.tenantUser.findFirst).not.toHaveBeenCalled();
    });

    it('returns the membership when the address is taken', async () => {
      const prisma = createPrismaMock({
        id: 'tu_1',
        authAccountId: 'auth_1',
        status: TenantUserStatus.LOCKED,
      });

      await expect(
        createService(prisma).findMemberByEmail(
          TENANT_ID,
          'target@example.com',
        ),
      ).resolves.toEqual({
        tenantUserId: 'tu_1',
        authAccountId: 'auth_1',
        status: TenantUserStatus.LOCKED,
      });
    });
  });

  describe('assertEmailAvailable', () => {
    it('passes when nobody in the tenant holds the address', async () => {
      await expect(
        createService(createPrismaMock()).assertEmailAvailable(
          TENANT_ID,
          'new@example.com',
        ),
      ).resolves.toBeUndefined();
    });

    it('throws 409 EMAIL_ALREADY_EXISTS when somebody does', async () => {
      const service = createService(
        createPrismaMock({
          id: 'tu_1',
          authAccountId: 'auth_1',
          status: TenantUserStatus.ACTIVE,
        }),
      );

      await expect(
        service.assertEmailAvailable(TENANT_ID, 'taken@example.com'),
      ).rejects.toThrow(ConflictException);
      await expect(
        service.assertEmailAvailable(TENANT_ID, 'taken@example.com'),
      ).rejects.toMatchObject({
        response: { error: USER_ERROR_CODES.EMAIL_ALREADY_EXISTS },
      });
    });

    it('frees the address again once the member is soft-deleted', async () => {
      const prisma = createPrismaMock();

      await createService(prisma).assertEmailAvailable(
        TENANT_ID,
        'left@example.com',
      );

      const where = (
        prisma.tenantUser.findFirst.mock.calls[0][0] as {
          where: { status: { not: string } };
        }
      ).where;
      expect(where.status).toEqual({ not: TenantUserStatus.DELETED });
    });
  });
});
