import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import {
  ActorType,
  AUTH_ERROR_CODES,
  AuthAuditEvent,
  AuthenticatedUserDto,
  DirectCreateUserResponseDto,
  SYSTEM_USER_MANAGE_PERMISSION,
  SYSTEM_USER_READ_PERMISSION,
  TENANT_USER_MANAGE_PERMISSION,
  TENANT_USER_READ_PERMISSION,
  TenantUserStatus,
  USER_ERROR_CODES,
  USER_LIST_DEFAULT_PAGE,
  USER_LIST_DEFAULT_PAGE_SIZE,
  USER_LIST_MAX_PAGE_SIZE,
  UserDetailDto,
  UserListQueryDto,
  UserListResponseDto,
  UserRoleSummaryDto,
  UserStatusChangeResponseDto,
  UserSummaryDto,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailDeliveryService } from '../../mail/email-delivery.service';
import { AuthAuditService } from '../auth/auth-audit.service';
import { AccountLifecycleService } from './account-lifecycle.service';
import { assertActorPermission } from './actor-permission';
import { DirectCreateUserDto } from './dto/direct-create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { generateTemporaryPassword } from './temporary-password';
import { TenantUserDirectoryService } from './tenant-user-directory.service';
import { UserQuotaService } from './user-quota.service';

const PASSWORD_SALT_ROUNDS = 10;

/**
 * The columns every user response is built from. Listed explicitly rather
 * than taking a whole row: `passwordHash` sits on the same `AuthAccount`
 * this joins to, and an explicit projection is what keeps a schema change
 * from quietly adding a secret to an API response.
 */
const TENANT_USER_SELECT = {
  id: true,
  tenantId: true,
  authAccountId: true,
  name: true,
  status: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  authAccount: { select: { email: true, mustChangePassword: true } },
  roles: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
} satisfies Prisma.TenantUserSelect;

const SYSTEM_USER_SELECT = {
  id: true,
  authAccountId: true,
  name: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  authAccount: { select: { email: true, mustChangePassword: true } },
  roles: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
} satisfies Prisma.SystemUserSelect;

type TenantUserRow = Prisma.TenantUserGetPayload<{
  select: typeof TENANT_USER_SELECT;
}>;

type SystemUserRow = Prisma.SystemUserGetPayload<{
  select: typeof SYSTEM_USER_SELECT;
}>;

/** A resolved `:userId`, in whichever scope the caller lives in. */
type TargetUser =
  | { actorType: ActorType.TENANT; row: TenantUserRow }
  | { actorType: ActorType.SYSTEM; row: SystemUserRow };

/** A tenant-scoped caller, once their token has been checked for one. */
interface TenantActor {
  tenantId: string;
  authAccountId: string;
}

/**
 * Reading and administering users: the list, one user's detail, profile and
 * role edits, direct creation, approval and the lock/unlock pair.
 *
 * Three rules shape the whole service.
 *
 * **Scope is a filter, not a check.** A tenant caller sees `TenantUser`
 * rows of their own tenant and a system caller sees `SystemUser` rows;
 * every query is written that way rather than fetching by id and comparing
 * afterwards. A `:userId` outside the caller's scope is therefore
 * indistinguishable from one that never existed, and both answer `404
 * USER_NOT_FOUND` -- a `403` would confirm that some other tenant has a
 * user with that id.
 *
 * **`status` and `isActive` are different questions.** `status` says where
 * in the lifecycle a membership is; `isActive` says whether it may
 * authenticate, and it is the only one `AuthService` reads. So every move
 * into `locked` clears `isActive` in the same write, and every move back
 * out of it restores `isActive` in the same write -- never two statements
 * that a crash could leave half-applied.
 *
 * **A refused transition says so.** Approving somebody who was never
 * awaiting approval, unlocking somebody who is not locked or touching a
 * `deleted` membership raises `400 INVALID_STATUS_TRANSITION` naming the
 * status the user is actually in, rather than succeeding as a no-op that
 * tells an administrator something happened when nothing did.
 *
 * What this service does *not* do is re-implement session revocation: it
 * calls `AccountLifecycleService.revokeLiveSessions()` inside its own
 * transaction, so locking a user and deactivating one end sessions through
 * exactly one piece of code. Quota and per-tenant email uniqueness come
 * from `UserQuotaService` and `TenantUserDirectoryService` for the same
 * reason.
 */
@Injectable()
export class UsersAdminService {
  private readonly logger = new Logger(UsersAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountLifecycleService: AccountLifecycleService,
    private readonly userQuotaService: UserQuotaService,
    private readonly tenantUserDirectoryService: TenantUserDirectoryService,
    private readonly emailDeliveryService: EmailDeliveryService,
    private readonly authAuditService: AuthAuditService,
  ) {}

  /**
   * `GET /api/users`, newest first.
   *
   * `deleted` memberships are left out unless `status=deleted` asks for
   * them by name: a soft-deleted user holds no seat and is gone as far as
   * the Users screen is concerned, but the record still exists and stays
   * reachable for anybody who goes looking.
   */
  async listUsers(
    query: UserListQueryDto,
    currentUser: AuthenticatedUserDto,
  ): Promise<UserListResponseDto> {
    assertActorPermission(currentUser, [
      TENANT_USER_READ_PERMISSION,
      SYSTEM_USER_READ_PERMISSION,
    ]);

    const page = this.parsePositiveInteger(
      query.page,
      USER_LIST_DEFAULT_PAGE,
      'page',
    );
    const pageSize = Math.min(
      this.parsePositiveInteger(
        query.pageSize,
        USER_LIST_DEFAULT_PAGE_SIZE,
        'pageSize',
      ),
      USER_LIST_MAX_PAGE_SIZE,
    );
    const skip = (page - 1) * pageSize;
    const keyword = this.parseKeyword(query.keyword);
    const roleId = query.roleId?.trim() || undefined;

    if (currentUser.actorType === ActorType.SYSTEM) {
      // A SystemUser has no lifecycle status at all, so the filter cannot
      // mean anything here. Refused rather than dropped: a listing that
      // ignores half of what was asked for is worse than one that says it
      // cannot answer.
      if (query.status !== undefined) {
        throw new BadRequestException({
          error: 'VALIDATION_ERROR',
          message: 'status filters tenant users only.',
          fields: { status: 'STATUS_NOT_APPLICABLE' },
        });
      }

      const where: Prisma.SystemUserWhereInput = {
        ...(roleId ? { roles: { some: { id: roleId } } } : {}),
        ...(keyword ? { OR: this.keywordFilter(keyword) } : {}),
      };

      const [rows, total] = await Promise.all([
        this.prisma.systemUser.findMany({
          where,
          select: SYSTEM_USER_SELECT,
          orderBy: { createdAt: 'desc' },
          skip,
          take: pageSize,
        }),
        this.prisma.systemUser.count({ where }),
      ]);

      return {
        items: rows.map((row) => this.toSystemUserSummary(row)),
        meta: { total, page, pageSize },
      };
    }

    const tenantId = this.requireTenantActor(currentUser).tenantId;
    const status = this.parseStatusFilter(query.status);

    const where: Prisma.TenantUserWhereInput = {
      tenantId,
      status: status ?? { not: TenantUserStatus.DELETED },
      ...(roleId ? { roles: { some: { id: roleId } } } : {}),
      ...(keyword ? { OR: this.keywordFilter(keyword) } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.tenantUser.findMany({
        where,
        select: TENANT_USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.tenantUser.count({ where }),
    ]);

    return {
      items: rows.map((row) => this.toTenantUserSummary(row)),
      meta: { total, page, pageSize },
    };
  }

  /** `GET /api/users/:userId`. */
  async getUser(
    userId: string,
    currentUser: AuthenticatedUserDto,
  ): Promise<UserDetailDto> {
    assertActorPermission(currentUser, [
      TENANT_USER_READ_PERMISSION,
      SYSTEM_USER_READ_PERMISSION,
    ]);

    return this.toDetailDto(await this.resolveTarget(userId, currentUser));
  }

  /**
   * `PATCH /api/users/:userId` -- full name and role.
   *
   * Nobody may change their own role, whichever scope they are in. That is
   * the same footgun self-deactivation is: the caller could otherwise
   * grant themselves a role holding permissions their own never had, or
   * strip the one permission that lets anybody undo it. Renaming yourself
   * stays allowed -- it grants nothing.
   */
  async updateUser(
    userId: string,
    dto: UpdateUserDto,
    currentUser: AuthenticatedUserDto,
  ): Promise<UserDetailDto> {
    assertActorPermission(currentUser, [
      TENANT_USER_MANAGE_PERMISSION,
      SYSTEM_USER_MANAGE_PERMISSION,
    ]);

    const changesName = dto.fullName !== undefined;
    const changesRole = dto.roleId !== undefined;

    if (!changesName && !changesRole) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: ['Provide fullName or roleId; the body changes nothing.'],
      });
    }

    const target = await this.resolveTarget(userId, currentUser);
    this.assertNotDeleted(target);

    if (changesRole && target.row.authAccountId === currentUser.authAccountId) {
      throw new ForbiddenException({
        error: USER_ERROR_CODES.CANNOT_CHANGE_OWN_ROLE,
        message: 'An administrator cannot change their own role.',
      });
    }

    const fullName = changesName ? (dto.fullName ?? '').trim() : undefined;
    if (fullName !== undefined && fullName.length === 0) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: ['fullName must not be blank.'],
      });
    }

    const roleId = changesRole
      ? await this.resolveRoleId(
          dto.roleId ?? null,
          target.actorType,
          currentUser,
        )
      : undefined;

    const previousRoleIds = target.row.roles.map((role) => role.id);
    const nextRoleIds = roleId ? [roleId] : [];
    const roleChanged =
      changesRole &&
      (previousRoleIds.length !== nextRoleIds.length ||
        previousRoleIds[0] !== nextRoleIds[0]);

    const data = {
      ...(fullName !== undefined ? { name: fullName } : {}),
      // `set` replaces the whole collection, which is what "the user's
      // role" means here: one role at a time, the same shape invites use.
      ...(changesRole
        ? { roles: { set: nextRoleIds.map((id) => ({ id })) } }
        : {}),
    };

    const updated =
      target.actorType === ActorType.TENANT
        ? {
            actorType: ActorType.TENANT as const,
            row: await this.prisma.tenantUser.update({
              where: { id: target.row.id },
              data,
              select: TENANT_USER_SELECT,
            }),
          }
        : {
            actorType: ActorType.SYSTEM as const,
            row: await this.prisma.systemUser.update({
              where: { id: target.row.id },
              data,
              select: SYSTEM_USER_SELECT,
            }),
          };

    const detail = this.toDetailDto(updated);

    await this.authAuditService.record({
      event: AuthAuditEvent.USER_UPDATED,
      tenantId: detail.tenantId,
      subjectAuthAccountId: detail.authAccountId,
      actorAuthAccountId: currentUser.authAccountId,
      metadata: {
        userId: detail.id,
        nameChanged: changesName,
        roleChanged,
      },
    });

    // Recorded on top of USER_UPDATED, and only when the role really
    // moved: a privilege change is the one user edit with a security
    // consequence, so it is findable by event alone rather than by parsing
    // the metadata of every profile write.
    if (roleChanged) {
      await this.authAuditService.record({
        event: AuthAuditEvent.USER_ROLE_CHANGED,
        tenantId: detail.tenantId,
        subjectAuthAccountId: detail.authAccountId,
        actorAuthAccountId: currentUser.authAccountId,
        metadata: {
          userId: detail.id,
          previousRoleId: previousRoleIds[0] ?? null,
          roleId: nextRoleIds[0] ?? null,
        },
      });
    }

    return detail;
  }

  /**
   * `POST /api/users/direct-create` -- an administrator seating somebody
   * without waiting for an invitation to be redeemed.
   *
   * Quota and per-tenant email uniqueness are the shared checks every
   * creation path runs (`UserQuotaService`, `TenantUserDirectoryService`),
   * in the order the Users specification fixes: the quota before anything
   * is written, so a full tenant creates nothing at all.
   *
   * The account lands `active` and able to log in, holding a generated
   * temporary password with `mustChangePassword` raised. That password
   * leaves the server only through the mail transport -- not in the
   * response, not in a log line, not in an audit row.
   */
  async directCreate(
    dto: DirectCreateUserDto,
    currentUser: AuthenticatedUserDto,
  ): Promise<DirectCreateUserResponseDto> {
    const actor = this.requireTenantActor(
      currentUser,
      'Users are created inside a tenant.',
    );
    assertActorPermission(currentUser, [
      TENANT_USER_MANAGE_PERMISSION,
      SYSTEM_USER_MANAGE_PERMISSION,
    ]);

    await this.userQuotaService.assertSeatsAvailable(actor.tenantId, 1);

    const email = this.tenantUserDirectoryService.normalizeEmail(dto.email);
    const fullName = dto.fullName.trim();
    if (!fullName) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: ['fullName must not be blank.'],
      });
    }

    const roleId = dto.roleId
      ? await this.resolveRoleId(dto.roleId, ActorType.TENANT, currentUser)
      : null;

    // bcrypt outside the transaction: hashing is the slowest thing here and
    // holding the transaction open for it buys nothing.
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(
      temporaryPassword,
      PASSWORD_SALT_ROUNDS,
    );

    const created = await this.prisma.$transaction(async (tx) => {
      // Inside the transaction it guards, so the read sits with the write
      // it protects -- the same contract invites and self-registration use.
      await this.tenantUserDirectoryService.assertEmailAvailable(
        actor.tenantId,
        email,
        tx,
      );

      const authAccount = await tx.authAccount.create({
        data: { email, passwordHash, mustChangePassword: true },
        select: { id: true },
      });

      return tx.tenantUser.create({
        data: {
          tenantId: actor.tenantId,
          authAccountId: authAccount.id,
          name: fullName,
          status: TenantUserStatus.ACTIVE,
          isActive: true,
          ...(roleId ? { roles: { connect: { id: roleId } } } : {}),
        },
        select: TENANT_USER_SELECT,
      });
    });

    const emailDelivered = await this.deliverTemporaryPassword(
      email,
      temporaryPassword,
    );

    const user = this.toDetailDto({
      actorType: ActorType.TENANT,
      row: created,
    });

    await this.authAuditService.record({
      event: AuthAuditEvent.USER_DIRECT_CREATED,
      tenantId: actor.tenantId,
      subjectAuthAccountId: user.authAccountId,
      actorAuthAccountId: currentUser.authAccountId,
      metadata: {
        userId: user.id,
        email,
        roleId,
        emailDelivered,
      },
    });

    return {
      user,
      seatUsage: await this.userQuotaService.getSeatUsage(actor.tenantId),
      emailDelivered,
    };
  }

  /**
   * `PATCH /api/users/:userId/approve` -- `pending_approval` -> `active`.
   *
   * Legal from `pending_approval` and nowhere else. The seat was already
   * taken when the person registered, so there is no quota question here;
   * what changes is `isActive`, which is what was keeping them out.
   */
  async approveUser(
    userId: string,
    currentUser: AuthenticatedUserDto,
  ): Promise<UserStatusChangeResponseDto> {
    const target = await this.resolveTenantTarget(
      userId,
      currentUser,
      'Approval applies to tenant users.',
    );

    if (target.row.status !== TenantUserStatus.PENDING_APPROVAL) {
      throw this.invalidTransition(
        target.row.status,
        `only a ${TenantUserStatus.PENDING_APPROVAL} user can be approved`,
      );
    }

    const row = await this.prisma.tenantUser.update({
      where: { id: target.row.id },
      data: { status: TenantUserStatus.ACTIVE, isActive: true },
      select: TENANT_USER_SELECT,
    });

    const user = this.toDetailDto({ actorType: ActorType.TENANT, row });
    const emailDelivered = await this.welcome(user.email, target.tenantName);

    await this.authAuditService.record({
      event: AuthAuditEvent.USER_APPROVED,
      tenantId: user.tenantId,
      subjectAuthAccountId: user.authAccountId,
      actorAuthAccountId: currentUser.authAccountId,
      metadata: { userId: user.id, emailDelivered },
    });

    return { user, revokedSessionCount: 0 };
  }

  /**
   * `PATCH /api/users/:userId/lock` -- suspend an active member.
   *
   * A locked user keeps their seat (`UserQuotaService` counts `locked`) but
   * cannot authenticate: `isActive` is cleared in the same write as the
   * status, and every live session is revoked in the same transaction, so
   * a refresh landing in between cannot hand back a session the lock was
   * meant to end. An access token already issued keeps working for its
   * remaining lifetime -- at most fifteen minutes -- which is the same
   * documented window deactivation has.
   *
   * Legal from `active` only. Locking somebody who has not finished
   * joining (`pending_invite`, `pending_approval`, `pending_setup`) is
   * refused rather than quietly making `unlock` a way to skip the step
   * they were waiting on; withdraw the invite or leave the approval
   * unapproved instead.
   */
  async lockUser(
    userId: string,
    currentUser: AuthenticatedUserDto,
  ): Promise<UserStatusChangeResponseDto> {
    const target = await this.resolveTenantTarget(
      userId,
      currentUser,
      'Locking applies to tenant users.',
    );

    // Locking yourself takes away the very permission you just used, with
    // no way back in short of another administrator -- the same reason
    // `deactivate` refuses it.
    if (target.row.authAccountId === currentUser.authAccountId) {
      throw new BadRequestException({
        error: USER_ERROR_CODES.CANNOT_LOCK_SELF,
        message: 'An administrator cannot lock their own account.',
      });
    }

    if (target.row.status !== TenantUserStatus.ACTIVE) {
      throw this.invalidTransition(
        target.row.status,
        `only an ${TenantUserStatus.ACTIVE} user can be locked`,
      );
    }

    const now = new Date();
    const { row, revokedSessionCount } = await this.prisma.$transaction(
      async (tx) => ({
        row: await tx.tenantUser.update({
          where: { id: target.row.id },
          // One write: `status` says where the membership is, `isActive`
          // says whether it may authenticate, and a lock that moved only
          // the first would leave a locked user still able to log in.
          data: { status: TenantUserStatus.LOCKED, isActive: false },
          select: TENANT_USER_SELECT,
        }),
        revokedSessionCount:
          await this.accountLifecycleService.revokeLiveSessions(
            tx,
            target.row.authAccountId,
            now,
          ),
      }),
    );

    const user = this.toDetailDto({ actorType: ActorType.TENANT, row });

    await this.authAuditService.record({
      event: AuthAuditEvent.USER_LOCKED,
      tenantId: user.tenantId,
      subjectAuthAccountId: user.authAccountId,
      actorAuthAccountId: currentUser.authAccountId,
      metadata: { userId: user.id, revokedSessionCount },
    });

    return { user, revokedSessionCount };
  }

  /** `PATCH /api/users/:userId/unlock` -- `locked` -> `active`. */
  async unlockUser(
    userId: string,
    currentUser: AuthenticatedUserDto,
  ): Promise<UserStatusChangeResponseDto> {
    const target = await this.resolveTenantTarget(
      userId,
      currentUser,
      'Unlocking applies to tenant users.',
    );

    if (target.row.status !== TenantUserStatus.LOCKED) {
      throw this.invalidTransition(
        target.row.status,
        `only a ${TenantUserStatus.LOCKED} user can be unlocked`,
      );
    }

    const row = await this.prisma.tenantUser.update({
      where: { id: target.row.id },
      data: { status: TenantUserStatus.ACTIVE, isActive: true },
      select: TENANT_USER_SELECT,
    });

    const user = this.toDetailDto({ actorType: ActorType.TENANT, row });

    await this.authAuditService.record({
      event: AuthAuditEvent.USER_UNLOCKED,
      tenantId: user.tenantId,
      subjectAuthAccountId: user.authAccountId,
      actorAuthAccountId: currentUser.authAccountId,
      metadata: { userId: user.id },
    });

    return { user, revokedSessionCount: 0 };
  }

  /**
   * Resolves `:userId` inside the caller's own scope, as a query rather
   * than a fetch-then-compare: a tenant caller can only ever match a
   * `TenantUser` of their tenant, a system caller only a `SystemUser`.
   * Anything else is `404`, so knowing another tenant's user id buys
   * nothing.
   */
  private async resolveTarget(
    userId: string,
    currentUser: AuthenticatedUserDto,
  ): Promise<TargetUser> {
    if (currentUser.actorType === ActorType.TENANT) {
      const row = await this.prisma.tenantUser.findFirst({
        where: {
          id: userId,
          tenantId: this.requireTenantActor(currentUser).tenantId,
        },
        select: TENANT_USER_SELECT,
      });

      if (!row) {
        throw this.userNotFound();
      }

      return { actorType: ActorType.TENANT, row };
    }

    const row = await this.prisma.systemUser.findFirst({
      where: { id: userId },
      select: SYSTEM_USER_SELECT,
    });

    if (!row) {
      throw this.userNotFound();
    }

    return { actorType: ActorType.SYSTEM, row };
  }

  /**
   * The same resolution for the three routes that only a tenant has:
   * `status` lives on `TenantUser`, and a SystemUser has nothing to
   * approve, lock or unlock -- deactivating one is what
   * `PATCH /api/users/:userId/deactivate` is for.
   *
   * Returns the tenant's name alongside the row so the approval mail does
   * not need a second round trip for it.
   */
  private async resolveTenantTarget(
    userId: string,
    currentUser: AuthenticatedUserDto,
    forbiddenMessage: string,
  ): Promise<{ row: TenantUserRow; tenantName: string }> {
    const actor = this.requireTenantActor(currentUser, forbiddenMessage);
    // The caller is a tenant actor by the line above, so this can only
    // ever demand `tenant.user.manage`; the pair is passed whole so the
    // permission is resolved the same way everywhere rather than spelled
    // out once by hand here.
    assertActorPermission(currentUser, [
      TENANT_USER_MANAGE_PERMISSION,
      SYSTEM_USER_MANAGE_PERMISSION,
    ]);

    const row = await this.prisma.tenantUser.findFirst({
      where: { id: userId, tenantId: actor.tenantId },
      select: { ...TENANT_USER_SELECT, tenant: { select: { name: true } } },
    });

    if (!row) {
      throw this.userNotFound();
    }

    const { tenant, ...user } = row;

    if (user.status === TenantUserStatus.DELETED) {
      throw this.invalidTransition(
        user.status,
        'a deleted user can no longer be changed',
      );
    }

    return { row: user, tenantName: tenant.name };
  }

  private assertNotDeleted(target: TargetUser): void {
    if (
      target.actorType === ActorType.TENANT &&
      target.row.status === TenantUserStatus.DELETED
    ) {
      throw this.invalidTransition(
        target.row.status,
        'a deleted user can no longer be changed',
      );
    }
  }

  /**
   * Validates that a role may be granted to this target at all. A tenant
   * Role belongs to exactly one tenant and a system Role to none
   * (`Role.tenantId` is null), so the lookup is scoped rather than checked
   * afterwards -- a role id from another tenant simply does not match.
   */
  private async resolveRoleId(
    roleId: string | null,
    actorType: ActorType,
    currentUser: AuthenticatedUserDto,
  ): Promise<string | null> {
    if (!roleId) {
      return null;
    }

    const role = await this.prisma.role.findFirst({
      where: {
        id: roleId,
        tenantId:
          actorType === ActorType.TENANT
            ? this.requireTenantActor(currentUser).tenantId
            : null,
      },
      select: { id: true },
    });

    if (!role) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message:
          actorType === ActorType.TENANT
            ? 'roleId does not name a role of this tenant.'
            : 'roleId does not name a system role.',
      });
    }

    return role.id;
  }

  private toDetailDto(target: TargetUser): UserDetailDto {
    return target.actorType === ActorType.TENANT
      ? {
          ...this.toTenantUserSummary(target.row),
          mustChangePassword: target.row.authAccount.mustChangePassword,
        }
      : {
          ...this.toSystemUserSummary(target.row),
          mustChangePassword: target.row.authAccount.mustChangePassword,
        };
  }

  private toTenantUserSummary(row: TenantUserRow): UserSummaryDto {
    return {
      id: row.id,
      actorType: ActorType.TENANT,
      tenantId: row.tenantId,
      authAccountId: row.authAccountId,
      email: row.authAccount.email,
      fullName: row.name,
      status: this.asTenantUserStatus(row.status),
      isActive: row.isActive,
      roles: this.toRoleSummaries(row.roles),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toSystemUserSummary(row: SystemUserRow): UserSummaryDto {
    return {
      id: row.id,
      actorType: ActorType.SYSTEM,
      tenantId: null,
      authAccountId: row.authAccountId,
      email: row.authAccount.email,
      fullName: row.name,
      // A SystemUser has no lifecycle status of its own -- only whether it
      // may authenticate.
      status: null,
      isActive: row.isActive,
      roles: this.toRoleSummaries(row.roles),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toRoleSummaries(
    roles: { id: string; name: string }[],
  ): UserRoleSummaryDto[] {
    return roles.map((role) => ({ id: role.id, name: role.name }));
  }

  /**
   * `status` is a plain string column validated at the service layer, like
   * `Permission.scope` and `DynamicField.dataType`. A value outside the
   * enum means the database holds something no code path writes; report it
   * as `null` (status unknown) rather than lying about which state the user
   * is in.
   */
  private asTenantUserStatus(status: string): TenantUserStatus | null {
    const known = Object.values(TenantUserStatus).find(
      (value) => value === status,
    );

    if (!known) {
      this.logger.warn(`Unknown TenantUser.status in the database: ${status}`);
      return null;
    }

    return known;
  }

  private parseStatusFilter(
    status: TenantUserStatus | undefined,
  ): TenantUserStatus | undefined {
    if (status === undefined || (status as string) === '') {
      return undefined;
    }

    const known = Object.values(TenantUserStatus).find(
      (value) => value === status,
    );

    if (!known) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: `status must be one of: ${Object.values(TenantUserStatus).join(', ')}.`,
        fields: { status: 'STATUS_INVALID' },
      });
    }

    return known;
  }

  /**
   * `keyword` matches the account's email or the user's name. The value
   * reaching this has already had `%`, `_` and `\` escaped by
   * `parseKeyword`, so a keyword cannot turn itself into a wildcard that
   * matches every user of the tenant.
   */
  private keywordFilter(keyword: string) {
    const contains = { contains: keyword, mode: 'insensitive' as const };

    return [{ name: contains }, { authAccount: { email: contains } }];
  }

  private parseKeyword(keyword: string | undefined): string | undefined {
    const trimmed = keyword?.trim();

    return trimmed
      ? trimmed.replace(/[\\%_]/g, (match) => `\\${match}`)
      : undefined;
  }

  private parsePositiveInteger(
    value: unknown,
    defaultValue: number,
    field: 'page' | 'pageSize',
  ): number {
    if (value === undefined || value === null || value === '') {
      return defaultValue;
    }

    const numeric = typeof value === 'number' ? value : Number(value);

    if (!Number.isInteger(numeric) || numeric <= 0) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: `${field} must be a positive integer.`,
        fields: { [field]: `${field.toUpperCase()}_INVALID` },
      });
    }

    return numeric;
  }

  private requireTenantActor(
    currentUser: AuthenticatedUserDto,
    forbiddenMessage = 'This route is scoped to a tenant.',
  ): TenantActor {
    if (currentUser.actorType !== ActorType.TENANT || !currentUser.tenantId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: forbiddenMessage,
      });
    }

    return {
      tenantId: currentUser.tenantId,
      authAccountId: currentUser.authAccountId,
    };
  }

  /** Mails the newly approved user. Reports delivery rather than raising. */
  private async welcome(email: string, tenantName: string): Promise<boolean> {
    const outcome = await this.emailDeliveryService.sendSelfRegistrationWelcome(
      email,
      tenantName,
    );

    if (!outcome.delivered) {
      this.logger.warn(
        `Approval welcome delivery failed: ${outcome.errorCode ?? 'unknown error'}`,
      );
    }

    return outcome.delivered;
  }

  private async deliverTemporaryPassword(
    email: string,
    temporaryPassword: string,
  ): Promise<boolean> {
    const outcome = await this.emailDeliveryService.sendTemporaryPassword(
      email,
      temporaryPassword,
    );

    if (!outcome.delivered) {
      // The error code, never the address or the password.
      this.logger.warn(
        `Temporary password delivery failed: ${outcome.errorCode ?? 'unknown error'}`,
      );
    }

    return outcome.delivered;
  }

  private invalidTransition(
    currentStatus: string,
    explanation: string,
  ): BadRequestException {
    return new BadRequestException({
      error: USER_ERROR_CODES.INVALID_STATUS_TRANSITION,
      message: `This user is ${currentStatus}: ${explanation}.`,
    });
  }

  private userNotFound(): NotFoundException {
    return new NotFoundException({
      error: AUTH_ERROR_CODES.USER_NOT_FOUND,
      message: 'No such user.',
    });
  }
}
