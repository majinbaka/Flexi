---
title: 'Story 2.3: Bootstrap Defaults And Tenant RBAC Seed'
type: 'feature'
created: '2026-08-22'
status: 'done'
review_loop_iteration: 0
baseline_commit: '2655caacaf75951c90dbe8f17640f172ec095ed4'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** After Story 2.2, a `PROVISIONING` tenant has a schema and metadata bootstrap tables (`_meta_tables`, `_meta_fields`, `_meta_migrations`) but no usable business defaults — no system settings, workflow statuses, RBAC roles, entity categories, or notification templates. Nothing after activation has a base to operate on.

**Approach:** Add a new `TenantSeedService` that creates fixed-shape Knex tables (`system_settings`, `statuses`, `roles`, `permissions`, `role_permissions`, `categories`, `notification_templates`) inside the tenant schema and idempotently inserts the required default rows, all inside one transaction. Wire it as a third sequential step in `provisionTenantSchema()`, called after `bootstrapTenantSchema()`, following the exact CLS + step-outcome + rethrow pattern Story 2.2 established.

## Boundaries & Constraints

**Always:** Resolve schema via `resolveTenantSchema(tenantId)` (never re-derive). Populate CLS (`cls.runWith({ tenantId, schema }, ...)`) before any `TenantKnexService`/`TenantSeedService` call. Run all table creation and row inserts inside one `tenantKnexService.transaction()`. Use the `buildSchema()`-factory-per-statement pattern from `ensureMetaTables()` (never reuse one `Knex.SchemaBuilder` across two awaits). Fully schema-qualify any FK `.inTable()` reference (`role_permissions` → `roles`/`permissions`). Make row seeding idempotent via `hasTable()` guards for DDL and `.onConflict(...).ignore()` (or pre-check by natural key) for inserts — replay must never duplicate rows or throw. Record one step outcome (`bootstrap_seeded`) succeeded/failed on the attempt; on any failure inside the transaction, record `failed` with a safe error code and re-throw (never activate, never catch-and-swallow).

**Ask First:** Splitting `bootstrap_seeded` into multiple finer-grained step names (e.g. per category); adding seed categories beyond the five specified; changing the default permission matrix shape beyond a simple role→permission-code list.

**Never:** Reuse or modify the public-schema `Role`/`Permission`/`RolePermission` Prisma models (`prisma/schema.prisma`) — those back platform login/route guards and are unrelated to tenant-schema business RBAC. Use the `_meta_` table-name prefix (reserved for dynamic-tables bookkeeping). Set `Tenant.status = ACTIVE` in this story. Add First Admin, setup links, email, or audit finalization (Stories 2.4–2.6). Use session-level `SET search_path`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First run | Schema + `_meta_*` tables exist; seed tables absent | Seed tables created; all default rows inserted; `bootstrap_seeded` recorded `succeeded` | — |
| Worker retry | Seed tables + rows already exist from a prior partial/complete run | `hasTable()` guards skip existing tables; `.onConflict().ignore()` skips existing rows; no duplicates; `bootstrap_seeded` still recorded `succeeded` | — |
| Seed transaction fails mid-way | DB error during any table create or insert | Whole transaction rolls back (no partial tables/rows); `bootstrap_seeded` recorded `failed` with safe error code; tenant stays `PROVISIONING`; error re-thrown for BullMQ retry | No stack trace, no raw SQL in recorded message |

</frozen-after-approval>

## Code Map

- `apps/backend/src/modules/tenants/provisioning.service.ts:223-229` -- `provisionTenantSchema()` orchestrator; add a third sequential call `await this.bootstrapTenantSeed(attemptId, tenantId);` after the existing `bootstrapTenantSchema()` call
- `apps/backend/src/modules/tenants/provisioning.service.ts:241-274,283-314` -- `createTenantSchema()`/`bootstrapTenantSchema()` -- exact template to copy for new private `bootstrapTenantSeed()`: `resolveTenantSchema` → `cls.runWith` → try/`updateAttemptStep succeeded`/catch-log-`updateAttemptStep failed`-rethrow; safe error code `BOOTSTRAP_SEED_FAILED`
- `apps/backend/src/modules/tenants/provisioning.service.ts:59` -- constructor DI site; add `private readonly tenantSeedService: TenantSeedService` alongside existing `dynamicTablesService`
- `packages/shared-types/src/entities.ts:57-65` -- `TenantOnboardingStepName` union; append `| 'bootstrap_seeded'`
- `apps/backend/src/modules/dynamic-tables/dynamic-tables.service.ts:103-137` -- `ensureMetaTables()` -- template for the seed transaction: `tenantKnexService.transaction(async (trx) => {...})` wrapping everything; `buildSchema()` factory (117-118) re-created fresh per statement, never reused across awaits
- `apps/backend/src/modules/dynamic-tables/dynamic-tables.service.ts:120-131` -- FK-across-tables-in-same-transaction gotcha: `.inTable()` needs a fully schema-qualified string, not schema-scoped builder inheritance -- applies to `role_permissions`' FKs into `roles`/`permissions`
- `apps/backend/src/modules/dynamic-tables/dynamic-tables.service.ts:139-216` -- per-table `hasTable()` guard pattern (`ensureMetaTablesTable`, etc.) -- mirror for each new seed table
- `apps/backend/src/modules/dynamic-tables/dynamic-tables.service.ts:29-31,36` -- table-name-constant convention and `RESERVED_TABLE_PREFIX = '_meta_'` -- new tables must NOT use this prefix
- `apps/backend/src/tenancy/tenant-knex.service.ts:62-64,75-77,86-88,100-105` -- `forCurrentTenant()` (DML/inserts), `schemaForCurrentTenant()` (DDL), `transaction()`, `raw()` -- the only sanctioned entry points for tenant-scoped Knex calls
- `apps/backend/src/tenancy/resolve-tenant-schema.ts:22-48` -- `resolveTenantSchema(tenantId)` -- reuse unchanged
- `apps/backend/src/modules/tenants/tenants.module.ts:24,36-39` -- module wiring; add `TenantSeedService` to `providers` (new file, same module -- no new module needed, mirrors how `DynamicTablesService` is imported rather than requiring a standalone `TenantSeedService` file to live elsewhere)
- `apps/backend/src/modules/tenants/provisioning.service.spec.ts:29-58` -- `buildConfigService`/`buildQueue`/`buildCls`/`buildTenantKnexService`/`buildDynamicTablesService` mock-builder pattern; add `buildTenantSeedService()` analog (`bootstrapSeed: jest.fn().mockResolvedValue(undefined)`)
- `apps/backend/src/modules/tenants/provisioning.service.spec.ts:74-79` -- comment noting each new provisioning step adds one more `updateAttemptSteps()` round trip to the scripted `$queryRaw`/`$executeRaw` mock chain -- Story 2.3 tests must extend these call-count expectations

## Tasks & Acceptance

**Execution:**
- [x] `apps/backend/src/modules/tenants/tenant-seed.service.ts` (new) -- create `TenantSeedService` with a public `bootstrapSeed(): Promise<void>` (called inside a caller-supplied CLS context, mirrors `DynamicTablesService.ensureMetaTables()`) that opens one `tenantKnexService.transaction()` and: (1) idempotently creates tables `system_settings`, `statuses`, `roles`, `permissions`, `role_permissions`, `categories`, `notification_templates` using the `buildSchema()`-factory-per-statement + `hasTable()` guard pattern; (2) idempotently inserts default rows for each (locale/timezone/base-currency/config-flag settings; `Draft`/`In Review`/`Active`/`Archived` statuses; `Admin`/`Tenant Admin`/`Manager`/`Member` roles with a default permission matrix via `role_permissions`; `General`/`Operations`/`Administrative` categories; `WELCOME_SETUP_INVITE`/`PASSWORD_RESET_REQUEST`/`WORKSPACE_LIMIT_WARNING` notification templates) using `.onConflict(...).ignore()` on each table's natural-key column(s) -- creates the tenant-schema RBAC/lookup data model from scratch, mirroring the `_meta_*` idempotent pattern
- [x] `apps/backend/src/modules/tenants/provisioning.service.ts` -- inject `TenantSeedService`; add private `bootstrapTenantSeed(attemptId, tenantId)` following the exact `createTenantSchema`/`bootstrapTenantSchema` template (resolve schema, `cls.runWith`, call `tenantSeedService.bootstrapSeed()`, record `bootstrap_seeded` succeeded/failed with error code `BOOTSTRAP_SEED_FAILED`, rethrow on failure); call it as a third step in `provisionTenantSchema()` after `bootstrapTenantSchema()` -- wires seeding into the provisioning pipeline
- [x] `packages/shared-types/src/entities.ts` -- add `'bootstrap_seeded'` to `TenantOnboardingStepName` -- extends the shared step-name contract
- [x] `apps/backend/src/modules/tenants/tenants.module.ts` -- add `TenantSeedService` to `providers` -- makes it injectable into `TenantProvisioningService`
- [x] `apps/backend/src/modules/tenants/tenant-seed.service.spec.ts` (new) -- unit tests: first run creates all tables and inserts all default rows (assert row counts/natural keys per table); re-running against pre-existing tables+rows is a no-op (no duplicate rows, no error); a mid-transaction DB error causes full rollback (no partial tables/rows persisted) -- locks `TenantSeedService` behavior in isolation
- [x] `apps/backend/src/modules/tenants/provisioning.service.spec.ts` -- add `buildTenantSeedService()` mock builder; extend existing scripted-mock call-count expectations for the new `bootstrap_seeded` step; add cases: seed success records `bootstrap_seeded` succeeded; seed failure records `bootstrap_seeded` failed and re-throws; worker-retry idempotency (seed already done = no error, step still `succeeded`) -- locks the provisioning-orchestration side of Story 2.3
- [x] `_bmad-output/implementation-artifacts/sprint-status.yaml` -- advance `2-3-bootstrap-defaults-and-tenant-rbac-seed` from `backlog` to `in-progress` then `review` per workflow -- keep sprint tracking accurate

**Acceptance Criteria:**
- Given the tenant schema is provisioned, when bootstrap seeding runs, then `system_settings` rows exist for locale, timezone, base currency, and configuration flags inside `tenant_<id>`.
- Given bootstrap seeding runs, then default workflow statuses `Draft`, `In Review`, `Active`, `Archived` exist in the tenant's `statuses` table.
- Given bootstrap seeding runs, then `Admin`/`Tenant Admin`, `Manager`, and `Member` roles exist in `roles` with rows in `role_permissions` reflecting a default permission matrix.
- Given bootstrap seeding runs, then categories `General`, `Operations`, `Administrative` exist, and notification templates `WELCOME_SETUP_INVITE`, `PASSWORD_RESET_REQUEST`, `WORKSPACE_LIMIT_WARNING` exist.
- Given any seed table creation or row insert fails, when the transaction is rolled back, then `bootstrap_seeded` is recorded `failed` with a safe error code (no stack trace, no raw SQL), the tenant remains `PROVISIONING`, and the error is re-thrown for BullMQ retry.
- Given a worker retry where seed tables and rows already exist, when `bootstrapTenantSeed` runs again, then no duplicate rows are created and `bootstrap_seeded` is still recorded `succeeded`.

## Design Notes

**Default permission matrix shape:** Keep it minimal and data-driven — a plain list of `(roleName, permissionCode)` pairs seeded into `role_permissions` by joining on each table's natural key (`roles.name`, `permissions.code`) inside the same transaction, e.g. `Admin`/`Tenant Admin` gets every seeded permission code, `Manager` gets a reasonable subset (e.g. create/read/update on business entities, no admin/settings permissions), `Member` gets read-only. Exact permission code strings are an implementation decision, not a human-gated one, as long as the three roles exist with a non-empty, sensibly-scoped matrix — this keeps the spec under the token budget rather than enumerating every code.

**Natural keys for `.onConflict().ignore()`:** `system_settings.key`, `statuses.name`, `roles.name`, `permissions.code`, `role_permissions.(role_id, permission_id)`, `categories.name`, `notification_templates.code`. Each table needs a unique constraint on its natural key for `onConflict` to target.

## Verification

**Commands:**
- `pnpm --filter @flexi/shared-types build` -- expected: shared type declarations rebuild cleanly with the new step name
- `pnpm --filter @flexi/backend test -- tenant-seed.service.spec.ts` -- expected: all seed-service unit tests pass
- `pnpm --filter @flexi/backend test -- provisioning.service.spec.ts` -- expected: all provisioning tests pass, including new `bootstrap_seeded` coverage
- `pnpm --filter @flexi/backend build` -- expected: Nest backend build passes with no TypeScript errors
- `git diff --check` -- expected: no whitespace errors

## Suggested Review Order

**Seed transaction and idempotency**

- Entry point: opens one transaction for all seven tables and their default rows, with the fresh-builder-per-statement discipline `ensureMetaTables()` established.
  [`tenant-seed.service.ts:165`](../../apps/backend/src/modules/tenants/tenant-seed.service.ts#L165)

- `role_permissions` FKs use fully schema-qualified table names, not schema-scoped builder inheritance -- required for FK references within the same transaction.
  [`tenant-seed.service.ts:274`](../../apps/backend/src/modules/tenants/tenant-seed.service.ts#L274)

- Row seeding via `.onConflict(...).ignore()` on each table's natural key -- a replay never duplicates rows or throws.
  [`tenant-seed.service.ts:338`](../../apps/backend/src/modules/tenants/tenant-seed.service.ts#L338)

- Default role -> permission-code matrix: Tenant Admin gets every code, Manager a subset, Member read-only.
  [`tenant-seed.service.ts:81`](../../apps/backend/src/modules/tenants/tenant-seed.service.ts#L81)

**Provisioning pipeline wiring**

- Third sequential step added after `bootstrapTenantSchema()`, following the exact CLS + step-outcome + rethrow template Story 2.2 established.
  [`provisioning.service.ts:392`](../../apps/backend/src/modules/tenants/provisioning.service.ts#L392)

- Orchestrator now calls all three schema-provisioning steps in sequence.
  [`provisioning.service.ts:367`](../../apps/backend/src/modules/tenants/provisioning.service.ts#L367)

**Peripherals**

- New `bootstrap_seeded` step name added to the shared step-name contract.
  [`entities.ts:65`](../../packages/shared-types/src/entities.ts#L65)

- `TenantSeedService` registered as a provider so it's injectable into `TenantProvisioningService`.
  [`tenants.module.ts:40`](../../apps/backend/src/modules/tenants/tenants.module.ts#L40)

- Unit tests covering first-run table/row creation, retry idempotency, and mid-transaction rollback.
  [`tenant-seed.service.spec.ts:1101`](../../apps/backend/src/modules/tenants/tenant-seed.service.spec.ts#L1101)

- Provisioning-orchestration tests: `bootstrap_seeded` success/failure recording and CLS population.
  [`provisioning.service.spec.ts:244`](../../apps/backend/src/modules/tenants/provisioning.service.spec.ts#L244)
