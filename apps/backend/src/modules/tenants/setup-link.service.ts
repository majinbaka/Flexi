import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { RedeemSetupTokenDto } from './dto/redeem-setup-token.dto';

const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const SETUP_TOKEN_BYTES = 32;
const PASSWORD_SALT_ROUNDS = 10;
const TENANT_USER_STATUS_PENDING_SETUP = 'pending_setup';
const TENANT_USER_STATUS_ACTIVE = 'active';

export interface GeneratedSetupLink {
  setupToken: string;
  expiresAt: Date;
}

/**
 * Single source of truth for minting a tenant's one-time setup token
 * (Story 2.5). Called from two sites: the blocking `setup_link_generated`
 * provisioning step (`TenantProvisioningService`) and the manual
 * `POST /api/v1/super-admin/tenants/:id/setup-link` regeneration endpoint
 * (`TenantsService.regenerateSetupLink()`).
 *
 * Mirrors `RefreshToken`'s hash-only-at-rest shape/pattern exactly: the raw
 * token is generated with `randomBytes(32).toString('base64url')`, hashed
 * with SHA-256 (duplicated locally from `auth.service.ts`'s `hashToken()`
 * -- deliberately not cross-imported from `AuthModule`), and only the hash
 * is persisted. The raw token is returned once, in-memory, and is never
 * re-readable afterward.
 *
 * Every call revokes every non-revoked `SetupToken` for the tenant first,
 * then mints a fresh one -- there is no way to "re-return" a previously
 * issued raw token (it was never persisted), so a BullMQ full-job retry or
 * a manual regeneration always rotates.
 */
@Injectable()
export class SetupLinkService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Rejects with `NotFoundException` if no `TenantUser` exists yet for the
   * tenant (Story 2.4's First Admin assignment must have run first).
   * Otherwise, inside one `prisma.$transaction`: revokes every non-revoked
   * `SetupToken` for the tenant, generates and hashes a fresh raw token,
   * persists only the hash with a 24h expiry, and returns the raw token +
   * expiry.
   */
  async generate(tenantId: string): Promise<GeneratedSetupLink> {
    return this.prisma.$transaction(async (tx) => {
      const existingTenantUser = await tx.tenantUser.findFirst({
        where: { tenantId },
        select: { id: true },
      });

      if (!existingTenantUser) {
        throw new NotFoundException({
          error: 'FIRST_ADMIN_NOT_FOUND',
          message:
            'No First Admin exists for this tenant yet; setup link generation requires Story 2.4 to have run.',
        });
      }

      await tx.setupToken.updateMany({
        where: { tenantId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const setupToken = randomBytes(SETUP_TOKEN_BYTES).toString('base64url');
      const tokenHash = this.hashToken(setupToken);
      const expiresAt = new Date(Date.now() + SETUP_TOKEN_TTL_MS);

      await tx.setupToken.create({
        data: {
          tenantId,
          tokenHash,
          expiresAt,
        },
      });

      return { setupToken, expiresAt };
    });
  }

  /**
   * Compensation for a Story 2.6 provisioning-orchestrator failure: revokes
   * every non-revoked `SetupToken` for `tenantId`, the same
   * "`revokedAt = now`" pattern `generate()` already uses internally before
   * minting a fresh token. Idempotent -- if no non-revoked tokens exist
   * (`generate()` never ran, or this is a retry after compensation already
   * succeeded), `updateMany` matches zero rows and resolves without error.
   * Never deletes `SetupToken` rows -- a revoked token is still a truthful
   * historical record that a link was once issued for this tenant.
   */
  async revokeAll(tenantId: string): Promise<void> {
    await this.prisma.setupToken.updateMany({
      where: { tenantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Claims a First Admin account from a setup token. Every mutable operation
   * runs in one transaction: the token is conditionally consumed, the
   * account password and user status are changed, and any still-live sibling
   * tokens are revoked. The conditional update is the concurrency guard --
   * a second request racing with a successful claim updates zero rows and
   * receives the same opaque error as any invalid link.
   */
  async redeem(dto: RedeemSetupTokenDto): Promise<void> {
    this.assertPasswordIsValid(dto.password);

    const tokenHash = this.hashToken(dto.token);
    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_SALT_ROUNDS);

    await this.prisma.$transaction(async (tx) => {
      const setupToken = await tx.setupToken.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          tenantId: true,
          expiresAt: true,
          revokedAt: true,
          usedAt: true,
        },
      });
      const redeemedAt = new Date();

      if (
        !setupToken ||
        setupToken.revokedAt ||
        setupToken.usedAt ||
        setupToken.expiresAt.getTime() <= redeemedAt.getTime()
      ) {
        throw this.invalidSetupTokenException();
      }

      const tenantUser = await tx.tenantUser.findFirst({
        where: {
          tenantId: setupToken.tenantId,
          status: TENANT_USER_STATUS_PENDING_SETUP,
          isActive: true,
        },
        select: { id: true, authAccountId: true },
      });

      // A setup token without its pending First Admin is not redeemable. Use
      // the same error as every other bad-token condition to avoid identity
      // disclosure.
      if (!tenantUser) {
        throw this.invalidSetupTokenException();
      }

      const consumed = await tx.setupToken.updateMany({
        where: {
          id: setupToken.id,
          revokedAt: null,
          usedAt: null,
          expiresAt: { gt: redeemedAt },
        },
        data: { usedAt: redeemedAt },
      });

      if (consumed.count !== 1) {
        throw this.invalidSetupTokenException();
      }

      await tx.authAccount.update({
        where: { id: tenantUser.authAccountId },
        data: { passwordHash },
      });
      await tx.tenantUser.update({
        where: { id: tenantUser.id },
        data: { status: TENANT_USER_STATUS_ACTIVE },
      });
      await tx.setupToken.updateMany({
        where: {
          tenantId: setupToken.tenantId,
          id: { not: setupToken.id },
          revokedAt: null,
          usedAt: null,
        },
        data: { revokedAt: redeemedAt },
      });
    });
  }

  private assertPasswordIsValid(password: unknown): asserts password is string {
    if (typeof password !== 'string' || !password.trim()) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: 'password must be a non-empty string.',
        fields: { password: 'PASSWORD_REQUIRED' },
      });
    }
  }

  private invalidSetupTokenException(): BadRequestException {
    return new BadRequestException({
      error: 'INVALID_SETUP_TOKEN',
      message: 'The setup link is invalid or has expired.',
    });
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
