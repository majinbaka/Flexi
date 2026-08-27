-- Users persistence and seat quota (issue #189, split out of epic #47).
--
-- Purely additive: one new column with a default that preserves today's
-- behaviour, two new tables, and one uniqueness constraint that states an
-- invariant the service layer already maintains. No existing row changes
-- meaning, so this is safe to apply to a live database and the First Admin
-- flow ("pending_setup" -> "active") keeps working untouched.

-- 1. Seat quota. -1 is unlimited, which is what every already-provisioned
--    tenant gets, so nothing starts refusing invites the moment this lands.
ALTER TABLE "tenants"
  ADD COLUMN "maxUsers" INTEGER NOT NULL DEFAULT -1;

-- 2. Per-tenant self-registration policy. One row per tenant, created
--    lazily on first read/write rather than backfilled here: the column
--    defaults encode the safe policy (registration off, approval
--    required), so an absent row and a default row mean the same thing.
CREATE TABLE "tenant_settings" (
  "id"                    TEXT NOT NULL,
  "tenantId"              TEXT NOT NULL,
  "allowSelfRegistration" BOOLEAN NOT NULL DEFAULT false,
  "allowedEmailDomains"   TEXT[] DEFAULT ARRAY[]::TEXT[],
  "defaultRoleId"         TEXT,
  "requireApproval"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,

  CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_settings_tenantId_key"
  ON "tenant_settings" ("tenantId");
CREATE INDEX "tenant_settings_defaultRoleId_idx"
  ON "tenant_settings" ("defaultRoleId");

ALTER TABLE "tenant_settings"
  ADD CONSTRAINT "tenant_settings_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A deleted role must not delete the tenant's whole settings row; the
-- registration policy then fails closed on a missing default role instead.
ALTER TABLE "tenant_settings"
  ADD CONSTRAINT "tenant_settings_defaultRoleId_fkey"
  FOREIGN KEY ("defaultRoleId") REFERENCES "roles" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Invitations. Hash-only at rest, the same shape as "setup_tokens" and
--    "refresh_tokens": only the SHA-256 of the token is stored, and
--    redemption looks the row up by that hash.
CREATE TABLE "user_invites" (
  "id"           TEXT NOT NULL,
  "tenantId"     TEXT NOT NULL,
  "email"        TEXT NOT NULL,
  "roleId"       TEXT,
  "tenantUserId" TEXT,
  "tokenHash"    TEXT NOT NULL,
  "expiresAt"    TIMESTAMP(3) NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'pending',
  "usedAt"       TIMESTAMP(3),
  "revokedAt"    TIMESTAMP(3),
  "invitedById"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "user_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_invites_tokenHash_key"
  ON "user_invites" ("tokenHash");

-- Covers the seat count ("live invites of this tenant") and the tenant's
-- invite listing. The unique token hash covers redemption on its own.
CREATE INDEX "user_invites_tenantId_status_expiresAt_idx"
  ON "user_invites" ("tenantId", "status", "expiresAt");
CREATE INDEX "user_invites_tenantId_email_idx"
  ON "user_invites" ("tenantId", "email");
CREATE INDEX "user_invites_roleId_idx" ON "user_invites" ("roleId");
CREATE INDEX "user_invites_tenantUserId_idx"
  ON "user_invites" ("tenantUserId");

ALTER TABLE "user_invites"
  ADD CONSTRAINT "user_invites_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_invites"
  ADD CONSTRAINT "user_invites_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "roles" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "user_invites"
  ADD CONSTRAINT "user_invites_tenantUserId_fkey"
  FOREIGN KEY ("tenantUserId") REFERENCES "tenant_users" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. One membership per login identity per tenant. Already true (an
--    AuthAccount backs at most one actor overall, service-enforced), so
--    this adds no behaviour today; it stops a future invite or
--    direct-create path from writing a second membership row that would
--    double-count a seat.
CREATE UNIQUE INDEX "tenant_users_tenantId_authAccountId_key"
  ON "tenant_users" ("tenantId", "authAccountId");
