import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import {
  ActorType,
  AUTH_ERROR_CODES,
  AuthAuditEvent,
  AuthenticatedUserDto,
  TENANT_USER_MANAGE_PERMISSION,
  TenantUserStatus,
  USER_ERROR_CODES,
  UserDeletionResponseDto,
} from '@flexi/shared-types';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext } from '../../tenancy/tenant-context';
import { TenantKnexService } from '../../tenancy/tenant-knex.service';
import { sanitizeIdentifier } from '../../tenancy/sanitize-identifier';
import { AccountLifecycleService } from './account-lifecycle.service';
import { assertActorPermission } from './actor-permission';

const META_TABLES = '_meta_tables';
const OWNER_COLUMN = 'owner_user_id';

interface TenantUserTarget {
  id: string;
  tenantId: string;
  authAccountId: string;
  status: string;
  isActive: boolean;
}

interface OwnedTable {
  id: string;
  name: string;
  owner_column: string | null;
}

/**
 * Tenant-member deletion, deliberately separate from UsersAdminService so
 * the cross-schema transaction boundary stays visible and cannot quietly be
 * replaced by an unrelated Prisma transaction later.
 */
@Injectable()
export class UserDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantKnexService: TenantKnexService,
    private readonly tenantContext: TenantContext,
    private readonly accountLifecycleService: AccountLifecycleService,
  ) {}

  async deleteUser(
    userId: string,
    mode: 'soft' | 'hard',
    transferToUserId: string | undefined,
    currentUser: AuthenticatedUserDto,
  ): Promise<UserDeletionResponseDto> {
    const actor = this.requireTenantActor(currentUser);
    assertActorPermission(currentUser, [
      TENANT_USER_MANAGE_PERMISSION,
      TENANT_USER_MANAGE_PERMISSION,
    ]);

    const source = await this.resolveSource(userId, actor.tenantId);
    this.assertCanDelete(source, currentUser);

    if (mode === 'soft') {
      return this.softDelete(source, currentUser);
    }

    const target = transferToUserId
      ? await this.resolveActiveTransferTarget(
          transferToUserId,
          source,
          actor.tenantId,
        )
      : undefined;
    return this.hardDelete(source, target, currentUser);
  }

  private async softDelete(
    source: TenantUserTarget,
    currentUser: AuthenticatedUserDto,
  ): Promise<UserDeletionResponseDto> {
    const now = new Date();
    const revokedSessionCount = await this.prisma.$transaction(async (tx) => {
      await tx.tenantUser.update({
        where: { id: source.id },
        data: { status: TenantUserStatus.DELETED, isActive: false },
      });
      return this.accountLifecycleService.revokeLiveSessions(
        tx,
        source.authAccountId,
        now,
      );
    });

    // Soft deletion has no cross-connection work, so the existing
    // best-effort audit service pattern remains appropriate here.
    await this.prisma.authAuditLog.create({
      data: {
        event: AuthAuditEvent.USER_SOFT_DELETED,
        tenantId: source.tenantId,
        subjectAuthAccountId: source.authAccountId,
        actorAuthAccountId: currentUser.authAccountId,
        metadata: { userId: source.id, revokedSessionCount },
      },
    });

    return {
      userId: source.id,
      mode: 'soft',
      revokedSessionCount,
      transferredRecordCount: 0,
    };
  }

  /**
   * One physical PostgreSQL transaction owns every hard-delete write. Prisma
   * is intentionally not used inside: a Prisma transaction and a Knex
   * transaction borrow different connections and are not atomic together.
   * Both `public` and the verified tenant schema are addressed through the
   * same Knex transaction connection instead.
   */
  private async hardDelete(
    source: TenantUserTarget,
    target: TenantUserTarget | undefined,
    currentUser: AuthenticatedUserDto,
  ): Promise<UserDeletionResponseDto> {
    const result = await this.tenantKnexService.transaction(async (trx) => {
      // Knex query builders are mutable. Build a fresh schema-scoped builder
      // for every statement so one WHERE clause cannot leak into another.
      const publicDb = () => trx.withSchema('public');
      const tenantDb = () => trx.withSchema(this.tenantContext.schema);

      const [lockedSource] = await publicDb()
        .table('tenant_users')
        .where({ id: source.id, tenantId: source.tenantId })
        .whereNot({ status: TenantUserStatus.DELETED })
        .select('id', 'authAccountId')
        .limit(1)
        .forUpdate();
      if (!lockedSource) {
        throw this.invalidTransition(
          'deleted',
          'a deleted user cannot be removed',
        );
      }

      if (target) {
        const [lockedTarget] = await publicDb()
          .table('tenant_users')
          .where({
            id: target.id,
            tenantId: source.tenantId,
            status: TenantUserStatus.ACTIVE,
            isActive: true,
          })
          .select('id')
          .limit(1)
          .forUpdate();
        if (!lockedTarget) {
          throw this.invalidTarget();
        }
      }

      const metaSchema = trx.schema.withSchema(this.tenantContext.schema);
      if (!(await metaSchema.hasTable(META_TABLES))) {
        return this.removeHardDeleteSource(publicDb, source, currentUser, 0);
      }
      if (!(await metaSchema.hasColumn(META_TABLES, 'owner_column'))) {
        throw this.ownershipContractRequired();
      }

      const tables = (await tenantDb()
        .table(META_TABLES)
        .select('id', 'name', 'owner_column')) as OwnedTable[];
      const legacy = tables.find(
        (table) => table.owner_column !== OWNER_COLUMN,
      );
      if (legacy) {
        throw this.ownershipContractRequired();
      }

      let transferredRecordCount = 0;
      for (const table of tables) {
        const tableName = sanitizeIdentifier(table.name);
        const [{ count }] = await tenantDb()
          .table(tableName)
          .where({ [OWNER_COLUMN]: source.id })
          .count<{ count: string }[]>({ count: '*' });
        const recordCount = Number(count);
        if (recordCount === 0) {
          continue;
        }
        if (!target) {
          throw new BadRequestException({
            error: 'VALIDATION_ERROR',
            message: 'transferToUserId is required when the user owns data.',
            fields: { transferToUserId: 'TRANSFER_TARGET_REQUIRED' },
          });
        }

        await tenantDb()
          .table(tableName)
          .where({ [OWNER_COLUMN]: source.id })
          .update({ [OWNER_COLUMN]: target.id });
        transferredRecordCount += recordCount;
        await publicDb()
          .table('auth_audit_logs')
          .insert({
            id: randomUUID(),
            event: AuthAuditEvent.DATA_TRANSFERRED,
            tenantId: source.tenantId,
            subjectAuthAccountId: source.authAccountId,
            actorAuthAccountId: currentUser.authAccountId,
            metadata: JSON.stringify({
              sourceUserId: source.id,
              targetUserId: target.id,
              tableId: table.id,
              tableName,
              recordCount,
            }),
            createdAt: new Date(),
          });
      }

      return this.removeHardDeleteSource(
        publicDb,
        source,
        currentUser,
        transferredRecordCount,
      );
    });

    return { userId: source.id, mode: 'hard', ...result };
  }

  private async resolveSource(
    userId: string,
    tenantId: string,
  ): Promise<TenantUserTarget> {
    const source = await this.prisma.tenantUser.findFirst({
      where: { id: userId, tenantId },
      select: {
        id: true,
        tenantId: true,
        authAccountId: true,
        status: true,
        isActive: true,
      },
    });
    if (!source) {
      throw new NotFoundException({
        error: AUTH_ERROR_CODES.USER_NOT_FOUND,
        message: 'No such user.',
      });
    }
    return source;
  }

  private async resolveActiveTransferTarget(
    targetUserId: string,
    source: TenantUserTarget,
    tenantId: string,
  ): Promise<TenantUserTarget> {
    if (targetUserId === source.id) {
      throw this.invalidTarget();
    }
    const target = await this.prisma.tenantUser.findFirst({
      where: {
        id: targetUserId,
        tenantId,
        status: TenantUserStatus.ACTIVE,
        isActive: true,
      },
      select: {
        id: true,
        tenantId: true,
        authAccountId: true,
        status: true,
        isActive: true,
      },
    });
    if (!target) {
      throw this.invalidTarget();
    }
    return target;
  }

  private assertCanDelete(
    source: TenantUserTarget,
    currentUser: AuthenticatedUserDto,
  ): void {
    if (source.authAccountId === currentUser.authAccountId) {
      throw new BadRequestException({
        error: USER_ERROR_CODES.CANNOT_DELETE_SELF,
        message: 'An administrator cannot delete their own account.',
      });
    }
    if (source.status === TenantUserStatus.DELETED) {
      throw this.invalidTransition(
        source.status,
        'a deleted user can no longer be changed',
      );
    }
  }

  private requireTenantActor(currentUser: AuthenticatedUserDto): {
    tenantId: string;
  } {
    if (currentUser.actorType !== ActorType.TENANT || !currentUser.tenantId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: 'User deletion applies to tenant users.',
      });
    }
    return { tenantId: currentUser.tenantId };
  }

  private invalidTarget(): BadRequestException {
    return new BadRequestException({
      error: USER_ERROR_CODES.INVALID_TARGET_USER,
      message: 'transferToUserId must name another active user of this tenant.',
    });
  }

  private ownershipContractRequired(): BadRequestException {
    return new BadRequestException({
      error: 'VALIDATION_ERROR',
      message:
        'Hard delete is unavailable while this tenant has legacy dynamic tables without an ownership contract.',
      fields: { transferToUserId: 'OWNERSHIP_CONTRACT_REQUIRED' },
    });
  }

  private async removeHardDeleteSource(
    publicDb: () => Knex.QueryBuilder,
    source: TenantUserTarget,
    currentUser: AuthenticatedUserDto,
    transferredRecordCount: number,
  ): Promise<{ revokedSessionCount: number; transferredRecordCount: number }> {
    const now = new Date();
    const revoked = await publicDb()
      .table('refresh_tokens')
      .where({ authAccountId: source.authAccountId })
      .whereNull('revokedAt')
      .update({ revokedAt: now });

    await publicDb().table('tenant_users').where({ id: source.id }).delete();
    await publicDb()
      .table('auth_accounts')
      .where({ id: source.authAccountId })
      .delete();
    await publicDb()
      .table('auth_audit_logs')
      .insert({
        id: randomUUID(),
        event: AuthAuditEvent.USER_HARD_DELETED,
        tenantId: source.tenantId,
        subjectAuthAccountId: source.authAccountId,
        actorAuthAccountId: currentUser.authAccountId,
        metadata: JSON.stringify({
          userId: source.id,
          revokedSessionCount: revoked,
          transferredRecordCount,
        }),
        createdAt: now,
      });

    return { revokedSessionCount: revoked, transferredRecordCount };
  }

  private invalidTransition(
    status: string,
    explanation: string,
  ): BadRequestException {
    return new BadRequestException({
      error: USER_ERROR_CODES.INVALID_STATUS_TRANSITION,
      message: `This user is ${status}: ${explanation}.`,
    });
  }
}
