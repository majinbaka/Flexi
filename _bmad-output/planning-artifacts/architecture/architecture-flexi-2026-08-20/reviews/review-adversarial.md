---
name: 'Adversarial Review — Dynamic Database / Table Builder Architecture Spine'
type: review
reviews: ARCHITECTURE-SPINE.md
created: '2026-08-20'
---

# Adversarial Review — ARCHITECTURE-SPINE.md (Dynamic Database / Table Builder)

**Verdict: PASS WITH FINDINGS**

The spine is well-formed and its ADs are individually coherent, but it operates at a level of abstraction that leaves several load-bearing details unpinned. For each finding below, I construct two units one level down — each independently implementing a different story/piece of this spine, each obeying every written AD to the letter — that build incompatibly with each other. None of these require misreading an AD; each pair is a legitimate, defensible interpretation of the text as written.

Method: for every finding I name "Developer/Unit A" and "Developer/Unit B," quote or cite the specific AD text each would point to in their own defense, and state concretely what breaks when their two pieces meet (a merge conflict, a runtime error, a silent correctness bug, or a security regression).

---

## CRITICAL

### F1 — AD-2 disciplines DDL exclusivity but never makes `DynamicTablesService` the exclusive DML gateway; AD-3's "every statement... via `forCurrentTenant()`" actively invites bypass

**The gap.** The Design Paradigm prose claims the module is "the exclusive gateway to both metadata... and DDL/DML execution" — but that's narrative, not a rule. The actual enforceable AD-2 rule text is scoped to DDL only:

> "Any **structural change** to a tenant's dynamic tables... goes through `DynamicTablesService`'s public API. No other module calls `TenantKnexService` for DDL directly."

AD-3's rule is the opposite of exclusive for DML — it says every statement must be *built from* `tenantKnexService.forCurrentTenant()`, which is a statement about **how** to reach tenant Postgres (never raw `pg`, never string concat), not **who** is allowed to call it:

> "Every statement — metadata or data — is built from `tenantKnexService.forCurrentTenant()`."

AD-4 only exempts DML from the **queue**, saying nothing about which module may issue it: "DML (row reads/writes) is exempt — it executes synchronously in-request via `forCurrentTenant()`, same as any normal query."

**Unit A (DynamicTables module author):** builds `rows.controller.ts` → `DynamicTablesService` → validation-schema-checked (AD-5) → `forCurrentTenant()` write path, exactly as the Structural Seed lays out.

**Unit B (a future module author, e.g. Workflow Builder, explicitly named in AD-2's own "Prevents" clause as an example of a module that must not bypass DDL):** implements a workflow action that writes a row into a dynamic table directly — injects `TenantKnexService`, calls `.forCurrentTenant().table(...).insert(...)` from its own module. This is *not* a structural change, so AD-2's prohibition doesn't apply. It *is* built from `forCurrentTenant()`, so AD-3 is satisfied. It executes synchronously in-request, so AD-4's DML exemption is satisfied. Unit B can point to all three ADs and be correct that none of them was violated.

**What breaks:** Unit B's writes never pass through `DynamicTablesService`'s CAP-3 validation-schema enforcement (AD-5's "DML handlers read only the cached schema" only disciplines handlers that live where AD-5 assumes they live — inside this module). CAP-3's entire promise ("An invalid write... is rejected with a field-level error... before it reaches the database") silently stops applying the moment any other module writes DML directly. This is also a guardrail bypass: CAP-8's table/column ceilings are checked "before CAP-1/CAP-2 accept a change" (structural), not before a DML write — so this isn't a guardrail gap, but it does mean two different code owners now maintain two different sets of assumptions about who validates dynamic-table writes, with no compiler or runtime signal that anything is wrong. This is the same failure class AD-2 exists to prevent for DDL, just left unclosed for DML.

**Fix direction:** Extend AD-2 (or add a new AD) so that *no module other than DynamicTables calls `TenantKnexService.forCurrentTenant()` against dynamic-table schemas at all* — DDL or DML — full stop. Route cross-module writes through `DynamicTablesService`'s DML API (the same `/api/tables/:tableId/rows` contract, or an internal equivalent), so CAP-3/CAP-5/CAP-8 discipline is unconditionally enforced at one seam.

---

## HIGH

### F2 — AD-7's "foreign-key-style reference" is hedged exactly enough that two implementers build different physical relation storage

**The gap.** AD-7's rule: "A linked-record field stores a **single foreign-key-style reference** to exactly one record on another dynamic table in the same tenant schema." "Style" is doing real work here — it reads as "conceptually like a foreign key," not "implemented as a Postgres `FOREIGN KEY` constraint."

**Unit A:** implements a literal Postgres `FOREIGN KEY` constraint on the generated relation column, referencing the target table's primary key, with `ON DELETE` behavior chosen ad hoc (nothing in the spine specifies it — Restrict? Cascade? Set Null?). Gets CAP-4's `json_agg` join "for free" via a DB-indexed, DB-enforced reference.

**Unit B:** stores the same field as a plain cuid/uuid column with **no** DB-level constraint, validating referential integrity purely in `DynamicTablesService` application code — reasoning (defensibly) that dynamically adding/dropping FK constraints on runtime-created tables complicates CAP-2's expand/contract flow and CAP-1/CAP-2's DDL-worker job design (a `DROP TABLE` on a relation target now has to consider live FK constraints from other tenant tables, which the spine's CAP-2 migration description never mentions handling). "Foreign-key-style" literally permits this — it's *not* claiming to be a real FK.

**What breaks:** Two divergent DB schemas for the same logical feature. Different failure/consistency behavior when a target row or table is deleted (DB-enforced integrity vs. silent dangling reference unless the app remembers to check on every path — including any DML bypass per F1). Different query plans (implicit FK index vs. none, unless separately added). A migration written against Unit A's assumption (real constraint) will fail or behave differently against Unit B's schema and vice versa — these are not interoperable table shapes for the same CAP-4 feature.

**Fix direction:** State explicitly whether the relation column is backed by an actual Postgres `FOREIGN KEY` constraint, and if so, specify the `ON DELETE` behavior (or explicitly defer it to CAP-2 with a stated interim default). If deliberately *not* a DB constraint (to keep DDL simpler), say so and specify where/how referential integrity is enforced instead.

---

### F3 — AD-9's guardrails are "stored per tenant" with no schema/table pinned, and the two natural readings are architecturally incompatible

**The gap.** AD-9: "Max-tables-per-schema and max-columns-per-table are stored per tenant (editable via tenant management/admin settings) and read by `DynamicTablesService` before CAP-1/CAP-2 accept a change." No statement of *where* — which schema, which table, Prisma or Knex.

**Unit A:** stores guardrails as rows in the tenant's own dynamic-schema metadata (e.g., a `_tenant_settings`-style table living inside `tenant_<id>`, alongside `TENANT_SCHEMA_METADATA_TABLE`), read via `TenantKnexService.forCurrentTenant()` — consistent with AD-1's "no Prisma involvement at all" framing for this module.

**Unit B:** stores it as a Prisma model in the `public` schema tied to the existing `Tenant` model, because "tenant management/admin settings surface" reads as the platform's existing tenant-admin area, which is Prisma-backed everywhere else in this codebase, and AD-1's Prisma-removal mandate is textually scoped to `DynamicTable`/`DynamicField` specifically — not to "anything dynamic-tables-adjacent."

**What breaks:** These aren't just different tables — they're different **connection layers**. Unit A creates a bootstrapping problem: to decide whether a brand-new tenant may create *any* dynamic table, `DynamicTablesService` must already be able to read Knex-schema state for a tenant schema whose existence and contents this module (per its own Deferred section) assumes were provisioned by something else. Unit B takes on a live Prisma dependency inside "the one deliberate Knex-only exception" module, which cuts against AD-1/AD-2's framing that this module has "no Prisma involvement at all." A future integration (e.g., CAP-7's admin settings UI, or CAP-8's own enforcement check) built against one location breaks entirely if the guardrail actually lives in the other. This is exactly the ambiguity the task prompt flagged, and it holds up under inspection.

**Fix direction:** Pin the guardrail's home explicitly — most likely the `public`-schema `Tenant`-adjacent Prisma model (guardrails are platform/admin configuration, not tenant business data, and reading them shouldn't require the tenant's dynamic schema to already exist) — and say so in AD-9's rule text, not just in the capability map.

---

### F4 — CAP-5's `MIGRATION_RECORD` has no owner, no shape, and no stated mechanism (Knex's own migration runner vs. a hand-rolled audit table) — and the codebase has no existing precedent to resolve it by convention

**The gap.** The Structural Seed's ER diagram shows `TENANT_SCHEMA_METADATA_TABLE ||--o{ MIGRATION_RECORD : "structural changes"`, and AD-1 binds CAP-5, but no AD or seed entry specifies `MIGRATION_RECORD`'s columns, or even whether it's a distinct hand-rolled table versus Knex's own built-in `knex_migrations` bookkeeping table (which Knex auto-creates when using its file-based migration API). CAP-5's own success text — "consistent with the `.withSchema()`-per-migration-file pattern the deferred cross-tenant migration tooling will later replay" — describes an existing pattern by reference, but that pattern (verified in the codebase) exists today only for **Prisma** migrations (`apps/backend/prisma/migrations/*`); there is no existing Knex-migration-runner precedent anywhere in this codebase to anchor "per-migration-file" against for *runtime-generated* DDL, which by definition has no migration *file* to point at.

**Unit A:** uses Knex's built-in migration API (`knex.migrate.*`) with dynamically-written migration files persisted to disk or DB-blob per structural change, relying on Knex's own auto-created `knex_migrations`/`knex_migrations_lock` tables inside the tenant schema for the "record."

**Unit B:** treats "migration engine" as a description of the *behavior* (versioned, replayable, auditable structural change) rather than a mandate to use Knex's file-based runner literally, and hand-writes a custom `_migration_log(id, table_id, operation, ddl_text, status, applied_at)` table populated directly by `ddl-worker.ts`, with no dependency on Knex's migration file mechanism at all (which doesn't fit a table/field builder whose DDL is generated at request time from user input, not authored ahead of time as a file).

**What breaks:** The cross-tenant migration replay tooling that CAP-5 explicitly gestures at as a *future* consumer ("the deferred cross-tenant migration tooling will later replay across tenants") will be built against whichever shape its author assumes exists — and if that's a different assumption than what CAP-5's implementer built, the replay tooling is DOA on day one. There is also no single owner named for *writing* to `MIGRATION_RECORD`: is it the DDL worker only (per the Structural Seed comment on `ddl-worker.ts`), or does `DynamicTablesService` also write a "pending" record synchronously before enqueueing (needed if API-layer callers want a job status story before the worker picks it up)? Two implementers can each own half of that write path and never agree on schema.

**Fix direction:** Add a rule (either folding into AD-1 or a new AD) that pins `MIGRATION_RECORD`'s owner (the DDL worker, single-writer) and states explicitly that it is a hand-rolled tenant-schema table (not Knex's file-based migration runner, which doesn't fit runtime-generated DDL) — with at minimum the columns needed for CAP-5's stated audit/replay purpose (target table id, operation type, the DDL executed, outcome/status, timestamp).

---

## MEDIUM

### F5 — Tenant-schema metadata table physical shape (columns, FieldDataType storage, identifier casing) is unpinned below the AD/ER level

**The gap.** AD-1 and the Structural Seed establish that two logical tables exist (table-definitions, field-definitions) inside the tenant schema, related 1:many, but specify no column names, no id type beyond the Consistency Convention's "metadata ids are cuids" (which *does* pin id type, but nothing else), and no storage mechanism for the field's data type (Postgres native `enum` type vs. a `text`/`varchar` column validated in app code against a shared TS enum — the latter being exactly the pattern the current Prisma `DynamicField.dataType` comment documents and which AD-1 supersedes without saying whether the *reasoning* for that choice carries forward).

**Unit A:** ports the existing Prisma field names almost directly — `dynamic_tables(id, name, slug, description, created_at, updated_at)` / `dynamic_fields(id, table_id, name, slug, data_type text, required boolean, config jsonb, created_at, updated_at)` — `data_type` stored as `text`, validated against the shared `FieldDataType` TS enum, continuing the existing single-source-of-truth comment's reasoning.

**Unit B:** builds `tables_meta(uuid, display_name, key, ...)` / `fields_meta(field_id, parent_table_id, label, type_enum, options jsonb, is_required boolean, ...)`, using a real Postgres `ENUM` type for `type_enum` for stronger DB-level validation — a legitimate engineering choice AD-1 never forecloses since its enum-as-string reasoning is only ever stated as a comment about the *old Prisma* model, not restated as a rule for the new Knex tables.

**What breaks:** Any code, migration-record row, or cache-key logic (AD-5's per-table-id cache) written against one shape breaks against the other. This is lower severity than F1–F4 because it's implementation-detail divergence within a single module (one team likely builds all of this together) rather than a cross-team integration seam — but it's still a real gap the prompt asked about, and it's the kind of thing that causes churn/rework if two developers split CAP-1 (table create) and CAP-2 (field edit) work without a shared migration file to anchor on first.

**Fix direction:** Lowest-cost fix is a companion "Structural Seed" addendum (or a first migration file checked in before story-split work begins) that pins actual column names/types for both metadata tables — doesn't need to be in the spine itself, but needs to exist and be referenced before two people implement CAP-1/CAP-2 in parallel.

---

## LOW

### F6 — Identifier sanitization for user-supplied table/column names is "mirrored," not shared, so two sanitizers can legally diverge

**The gap.** The Consistency Convention row says physical table/column names are "slug-validated (mirrors `resolveTenantSchema()`'s allowlist discipline, applied to table/column identifiers too)." Verified in code: `resolveTenantSchema()` (`apps/backend/src/tenancy/resolve-tenant-schema.ts`) only sanitizes the **schema** name (`tenant_${tenantId}`, itself system-derived, never user input) — it exposes no reusable function for table/column identifiers. "Mirrors" is a design intent, not a shared utility the spine mandates reuse of.

**Unit A** writes its own slugifier: lowercase, `[a-z0-9_]`, must start with a letter, max 63 bytes (matching `resolveTenantSchema`'s own `MAX_SCHEMA_NAME_LENGTH` reasoning about Postgres `NAMEDATALEN` truncation).

**Unit B** writes a different one: allows mixed case preserved in a `name` column while deriving a separate normalized `slug` column for the physical identifier, with different reserved-word handling (or none) for Postgres reserved keywords as user-supplied field names (e.g. a field literally named "order" or "select").

**What breaks:** Lower severity than F1-F4 because both are "compliant" with the same vague convention and a mismatch here produces a validation/rejection bug (a name valid under Unit A's rules rejected/differently-truncated under Unit B's, or vice versa) rather than a cross-module architectural incompatibility — but it's still worth closing since NAMEDATALEN truncation silently colliding two user-chosen column names is the same bug class `resolveTenantSchema()` was hardened against for schema names.

**Fix direction:** Extract a single shared `resolveTenantIdentifier()`-style utility (same file/module as `resolveTenantSchema()`) that both table-name and column-name generation must call, so the discipline is enforced by one function instead of "mirrored" by convention.

---

## Summary Table

| # | Finding | Severity | AD(s) involved |
| --- | --- | --- | --- |
| F1 | No exclusivity rule forces DML through `DynamicTablesService`; a future module can write dynamic-table rows directly via `TenantKnexService`, bypassing CAP-3 validation entirely | Critical | AD-2, AD-3, AD-4 |
| F2 | AD-7's "foreign-key-style" permits both a real Postgres FK constraint and a plain unconstrained pointer column | High | AD-7 |
| F3 | AD-9 guardrails' storage location (tenant Knex schema vs. public-schema Prisma) is unpinned; the two readings are architecturally incompatible (bootstrapping vs. Prisma-dependency) | High | AD-9, AD-1 |
| F4 | CAP-5's `MIGRATION_RECORD` has no owner, shape, or stated mechanism (Knex's file-based runner vs. hand-rolled audit table); no codebase precedent resolves it | High | AD-1 (binds CAP-5) |
| F5 | Tenant-schema metadata table column names / FieldDataType storage mechanism unpinned below AD/ER level | Medium | AD-1, Structural Seed |
| F6 | Table/column identifier sanitization is "mirrored" by convention, not a shared utility — two sanitizers can diverge | Low | Consistency Conventions |

## Recommendation

Close F1 first — it's the one finding where a letter-compliant implementation actively defeats a capability's core promise (CAP-3 validation) rather than merely producing an incompatible-but-otherwise-safe shape. F2–F4 should each get a one-line rule addition (FK-or-not + ON DELETE; guardrail table location; MIGRATION_RECORD owner+shape) before story-split implementation begins, since all three are seams where two developers working in parallel would plausibly land on different, mutually incompatible answers without ever violating a written AD. F5/F6 are best closed by a pre-implementation "first migration file" artifact rather than more spine prose.
