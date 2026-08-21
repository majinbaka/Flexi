---
id: SPEC-dynamic-table-builder
companions:
  - architecture-diagrams.md
  - ../../planning-artifacts/architecture/architecture-flexi-2026-08-20/ARCHITECTURE-SPINE.md
sources:
  - _bmad-output/planning-artifacts/research/technical-dynamic-table-builder-schema-2026-08-17/research.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Dynamic Database / Table Builder

## Why

Flexi's roadmap splits off a Dynamic Table Builder as an independently shippable module (per `deferred-work.md`), and the platform already carries infrastructure built specifically for it: a tenant-schema-routing layer (`TenantKnexService`, `resolveTenantSchema()`) whose own spec states it exists "for the future dynamic-tables data path." Tenant admins currently have no way to define their own data structures at runtime — every table in the system is one of Flexi's fixed, developer-authored Prisma models. This is a vision-to-realize: let a tenant admin define, evolve, and populate their own tables and relations through the product, on real Postgres tables scoped to their tenant's own schema, without needing a developer or a code deploy.

## Capabilities

- **CAP-1**
  - **intent:** Tenant admin can define a new dynamic table (name + initial fields) via API.
  - **success:** Table and column creation compiles to real physical DDL in the tenant's Postgres schema, wrapped in one transaction together with the metadata row (in the tenant's own Knex-managed metadata table, not Prisma) that describes the table.

- **CAP-2**
  - **intent:** Tenant admin can add, remove, or modify fields (columns) on an existing dynamic table.
  - **success:** Additive changes (`ADD COLUMN` with a constant `DEFAULT`) apply without a table rewrite; destructive or type-changing edits follow an expand/contract flow (new column → dual-write → backfill → cutover/drop) instead of an unsafe in-place `ALTER`.

- **CAP-3**
  - **intent:** Field definitions carry a validation ruleset (required, type constraint, string length, numeric range, enum) enforced on every dynamic-table write.
  - **success:** An invalid write against a table's field rules is rejected with a field-level error (class-validator-style field-error array, matching this codebase's existing DTO error shape) at the application layer before it reaches the database. The validation ruleset is generated from a table's field definitions and cached per table, invalidated on every field edit — never re-derived from raw metadata per request.

- **CAP-4**
  - **intent:** Tenant admin can define a many-to-one linked-record (relation) field on a dynamic table, pointing at exactly one record on another dynamic table in the same tenant. (Many-to-many/join-table relations are out of scope for this first cut — see Non-goals.)
  - **success:** A relation field is a literal Postgres foreign-key column on the source table, referencing the target table's primary key. Relation reads return joined/aggregated data via server-side `json_agg` (no N+1 query pattern). Cross-tenant linking is structurally impossible, not just application-checked — the target table can only ever live in the caller's own tenant schema.

- **CAP-5**
  - **intent:** Every DDL-issuing operation (create table, add/alter/drop column) runs through a migration engine that records the change for replay and audit.
  - **success:** Each structural change to a dynamic table is captured as a migration record scoped to the tenant's own schema, consistent with the `.withSchema()`-per-migration-file pattern the deferred cross-tenant migration tooling will later replay across tenants.

- **CAP-6**
  - **intent:** Runtime DDL executes safely under concurrent load instead of risking a lock-queue cascade onto live traffic.
  - **success:** Every DDL statement sets a bounded `lock_timeout` before executing and runs off the request/response path via a BullMQ queue (PostgreSQL-backed, reusing the existing database connection — no Redis dependency), so a blocked `ALTER` fails fast and retries/queues instead of stalling live reads/writes on the same table. A client can poll a job-status endpoint to learn a queued DDL change's outcome.

- **CAP-7**
  - **intent:** Tenant admin can create and edit tables and fields through a frontend UI, not only raw API calls.
  - **success:** A form-driven table/field builder in the frontend app calls this module's API and surfaces CAP-3's field-level validation errors inline.

- **CAP-8**
  - **intent:** The module enforces per-tenant guardrails bounding how many dynamic tables and columns a single tenant schema can accumulate, with ceilings a tenant admin can configure for their own tenant (falling back to a platform-wide default when unset).
  - **success:** A creation request beyond the tenant's configured ceiling (max tables per tenant schema, max columns per table) is rejected with a clear error; the ceiling is stored per-tenant and editable through the tenant management/admin settings surface, not a single hardcoded global constant.

## Constraints

- Metadata (table/field definitions) lives entirely inside each tenant's own Postgres schema as Knex-managed tables — never Prisma. The pre-existing Prisma `DynamicTable`/`DynamicField` models are superseded and removed as part of this module's implementation, not left running in parallel. Sole exception: CAP-8's guardrail ceiling settings stay in Prisma (`Tenant.dynamicTableGuardrails`), since they must be readable before a tenant's first table — and first Knex-managed metadata table — exists.
- All dynamic-table DDL **and DML** (structural changes and row reads/writes alike) goes through Knex via the existing tenancy layer (`TenantKnexService.forCurrentTenant()`, `resolveTenantSchema()`), and exclusively through this module's own service — no other module or code path calls `TenantKnexService` for dynamic-table data directly, even for reads. That layer's `resolveTenantSchema()` allowlist is the single choke point defending against schema-name injection; a second path around it reopens that risk. User-supplied table/column names are validated by one shared identifier-sanitizing function, never a second independently-written check.
- Dynamic tables carry no row-level `tenant_id` column — tenant isolation comes from living inside the tenant's own Postgres schema. Indexes are chosen for the table's own query patterns (e.g. `(created_at)` for pagination) rather than leading with a tenant key that doesn't exist on these tables.
- `statement_timeout` and `lock_timeout` for DDL sessions are explicit `ConfigService`/env-backed values, following this codebase's existing convention of surfacing tunables in `env.validation.ts` rather than hardcoding them.
- BullMQ is a new backend dependency introduced specifically for CAP-6's DDL job queue, using BullMQ's PostgreSQL backend (no Redis, no `ioredis`, no new required env var — reuses the existing database connection).
- CAP-8's table/column ceilings are per-tenant admin-configurable settings stored in Prisma (`Tenant.dynamicTableGuardrails`, with a platform-wide default of 100 tables/tenant and 50 columns/table when unset), not a single hardcoded global constant — a tenant admin manages them through the tenant management surface. These two defaults are explicitly placeholders, not benchmarked figures. Row-count, page-size, and rate-limit guardrail numbers remain unresolved and must be re-derived from Flexi's own expected tenant profile, not copied from the source research's illustrative figures (100k rows/table, etc.), which carry no traceable source — see Open Questions.

## Non-goals

- Tenant schema provisioning (creating a new tenant's Postgres schema in the first place) — deferred separately; this module assumes a tenant's schema already exists before its admin starts defining dynamic tables.
- Cross-tenant migration replay tooling (a `migrateAllTenants()` runner across every tenant schema) — tracked as its own deferred-work item; this module's migrations only need to be schema-scoped and replayable per-tenant.
- Advanced field types beyond basic scalars and relations — computed/formula fields, file/attachment fields, lookup/rollup aggregation across relations are a natural follow-up, not part of this first cut.
- Fleet-wide catalog-object-budget metrics/alerting (cross-tenant monitoring of total Postgres system-catalog growth) — CAP-8 covers per-tenant enforcement only.

## Success signal

A tenant admin creates a new dynamic table with several typed fields and a linked-record field to another of their tables entirely through the frontend UI, writes and reads rows against it with validation errors surfacing correctly on bad input, and the underlying Postgres schema shows real physical tables/columns/indexes with no cross-tenant leakage — all without a developer touching code or a deploy.

## Open Questions

- Row-count, page-size, and rate-limit guardrail numbers (beyond CAP-8's now-pinned table/column defaults of 100/50) remain unresolved — the source research's figures are untraceable illustrative guesses. Needs a decision grounded in Flexi's own expected tenant profile before `bmad-build` implements concrete values.
- Disposition of the superseded Prisma `DynamicTable`/`DynamicField` models (drop directly vs. deprecate-then-drop) is an implementation-sequencing detail left to `bmad-build`, not fixed here.
