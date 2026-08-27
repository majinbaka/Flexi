-- Catalog entries for the Users administration routes (issue #189).
--
-- Seeded ahead of the routes that will require them, matching the
-- convention stated above these codes in
-- packages/shared-types/src/permissions.ts: a permission exists in the
-- catalog before a guard can name it, so seeding and route authorization
-- cannot drift.
--
-- Each operation is a TENANT/SYSTEM pair because a tenant Role can never
-- hold a SYSTEM-scope permission (and vice versa) -- one shared code
-- usable by both actor types is not representable. "tenant.user.invite"
-- is the exception with no counterpart: inviting somebody into the
-- platform itself is not a flow the Users specification describes, and a
-- permission no role can ever hold is worse than an absent one.
INSERT INTO "permissions" ("id", "code", "description", "scope")
VALUES
  (md5('tenant.user.read'), 'tenant.user.read', 'List and read TenantUsers of the caller tenant', 'TENANT'),
  (md5('system.user.read'), 'system.user.read', 'List and read SystemUsers', 'SYSTEM'),
  (md5('tenant.user.invite'), 'tenant.user.invite', 'Invite, resend and revoke invites for the caller tenant', 'TENANT'),
  (md5('tenant.settings.manage'), 'tenant.settings.manage', 'Read and update the caller tenant settings (self-registration policy)', 'TENANT'),
  (md5('system.settings.manage'), 'system.settings.manage', 'Read and update settings of any tenant', 'SYSTEM')
ON CONFLICT ("code") DO UPDATE
SET
  "description" = EXCLUDED."description",
  "scope" = EXCLUDED."scope";

-- Role grants are written once, at provisioning time, from the catalog as
-- it stood at that moment (FirstAdminService.grantTenantScopePermissions),
-- so a catalog insert alone leaves every existing tenant's TENANT_ADMIN
-- short of the new codes. Restore that role's invariant -- every
-- TENANT-scope permission -- exactly as the account-lifecycle and
-- dynamic-tables migrations did.
INSERT INTO "role_permissions" ("id", "roleId", "permissionId")
SELECT md5(r."id" || ':' || p."id"), r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."tenantId" IS NOT NULL
  AND r."name" = 'TENANT_ADMIN'
  AND p."scope" = 'TENANT'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
