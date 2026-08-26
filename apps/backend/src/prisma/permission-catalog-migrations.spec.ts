import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { MVP_PERMISSION_CATALOG, PermissionScope } from '@flexi/shared-types';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');

function readMigrationSql(): string {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(MIGRATIONS_DIR, entry.name, 'migration.sql'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

/**
 * Migrations cannot import TypeScript, so the SQL catalog is a hand-kept
 * mirror of `MVP_PERMISSION_CATALOG`. A permission that only ever exists in
 * the TypeScript catalog is seeded into demo databases but missing from
 * every deployed one, which surfaces as a 403 on the route that requires it
 * (issue #28) rather than as a failing build.
 */
describe('MVP permission catalog migrations', () => {
  const sql = readMigrationSql();

  it.each(MVP_PERMISSION_CATALOG.map((permission) => permission.code))(
    'inserts %s into the permissions catalog',
    (code) => {
      expect(sql).toContain(`'${code}'`);
    },
  );

  /**
   * Role grants are written once, at provisioning time, so a TENANT-scope
   * permission introduced after a tenant exists reaches nobody without an
   * explicit `role_permissions` backfill.
   */
  it('backfills tenant role grants for TENANT-scope permissions', () => {
    const hasTenantScopePermission = MVP_PERMISSION_CATALOG.some(
      (permission) => permission.scope === PermissionScope.TENANT,
    );

    expect(hasTenantScopePermission).toBe(true);
    expect(sql).toContain('INSERT INTO "role_permissions"');
  });
});
