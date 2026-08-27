-- Password recovery, session revocation and account lifecycle (issue #46).
--
-- Three independent pieces: the force-reset flag on the login identity, the
-- hash-only reset-code table, and the append-only audit trail for all of
-- the above. None of them touch existing rows' behaviour, so this migration
-- is additive and safe to apply to a live database.

-- 1. Admin force-reset raises this; the holder's own change-password call
--    clears it. Existing accounts are unaffected (default false).
ALTER TABLE "auth_accounts"
  ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- 2. Emailed six-digit reset codes. Only the SHA-256 hash is stored, the
--    same hash-only-at-rest shape as "refresh_tokens" and "setup_tokens".
--    Rows are consumed (consumedAt), never deleted.
CREATE TABLE "password_reset_otps" (
  "id"            TEXT NOT NULL,
  "authAccountId" TEXT NOT NULL,
  "otpHash"       TEXT NOT NULL,
  "expiresAt"     TIMESTAMP(3) NOT NULL,
  "consumedAt"    TIMESTAMP(3),
  "attemptCount"  INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "password_reset_otps_pkey" PRIMARY KEY ("id")
);

-- Covers both hot reads: the live-code lookup (cooldown + verification) and
-- burning every outstanding code for an account.
CREATE INDEX "password_reset_otps_authAccountId_consumedAt_idx"
  ON "password_reset_otps" ("authAccountId", "consumedAt");

ALTER TABLE "password_reset_otps"
  ADD CONSTRAINT "password_reset_otps_authAccountId_fkey"
  FOREIGN KEY ("authAccountId") REFERENCES "auth_accounts" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Append-only audit trail. Deliberately without foreign keys (mirroring
--    "tenant_onboarding_audit_logs") so a row outlives the account it
--    describes. "metadata" carries non-secret context only.
CREATE TABLE "auth_audit_logs" (
  "id"                   TEXT NOT NULL,
  "event"                TEXT NOT NULL,
  "tenantId"             TEXT,
  "subjectAuthAccountId" TEXT,
  "actorAuthAccountId"   TEXT,
  "metadata"             JSONB,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "auth_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "auth_audit_logs_event_idx" ON "auth_audit_logs" ("event");
CREATE INDEX "auth_audit_logs_subjectAuthAccountId_idx"
  ON "auth_audit_logs" ("subjectAuthAccountId");
CREATE INDEX "auth_audit_logs_tenantId_idx" ON "auth_audit_logs" ("tenantId");
CREATE INDEX "auth_audit_logs_createdAt_idx" ON "auth_audit_logs" ("createdAt");
