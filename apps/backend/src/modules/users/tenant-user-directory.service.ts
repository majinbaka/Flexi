import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantUserStatus, USER_ERROR_CODES } from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';

/** Enough of a membership to decide whether an email is taken. */
export interface ExistingTenantMember {
  tenantUserId: string;
  authAccountId: string;
  status: string;
}

/**
 * Email uniqueness inside one tenant -- the rule behind
 * `409 EMAIL_ALREADY_EXISTS`.
 *
 * Enforced here rather than by a database constraint, and that is a
 * deliberate limitation rather than an omission: the address lives on
 * `AuthAccount`, the tenant on `TenantUser`, and Postgres cannot put a
 * unique index across two tables. The alternatives were to denormalize the
 * email onto `TenantUser` -- creating a second copy that can drift from
 * the one the login path actually reads -- or to leave the rule to each
 * caller. Neither is better than one shared checkpoint that every creation
 * path runs inside its own transaction.
 *
 * The practical consequence: two simultaneous creations of the same
 * address in the same tenant can both pass the check. Pass the enclosing
 * transaction client (`tx`) so the read at least sits inside the write it
 * guards, and, for the invite path, rely on the unique index on
 * `(tenantId, authAccountId)` to reject the second membership row.
 */
@Injectable()
export class TenantUserDirectoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lowercased and trimmed, matching how provisioning stores a First
   * Admin's address and therefore how `AuthService` finds it at login. An
   * address that skips this normalization is an address nobody can log in
   * with.
   */
  normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * The tenant's non-deleted member holding this address, if any.
   *
   * Soft-deleted members are excluded: their seat is free, so their
   * address must be too, or a tenant could never re-invite somebody it had
   * removed.
   */
  async findMemberByEmail(
    tenantId: string,
    email: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<ExistingTenantMember | null> {
    const member = await client.tenantUser.findFirst({
      where: {
        tenantId,
        status: { not: TenantUserStatus.DELETED },
        authAccount: { email: this.normalizeEmail(email) },
      },
      select: { id: true, authAccountId: true, status: true },
    });

    return member
      ? {
          tenantUserId: member.id,
          authAccountId: member.authAccountId,
          status: member.status,
        }
      : null;
  }

  /**
   * Throws `409 EMAIL_ALREADY_EXISTS` if the address is already a member
   * of this tenant.
   *
   * The message names neither the existing user nor their status. Invite
   * and direct-create are behind a permission, so an administrator learning
   * that an address is taken in their own tenant is no disclosure; the
   * public self-registration route is not, and reuses this same wording so
   * the two cannot be told apart.
   */
  async assertEmailAvailable(
    tenantId: string,
    email: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const existing = await this.findMemberByEmail(tenantId, email, client);

    if (existing) {
      throw new ConflictException({
        error: USER_ERROR_CODES.EMAIL_ALREADY_EXISTS,
        message: 'This email already belongs to a user of this tenant.',
      });
    }
  }
}
