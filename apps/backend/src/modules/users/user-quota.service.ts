import { BadRequestException, Injectable } from '@nestjs/common';
import {
  TenantSeatUsageDto,
  TenantUserStatus,
  USER_ERROR_CODES,
  UserInviteStatus,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Canonical `Tenant.maxUsers` value that switches the quota off entirely.
 * Any negative value is read as unlimited, so a bad write can only ever
 * make a tenant too permissive, never lock every one of its users out.
 */
export const UNLIMITED_SEATS = -1;

function isUnlimited(maxUsers: number): boolean {
  return maxUsers < 0;
}

/**
 * Statuses that hold a seat on their own, without reference to anything
 * else. `pending_invite` is deliberately absent -- see `usedSeats()`.
 *
 * `locked` is in the list because the Users specification says so in prose
 * ("LOCKED vẫn chiếm quota") even though its literal seat formula omits it.
 * The prose wins: a locked user is a suspended employee, not a departed
 * one, and letting a suspension free a seat would let a tenant hold more
 * accounts than it pays for by locking them in rotation.
 *
 * `pending_setup` (the First Admin who has not claimed their account yet)
 * is not in the specification's list at all, because that flow predates it.
 * It counts: the account exists, it will be used, and the alternative is a
 * tenant whose first seat is invisible until somebody clicks an email.
 */
const SEAT_HOLDING_STATUSES = [
  TenantUserStatus.ACTIVE,
  TenantUserStatus.PENDING_SETUP,
  TenantUserStatus.PENDING_APPROVAL,
  TenantUserStatus.LOCKED,
];

/**
 * The one place that decides whether a tenant has room for another user.
 *
 * Every path that can create a seat -- invite, direct-create,
 * self-registration -- calls `assertSeatsAvailable()` before writing
 * anything, so the rule exists once instead of three times in three
 * slightly different shapes.
 *
 * The count is taken outside the write transaction, so two requests racing
 * for the last seat can both see it free and both succeed, overshooting the
 * quota by one. That is deliberate: the alternative is serializing every
 * user creation in a tenant behind a lock, and a quota is a commercial
 * limit, not a security boundary. If it ever has to be exact, the fix is a
 * `SELECT ... FOR UPDATE` on the tenant row inside the caller's
 * transaction, not a cache or a counter column.
 */
@Injectable()
export class UserQuotaService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Seats currently held by a tenant.
   *
   * An invited user holds a seat only while their invite is live: the
   * `TenantUser` row is created up front, in `pending_invite`, but the
   * specification frees the seat again once the invite expires or is
   * revoked. So `pending_invite` rows are counted through their invites
   * rather than by status -- and counted as *users with* a live invite, not
   * as live invites, so a resend that leaves two `pending` rows behind can
   * never bill the tenant twice for one person.
   */
  async usedSeats(tenantId: string): Promise<number> {
    const now = new Date();

    const [occupied, invited] = await Promise.all([
      this.prisma.tenantUser.count({
        where: { tenantId, status: { in: SEAT_HOLDING_STATUSES } },
      }),
      this.prisma.tenantUser.count({
        where: {
          tenantId,
          status: TenantUserStatus.PENDING_INVITE,
          invites: {
            some: {
              status: UserInviteStatus.PENDING,
              expiresAt: { gt: now },
            },
          },
        },
      }),
    ]);

    return occupied + invited;
  }

  /** Seat usage of one tenant, in the shape the frontend renders. */
  async getSeatUsage(tenantId: string): Promise<TenantSeatUsageDto> {
    const [maxUsers, usedSeats] = await Promise.all([
      this.resolveMaxUsers(tenantId),
      this.usedSeats(tenantId),
    ]);

    return this.toSeatUsage(usedSeats, maxUsers);
  }

  /**
   * Throws `400 QUOTA_EXCEEDED` unless the tenant can take `seats` more
   * users. `seats` is more than one for a batch invite, which the
   * specification requires to be all-or-nothing: five invites into three
   * free seats create nothing at all rather than the first three.
   *
   * Returns the usage it measured so a caller that needs it (to report how
   * many seats are left, say) does not have to count a second time.
   */
  async assertSeatsAvailable(
    tenantId: string,
    seats = 1,
  ): Promise<TenantSeatUsageDto> {
    const [maxUsers, usedSeats] = await Promise.all([
      this.resolveMaxUsers(tenantId),
      this.usedSeats(tenantId),
    ]);

    if (!isUnlimited(maxUsers) && usedSeats + seats > maxUsers) {
      throw new BadRequestException({
        error: USER_ERROR_CODES.QUOTA_EXCEEDED,
        message:
          seats === 1
            ? `This tenant uses ${usedSeats} of its ${maxUsers} user seats and has none left.`
            : `This tenant uses ${usedSeats} of its ${maxUsers} user seats and cannot take ${seats} more.`,
      });
    }

    return this.toSeatUsage(usedSeats, maxUsers);
  }

  private async resolveMaxUsers(tenantId: string): Promise<number> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { maxUsers: true },
    });

    // A caller holding a verified tenant-scoped token whose tenant has
    // vanished is not a quota question; treat the quota as unlimited and
    // let the caller's own tenant lookup produce the real error.
    return tenant?.maxUsers ?? UNLIMITED_SEATS;
  }

  private toSeatUsage(usedSeats: number, maxUsers: number): TenantSeatUsageDto {
    const unlimited = isUnlimited(maxUsers);

    return {
      usedSeats,
      maxUsers,
      // Never negative: an over-quota tenant (the limit was lowered under
      // it, or a race overshot it) reports zero seats left, not a negative
      // number the UI would have to special-case.
      remainingSeats: unlimited ? null : Math.max(0, maxUsers - usedSeats),
      unlimited,
    };
  }
}
