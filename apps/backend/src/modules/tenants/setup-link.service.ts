import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const SETUP_TOKEN_BYTES = 32;

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

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
