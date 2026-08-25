-- Adds the tenant-scoped metadata catalog permission introduced with the
-- Dynamic Tables read API contract. Existing installations need this
-- migration; fresh/demo installations receive the same permission from the
-- shared seed catalog.
INSERT INTO "permissions" ("id", "code", "description", "scope")
VALUES (
  md5('dynamic-tables.tables.read'),
  'dynamic-tables.tables.read',
  'Read Dynamic Tables table metadata',
  'TENANT'
)
ON CONFLICT ("code") DO UPDATE
SET
  "description" = EXCLUDED."description",
  "scope" = EXCLUDED."scope";
