---
title: 'Tenant-schema metadata tables and DynamicTables module skeleton'
type: 'feature'
created: '2026-08-20'
status: 'done'
baseline_revision: '1e1888b9516bb867b2ed4a840cd7bfa4a4926679'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      hasTable()-then-createTable() in the bootstrap migration is not atomic,
      so two concurrent bootstrap calls for the same brand-new tenant schema
      can both pass the hasTable guard and race on createTable.
    evidence: |-
      apps/backend/src/modules/dynamic-tables/dynamic-tables.service.ts's
      ensureMetaTables() checks hasTable() then calls createTable() as two
      separate awaited steps with no advisory lock or serializable
      transaction isolation between them -- a second concurrent invocation
      (e.g. two requests racing to bootstrap the same tenant's first table)
      can observe hasTable()=false in both and both attempt createTable(),
      with the loser throwing an unhandled duplicate-relation error.
    location: >-
      apps/backend/src/modules/dynamic-tables/dynamic-tables.service.ts
    severity: low
  - summary: >-
      No index on _meta_fields.relation_target_table_id or on
      _meta_migrations.table_id/status/job_id.
    evidence: |-
      Story 2+ (CAP-4 relation resolution, CAP-5/CAP-6 migration-record
      queries by status/job_id) will query these columns; without an index,
      those lookups sequential-scan. No query against these columns exists
      yet in this story's scope, so premature to add now, but worth revisiting
      once Story 2's actual query shapes are known.
    location: >-
      apps/backend/src/modules/dynamic-tables/dynamic-tables.service.ts
    severity: low
  - summary: >-
      _meta_migrations.status/operation have no CHECK constraint or enum
      validation, unlike _meta_fields.data_type which is at least documented
      as app-validated against FieldDataType.
    evidence: |-
      Story 2's ddl-worker.ts is what actually defines and writes the
      allowed status/operation value sets (per this story's own Design
      Notes -- _meta_migrations isn't written to yet). Adding a CHECK
      constraint now would mean guessing at values not yet defined.
    location: >-
      apps/backend/src/modules/dynamic-tables/dynamic-tables.service.ts
    severity: low
  - summary: >-
      sanitizeIdentifier()'s allowlist regex accepts reserved Postgres
      keywords (e.g. select, table, user) as syntactically valid identifiers.
    evidence: |-
      IDENTIFIER_PATTERN only checks character shape, not keyword collision.
      This function has zero production call sites in this story (wiring
      is Story 2's job per this spec's own Never section), so the practical
      exposure is nil today, but Story 2's CAP-1 rejection path should
      account for reserved-keyword identifiers when it wires this in --
      likely via correctly quoting all generated identifiers rather than
      rejecting keywords outright, since Postgres allows quoted keyword
      identifiers.
    location: >-
      apps/backend/src/tenancy/sanitize-identifier.ts
    severity: low
  - summary: >-
      ensureMetaTables() has no error handling around its three sequential
      ensure*Table calls, so a mid-bootstrap failure gives no indication of
      which of the three tables' creation actually failed.
    evidence: |-
      apps/backend/src/modules/dynamic-tables/dynamic-tables.service.ts's
      ensureMetaTables() awaits ensureMetaTablesTable/ensureMetaFieldsTable/
      ensureMetaMigrationsTable in sequence inside one transaction with no
      try/catch around any of them; the transaction's own rollback already
      prevents a partially-created _meta_* set (the main risk), but the
      raw Knex/pg error that propagates on failure doesn't identify which
      of the three tables' create statement was the one that failed,
      making diagnosis slower than a wrapped, contextualized error would be.
    location: >-
      apps/backend/src/modules/dynamic-tables/dynamic-tables.service.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** Tenant admins have no storage substrate for dynamic tables yet. The `DynamicTables` module is still a stub, there is no `sanitizeIdentifier()` guard for user-supplied identifiers, and no tenant-schema tables exist to hold table/field/migration metadata (AD-1, AD-10).

**Approach:** Add a `sanitizeIdentifier()` utility beside `resolve-tenant-schema.ts`, then a bootstrap Knex migration function that creates `_meta_tables`, `_meta_fields`, and `_meta_migrations` inside the current tenant schema (via a new `TenantKnexService.schemaForCurrentTenant()`), and supersede the `DynamicTables` stub module in place with real scaffolding that can run the bootstrap.

## Boundaries & Constraints

**Always:** Table/column shapes match AD-10 exactly (`_meta_tables`, `_meta_fields`, `_meta_migrations` — see Code Map for pinned columns). `sanitizeIdentifier()` lives in `apps/backend/src/tenancy/`, alongside `resolve-tenant-schema.ts`, using the same allowlist regex `/^[A-Za-z_][\w$]*$/` and `NAMEDATALEN`-capped length (63 bytes) — this is the one shared function; no second identifier check anywhere in this module. All schema DDL is built from `TenantKnexService` (AD-3) — its new `schemaForCurrentTenant()` for DDL (schema builder), its existing `forCurrentTenant()` for DML (query builder) — no raw `pg` client, no Prisma. `_meta_` table-name prefix is reserved (AD-10's last bullet): document this as a rule for Story 2's CAP-1 to enforce, but do not build the rejection path itself here (no create-table endpoint exists yet this story). `data_type` on `_meta_fields` is a plain `text` column, app-validated against `FieldDataType` from `@flexi/shared-types` (already defined at `packages/shared-types/src/enums.ts:7`) — not a native Postgres enum. Metadata ids are cuids, matching every existing Prisma model's id convention.

**Block If:** None — scope, shapes, and locations are fully pinned by AD-1/AD-3/AD-10 and stories.yaml's entry; no undecided branches remain for this story.

**Never:** Do not implement CAP-1/CAP-2 table/field CRUD, the BullMQ DDL queue, or `ddl-worker.ts` — that is Story 2. Do not touch the Prisma `DynamicTable`/`DynamicField` models or remove them — that is Story 7 (confirmed zero live Prisma-client usage of them today, but removal is out of scope here). Do not add `Tenant.dynamicTableGuardrails` — that is Story 5. Do not build `tables.controller.ts`/`rows.controller.ts` real routes — the controller stays a stub for now, only the module/service scaffolding changes. Do not invent a new tenant-schema-provisioning path — this story assumes a tenant's own Postgres schema already exists (SPEC.md Non-goals) and only creates the three `_meta_*` tables inside it once invoked.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid identifier | `sanitizeIdentifier('my_table_1')` | Returns `'my_table_1'` unchanged | No error expected |
| Injection attempt | `sanitizeIdentifier('a"; DROP TABLE users; --')` | Throws | Rejected before reaching any DDL/DML string |
| Over-length identifier | `sanitizeIdentifier('a'.repeat(64))` | Throws | Rejected — exceeds `NAMEDATALEN` (63 usable bytes) |
| Boundary-length identifier | `sanitizeIdentifier('a'.repeat(63))` | Returns unchanged | No error expected |
| Reserved prefix passed through sanitizeIdentifier itself | `sanitizeIdentifier('_meta_tables')` | Returns unchanged (sanitizeIdentifier only checks character-safety/length, not the `_meta_` business rule — that check belongs to Story 2's CAP-1, per Boundaries) | No error expected |
| Bootstrap migration run twice for same tenant schema | Bootstrap fn invoked when `_meta_tables` already exists | Idempotent: no error, no duplicate tables (`CREATE TABLE IF NOT EXISTS` or existence check) | No error expected |

</intent-contract>

## Code Map

- `apps/backend/src/tenancy/resolve-tenant-schema.ts` -- existing sibling; `sanitizeIdentifier()` goes in a new file next to this one, same allowlist regex (`/^[A-Za-z_][\w$]*$/`) and 63-byte `MAX_SCHEMA_NAME_LENGTH`-style cap, reused/duplicated as a local constant since it validates table/column identifiers, not schema names.
- `apps/backend/src/tenancy/resolve-tenant-schema.spec.ts` -- style precedent for the new `sanitize-identifier.spec.ts`: `describe`/`it.each` adversarial-input table, exact error-message regex assertions, explicit boundary-length cases (63 vs 64 chars).
- `apps/backend/src/tenancy/tenant-knex.service.ts:26-65` -- `forCurrentTenant(): Knex.QueryBuilder` returns `this.knex.withSchema(tenantContext.schema)`, built for DML (query building), not DDL — `QueryBuilder.withSchema()` has no `.schema` property (verified against installed `knex@3.3.0`). DDL (`CREATE TABLE`) needs the schema builder instead: `knex.schema.withSchema(schemaName)`, a separate entry point on the raw `Knex` instance. `TenantKnexService` must gain a second method for this — e.g. `schemaForCurrentTenant(): Knex.SchemaBuilder` returning `this.knex.schema.withSchema(this.tenantContext.schema)` — added next to `forCurrentTenant()`, same lazy-pool instance, same `tenantContext.schema` source. This keeps `TenantKnexService` (not `DynamicTablesService`) as the one place that reads the raw `knex` instance, consistent with its existing role.
- `apps/backend/src/tenancy/tenancy.module.ts` -- `@Global()` module already exports `TenantContext`/`TenantKnexService`; `DynamicTablesModule` does NOT need to import `TenancyModule` to inject these.
- `apps/backend/src/modules/dynamic-tables/dynamic-tables.module.ts` -- current stub (`controllers: [DynamicTablesController], providers: [DynamicTablesService]`); supersede in place, keep same class name/file location per spine's "Structural Seed."
- `apps/backend/src/modules/dynamic-tables/dynamic-tables.service.ts` -- current stub (`getStatus()` returning `NotImplementedStatus`); add the bootstrap-migration method here (this module's sole DDL/metadata owner per AD-2), keep `getStatus()` or fold its behavior in — implementer's call as long as no route breaks.
- `apps/backend/src/modules/dynamic-tables/dynamic-tables.controller.ts` -- current stub single `GET /api/dynamic-tables` route; leave route behavior working (do not remove without replacement) since Story 2 builds the real routes.
- `apps/backend/src/app.module.ts:13,37` -- `DynamicTablesModule` already imported and registered; no change needed here.
- `packages/shared-types/src/enums.ts:7` -- `FieldDataType` enum already defined (`STRING`, `TEXT`, `NUMBER`, `BOOLEAN`, `DATE`, `DATETIME`, `JSON`, `EMAIL`, `URL`, `SELECT`, `RELATION`) — reuse as-is, do not redefine.
- `apps/backend/prisma/schema.prisma:198-237` -- existing `DynamicTable`/`DynamicField` Prisma models (read-only reference for AD-10's column-naming mirror); confirmed zero live `prisma.dynamicTable`/`prisma.dynamicField` client usage anywhere in `apps/backend/src` or `apps/frontend` today — do not modify, Story 7's concern.
- `apps/backend/src/tenancy/tenant-knex.service.spec.ts` -- existing test pattern for services wrapping `TenantKnexService`; mirror its mocking approach for the new bootstrap-migration test.

## Tasks & Acceptance

**Execution:**
- `apps/backend/src/tenancy/sanitize-identifier.ts` -- create `sanitizeIdentifier(name: string): string` using the same allowlist regex and length cap as `resolveTenantSchema()` -- shared single validator for all user-supplied table/column names per AD-3, so no second sanitizer gets written independently later.
- `apps/backend/src/tenancy/sanitize-identifier.spec.ts` -- unit tests covering the I/O matrix's identifier rows (valid, injection attempt, over-length, boundary-length), mirroring `resolve-tenant-schema.spec.ts`'s style.
- `apps/backend/src/tenancy/tenant-knex.service.ts` -- add `schemaForCurrentTenant(): Knex.SchemaBuilder` (returns `this.knex.schema.withSchema(this.tenantContext.schema)`), alongside the existing `forCurrentTenant()`, so DDL callers get a schema-scoped `SchemaBuilder` the same way DML callers get a schema-scoped `QueryBuilder`. Also add `transaction<T>(fn: (trx: Knex.Transaction) => Promise<T>): Promise<T>` (returns `this.knex.transaction(fn)`) -- the one place `DynamicTablesService` can get a transaction without touching the raw `knex` instance itself (AD-3).
- `apps/backend/src/tenancy/tenant-knex.service.spec.ts` -- extend with a test for `schemaForCurrentTenant()` mirroring the existing `forCurrentTenant()` coverage (schema-scoping applied, no live connection required), plus a test that `transaction()` delegates to the underlying `knex.transaction()`.
- `apps/backend/src/modules/dynamic-tables/dynamic-tables.service.ts` -- add a bootstrap-migration method (e.g. `ensureMetaTables()`) that, using `TenantKnexService.schemaForCurrentTenant()`, creates `_meta_tables`, `_meta_fields`, `_meta_migrations` per AD-10's pinned column shapes if they don't already exist (idempotent, e.g. guard each `createTable` with a `hasTable` check) -- this is the "bootstrap migration" stories.yaml Story 1 calls for. The three `createTable` calls run inside one `schema.transaction` or a single connection-scoped transaction (Knex's `SchemaBuilder` supports `.transacting(trx)` — wrap the three calls with `knex.transaction()` at the point they're issued) so a mid-bootstrap failure never leaves the tenant schema with only some of the three tables created. Every FK column (`_meta_fields.table_id`, `_meta_fields.relation_target_table_id`, `_meta_migrations.table_id`) sets `.onDelete('CASCADE')` -- deleting a `_meta_tables` row is expected to cascade-delete its own fields/migration-log rows (a table's metadata row and its field/migration records have no independent lifecycle), consistent with the existing Prisma `DynamicTable`/`DynamicField`/`onDelete: Cascade` convention this module supersedes (`schema.prisma:207`, `:230-231`).
- `apps/backend/src/modules/dynamic-tables/dynamic-tables.service.spec.ts` -- unit test for the bootstrap method: verifies correct table/column shape is requested via a mocked `TenantKnexService.schemaForCurrentTenant()` for **all three tables** (`_meta_tables`, `_meta_fields`, `_meta_migrations` -- not just the first), including that each FK column's `.onDelete('CASCADE')` was requested and `_meta_fields`' `unique(['table_id','slug'])` was requested; and that a second invocation is a no-op (idempotency edge case from the I/O matrix, exercised via a mocked `hasTable` returning `true`).
- `apps/backend/src/modules/dynamic-tables/dynamic-tables.module.ts` -- confirm/adjust provider wiring stays valid after the service gains the bootstrap method (no structural change expected beyond what's already there).

**Acceptance Criteria:**
- Given a tenant schema with no `_meta_*` tables, when the bootstrap-migration method runs, then `_meta_tables`, `_meta_fields`, and `_meta_migrations` are created inside that tenant's schema (never `public`) with AD-10's pinned columns, via `TenantKnexService.schemaForCurrentTenant()` only, all three inside one transaction.
- Given a tenant schema where the `_meta_*` tables already exist, when the bootstrap-migration method runs again, then it completes without error and does not attempt to recreate/duplicate the tables.
- Given a user-supplied identifier containing SQL-unsafe characters or exceeding 63 bytes, when `sanitizeIdentifier()` is called with it, then it throws before the value could reach any DDL/DML statement.
- Given the existing `GET /api/dynamic-tables` stub route, when this story's changes are applied, then the route still responds successfully (no regression to the placeholder behavior Story 2 will later replace).
- Given `_meta_fields.table_id`, `_meta_fields.relation_target_table_id`, and `_meta_migrations.table_id`, when the bootstrap creates these FK columns, then each specifies `.onDelete('CASCADE')`.

## Spec Change Log

### 2026-08-20 — Review pass 1 (bad_spec loopback)

**Triggering findings:** (1) no `onDelete` cascade behavior specified for `_meta_fields.table_id`, `_meta_fields.relation_target_table_id`, `_meta_migrations.table_id` -- an unhandled FK constraint error on any future delete of a `_meta_tables` row; (2) the three `createTable` calls in the bootstrap migration run without a shared transaction -- a mid-bootstrap crash/connection-drop leaves the tenant schema with only some of the three `_meta_*` tables and no automatic recovery.

**Amended:** Tasks & Acceptance now requires `.onDelete('CASCADE')` on all three FK columns (mirroring the superseded Prisma models' own `onDelete: Cascade` convention) and requires the three `createTable` calls to run inside one transaction via a new `TenantKnexService.transaction()` passthrough. Design Notes' code example updated to show the transaction-wrapped, cascade-annotated shape. Acceptance Criteria gained a cascade-behavior row. The `dynamic-tables.service.spec.ts` task now explicitly requires column-shape assertions for **all three** tables (not just `_meta_tables`), closing a review-confirmed verification gap where two of the three `createTable` column-builder callbacks were never invoked by any test.

**Known-bad state avoided:** a first-cut implementation that (a) throws an unhandled Postgres FK-violation error the first time anything deletes a `_meta_tables` row once Story 2+ adds delete support, and (b) can leave a tenant schema in a permanently partial state (e.g. only `_meta_tables` exists) if the process crashes mid-bootstrap, with no code path to detect or repair that state short of manually dropping and re-running.

**KEEP:** The overall `_meta_tables`/`_meta_fields`/`_meta_migrations` column shapes (all four reviewers confirmed these match AD-10 correctly) — do not change primary-key, non-FK column, or the `unique(['table_id','slug'])` shape on re-derivation. The `hasTable()`-guarded idempotency pattern is correct and must be preserved. `sanitizeIdentifier()`'s own implementation (regex, length cap, error messages) is correct as-is and needs no change — it was correctly scoped to have no production caller yet (Story 2's job), which is intentional, not a gap. `schemaForCurrentTenant()`'s resolution of the Knex `.schema` API gap is correct and must be preserved verbatim. Keep `getStatus()`'s stub route working unchanged.

## Review Triage Log

### 2026-08-20 — Review pass 1
- intent_gap: 0
- bad_spec: 2 (medium 2, low 0)
- patch: 0 (moot: bad_spec findings present, code will be re-derived)
- defer: 4 (low 4)
- reject: 13
- addressed_findings:
  - `[medium]` `[bad_spec]` No `onDelete` cascade behavior on `_meta_fields.table_id`, `_meta_fields.relation_target_table_id`, `_meta_migrations.table_id` -- spec amended to require `.onDelete('CASCADE')` on all three FK columns.
  - `[medium]` `[bad_spec]` Three `createTable` calls not transaction-wrapped -- spec amended to require a `TenantKnexService.transaction()` passthrough and transaction-wrapped bootstrap.

### 2026-08-20 — Review pass 2
- intent_gap: 0
- bad_spec: 0
- patch: 0
- defer: 1 (low 1; the race-condition and no-index/no-CHECK/reserved-keyword items re-surfaced by this pass duplicate items already deferred in pass 1 and were not re-added)
- reject: 16
- addressed_findings:
  - none

Verification-gap reviewer confirmed (via mutation testing) that both pass-1 bad_spec fixes are genuinely covered by tests: reverting `.onDelete('CASCADE')` on `_meta_fields.table_id` causes the new column-shape test to fail as expected; the transaction-wrap assertions exercise a `TenantKnexService` mock whose `transaction()` genuinely invokes its callback, not a no-op stub.

## Design Notes

`_meta_migrations` is created by this story (AD-10 pins its shape) but not yet written to — CAP-5's actual migration-record-writing happens in Story 2's `ddl-worker.ts`. This story only needs the table to exist with the right columns; populating it is out of scope here.

Confirmed against the installed `knex@3.3.0`: `QueryBuilder.withSchema()` (what `forCurrentTenant()` returns) has no `.schema` property — schema-scoped DDL instead goes through the separate `knex.schema.withSchema(name)` entry point, which is why `TenantKnexService` gains `schemaForCurrentTenant()`. Example:

```ts
// tenant-knex.service.ts
schemaForCurrentTenant(): Knex.SchemaBuilder {
  return this.knex.schema.withSchema(this.tenantContext.schema);
}

// dynamic-tables.service.ts -- all three tables created inside one transaction
// so a mid-bootstrap failure never leaves a partially-created _meta_* set.
await this.tenantKnexService.transaction(async (trx) => {
  const schema = this.tenantKnexService.schemaForCurrentTenant().transacting(trx);
  if (!(await schema.hasTable('_meta_tables'))) {
    await schema.createTable('_meta_tables', (t) => {
      t.string('id').primary();
      t.text('name').notNullable();
      t.text('slug').notNullable().unique();
      t.text('description').nullable();
      t.timestamps(true, true);
    });
  }
  // ...same hasTable-guarded pattern for _meta_fields, _meta_migrations
});
```

`TenantKnexService` needs a `transaction()` passthrough (e.g. `transaction<T>(fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> { return this.knex.transaction(fn); }`) alongside `forCurrentTenant()`/`schemaForCurrentTenant()`, since only `TenantKnexService` may touch the raw `knex` instance (AD-3) — `DynamicTablesService` cannot call `knex.transaction()` directly. `_meta_fields` and `_meta_migrations` follow the same `hasTable` guard, with `t.string('table_id').references('id').inTable('_meta_tables').onDelete('CASCADE')` for every FK column AD-10 specifies (`_meta_fields.table_id`, `_meta_fields.relation_target_table_id`, `_meta_migrations.table_id`) — a table's own field/migration-log rows have no independent lifecycle once the table's metadata row is gone, mirroring the superseded Prisma models' `onDelete: Cascade`.

## Verification

**Commands:**
- `cd apps/backend && npx jest src/tenancy/sanitize-identifier.spec.ts` -- expected: all cases pass, including adversarial/boundary rows.
- `cd apps/backend && npx jest src/modules/dynamic-tables/dynamic-tables.service.spec.ts` -- expected: bootstrap-migration shape and idempotency tests pass.
- `cd apps/backend && npx tsc --noEmit` -- expected: no type errors introduced.
- `cd apps/backend && npx eslint src/tenancy/sanitize-identifier.ts src/modules/dynamic-tables/dynamic-tables.service.ts` -- expected: no lint errors.

## Auto Run Result

**Summary:** Implemented Story 1 of the Dynamic Table Builder epic: a `sanitizeIdentifier()` utility for validating user-supplied Postgres table/column identifiers, a `TenantKnexService.schemaForCurrentTenant()`/`transaction()` pair enabling schema-scoped, transaction-wrapped DDL, and a `DynamicTablesService.ensureMetaTables()` bootstrap method that idempotently creates the `_meta_tables`/`_meta_fields`/`_meta_migrations` tenant-schema metadata tables per AD-10's pinned shapes, with `onDelete('CASCADE')` on all foreign keys. The `DynamicTables` module's stub controller/route was left working unchanged; CRUD, the BullMQ DDL queue, and Prisma-model removal remain out of scope (Story 2+/Story 7).

**Files changed:**
- `apps/backend/src/tenancy/sanitize-identifier.ts` (new) -- shared identifier-sanitizing function (AD-3), same allowlist regex/length cap as `resolveTenantSchema()`.
- `apps/backend/src/tenancy/sanitize-identifier.spec.ts` (new) -- 11 unit tests covering the I/O matrix's identifier rows.
- `apps/backend/src/tenancy/tenant-knex.service.ts` (modified) -- added `schemaForCurrentTenant(): Knex.SchemaBuilder` (DDL entry point) and `transaction<T>()` (transaction passthrough, added in the review loopback).
- `apps/backend/src/tenancy/tenant-knex.service.spec.ts` (modified) -- added coverage for both new methods.
- `apps/backend/src/modules/dynamic-tables/dynamic-tables.service.ts` (modified) -- superseded stub in place; added `ensureMetaTables()` bootstrap method, transaction-wrapped, with `onDelete('CASCADE')` FKs.
- `apps/backend/src/modules/dynamic-tables/dynamic-tables.service.spec.ts` (new) -- unit tests asserting all three tables' column shapes, CASCADE FKs, unique constraint, transaction-wrapping, and idempotency.

**Review findings breakdown (2 passes):** 2 `bad_spec` findings addressed via spec amendment + code re-derivation (missing FK `onDelete('CASCADE')`; missing transaction-wrapping around the three `createTable` calls) — both confirmed closed by a follow-up review pass, including mutation-testing verification. 0 `patch` findings. 5 items `deferred` (all low severity: check-then-act race on concurrent first-bootstrap, missing indexes on future Story-2 query columns, missing CHECK constraints on not-yet-written columns, reserved-Postgres-keyword handling for a function with no production callers yet, and missing per-step error context in the bootstrap transaction). 29 findings `rejected` as out of scope, already-covered by existing codebase convention, or factually incorrect (e.g. a claim that `schemaForCurrentTenant()` lacks a missing-tenant-context guard, when `TenantContext.schema`'s underlying getter already throws and is tested).

**Follow-up review recommendation:** `false` (patched-finding score: 0 -- no findings were triaged `patch` in either pass).

**Verification performed:** All four spec-listed commands re-run and passed after the final re-derivation: `npx jest src/tenancy/sanitize-identifier.spec.ts` (11/11), `npx jest src/modules/dynamic-tables/dynamic-tables.service.spec.ts` (7/7), `npx tsc --noEmit` (clean), `npx eslint` on all three changed source files (clean). Full backend suite (`npx jest`): 9 suites / 91 tests pass, no regressions. Matrix Test Audit: all six I/O & Edge-Case Matrix rows confirmed covered by passing tests.

**Residual risks:** No live-Postgres integration test exists for the bootstrap migration (consistent with this codebase's existing `tenant-knex.service.spec.ts` convention of SQL-compilation/mocked-service-only coverage; no DB available in this environment). `ensureMetaTables()` and `sanitizeIdentifier()` currently have no production call site — this is intentional per the story's own scope (wiring belongs to Story 2's CAP-1), not an oversight, but means this story's code cannot execute in the running app until Story 2 lands.
