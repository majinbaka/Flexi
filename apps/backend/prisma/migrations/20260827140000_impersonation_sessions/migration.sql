-- Issue #194: short-lived, revocable System Admin -> TenantUser delegation.
-- No refresh-token relation exists here on purpose: impersonation is always
-- access-token-only and can never be extended through refresh rotation.

ALTER TABLE "tenant_settings"
  ADD COLUMN "allowSystemImpersonation" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "auth_audit_logs"
  ADD COLUMN "impersonated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "impersonatorId" TEXT;

CREATE INDEX "auth_audit_logs_impersonated_impersonatorId_idx"
  ON "auth_audit_logs" ("impersonated", "impersonatorId");

CREATE TABLE "impersonation_sessions" (
  "id"                  TEXT NOT NULL,
  "tenantId"            TEXT NOT NULL,
  "targetAuthAccountId" TEXT NOT NULL,
  "targetTenantUserId"  TEXT NOT NULL,
  "impersonatorId"      TEXT NOT NULL,
  "expiresAt"           TIMESTAMP(3) NOT NULL,
  "endedAt"             TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "impersonation_sessions_targetTenantUserId_endedAt_idx"
  ON "impersonation_sessions" ("targetTenantUserId", "endedAt");
CREATE INDEX "impersonation_sessions_impersonatorId_endedAt_idx"
  ON "impersonation_sessions" ("impersonatorId", "endedAt");
CREATE INDEX "impersonation_sessions_expiresAt_idx"
  ON "impersonation_sessions" ("expiresAt");

ALTER TABLE "impersonation_sessions"
  ADD CONSTRAINT "impersonation_sessions_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "permissions" ("id", "code", "description", "scope")
VALUES (
  md5('system.impersonation.create'),
  'system.impersonation.create',
  'Create short-lived, audited TenantUser impersonation sessions',
  'SYSTEM'
)
ON CONFLICT ("code") DO UPDATE
SET "description" = EXCLUDED."description", "scope" = EXCLUDED."scope";

-- The demo/bootstrap PlatformAdmin is the existing System Administrator
-- role. Other system roles need an explicit grant, preserving least
-- privilege for support and read-only control-plane roles.
INSERT INTO "role_permissions" ("id", "roleId", "permissionId")
SELECT md5(r."id" || ':' || p."id"), r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" = 'system.impersonation.create'
WHERE r."tenantId" IS NULL
  AND r."name" = 'PlatformAdmin'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
