import { createHash, randomBytes } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import {
  ActorType,
  AUTH_ERROR_CODES,
  AuthAuditEvent,
  AuthenticatedUserDto,
  CreatedUserInviteDto,
  InviteUsersResponseDto,
  RedeemUserInviteResponseDto,
  TenantUserStatus,
  USER_ERROR_CODES,
  USER_INVITE_TTL_HOURS,
  UserInviteDto,
  UserInviteStatus,
  validatePasswordStrength,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailDeliveryService } from '../../mail/email-delivery.service';
import { AuthAuditService } from '../auth/auth-audit.service';
import { CreateUserInvitesDto } from './dto/create-user-invites.dto';
import { RedeemUserInviteDto } from './dto/redeem-user-invite.dto';
import { TenantUserDirectoryService } from './tenant-user-directory.service';
import { UserQuotaService } from './user-quota.service';

const INVITE_TOKEN_BYTES = 32;
const INVITE_TOKEN_TTL_MS = USER_INVITE_TTL_HOURS * 60 * 60 * 1000;
const PASSWORD_SALT_ROUNDS = 10;
const ACTIVE_TENANT_STATUS = 'ACTIVE';

/** The subset of an invite row every response shape is built from. */
const INVITE_SELECT = {
  id: true,
  tenantId: true,
  email: true,
  roleId: true,
  tenantUserId: true,
  status: true,
  expiresAt: true,
  usedAt: true,
  revokedAt: true,
  invitedById: true,
  createdAt: true,
  role: { select: { name: true } },
} satisfies Prisma.UserInviteSelect;

type InviteRow = Prisma.UserInviteGetPayload<{ select: typeof INVITE_SELECT }>;

/** A tenant-scoped caller, once their token has been checked for one. */
interface TenantActor {
  tenantId: string;
  authAccountId: string;
  tenantUserId: string | null;
}

/** A freshly minted token and everything derived from it. */
interface MintedToken {
  inviteToken: string;
  tokenHash: string;
  expiresAt: Date;
}

/**
 * The invite lifecycle: send, list, resend, revoke, redeem.
 *
 * Two rules shape the whole service.
 *
 * The first is that a token is a secret the server cannot read back. Only
 * its SHA-256 hash is stored -- the same hash-only contract `SetupToken`
 * and `RefreshToken` already use -- so the raw token exists exactly twice:
 * in the response of the call that minted it, and in the email it was put
 * in. It is never logged and never recorded in an audit row.
 *
 * The second is that a failing redemption must not describe why it failed.
 * Unknown token, expired token, revoked token, already-used token, an
 * invite whose user has since been deleted, an invite into a tenant that
 * is no longer active: all six answer `401 INVITE_TOKEN_EXPIRED`, so the
 * public endpoint cannot be used to discover which invites exist.
 */
@Injectable()
export class UserInviteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userQuotaService: UserQuotaService,
    private readonly tenantUserDirectoryService: TenantUserDirectoryService,
    private readonly emailDeliveryService: EmailDeliveryService,
    private readonly authAuditService: AuthAuditService,
  ) {}

  /**
   * Invites a batch of addresses into the caller's tenant, all or nothing.
   *
   * The quota is asserted for the whole batch before anything is written,
   * and every row of the batch is created in one transaction, so five
   * invites into three free seats create nothing at all rather than the
   * first three. The same holds for an address that is already a member:
   * the `409` it raises rolls the entire batch back.
   *
   * Mail goes out after the transaction commits. A delivery failure is
   * reported per invite (`emailDelivered`) rather than raised: the invite
   * exists and can be resent, and unwinding a committed transaction
   * because an SMTP server was briefly unreachable would be worse than
   * telling the administrator what happened.
   */
  async createInvites(
    dto: CreateUserInvitesDto,
    currentUser: AuthenticatedUserDto,
  ): Promise<InviteUsersResponseDto> {
    const actor = this.requireTenantActor(currentUser);
    const emails = this.normalizeBatch(dto.emails);

    // Before anything is written, as the specification requires.
    await this.userQuotaService.assertSeatsAvailable(
      actor.tenantId,
      emails.length,
    );

    const tenant = await this.requireActiveTenant(actor.tenantId);
    const roleId = await this.resolveRoleId(actor.tenantId, dto.roleId);

    // bcrypt is deliberately outside the transaction: hashing a batch of
    // placeholder passwords would otherwise hold it open for the entire
    // cost of the batch.
    const prepared = await Promise.all(
      emails.map(async (email) => ({
        email,
        token: this.mintToken(),
        placeholderPasswordHash: await this.hashUnusablePassword(),
      })),
    );

    const created = await this.prisma.$transaction(async (tx) => {
      const rows: InviteRow[] = [];

      for (const { email, token, placeholderPasswordHash } of prepared) {
        await this.tenantUserDirectoryService.assertEmailAvailable(
          actor.tenantId,
          email,
          tx,
        );

        const authAccount = await tx.authAccount.create({
          data: { email, passwordHash: placeholderPasswordHash },
          select: { id: true },
        });

        // `isActive: false` until the invite is redeemed: the membership,
        // not the account, is what `AuthService` refuses to log in.
        const tenantUser = await tx.tenantUser.create({
          data: {
            tenantId: actor.tenantId,
            authAccountId: authAccount.id,
            status: TenantUserStatus.PENDING_INVITE,
            isActive: false,
          },
          select: { id: true },
        });

        rows.push(
          await tx.userInvite.create({
            data: {
              tenantId: actor.tenantId,
              email,
              roleId,
              tenantUserId: tenantUser.id,
              tokenHash: token.tokenHash,
              expiresAt: token.expiresAt,
              status: UserInviteStatus.PENDING,
              invitedById: actor.tenantUserId,
            },
            select: INVITE_SELECT,
          }),
        );
      }

      return rows;
    });

    const invites = await Promise.all(
      created.map((row, index) =>
        this.deliver(row, tenant.name, prepared[index].token.inviteToken, {
          event: AuthAuditEvent.USER_INVITE_SENT,
          actorAuthAccountId: actor.authAccountId,
        }),
      ),
    );

    return {
      invites,
      seatUsage: await this.userQuotaService.getSeatUsage(actor.tenantId),
    };
  }

  /** Every invite of the caller's tenant, newest first. Never any token. */
  async listInvites(
    currentUser: AuthenticatedUserDto,
  ): Promise<UserInviteDto[]> {
    const actor = this.requireTenantActor(currentUser);

    const invites = await this.prisma.userInvite.findMany({
      where: { tenantId: actor.tenantId },
      select: INVITE_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    return invites.map((invite) => this.toInviteDto(invite));
  }

  /**
   * Retires an invite and issues a fresh one to the same address.
   *
   * A new row rather than a new token on the old one: the old invite stays
   * as a truthful record that a link was once issued and later retired,
   * the same reason `SetupLinkService` revokes instead of deleting. Both
   * rows point at the one `TenantUser`, which is why `UserQuotaService`
   * counts invited *users* rather than live invites -- a resend can never
   * bill a tenant twice for one person.
   *
   * Resending an expired invite re-claims a seat that expiry had already
   * freed, so the quota is asserted again in exactly that case.
   */
  async resendInvite(
    inviteId: string,
    currentUser: AuthenticatedUserDto,
  ): Promise<CreatedUserInviteDto> {
    const actor = this.requireTenantActor(currentUser);
    const existing = await this.requireInvite(inviteId, actor.tenantId);

    if (existing.status !== UserInviteStatus.PENDING) {
      throw this.notPendingException(existing.status);
    }

    // Only possible if the membership was deleted underneath a live
    // invite (the FK is `SetNull`), which leaves nothing to resend to.
    if (!existing.tenantUserId) {
      throw new BadRequestException({
        error: USER_ERROR_CODES.INVITE_NOT_PENDING,
        message: 'The membership this invite was holding no longer exists.',
      });
    }

    if (this.hasExpired(existing)) {
      await this.userQuotaService.assertSeatsAvailable(actor.tenantId, 1);
    }

    const tenant = await this.requireActiveTenant(actor.tenantId);
    const token = this.mintToken();

    const replacement = await this.prisma.$transaction(async (tx) => {
      // Conditional, so two administrators resending the same invite at
      // once cannot both retire it and leave two live tokens behind.
      const retired = await tx.userInvite.updateMany({
        where: { id: existing.id, status: UserInviteStatus.PENDING },
        data: {
          status: UserInviteStatus.REVOKED,
          revokedAt: new Date(),
        },
      });

      if (retired.count !== 1) {
        throw this.notPendingException(existing.status);
      }

      return tx.userInvite.create({
        data: {
          tenantId: actor.tenantId,
          email: existing.email,
          roleId: existing.roleId,
          tenantUserId: existing.tenantUserId,
          tokenHash: token.tokenHash,
          expiresAt: token.expiresAt,
          status: UserInviteStatus.PENDING,
          invitedById: actor.tenantUserId,
        },
        select: INVITE_SELECT,
      });
    });

    return this.deliver(replacement, tenant.name, token.inviteToken, {
      event: AuthAuditEvent.USER_INVITE_RESENT,
      actorAuthAccountId: actor.authAccountId,
    });
  }

  /**
   * Withdraws an invite and the membership it was holding open, freeing
   * the seat immediately.
   *
   * The `TenantUser` goes to `DELETED` rather than being removed: the
   * status frees the seat and releases the address for a later invite (see
   * `TenantUserDirectoryService`), while leaving the row in place for
   * anything that references it.
   *
   * Revoking an already-revoked invite succeeds and changes nothing --
   * clicking twice is not an error. Revoking a redeemed one does not: the
   * person is an active member, and removing them is user deletion, not
   * invite management.
   */
  async revokeInvite(
    inviteId: string,
    currentUser: AuthenticatedUserDto,
  ): Promise<UserInviteDto> {
    const actor = this.requireTenantActor(currentUser);
    const existing = await this.requireInvite(inviteId, actor.tenantId);

    if (existing.status === UserInviteStatus.REVOKED) {
      return this.toInviteDto(existing);
    }

    if (existing.status !== UserInviteStatus.PENDING) {
      throw this.notPendingException(existing.status);
    }

    const revoked = await this.prisma.$transaction(async (tx) => {
      const revokedAt = new Date();

      const consumed = await tx.userInvite.updateMany({
        where: { id: existing.id, status: UserInviteStatus.PENDING },
        data: { status: UserInviteStatus.REVOKED, revokedAt },
      });

      if (consumed.count !== 1) {
        throw this.notPendingException(existing.status);
      }

      if (existing.tenantUserId) {
        await tx.tenantUser.update({
          where: { id: existing.tenantUserId },
          data: {
            status: TenantUserStatus.DELETED,
            isActive: false,
          },
        });

        // Any other live invite for the same person would otherwise keep
        // the seat -- and a redeemable token -- alive past the revocation.
        await tx.userInvite.updateMany({
          where: {
            tenantUserId: existing.tenantUserId,
            id: { not: existing.id },
            status: UserInviteStatus.PENDING,
          },
          data: { status: UserInviteStatus.REVOKED, revokedAt },
        });
      }

      return tx.userInvite.findUniqueOrThrow({
        where: { id: existing.id },
        select: INVITE_SELECT,
      });
    });

    await this.authAuditService.record({
      event: AuthAuditEvent.USER_INVITE_REVOKED,
      tenantId: actor.tenantId,
      actorAuthAccountId: actor.authAccountId,
      metadata: { inviteId: existing.id, email: existing.email },
    });

    return this.toInviteDto(revoked);
  }

  /**
   * Claims an invited account. Public: the caller holds a token, not a
   * session.
   *
   * Every mutable step runs in one transaction, and the invite is consumed
   * by a conditional `updateMany` rather than by a read followed by a
   * write. That conditional update is the concurrency guard: two requests
   * racing with the same token both find a live invite, but only one
   * updates a row, and the loser gets the same opaque error as any invalid
   * token.
   */
  async redeemInvite(
    dto: RedeemUserInviteDto,
  ): Promise<RedeemUserInviteResponseDto> {
    this.assertPasswordsMatch(dto);
    this.assertPasswordMeetsPolicy(dto.password);

    const fullName = dto.fullName.trim();
    if (!fullName) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: 'fullName must not be blank.',
      });
    }

    const tokenHash = this.hashToken(dto.token);
    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_SALT_ROUNDS);

    const redeemed = await this.prisma.$transaction(async (tx) => {
      const redeemedAt = new Date();
      const invite = await tx.userInvite.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          tenantId: true,
          email: true,
          roleId: true,
          tenantUserId: true,
          status: true,
          expiresAt: true,
          tenant: { select: { status: true } },
        },
      });

      if (
        !invite ||
        !invite.tenantUserId ||
        invite.status !== UserInviteStatus.PENDING ||
        invite.expiresAt.getTime() <= redeemedAt.getTime() ||
        invite.tenant.status !== ACTIVE_TENANT_STATUS
      ) {
        throw this.invalidInviteTokenException();
      }

      const tenantUser = await tx.tenantUser.findFirst({
        where: {
          id: invite.tenantUserId,
          tenantId: invite.tenantId,
          status: TenantUserStatus.PENDING_INVITE,
        },
        select: { id: true, authAccountId: true },
      });

      // A live invite whose membership has been deleted underneath it is
      // not redeemable, and says so with the same opaque error.
      if (!tenantUser) {
        throw this.invalidInviteTokenException();
      }

      const consumed = await tx.userInvite.updateMany({
        where: {
          id: invite.id,
          status: UserInviteStatus.PENDING,
          expiresAt: { gt: redeemedAt },
        },
        data: { status: UserInviteStatus.USED, usedAt: redeemedAt },
      });

      if (consumed.count !== 1) {
        throw this.invalidInviteTokenException();
      }

      await tx.authAccount.update({
        where: { id: tenantUser.authAccountId },
        data: { passwordHash, mustChangePassword: false },
      });

      // The role the invite named is granted here, not at invite time: an
      // unredeemed invite must not leave a grant lying around on a
      // membership that cannot log in.
      await tx.tenantUser.update({
        where: { id: tenantUser.id },
        data: {
          name: fullName,
          status: TenantUserStatus.ACTIVE,
          isActive: true,
          ...(invite.roleId
            ? { roles: { connect: { id: invite.roleId } } }
            : {}),
        },
      });

      await tx.userInvite.updateMany({
        where: {
          tenantUserId: tenantUser.id,
          id: { not: invite.id },
          status: UserInviteStatus.PENDING,
        },
        data: { status: UserInviteStatus.REVOKED, revokedAt: redeemedAt },
      });

      return {
        tenantId: invite.tenantId,
        userId: tenantUser.id,
        authAccountId: tenantUser.authAccountId,
        email: invite.email,
        inviteId: invite.id,
      };
    });

    await this.authAuditService.record({
      event: AuthAuditEvent.USER_INVITE_REDEEMED,
      tenantId: redeemed.tenantId,
      subjectAuthAccountId: redeemed.authAccountId,
      metadata: { inviteId: redeemed.inviteId, email: redeemed.email },
    });

    return {
      tenantId: redeemed.tenantId,
      userId: redeemed.userId,
      email: redeemed.email,
      status: TenantUserStatus.ACTIVE,
    };
  }

  /**
   * Mails an invite and records it, then returns the one response shape
   * that carries the raw token. Shared by send and resend so the two
   * cannot drift in what they deliver, return or audit.
   */
  private async deliver(
    invite: InviteRow,
    tenantName: string,
    inviteToken: string,
    audit: { event: AuthAuditEvent; actorAuthAccountId: string },
  ): Promise<CreatedUserInviteDto> {
    const outcome = await this.emailDeliveryService.sendUserInvite(
      invite.email,
      tenantName,
      inviteToken,
      USER_INVITE_TTL_HOURS,
    );

    await this.authAuditService.record({
      event: audit.event,
      tenantId: invite.tenantId,
      actorAuthAccountId: audit.actorAuthAccountId,
      metadata: {
        inviteId: invite.id,
        email: invite.email,
        emailDelivered: outcome.delivered,
      },
    });

    return {
      ...this.toInviteDto(invite),
      inviteToken,
      acceptUrl: this.emailDeliveryService.createAcceptInviteUrl(inviteToken),
      emailDelivered: outcome.delivered,
    };
  }

  private mintToken(): MintedToken {
    const inviteToken = randomBytes(INVITE_TOKEN_BYTES).toString('base64url');

    return {
      inviteToken,
      tokenHash: this.hashToken(inviteToken),
      expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * A password nobody holds, for the account of somebody who has not
   * chosen one yet. `AuthAccount.passwordHash` is not nullable, and a
   * placeholder that is a hash of 32 random bytes is unguessable rather
   * than merely unlikely -- the invitee replaces it at redemption.
   */
  private hashUnusablePassword(): Promise<string> {
    return bcrypt.hash(
      randomBytes(INVITE_TOKEN_BYTES).toString('base64url'),
      PASSWORD_SALT_ROUNDS,
    );
  }

  /**
   * Lowercases every address and rejects a batch that names the same
   * person twice -- otherwise the duplicate would only be caught halfway
   * through the transaction, by the membership the first copy had just
   * created, and reported as `EMAIL_ALREADY_EXISTS` about an address that
   * was not a member when the request arrived.
   */
  private normalizeBatch(emails: string[]): string[] {
    const normalized = emails.map((email) =>
      this.tenantUserDirectoryService.normalizeEmail(email),
    );
    const seen = new Set<string>();

    for (const email of normalized) {
      if (seen.has(email)) {
        throw new BadRequestException({
          error: 'VALIDATION_ERROR',
          message: `emails contains ${email} more than once.`,
        });
      }
      seen.add(email);
    }

    return normalized;
  }

  private async requireActiveTenant(
    tenantId: string,
  ): Promise<{ id: string; name: string }> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, status: ACTIVE_TENANT_STATUS },
      select: { id: true, name: true },
    });

    if (!tenant) {
      throw new NotFoundException({
        error: 'TENANT_NOT_FOUND',
        message: 'This tenant does not exist or is not active.',
      });
    }

    return tenant;
  }

  /** `null` for an invite without a role; otherwise a role of this tenant. */
  private async resolveRoleId(
    tenantId: string,
    roleId: string | undefined,
  ): Promise<string | null> {
    if (!roleId) {
      return null;
    }

    const role = await this.prisma.role.findFirst({
      where: { id: roleId, tenantId },
      select: { id: true },
    });

    if (!role) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: 'roleId does not name a role of this tenant.',
      });
    }

    return role.id;
  }

  private async requireInvite(
    inviteId: string,
    tenantId: string,
  ): Promise<InviteRow> {
    // The tenant filter is the isolation boundary: another tenant's invite
    // simply does not resolve, so the route cannot be used to discover ids
    // elsewhere.
    const invite = await this.prisma.userInvite.findFirst({
      where: { id: inviteId, tenantId },
      select: INVITE_SELECT,
    });

    if (!invite) {
      throw new NotFoundException({
        error: USER_ERROR_CODES.INVITE_NOT_FOUND,
        message: 'No invite with this id belongs to this tenant.',
      });
    }

    return invite;
  }

  private requireTenantActor(currentUser: AuthenticatedUserDto): TenantActor {
    if (currentUser.actorType !== ActorType.TENANT || !currentUser.tenantId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: 'Invites are managed from within a tenant.',
      });
    }

    return {
      tenantId: currentUser.tenantId,
      authAccountId: currentUser.authAccountId,
      tenantUserId: currentUser.tenantUserId ?? null,
    };
  }

  private assertPasswordsMatch(dto: RedeemUserInviteDto): void {
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: 'password and confirmPassword do not match.',
      });
    }
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

  private hasExpired(invite: InviteRow): boolean {
    return invite.expiresAt.getTime() <= Date.now();
  }

  /**
   * Derived rather than stored: a `pending` row whose `expiresAt` has
   * passed is `expired` everywhere it matters, with no sweeper job needed
   * to make that true.
   */
  private resolveStatus(invite: InviteRow): UserInviteStatus {
    if (invite.status === UserInviteStatus.PENDING && this.hasExpired(invite)) {
      return UserInviteStatus.EXPIRED;
    }

    return invite.status as UserInviteStatus;
  }

  private toInviteDto(invite: InviteRow): UserInviteDto {
    return {
      id: invite.id,
      tenantId: invite.tenantId,
      email: invite.email,
      roleId: invite.roleId,
      roleName: invite.role?.name ?? null,
      tenantUserId: invite.tenantUserId,
      status: this.resolveStatus(invite),
      expiresAt: invite.expiresAt.toISOString(),
      usedAt: invite.usedAt?.toISOString() ?? null,
      revokedAt: invite.revokedAt?.toISOString() ?? null,
      invitedById: invite.invitedById,
      createdAt: invite.createdAt.toISOString(),
    };
  }

  private notPendingException(status: string): BadRequestException {
    return new BadRequestException({
      error: USER_ERROR_CODES.INVITE_NOT_PENDING,
      message: `This invite is ${status} and can no longer be resent or revoked.`,
    });
  }

  /**
   * The one answer every failing redemption gets. `401` rather than `400`,
   * per the Users specification's error table: the caller presented a
   * credential and it was not accepted.
   */
  private invalidInviteTokenException(): UnauthorizedException {
    return new UnauthorizedException({
      error: USER_ERROR_CODES.INVITE_TOKEN_EXPIRED,
      message: 'This invitation link is invalid or has expired.',
    });
  }
}
