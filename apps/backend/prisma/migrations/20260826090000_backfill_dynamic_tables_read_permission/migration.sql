-- Backfills tenant role grants for permissions added to the catalog after a
-- tenant was already provisioned -- `dynamic-tables.tables.read` above all.
--
-- Catalog migrations only insert into `permissions`. Role grants are
-- otherwise written exactly once, at provisioning time
-- (`FirstAdminService.grantTenantScopePermissions` grants every TENANT-scope
-- permission that exists *at that moment*), so every already-provisioned
-- tenant kept a `TENANT_ADMIN` role without the newer codes and started
-- getting 403 on `GET /api/tables` and `GET /api/tables/:tableId` -- and
-- lost the Dynamic Tables nav item, which now requires the same code.

-- 1. `TENANT_ADMIN` is provisioning's full-tenant-access role: restore the
--    invariant it is created with by granting it every TENANT-scope
--    permission in the catalog, exactly as
--    `grantTenantScopePermissions()` would today. This also repairs
--    tenants provisioned before the MVP catalog migration, which are
--    missing the whole `dynamic-tables.*` set rather than just the new
--    read code.
INSERT INTO "role_permissions" ("id", "roleId", "permissionId")
SELECT md5(r."id" || ':' || p."id"), r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."tenantId" IS NOT NULL
  AND r."name" = 'TENANT_ADMIN'
  AND p."scope" = 'TENANT'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 2. Any other tenant role that already holds a `dynamic-tables.*`
--    permission could read rows but not the table metadata needed to reach
--    them, so give it the new read code too. A tenant role can never hold a
--    SYSTEM-scope permission, hence the `tenantId IS NOT NULL` filter; a
--    hand-built role with no Dynamic Tables access at all is deliberately
--    left alone rather than silently widened.
INSERT INTO "role_permissions" ("id", "roleId", "permissionId")
SELECT md5(r."id" || ':' || p."id"), r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE p."code" = 'dynamic-tables.tables.read'
  AND r."tenantId" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "role_permissions" rp
    JOIN "permissions" granted ON granted."id" = rp."permissionId"
    WHERE rp."roleId" = r."id"
      AND granted."scope" = 'TENANT'
      AND granted."code" LIKE 'dynamic-tables.%'
  )
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
