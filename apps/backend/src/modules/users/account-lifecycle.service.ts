import { randomInt } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import {
  AccountLifecycleResponseDto,
  ActorType,
  AUTH_ERROR_CODES,
  AuthAuditEvent,
  AuthenticatedUserDto,
  ForceResetPasswordResponseDto,
  PASSWORD_MIN_LENGTH,
  PASSWORD_SPECIAL_CHARACTERS,
  SYSTEM_ACCOUNT_RESET_PASSWORD_PERMISSION,
  SYSTEM_USER_MANAGE_PERMISSION,
  TENANT_ACCOUNT_RESET_PASSWORD_PERMISSION,
  TENANT_USER_MANAGE_PERMISSION,
  validatePasswordStrength,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailDeliveryService } from '../../mail/email-delivery.service';
import { AuthAuditService } from '../auth/auth-audit.service';
import { ForceResetPasswordDto } from './dto/force-reset-password.dto';

const PASSWORD_SALT_ROUNDS = 10;

/**
 * Length of a generated temporary password. Well above
 * `PASSWORD_MIN_LENGTH`, because this one is never chosen by a human and
 * has to survive being mailed: the only thing making it safe is that
 * guessing it is hopeless.
 */
const TEMPORARY_PASSWORD_LENGTH = 20;

const TEMPORARY_PASSWORD_ALPHABET =
  'abcdefghijklmnopqrstuvwxyz' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
  '0123456789' +
  PASSWORD_SPECIAL_CHARACTERS;

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

      const revoked = await tx.refreshToken.updateMany({
        where: { authAccountId: target.authAccountId, revokedAt: null },
        data: { revokedAt: now },
      });

      return revoked.count;
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
    const temporaryPassword = this.generateTemporaryPassword();
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

      const revoked = await tx.refreshToken.updateMany({
        where: { authAccountId: target.authAccountId, revokedAt: null },
        data: { revokedAt: now },
      });

      return revoked.count;
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
   * Draws uniformly from the full alphabet with `randomInt`, which Node
   * rejection-samples, then re-draws if the result happens to miss a
   * required character class. At twenty characters a miss is vanishingly
   * unlikely, so the loop is a correctness guarantee rather than a hot
   * path -- the password must satisfy the same policy the holder will be
   * held to when they replace it.
   */
  private generateTemporaryPassword(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let password = '';
      for (let index = 0; index < TEMPORARY_PASSWORD_LENGTH; index += 1) {
        password += TEMPORARY_PASSWORD_ALPHABET.charAt(
          randomInt(0, TEMPORARY_PASSWORD_ALPHABET.length),
        );
      }

      if (validatePasswordStrength(password).length === 0) {
        return password;
      }
    }

    // Unreachable for any sane alphabet and length; throwing beats
    // returning a password that does not meet the policy the account will
    // be validated against.
    throw new Error(
      `Could not generate a temporary password of ${TEMPORARY_PASSWORD_LENGTH} characters meeting the ${PASSWORD_MIN_LENGTH}-character policy.`,
    );
  }

  /**
   * Picks the TENANT or SYSTEM spelling of a permission by actor type. A
   * tenant Role can never hold a SYSTEM-scope permission and vice versa, so
   * every operation has a pair of codes and only the request knows which
   * one applies -- the same reason `AuthService.me()` resolves its own.
   */
  private assertPermission(
    currentUser: AuthenticatedUserDto,
    [tenantCode, systemCode]: [string, string],
  ): void {
    const required =
      currentUser.actorType === ActorType.TENANT ? tenantCode : systemCode;

    if (!currentUser.permissions.includes(required)) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: 'Insufficient permissions',
      });
    }
  }

  private userNotFound(): NotFoundException {
    return new NotFoundException({
      error: AUTH_ERROR_CODES.USER_NOT_FOUND,
      message: 'No such user.',
    });
  }
}
