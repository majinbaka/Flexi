import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import {
  AccountLifecycleResponseDto,
  ActorType,
  AUTH_ERROR_CODES,
  AuthAuditEvent,
  AuthenticatedUserDto,
  ForceResetPasswordResponseDto,
  SYSTEM_ACCOUNT_RESET_PASSWORD_PERMISSION,
  SYSTEM_USER_MANAGE_PERMISSION,
  TENANT_ACCOUNT_RESET_PASSWORD_PERMISSION,
  TENANT_USER_MANAGE_PERMISSION,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailDeliveryService } from '../../mail/email-delivery.service';
import { AuthAuditService } from '../auth/auth-audit.service';
import { assertActorPermission } from './actor-permission';
import { ForceResetPasswordDto } from './dto/force-reset-password.dto';
import { generateTemporaryPassword } from './temporary-password';

const PASSWORD_SALT_ROUNDS = 10;

/** The target actor of a lifecycle operation, resolved from `:userId`. */
interface TargetActor {
  userId: string;
  authAccountId: string;
  tenantId: string | null;
  isActive: boolean;
  email: string;
  actorType: ActorType;
}

/**
 * Account activation, deactivation and admin-forced password resets.
 *
 * Scope is deliberately narrow, matching what the authentication
 * specification pins down: a tenant caller manages TenantUsers of their own
 * tenant, a system caller manages SystemUsers. Cross-tenant administration,
 * invites, quotas, the `LOCKED` state, soft delete and impersonation belong
 * to the Users module story (#47) and are not smuggled in here.
 *
 * Deactivation revokes every live refresh token, but an access token
 * already issued keeps working until it expires -- at most fifteen minutes.
 * That window is the documented contract, not an oversight: the
 * specification rules out a blacklist or a Redis-backed revocation list.
 */
@Injectable()
export class AccountLifecycleService {
  private readonly logger = new Logger(AccountLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailDeliveryService: EmailDeliveryService,
    private readonly authAuditService: AuthAuditService,
  ) {}

  async deactivate(
    userId: string,
    currentUser: AuthenticatedUserDto,
  ): Promise<AccountLifecycleResponseDto> {
    this.assertPermission(currentUser, [
      TENANT_USER_MANAGE_PERMISSION,
      SYSTEM_USER_MANAGE_PERMISSION,
    ]);

    const target = await this.resolveTarget(userId, currentUser);

    // Deactivating yourself locks you out of the very permission you just
    // used, with no way back in short of another admin. Refuse rather than
    // let an administrator strand themselves.
    if (target.authAccountId === currentUser.authAccountId) {
      throw new BadRequestException({
        error: 'CANNOT_DEACTIVATE_SELF',
        message: 'An account cannot deactivate itself.',
      });
    }

    const now = new Date();
    const revokedSessionCount = await this.prisma.$transaction(async (tx) => {
      await this.setActorActive(tx, target, false);

      return this.revokeLiveSessions(tx, target.authAccountId, now);
    });

    await this.authAuditService.record({
      event: AuthAuditEvent.ACCOUNT_DEACTIVATED,
      tenantId: target.tenantId,
      subjectAuthAccountId: target.authAccountId,
      actorAuthAccountId: currentUser.authAccountId,
      metadata: { userId: target.userId, revokedSessionCount },
    });

    return {
      userId: target.userId,
      actorType: target.actorType,
      isActive: false,
      revokedSessionCount,
    };
  }

  async activate(
    userId: string,
    currentUser: AuthenticatedUserDto,
  ): Promise<AccountLifecycleResponseDto> {
    this.assertPermission(currentUser, [
      TENANT_USER_MANAGE_PERMISSION,
      SYSTEM_USER_MANAGE_PERMISSION,
    ]);

    const target = await this.resolveTarget(userId, currentUser);

    await this.setActorActive(this.prisma, target, true);

    await this.authAuditService.record({
      event: AuthAuditEvent.ACCOUNT_ACTIVATED,
      tenantId: target.tenantId,
      subjectAuthAccountId: target.authAccountId,
      actorAuthAccountId: currentUser.authAccountId,
      metadata: { userId: target.userId },
    });

    return {
      userId: target.userId,
      actorType: target.actorType,
      isActive: true,
      // Activation revokes nothing -- reported for a response shape that
      // does not change between the two operations.
      revokedSessionCount: 0,
    };
  }

  /**
   * Replaces the account's password with a generated one, raises
   * `mustChangePassword` and revokes every live session.
   *
   * The temporary password leaves the server only through the mail
   * transport. It is not in the response, not in a log line and not in an
   * audit row, so an administrator who triggers the reset cannot read the
   * credential they just created for somebody else.
   */
  async forceResetPassword(
    userId: string,
    dto: ForceResetPasswordDto,
    currentUser: AuthenticatedUserDto,
  ): Promise<ForceResetPasswordResponseDto> {
    this.assertPermission(currentUser, [
      TENANT_ACCOUNT_RESET_PASSWORD_PERMISSION,
      SYSTEM_ACCOUNT_RESET_PASSWORD_PERMISSION,
    ]);

    const target = await this.resolveTarget(userId, currentUser);
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(
      temporaryPassword,
      PASSWORD_SALT_ROUNDS,
    );
    const now = new Date();

    const revokedSessionCount = await this.prisma.$transaction(async (tx) => {
      await tx.authAccount.update({
        where: { id: target.authAccountId },
        data: { passwordHash, mustChangePassword: true },
      });

      return this.revokeLiveSessions(tx, target.authAccountId, now);
    });

    // Any outstanding self-service reset code is burned too: it was issued
    // against the password this call just replaced.
    await this.prisma.passwordResetOtp.updateMany({
      where: { authAccountId: target.authAccountId, consumedAt: null },
      data: { consumedAt: now },
    });

    const sendEmail = dto.sendEmail ?? true;
    const emailDelivered = sendEmail
      ? await this.deliverTemporaryPassword(target.email, temporaryPassword)
      : false;

    await this.authAuditService.record({
      event: AuthAuditEvent.ADMIN_FORCE_PASSWORD_RESET,
      tenantId: target.tenantId,
      subjectAuthAccountId: target.authAccountId,
      actorAuthAccountId: currentUser.authAccountId,
      metadata: {
        userId: target.userId,
        revokedSessionCount,
        emailRequested: sendEmail,
        emailDelivered,
      },
    });

    return {
      userId: target.userId,
      mustChangePassword: true,
      revokedSessionCount,
      emailDelivered,
    };
  }

  /**
   * Revokes every live refresh token of one account and reports how many
   * it retired.
   *
   * Public and client-parameterised so it can be called with the caller's
   * own transaction: any write that takes an account's ability to
   * authenticate away -- deactivation, an admin force-reset, locking a
   * user (`UsersAdminService`) -- must revoke sessions in the same
   * transaction as the write itself, or a refresh landing in between would
   * hand back a fresh session the write was meant to end.
   *
   * `revokedAt: null` in the WHERE clause makes it idempotent: an account
   * with nothing live reports zero rather than re-revoking rows.
   */
  async revokeLiveSessions(
    client: Prisma.TransactionClient | PrismaService,
    authAccountId: string,
    now = new Date(),
  ): Promise<number> {
    const revoked = await client.refreshToken.updateMany({
      where: { authAccountId, revokedAt: null },
      data: { revokedAt: now },
    });

    return revoked.count;
  }

  /**
   * Resolves `:userId` within the caller's own scope: a tenant caller sees
   * only TenantUsers of their tenant, a system caller only SystemUsers. A
   * target outside that scope is reported as missing rather than
   * forbidden, so the route cannot be used to discover which user ids exist
   * elsewhere.
   */
  private async resolveTarget(
    userId: string,
    currentUser: AuthenticatedUserDto,
  ): Promise<TargetActor> {
    if (currentUser.actorType === ActorType.TENANT) {
      const tenantUser = await this.prisma.tenantUser.findFirst({
        where: { id: userId, tenantId: currentUser.tenantId },
        select: {
          id: true,
          tenantId: true,
          authAccountId: true,
          isActive: true,
          authAccount: { select: { email: true } },
        },
      });

      if (!tenantUser) {
        throw this.userNotFound();
      }

      return {
        userId: tenantUser.id,
        authAccountId: tenantUser.authAccountId,
        tenantId: tenantUser.tenantId,
        isActive: tenantUser.isActive,
        email: tenantUser.authAccount.email,
        actorType: ActorType.TENANT,
      };
    }

    const systemUser = await this.prisma.systemUser.findFirst({
      where: { id: userId },
      select: {
        id: true,
        authAccountId: true,
        isActive: true,
        authAccount: { select: { email: true } },
      },
    });

    if (!systemUser) {
      throw this.userNotFound();
    }

    return {
      userId: systemUser.id,
      authAccountId: systemUser.authAccountId,
      tenantId: null,
      isActive: systemUser.isActive,
      email: systemUser.authAccount.email,
      actorType: ActorType.SYSTEM,
    };
  }

  private async setActorActive(
    client: Pick<PrismaService, 'tenantUser' | 'systemUser'>,
    target: TargetActor,
    isActive: boolean,
  ): Promise<void> {
    if (target.actorType === ActorType.TENANT) {
      await client.tenantUser.update({
        where: { id: target.userId },
        data: { isActive },
      });
      return;
    }

    await client.systemUser.update({
      where: { id: target.userId },
      data: { isActive },
    });
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

  /**
   * Delegates to the shared assertion so this service and
   * `UsersAdminService` resolve a TENANT/SYSTEM permission pair the same
   * way. See `assertActorPermission` for why the pair exists at all.
   */
  private assertPermission(
    currentUser: AuthenticatedUserDto,
    codes: [string, string],
  ): void {
    assertActorPermission(currentUser, codes);
  }

  private userNotFound(): NotFoundException {
    return new NotFoundException({
      error: AUTH_ERROR_CODES.USER_NOT_FOUND,
      message: 'No such user.',
    });
  }
}
