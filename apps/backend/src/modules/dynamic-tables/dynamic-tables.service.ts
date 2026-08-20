import { Injectable, Logger } from '@nestjs/common';
import { NotImplementedStatus } from '@flexi/shared-types';
import { Knex } from 'knex';
import { TenantKnexService } from '../../tenancy/tenant-knex.service';

const META_TABLES = '_meta_tables';
const META_FIELDS = '_meta_fields';
const META_MIGRATIONS = '_meta_migrations';

/**
 * Sole DDL/metadata owner for the DynamicTables module (AD-2). This story
 * only adds the bootstrap migration that creates the three tenant-schema
 * metadata tables AD-10 pins the shape of -- CAP-1/2/3/4/5/6's real table/
 * field/row CRUD, validation-schema caching (AD-5), and BullMQ DDL queueing
 * (AD-4/AD-6/AD-8) are Story 2+ and deliberately not implemented here.
 */
@Injectable()
export class DynamicTablesService {
  private readonly logger = new Logger(DynamicTablesService.name);

  constructor(private readonly tenantKnexService: TenantKnexService) {}

  getStatus(): NotImplementedStatus {
    return { status: 'not-implemented' };
  }

  /**
   * Bootstrap migration: creates `_meta_tables`, `_meta_fields`, and
   * `_meta_migrations` inside the current tenant's own Postgres schema
   * (never `public`) if they don't already exist, per AD-10's pinned column
   * shapes. Idempotent -- each table creation is guarded by a `hasTable()`
   * check, so invoking this twice for the same tenant schema is a no-op the
   * second time (no error, no duplicate/recreated tables).
   *
   * All three `createTable` calls run inside one transaction (via
   * `TenantKnexService.transaction()`) so a mid-bootstrap failure never
   * leaves the tenant schema with only some of the three tables created.
   *
   * Only creates the tables; `_meta_migrations` is not written to here --
   * that's CAP-5's job, done by Story 2's `ddl-worker.ts`.
   */
  async ensureMetaTables(): Promise<void> {
    await this.tenantKnexService.transaction(async (trx) => {
      const schema = this.tenantKnexService
        .schemaForCurrentTenant()
        .transacting(trx);

      await this.ensureMetaTablesTable(schema);
      await this.ensureMetaFieldsTable(schema);
      await this.ensureMetaMigrationsTable(schema);
    });
  }

  private async ensureMetaTablesTable(schema: Knex.SchemaBuilder): Promise<void> {
    if (await schema.hasTable(META_TABLES)) {
      return;
    }

    this.logger.log(`Creating ${META_TABLES}`);
    await schema.createTable(META_TABLES, (t) => {
      t.string('id').primary();
      t.text('name').notNullable();
      t.text('slug').notNullable().unique();
      t.text('description').nullable();
      t.timestamps(true, true);
    });
  }

  private async ensureMetaFieldsTable(schema: Knex.SchemaBuilder): Promise<void> {
    if (await schema.hasTable(META_FIELDS)) {
      return;
    }

    this.logger.log(`Creating ${META_FIELDS}`);
    await schema.createTable(META_FIELDS, (t) => {
      t.string('id').primary();
      t.string('table_id')
        .notNullable()
        .references('id')
        .inTable(META_TABLES)
        .onDelete('CASCADE');
      t.text('name').notNullable();
      t.text('slug').notNullable();
      // Plain text column, app-validated against FieldDataType from
      // @flexi/shared-types -- not a native Postgres enum (AD-10).
      t.text('data_type').notNullable();
      t.boolean('required').notNullable().defaultTo(false);
      t.string('relation_target_table_id')
        .nullable()
        .references('id')
        .inTable(META_TABLES)
        .onDelete('CASCADE');
      t.jsonb('config').nullable();
      t.timestamps(true, true);
      t.unique(['table_id', 'slug']);
    });
  }

  private async ensureMetaMigrationsTable(
    schema: Knex.SchemaBuilder,
  ): Promise<void> {
    if (await schema.hasTable(META_MIGRATIONS)) {
      return;
    }

    this.logger.log(`Creating ${META_MIGRATIONS}`);
    await schema.createTable(META_MIGRATIONS, (t) => {
      t.string('id').primary();
      t.string('table_id')
        .nullable()
        .references('id')
        .inTable(META_TABLES)
        .onDelete('CASCADE');
      t.text('job_id').notNullable();
      t.text('operation').notNullable();
      t.text('statement').notNullable();
      t.text('status').notNullable();
      t.text('error').nullable();
      // No DB-level default: this table isn't written to by this story
      // (see Design Notes) -- Story 2's ddl-worker.ts sets created_at
      // explicitly on insert, same as every other _meta_ table's app-set id.
      t.timestamp('created_at').notNullable();
      t.timestamp('completed_at').nullable();
    });
  }
}
