import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';

type PrismaTransactionClient = Prisma.TransactionClient;

const TENANT_ADMIN_ROLE_NAME = 'TENANT_ADMIN';
const TENANT_USER_STATUS_PENDING_SETUP = 'pending_setup';
const PASSWORD_SALT_ROUNDS = 10;
const PERMISSION_SCOPE_TENANT = 'TENANT';

/**
 * Creates the First Admin login identity and its `TENANT_ADMIN`
 * authorization role for a `PROVISIONING` tenant (Story 2.4).
 *
 * Deliberately separate from `prisma/seed.ts` (which seeds demo data with
 * caller-supplied, publicly-known passwords) -- this service always
 * generates a random, unusable placeholder password since the First Admin's
 * real credential setup happens in Story 2.5 via a one-time setup link.
 *
 * Public-schema/Prisma only -- never touches the tenant-schema Knex
 * `roles`/`role_permissions` tables created by `TenantSeedService`
 * (Story 2.3); those are a disconnected business-data catalog, not the
 * authorization-gating `Role` this service creates/assigns.
 */
@Injectable()
export class FirstAdminService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent: safe to call repeatedly for the same `tenantId` (BullMQ
   * retry). Reuses an existing `TenantUser`/`AuthAccount`/`Role` rather than
   * creating duplicates. Runs entirely inside one `prisma.$transaction` so a
   * mid-way failure rolls back cleanly with no partial rows persisted.
   */
  async assign(tenantId: string, firstAdminEmail: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existingTenantUser = await tx.tenantUser.findFirst({
        where: { tenantId },
      });

      const authAccountId = existingTenantUser
        ? existingTenantUser.authAccountId
        : await this.createFirstAdminAuthAccount(tx, firstAdminEmail);

      const tenantUser =
        existingTenantUser ??
        (await tx.tenantUser.create({
          data: {
            tenantId,
            authAccountId,
            status: TENANT_USER_STATUS_PENDING_SETUP,
          },
        }));

      const role = await tx.role.upsert({
        where: {
          tenantId_name: { tenantId, name: TENANT_ADMIN_ROLE_NAME },
        },
        update: {},
        create: {
          tenantId,
          name: TENANT_ADMIN_ROLE_NAME,
          description: 'Full administrative access to the tenant workspace.',
        },
      });

      await this.grantTenantScopePermissions(tx, role.id);

      await tx.tenantUser.update({
        where: { id: tenantUser.id },
        data: { roles: { connect: [{ id: role.id }] } },
      });
    });
  }

  /**
   * Creates a brand-new `AuthAccount` for the First Admin, rejecting first
   * if an `AuthAccount` for this email already backs a `SystemUser` --
   * check-before-create, since no DB constraint enforces the
   * SystemUser-XOR-TenantUser invariant (mirrors the read-time guard in
   * `auth.service.ts`'s `resolveActorByAuthAccountId()`).
   *
   * The password is a random, unusable bcrypt hash -- never a guessable
   * fixed string, never left blank -- since real credential setup happens
   * in Story 2.5.
   */
  private async createFirstAdminAuthAccount(
    tx: PrismaTransactionClient,
    email: string,
  ): Promise<string> {
    const existingSystemUser = await tx.systemUser.findFirst({
      where: { authAccount: { email } },
      select: { id: true },
    });

    if (existingSystemUser) {
      throw new InternalServerErrorException(
        'First Admin email is already in use by a system-level account.',
      );
    }

    const passwordHash = await bcrypt.hash(
      randomUUID(),
      PASSWORD_SALT_ROUNDS,
    );
    const authAccount = await tx.authAccount.create({
      data: { email, passwordHash },
    });

    return authAccount.id;
  }

  /**
   * Grants the `TENANT_ADMIN` role every currently-seeded `TENANT`-scope
   * `Permission`, mirroring `assignPermissionToRole()` in `prisma/seed.ts`
   * (same natural-key upsert shape, same tenant-role-never-holds-SYSTEM-scope
   * rule -- enforced here by only ever querying `TENANT`-scope permissions).
   */
  private async grantTenantScopePermissions(
    tx: PrismaTransactionClient,
    roleId: string,
  ): Promise<void> {
    const tenantScopePermissions = await tx.permission.findMany({
      where: { scope: PERMISSION_SCOPE_TENANT },
      select: { id: true },
    });

    for (const permission of tenantScopePermissions) {
      await tx.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId, permissionId: permission.id },
        },
        update: {},
        create: { roleId, permissionId: permission.id },
      });
    }
  }
}
