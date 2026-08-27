-- Catalog entries for the session-revocation and account-lifecycle routes.
--
-- Each operation exists as a TENANT/SYSTEM pair because a tenant Role can
-- never hold a SYSTEM-scope permission (and vice versa), so one shared code
-- usable by both actor types is not representable -- see the comment above
-- these codes in packages/shared-types/src/permissions.ts. The tenant-side
-- spellings ("auth.session.manage", "admin.account.reset_password") are the
-- ones the authentication specification names.
INSERT INTO "permissions" ("id", "code", "description", "scope")
VALUES
  (md5('auth.session.manage'), 'auth.session.manage', 'Revoke own or managed TenantUser sessions', 'TENANT'),
  (md5('system.session.manage'), 'system.session.manage', 'Revoke own or managed SystemUser sessions', 'SYSTEM'),
  (md5('tenant.user.manage'), 'tenant.user.manage', 'Activate or deactivate TenantUsers of the caller tenant', 'TENANT'),
  (md5('system.user.manage'), 'system.user.manage', 'Activate or deactivate SystemUsers', 'SYSTEM'),
  (md5('admin.account.reset_password'), 'admin.account.reset_password', 'Force a password reset on a TenantUser of the caller tenant', 'TENANT'),
  (md5('system.account.reset_password'), 'system.account.reset_password', 'Force a password reset on a SystemUser', 'SYSTEM')
ON CONFLICT ("code") DO UPDATE
SET
  "description" = EXCLUDED."description",
  "scope" = EXCLUDED."scope";

-- Catalog inserts alone would leave every already-provisioned tenant's
-- TENANT_ADMIN role short of the new codes: role grants are written once,
-- at provisioning time, from the catalog as it stood at that moment
-- (FirstAdminService.grantTenantScopePermissions). Restore that role's
-- invariant -- every TENANT-scope permission -- exactly as the
-- dynamic-tables backfill migration did.
INSERT INTO "role_permissions" ("id", "roleId", "permissionId")
SELECT md5(r."id" || ':' || p."id"), r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."tenantId" IS NOT NULL
  AND r."name" = 'TENANT_ADMIN'
  AND p."scope" = 'TENANT'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
