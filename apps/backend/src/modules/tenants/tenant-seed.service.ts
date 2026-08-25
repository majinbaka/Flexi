import { Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService } from '../../tenancy/tenant-knex.service';
import { TenantContext } from '../../tenancy/tenant-context';

const TABLE_SYSTEM_SETTINGS = 'system_settings';
const TABLE_STATUSES = 'statuses';
const TABLE_ROLES = 'roles';
const TABLE_PERMISSIONS = 'permissions';
const TABLE_ROLE_PERMISSIONS = 'role_permissions';
const TABLE_CATEGORIES = 'categories';
const TABLE_NOTIFICATION_TEMPLATES = 'notification_templates';

interface DefaultSystemSetting {
  key: string;
  value: string;
}

interface DefaultStatus {
  name: string;
  description: string;
}

interface DefaultRole {
  name: string;
  description: string;
}

interface DefaultPermission {
  code: string;
  description: string;
}

interface DefaultCategory {
  name: string;
  description: string;
}

interface DefaultNotificationTemplate {
  code: string;
  subject: string;
  body: string;
}

const DEFAULT_SYSTEM_SETTINGS: DefaultSystemSetting[] = [
  { key: 'locale', value: 'en-US' },
  { key: 'timezone', value: 'UTC' },
  { key: 'base_currency', value: 'USD' },
  { key: 'feature.dynamic_tables_enabled', value: 'true' },
];

const DEFAULT_STATUSES: DefaultStatus[] = [
  { name: 'Draft', description: 'Work has not started yet.' },
  { name: 'In Review', description: 'Work is under review.' },
  { name: 'Active', description: 'Work is active/in progress.' },
  { name: 'Archived', description: 'Work is complete and archived.' },
];

const DEFAULT_ROLES: DefaultRole[] = [
  {
    name: 'Tenant Admin',
    description: 'Full administrative access to the tenant workspace.',
  },
  {
    name: 'Manager',
    description: 'Can manage business entities without administrative access.',
  },
  { name: 'Member', description: 'Read-only access to the tenant workspace.' },
];

const DEFAULT_PERMISSIONS: DefaultPermission[] = [
  { code: 'entities.create', description: 'Create business entity records.' },
  { code: 'entities.read', description: 'Read business entity records.' },
  { code: 'entities.update', description: 'Update business entity records.' },
  { code: 'entities.delete', description: 'Delete business entity records.' },
  { code: 'settings.manage', description: 'Manage tenant system settings.' },
  {
    code: 'roles.manage',
    description: 'Manage roles and permission assignments.',
  },
  { code: 'users.manage', description: 'Manage tenant user accounts.' },
];

/**
 * Default role -> permission-code matrix (spec Design Notes): "Tenant
 * Admin" gets every seeded permission code, "Manager" gets create/read/
 * update on business entities (no admin/settings permissions), "Member"
 * gets read-only.
 */
const DEFAULT_ROLE_PERMISSIONS: Array<{
  roleName: string;
  permissionCode: string;
}> = [
  ...DEFAULT_PERMISSIONS.map((permission) => ({
    roleName: 'Tenant Admin',
    permissionCode: permission.code,
  })),
  { roleName: 'Manager', permissionCode: 'entities.create' },
  { roleName: 'Manager', permissionCode: 'entities.read' },
  { roleName: 'Manager', permissionCode: 'entities.update' },
  { roleName: 'Member', permissionCode: 'entities.read' },
];

// Validated at module load, not only inside seedRolePermissions() at
// provisioning time -- a future edit to DEFAULT_ROLES/DEFAULT_PERMISSIONS/
// DEFAULT_ROLE_PERMISSIONS that goes out of sync fails fast at import
// (test/app boot), not by breaking every tenant onboarding attempt.
(() => {
  const roleNames = new Set(DEFAULT_ROLES.map((role) => role.name));
  const permissionCodes = new Set(
    DEFAULT_PERMISSIONS.map((permission) => permission.code),
  );
  for (const pair of DEFAULT_ROLE_PERMISSIONS) {
    if (
      !roleNames.has(pair.roleName) ||
      !permissionCodes.has(pair.permissionCode)
    ) {
      throw new Error(
        `DEFAULT_ROLE_PERMISSIONS references an unknown role/permission pair: ${pair.roleName}/${pair.permissionCode}`,
      );
    }
  }
})();

const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { name: 'General', description: 'General-purpose, uncategorized entities.' },
  { name: 'Operations', description: 'Day-to-day operational entities.' },
  {
    name: 'Administrative',
    description: 'Administrative and back-office entities.',
  },
];

const DEFAULT_NOTIFICATION_TEMPLATES: DefaultNotificationTemplate[] = [
  {
    code: 'WELCOME_SETUP_INVITE',
    subject: 'Welcome -- finish setting up your workspace',
    body: 'Use the link below to finish setting up your account.',
  },
  {
    code: 'PASSWORD_RESET_REQUEST',
    subject: 'Reset your password',
    body: 'Use the link below to reset your password.',
  },
  {
    code: 'WORKSPACE_LIMIT_WARNING',
    subject: 'Your workspace is approaching a limit',
    body: 'Your workspace is approaching one of its usage limits.',
  },
];

/**
 * Creates the tenant-schema business-defaults/RBAC data model (Story 2.3):
 * `system_settings`, `statuses`, `roles`, `permissions`, `role_permissions`,
 * `categories`, `notification_templates`. Mirrors
 * `DynamicTablesService.ensureMetaTables()`'s idempotent bootstrap-migration
 * pattern: all table creation and row inserts run inside one
 * `TenantKnexService.transaction()`, DDL is guarded by `hasTable()`, and row
 * inserts use `.onConflict(...).ignore()` on each table's natural key so a
 * replay never duplicates rows or throws.
 *
 * Deliberately separate from `DynamicTablesService` (spec Boundaries: never
 * reuse the `_meta_` prefix or that module's tables) -- this is tenant
 * business data, not dynamic-tables bookkeeping metadata.
 */
@Injectable()
export class TenantSeedService {
  private readonly logger = new Logger(TenantSeedService.name);

  constructor(
    private readonly tenantKnexService: TenantKnexService,
    private readonly tenantContext: TenantContext,
  ) {}

  /**
   * Runs inside a caller-supplied CLS context (`cls.runWith({ tenantId,
   * schema }, ...)`), same as `DynamicTablesService.ensureMetaTables()`.
   * Everything -- table creation and row inserts -- happens inside one
   * transaction so a mid-way failure rolls back cleanly with no partial
   * tables/rows persisted (spec I/O matrix).
   */
  async bootstrapSeed(): Promise<void> {
    await this.tenantKnexService.transaction(async (trx) => {
      // Same fresh-builder-per-statement discipline as ensureMetaTables():
      // a Knex.SchemaBuilder is a mutable, single-use thenable -- reusing
      // one instance across two awaited statements replays its entire
      // prior statement history against Postgres.
      const buildSchema = () =>
        this.tenantKnexService.schemaForCurrentTenant().transacting(trx);

      // AD-3: every DML statement is still built from
      // tenantKnexService.forCurrentTenant(), even inside a transaction --
      // `.transacting(trx)` scopes it, matching ddl-worker.ts's
      // `metaTable()` helper.
      const table = (name: string) =>
        this.tenantKnexService.forCurrentTenant().table(name).transacting(trx);

      const qualifiedRoles = `${this.tenantContext.schema}.${TABLE_ROLES}`;
      const qualifiedPermissions = `${this.tenantContext.schema}.${TABLE_PERMISSIONS}`;

      await this.ensureSystemSettingsTable(buildSchema);
      await this.ensureStatusesTable(buildSchema);
      await this.ensureRolesTable(buildSchema);
      await this.ensurePermissionsTable(buildSchema);
      await this.ensureRolePermissionsTable(
        buildSchema,
        qualifiedRoles,
        qualifiedPermissions,
      );
      await this.ensureCategoriesTable(buildSchema);
      await this.ensureNotificationTemplatesTable(buildSchema);

      await this.seedSystemSettings(table);
      await this.seedStatuses(table);
      const roleIdsByName = await this.seedRoles(table);
      const permissionIdsByCode = await this.seedPermissions(table);
      await this.seedRolePermissions(table, roleIdsByName, permissionIdsByCode);
      await this.seedCategories(table);
      await this.seedNotificationTemplates(table);
    });
  }

  // ------------------------------------------------------------------
  // Table creation (idempotent via hasTable())
  // ------------------------------------------------------------------

  private async ensureSystemSettingsTable(
    buildSchema: () => Knex.SchemaBuilder,
  ): Promise<void> {
    if (await buildSchema().hasTable(TABLE_SYSTEM_SETTINGS)) {
      return;
    }

    this.logger.log(`Creating ${TABLE_SYSTEM_SETTINGS}`);
    await buildSchema().createTable(TABLE_SYSTEM_SETTINGS, (t) => {
      t.string('id').primary();
      t.text('key').notNullable().unique();
      t.text('value').notNullable();
      t.timestamps(true, true);
    });
  }

  private async ensureStatusesTable(
    buildSchema: () => Knex.SchemaBuilder,
  ): Promise<void> {
    if (await buildSchema().hasTable(TABLE_STATUSES)) {
      return;
    }

    this.logger.log(`Creating ${TABLE_STATUSES}`);
    await buildSchema().createTable(TABLE_STATUSES, (t) => {
      t.string('id').primary();
      t.text('name').notNullable().unique();
      t.text('description').nullable();
      t.timestamps(true, true);
    });
  }

  private async ensureRolesTable(
    buildSchema: () => Knex.SchemaBuilder,
  ): Promise<void> {
    if (await buildSchema().hasTable(TABLE_ROLES)) {
      return;
    }

    this.logger.log(`Creating ${TABLE_ROLES}`);
    await buildSchema().createTable(TABLE_ROLES, (t) => {
      t.string('id').primary();
      t.text('name').notNullable().unique();
      t.text('description').nullable();
      t.timestamps(true, true);
    });
  }

  private async ensurePermissionsTable(
    buildSchema: () => Knex.SchemaBuilder,
  ): Promise<void> {
    if (await buildSchema().hasTable(TABLE_PERMISSIONS)) {
      return;
    }

    this.logger.log(`Creating ${TABLE_PERMISSIONS}`);
    await buildSchema().createTable(TABLE_PERMISSIONS, (t) => {
      t.string('id').primary();
      t.text('code').notNullable().unique();
      t.text('description').nullable();
      t.timestamps(true, true);
    });
  }

  private async ensureRolePermissionsTable(
    buildSchema: () => Knex.SchemaBuilder,
    qualifiedRoles: string,
    qualifiedPermissions: string,
  ): Promise<void> {
    if (await buildSchema().hasTable(TABLE_ROLE_PERMISSIONS)) {
      return;
    }

    this.logger.log(`Creating ${TABLE_ROLE_PERMISSIONS}`);
    await buildSchema().createTable(TABLE_ROLE_PERMISSIONS, (t) => {
      t.string('id').primary();
      t.string('role_id')
        .notNullable()
        .references('id')
        .inTable(qualifiedRoles)
        .onDelete('CASCADE');
      t.string('permission_id')
        .notNullable()
        .references('id')
        .inTable(qualifiedPermissions)
        .onDelete('CASCADE');
      t.timestamps(true, true);
      t.unique(['role_id', 'permission_id']);
    });
  }

  private async ensureCategoriesTable(
    buildSchema: () => Knex.SchemaBuilder,
  ): Promise<void> {
    if (await buildSchema().hasTable(TABLE_CATEGORIES)) {
      return;
    }

    this.logger.log(`Creating ${TABLE_CATEGORIES}`);
    await buildSchema().createTable(TABLE_CATEGORIES, (t) => {
      t.string('id').primary();
      t.text('name').notNullable().unique();
      t.text('description').nullable();
      t.timestamps(true, true);
    });
  }

  private async ensureNotificationTemplatesTable(
    buildSchema: () => Knex.SchemaBuilder,
  ): Promise<void> {
    if (await buildSchema().hasTable(TABLE_NOTIFICATION_TEMPLATES)) {
      return;
    }

    this.logger.log(`Creating ${TABLE_NOTIFICATION_TEMPLATES}`);
    await buildSchema().createTable(TABLE_NOTIFICATION_TEMPLATES, (t) => {
      t.string('id').primary();
      t.text('code').notNullable().unique();
      t.text('subject').notNullable();
      t.text('body').notNullable();
      t.timestamps(true, true);
    });
  }

  // ------------------------------------------------------------------
  // Row seeding (idempotent via onConflict(...).ignore())
  // ------------------------------------------------------------------

  private async seedSystemSettings(
    table: (name: string) => Knex.QueryBuilder,
  ): Promise<void> {
    await table(TABLE_SYSTEM_SETTINGS)
      .insert(
        DEFAULT_SYSTEM_SETTINGS.map((setting) => ({
          id: this.rowId('setting', setting.key),
          key: setting.key,
          value: setting.value,
        })),
      )
      .onConflict('key')
      .ignore();
  }

  private async seedStatuses(
    table: (name: string) => Knex.QueryBuilder,
  ): Promise<void> {
    await table(TABLE_STATUSES)
      .insert(
        DEFAULT_STATUSES.map((status) => ({
          id: this.rowId('status', status.name),
          name: status.name,
          description: status.description,
        })),
      )
      .onConflict('name')
      .ignore();
  }

  /** Returns every seeded role's id keyed by name (existing or newly inserted), for role_permissions linking. */
  private async seedRoles(
    table: (name: string) => Knex.QueryBuilder,
  ): Promise<Map<string, string>> {
    await table(TABLE_ROLES)
      .insert(
        DEFAULT_ROLES.map((role) => ({
          id: this.rowId('role', role.name),
          name: role.name,
          description: role.description,
        })),
      )
      .onConflict('name')
      .ignore();

    const rows: Array<{ id: string; name: string }> = await table(TABLE_ROLES)
      .whereIn(
        'name',
        DEFAULT_ROLES.map((role) => role.name),
      )
      .select('id', 'name');

    return new Map(rows.map((row) => [row.name, row.id]));
  }

  /** Returns every seeded permission's id keyed by code (existing or newly inserted), for role_permissions linking. */
  private async seedPermissions(
    table: (name: string) => Knex.QueryBuilder,
  ): Promise<Map<string, string>> {
    await table(TABLE_PERMISSIONS)
      .insert(
        DEFAULT_PERMISSIONS.map((permission) => ({
          id: this.rowId('permission', permission.code),
          code: permission.code,
          description: permission.description,
        })),
      )
      .onConflict('code')
      .ignore();

    const rows: Array<{ id: string; code: string }> = await table(
      TABLE_PERMISSIONS,
    )
      .whereIn(
        'code',
        DEFAULT_PERMISSIONS.map((permission) => permission.code),
      )
      .select('id', 'code');

    return new Map(rows.map((row) => [row.code, row.id]));
  }

  private async seedRolePermissions(
    table: (name: string) => Knex.QueryBuilder,
    roleIdsByName: Map<string, string>,
    permissionIdsByCode: Map<string, string>,
  ): Promise<void> {
    const rows = DEFAULT_ROLE_PERMISSIONS.map((pair) => {
      const roleId = roleIdsByName.get(pair.roleName);
      const permissionId = permissionIdsByCode.get(pair.permissionCode);
      if (!roleId || !permissionId) {
        throw new Error(
          `Bootstrap seed permission matrix references an unknown role/permission pair: ${pair.roleName}/${pair.permissionCode}`,
        );
      }
      return {
        id: this.rowId('role-permission', `${roleId}:${permissionId}`),
        role_id: roleId,
        permission_id: permissionId,
      };
    });

    await table(TABLE_ROLE_PERMISSIONS)
      .insert(rows)
      .onConflict(['role_id', 'permission_id'])
      .ignore();
  }

  private async seedCategories(
    table: (name: string) => Knex.QueryBuilder,
  ): Promise<void> {
    await table(TABLE_CATEGORIES)
      .insert(
        DEFAULT_CATEGORIES.map((category) => ({
          id: this.rowId('category', category.name),
          name: category.name,
          description: category.description,
        })),
      )
      .onConflict('name')
      .ignore();
  }

  private async seedNotificationTemplates(
    table: (name: string) => Knex.QueryBuilder,
  ): Promise<void> {
    await table(TABLE_NOTIFICATION_TEMPLATES)
      .insert(
        DEFAULT_NOTIFICATION_TEMPLATES.map((template) => ({
          id: this.rowId('notification-template', template.code),
          code: template.code,
          subject: template.subject,
          body: template.body,
        })),
      )
      .onConflict('code')
      .ignore();
  }

  /**
   * Deterministic id for a seeded row, derived from its natural key rather
   * than randomUUID() -- keeps a replay's insert payload byte-for-byte
   * identical to the first run, which is irrelevant to onConflict().ignore()
   * (natural-key conflict alone is enough) but keeps ids stable/inspectable
   * across environments seeded from the same defaults.
   */
  private rowId(kind: string, naturalKey: string): string {
    const slug = naturalKey
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    return `seed-${kind}-${slug}`;
  }
}
