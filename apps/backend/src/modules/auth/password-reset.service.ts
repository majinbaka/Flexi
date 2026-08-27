import { randomInt } from 'crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import {
  AUTH_ERROR_CODES,
  AuthAuditEvent,
  PASSWORD_RESET_OTP_COOLDOWN_SECONDS,
  PASSWORD_RESET_OTP_LENGTH,
  PASSWORD_RESET_OTP_MAX_ATTEMPTS,
  PASSWORD_RESET_OTP_TTL_SECONDS,
  validatePasswordStrength,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailDeliveryService } from '../../mail/email-delivery.service';
import { AuthAuditService } from './auth-audit.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

const PASSWORD_SALT_ROUNDS = 10;
const ACTIVE_TENANT_STATUS = 'ACTIVE';

/**
 * Stands in for the account id when no account matched the submitted
 * address. The OTP lookup still runs against it -- see `resetPassword` --
 * so the "unknown email" and "known email" branches issue the same queries
 * and cannot be told apart by response time.
 */
const NO_MATCHING_ACCOUNT_ID = '';

/** Digits-only, exactly `PASSWORD_RESET_OTP_LENGTH` long. */
const OTP_PATTERN = new RegExp(`^\\d{${PASSWORD_RESET_OTP_LENGTH}}$`);

interface ResetActor {
  authAccountId: string;
  tenantId: string | null;
  isActive: boolean;
}

/**
 * Emailed-OTP password recovery.
 *
 * Two properties drive nearly every decision here:
 *
 * 1. **Anti-enumeration.** `forgot-password` answers `200` with an empty
 *    body whatever happened, and every `reset-password` failure -- wrong
 *    code, expired code, no code outstanding, unknown address, attempt
 *    budget spent -- collapses to one `INVALID_OTP`. Neither the status
 *    code, the body nor the work done differs enough between branches to
 *    say whether an address has an account.
 * 2. **Hash-only at rest.** The raw six digits exist in memory just long
 *    enough to reach the mail transport. Only a bcrypt hash of them is
 *    persisted, and neither the code nor the new password is ever logged
 *    or written to an audit row.
 *
 *    bcrypt rather than the SHA-256 used for `RefreshToken` and
 *    `SetupToken`: those are 256-bit random tokens, where a fast hash is
 *    fine because the preimage space is unsearchable. A six-digit code has
 *    about twenty bits of entropy, so a SHA-256 of it falls to an
 *    exhaustive sweep of all 10^6 candidates in milliseconds if the table
 *    ever leaks. At cost 10 the same sweep costs days per code, which
 *    comfortably outlives the code's five-minute life.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailDeliveryService: EmailDeliveryService,
    private readonly authAuditService: AuthAuditService,
  ) {}

  /**
   * Issues a reset code for the account behind `email`, if there is one.
   * Always resolves; never signals whether an account existed, whether it
   * was active, or whether a code was actually sent.
   */
  async requestReset(dto: ForgotPasswordDto, tenantId?: string): Promise<void> {
    const email = this.normalizeEmail(dto.email);
    const actor = await this.resolveActor(email, tenantId);

    // A deactivated account gets no code: a reset would otherwise hand back
    // a working password to somebody an admin has just locked out. The
    // caller cannot tell this branch from the "no such account" one.
    if (!actor || !actor.isActive) {
      return;
    }

    if (await this.isWithinCooldown(actor.authAccountId)) {
      await this.authAuditService.record({
        event: AuthAuditEvent.FORGOT_PASSWORD_REQUESTED,
        tenantId: actor.tenantId,
        subjectAuthAccountId: actor.authAccountId,
        metadata: { outcome: 'THROTTLED_BY_COOLDOWN' },
      });
      return;
    }

    const otp = this.generateOtp();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + PASSWORD_RESET_OTP_TTL_SECONDS * 1000,
    );

    const otpHash = await this.hashOtp(otp);

    await this.prisma.$transaction(async (tx) => {
      // At most one live code per account. Any earlier one is consumed
      // rather than deleted, so the row stays as the record that a code was
      // once issued.
      await tx.passwordResetOtp.updateMany({
        where: { authAccountId: actor.authAccountId, consumedAt: null },
        data: { consumedAt: now },
      });

      await tx.passwordResetOtp.create({
        data: {
          authAccountId: actor.authAccountId,
          otpHash,
          expiresAt,
        },
      });
    });

    await this.authAuditService.record({
      event: AuthAuditEvent.FORGOT_PASSWORD_REQUESTED,
      tenantId: actor.tenantId,
      subjectAuthAccountId: actor.authAccountId,
      metadata: { outcome: 'OTP_ISSUED' },
    });

    // Deliberately not awaited. SMTP delivery takes hundreds of
    // milliseconds and only ever happens on the "account exists" branch, so
    // awaiting it here would make response time the enumeration oracle that
    // the identical `200` response is there to deny. The outcome is
    // recorded to the audit trail once the transport settles.
    void this.deliverOtp(actor, email, otp);
  }

  /**
   * Verifies a reset code and, on success, sets the new password and
   * revokes every live session for the account.
   */
  async resetPassword(dto: ResetPasswordDto, tenantId?: string): Promise<void> {
    // Checked before anything is read: the policy depends only on the
    // submitted password, so rejecting here reveals nothing about the
    // address and -- just as importantly -- costs the caller no attempt
    // against the code's budget.
    this.assertPasswordMeetsPolicy(dto.newPassword);

    const email = this.normalizeEmail(dto.email);
    const actor = await this.resolveActor(email, tenantId);

    // Runs even when nothing matched, against an id that cannot exist, so
    // both branches perform the same two reads.
    const otp = await this.prisma.passwordResetOtp.findFirst({
      where: {
        authAccountId: actor?.authAccountId ?? NO_MATCHING_ACCOUNT_ID,
        consumedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!actor || !actor.isActive || !otp) {
      await this.recordFailure(actor, 'NO_LIVE_OTP');
      throw this.invalidOtp();
    }

    const now = new Date();

    if (otp.expiresAt.getTime() <= now.getTime()) {
      await this.prisma.passwordResetOtp.updateMany({
        where: { id: otp.id, consumedAt: null },
        data: { consumedAt: now },
      });
      await this.recordFailure(actor, 'OTP_EXPIRED');
      throw this.invalidOtp();
    }

    if (!(await this.otpMatches(dto.otp, otp.otpHash))) {
      const attemptCount = otp.attemptCount + 1;
      const budgetSpent = attemptCount >= PASSWORD_RESET_OTP_MAX_ATTEMPTS;

      // `attemptCount` in the WHERE clause is the optimistic-concurrency
      // guard: two requests reading the same row can't both apply the same
      // increment, and the loser matches zero rows -- still a failed
      // attempt, so the response does not change.
      await this.prisma.passwordResetOtp.updateMany({
        where: {
          id: otp.id,
          consumedAt: null,
          attemptCount: otp.attemptCount,
        },
        data: {
          attemptCount,
          ...(budgetSpent ? { consumedAt: now } : {}),
        },
      });

      await this.recordFailure(
        actor,
        budgetSpent ? 'ATTEMPT_BUDGET_SPENT' : 'OTP_MISMATCH',
        attemptCount,
      );
      throw this.invalidOtp();
    }

    // Hashed outside the transaction: bcrypt at cost 10 takes long enough
    // that holding a write transaction open across it would pin a
    // connection for no reason.
    const passwordHash = await bcrypt.hash(
      dto.newPassword,
      PASSWORD_SALT_ROUNDS,
    );

    const revokedSessionCount = await this.prisma.$transaction(async (tx) => {
      // Consuming the code is the concurrency guard for the whole
      // operation: two requests presenting the same valid code race here
      // and exactly one flips the row, so only one gets to set a password.
      const consumed = await tx.passwordResetOtp.updateMany({
        where: { id: otp.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count === 0) {
        throw this.invalidOtp();
      }

      await tx.authAccount.update({
        where: { id: actor.authAccountId },
        data: { passwordHash, mustChangePassword: false },
      });

      // The account holder just proved control of the mailbox and chose a
      // new password; anything still holding a session predates that, so
      // it goes. Access tokens already minted stay valid for their
      // remaining lifetime (<= 15 minutes) -- the spec deliberately rules
      // out a blacklist or a Redis-backed revocation list.
      const revoked = await tx.refreshToken.updateMany({
        where: { authAccountId: actor.authAccountId, revokedAt: null },
        data: { revokedAt: now },
      });

      return revoked.count;
    });

    await this.authAuditService.record({
      event: AuthAuditEvent.PASSWORD_RESET_SUCCESS,
      tenantId: actor.tenantId,
      subjectAuthAccountId: actor.authAccountId,
      metadata: { revokedSessionCount },
    });
  }

  /**
   * Resolves the account behind an address using exactly the rule login
   * uses: `x-tenant-id` present -> the TenantUser of that tenant, absent ->
   * the SystemUser. Branching on the header's *presence* rather than its
   * truthiness matters -- an empty `x-tenant-id` must stay on the tenant
   * branch and find nothing, not silently fall through to a system lookup.
   */
  private async resolveActor(
    email: string,
    tenantId?: string,
  ): Promise<ResetActor | null> {
    if (tenantId !== undefined) {
      const tenantUser = await this.prisma.tenantUser.findFirst({
        where: { tenantId, authAccount: { email } },
        select: {
          authAccountId: true,
          tenantId: true,
          isActive: true,
          authAccount: { select: { isActive: true } },
        },
      });

      if (!tenantUser || !(await this.isTenantActive(tenantId))) {
        return null;
      }

      return {
        authAccountId: tenantUser.authAccountId,
        tenantId: tenantUser.tenantId,
        isActive: tenantUser.isActive && tenantUser.authAccount.isActive,
      };
    }

    const systemUser = await this.prisma.systemUser.findFirst({
      where: { authAccount: { email } },
      select: {
        authAccountId: true,
        isActive: true,
        authAccount: { select: { isActive: true } },
      },
    });

    if (!systemUser) {
      return null;
    }

    return {
      authAccountId: systemUser.authAccountId,
      tenantId: null,
      isActive: systemUser.isActive && systemUser.authAccount.isActive,
    };
  }

  private async isTenantActive(tenantId: string): Promise<boolean> {
    const [tenant] = await this.prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT "id"
        FROM "tenants"
        WHERE
          "id" = ${tenantId}
          AND "status" = ${ACTIVE_TENANT_STATUS}
        LIMIT 1
      `,
    );

    return Boolean(tenant);
  }

  /**
   * True when a code was issued for this account less than
   * `PASSWORD_RESET_OTP_COOLDOWN_SECONDS` ago. Deliberately looks at the
   * most recent row whether or not it was consumed: the cooldown is a
   * per-account rate limit on sending mail, so a code that was just used
   * still counts.
   */
  private async isWithinCooldown(authAccountId: string): Promise<boolean> {
    const latest = await this.prisma.passwordResetOtp.findFirst({
      where: { authAccountId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (!latest) {
      return false;
    }

    const elapsedMs = Date.now() - latest.createdAt.getTime();
    return elapsedMs < PASSWORD_RESET_OTP_COOLDOWN_SECONDS * 1000;
  }

  private async deliverOtp(
    actor: ResetActor,
    email: string,
    otp: string,
  ): Promise<void> {
    const outcome = await this.emailDeliveryService.sendPasswordResetOtp(
      email,
      otp,
      PASSWORD_RESET_OTP_TTL_SECONDS / 60,
    );

    if (!outcome.delivered) {
      // The error code, never the address or the code itself.
      this.logger.warn(
        `Password reset code delivery failed: ${outcome.errorCode ?? 'unknown error'}`,
      );
    }

    await this.authAuditService.record({
      event: AuthAuditEvent.FORGOT_PASSWORD_REQUESTED,
      tenantId: actor.tenantId,
      subjectAuthAccountId: actor.authAccountId,
      metadata: {
        outcome: outcome.delivered ? 'EMAIL_DELIVERED' : 'EMAIL_FAILED',
        errorCode: outcome.errorCode ?? null,
      },
    });
  }

  private async recordFailure(
    actor: ResetActor | null,
    reason: string,
    attemptCount?: number,
  ): Promise<void> {
    await this.authAuditService.record({
      event: AuthAuditEvent.PASSWORD_RESET_FAILED,
      tenantId: actor?.tenantId ?? null,
      subjectAuthAccountId: actor?.authAccountId ?? null,
      metadata: {
        reason,
        ...(attemptCount === undefined ? {} : { attemptCount }),
      },
    });
  }

  /**
   * `randomInt` is rejection-sampled by Node, so every code in
   * `[0, 10^length)` is equally likely -- unlike `Math.random()` scaling or
   * a modulo of random bytes, both of which bias the low end.
   */
  private generateOtp(): string {
    const ceiling = 10 ** PASSWORD_RESET_OTP_LENGTH;
    return String(randomInt(0, ceiling)).padStart(
      PASSWORD_RESET_OTP_LENGTH,
      '0',
    );
  }

  /**
   * Shape-checked before the hash comparison so an obviously malformed
   * submission is rejected without paying for a bcrypt round -- it cannot
   * match a well-formed code anyway, and skipping the work here does not
   * leak anything a caller does not already know about their own input.
   */
  private async otpMatches(
    submitted: string,
    storedHash: string,
  ): Promise<boolean> {
    if (!OTP_PATTERN.test(submitted)) {
      return false;
    }

    return bcrypt.compare(submitted, storedHash);
  }

  private hashOtp(otp: string): Promise<string> {
    return bcrypt.hash(otp, PASSWORD_SALT_ROUNDS);
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private assertPasswordMeetsPolicy(password: string): void {
    const violations = validatePasswordStrength(password);

    if (violations.length > 0) {
      throw new BadRequestException({
        error: AUTH_ERROR_CODES.PASSWORD_POLICY_VIOLATION,
        message: violations,
      });
    }
  }

  private invalidOtp(): BadRequestException {
    return new BadRequestException({
      error: AUTH_ERROR_CODES.INVALID_OTP,
      message: 'The reset code is invalid or has expired.',
    });
  }
}
