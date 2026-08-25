-- Record successful setup-link consumption independently from revocation.
-- Existing, unconsumed setup tokens remain redeemable until their existing
-- expiry/revocation rules apply; no token material or historic row is lost.
ALTER TABLE "setup_tokens" ADD COLUMN "usedAt" TIMESTAMP(3);

-- `tokenHash` is already uniquely indexed for redemption lookup. Replace the
-- former tenant-only index with one that supports active-token revocation and
-- regeneration.
DROP INDEX "setup_tokens_tenantId_idx";

CREATE INDEX "setup_tokens_tenantId_revokedAt_usedAt_idx"
ON "setup_tokens"("tenantId", "revokedAt", "usedAt");
