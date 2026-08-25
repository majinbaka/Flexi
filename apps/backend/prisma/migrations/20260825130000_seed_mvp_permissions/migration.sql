-- Seed the public MVP permission catalog independently of demo accounts.
-- Permission.code is the catalog's natural key, so this is safe for fresh
-- databases and for production databases that already have some entries.
INSERT INTO "permissions" ("id", "code", "description", "scope")
VALUES
  (md5('auth.me.read'), 'auth.me.read', 'Read own profile via GET /api/auth/me (TenantUser)', 'TENANT'),
  (md5('system.me.read'), 'system.me.read', 'Read own profile via GET /api/auth/me (SystemUser)', 'SYSTEM'),
  (md5('system.tenants.read'), 'system.tenants.read', 'List tenant records and onboarding history as a SystemUser', 'SYSTEM'),
  (md5('system.tenants.onboard'), 'system.tenants.onboard', 'Start tenant onboarding intake as a SystemUser', 'SYSTEM'),
  (md5('system.tenants.setup-link'), 'system.tenants.setup-link', 'Regenerate a tenant setup link as a SystemUser', 'SYSTEM'),
  (md5('dynamic-tables.tables.create'), 'dynamic-tables.tables.create', 'Create Dynamic Tables tables', 'TENANT'),
  (md5('dynamic-tables.fields.update'), 'dynamic-tables.fields.update', 'Add, modify, or remove Dynamic Tables fields', 'TENANT'),
  (md5('dynamic-tables.jobs.read'), 'dynamic-tables.jobs.read', 'Read Dynamic Tables DDL job status', 'TENANT'),
  (md5('dynamic-tables.rows.create'), 'dynamic-tables.rows.create', 'Create Dynamic Tables rows', 'TENANT'),
  (md5('dynamic-tables.rows.read'), 'dynamic-tables.rows.read', 'Read Dynamic Tables rows', 'TENANT'),
  (md5('dynamic-tables.rows.update'), 'dynamic-tables.rows.update', 'Update Dynamic Tables rows', 'TENANT'),
  (md5('dynamic-tables.rows.delete'), 'dynamic-tables.rows.delete', 'Delete Dynamic Tables rows', 'TENANT')
ON CONFLICT ("code") DO UPDATE
SET
  "description" = EXCLUDED."description",
  "scope" = EXCLUDED."scope";
