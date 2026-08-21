---
title: Schema-per-Tenant Implementation Guide — Flexi Dynamic Table Builder
status: draft
audience: Flexi engineering (NestJS + Knex.js + PostgreSQL)
based_on:
  - _bmad-output/planning-artifacts/research/technical-dynamic-table-builder-schema-2026-08-17/research.md
  - _bmad-output/planning-artifacts/research/technical-schema-per-tenant-implementation-2026-08-18/research.md
created: 2026-08-18
updated: 2026-08-18
---

# Schema-per-Tenant Implementation Guide — Flexi Dynamic Table Builder

**Scope:** how to build schema-per-tenant multi-tenancy (each tenant gets its own PostgreSQL schema, containing both Flexi's own tables and the tenant's Dynamic-Table-Builder-created tables) for Flexi, on NestJS + Knex.js + PostgreSQL. This is an implementation guide, not a strategy comparison — schema-per-tenant is the already-made decision. It draws on two prior research passes: DDL safety/guardrails for Runtime DDL ([2026-08-17 research](research/technical-dynamic-table-builder-schema-2026-08-17/research.md)) and schema-per-tenant implementation mechanics ([2026-08-18 research](research/technical-schema-per-tenant-implementation-2026-08-18/research.md)). Schema-per-tenant does not replace the DDL-safety guardrails from the first pass — it changes their scope from "global" to "per-tenant-schema."

**Read this first — the one risk that gates everything else:** nothing in current public engineering writing validates schema-per-tenant combined with tenant-initiated, uncapped dynamic table creation. The scaling ceilings cited for schema-per-tenant (anywhere from a few hundred to ~10,000 tenants, depending on source) all implicitly assume a *fixed, developer-controlled* table count per tenant. Flexi's Dynamic Table Builder removes that assumption. Section 7 (Guardrails) is not optional polish — treat it as load-bearing from day one.

---

## 1. Architecture overview

```
Request → [Auth Guard: verify JWT] → [ClsModule middleware: resolve tenant]
                                            │
                              nestjs-cls (AsyncLocalStorage under the hood)
                                            │
                          ┌─────────────────┼─────────────────┐
                          ▼                 ▼                 ▼
                   Controller         Service layer      Data-access layer
                                                                │
                                                    resolveTenantSchema(tenantId)
                                                                │
                                                     knex.withSchema(schema)...
                                                                │
                                                  Shared connection pool → Postgres
                                                     schema: tenant_<id>
```

Two invariants hold everywhere below:

1. **Tenant identity only ever comes from a cryptographically verified JWT claim** — never from request body, query string, or header. [research 2026-08-18, §Integration & interoperability]
2. **Every query is schema-scoped via `knex.withSchema(schema)` at the call site.** No code path ever issues a session-level `SET search_path`. [research 2026-08-18, §Architecture patterns; verified against Knex docs]

---

## 2. Tenant-context propagation (NestJS)

**Use the `nestjs-cls` library, not hand-rolled `AsyncLocalStorage`, and not `REQUEST`-scoped providers.** [research 2026-08-18, §Architecture patterns — verified directly against the library's source]

- `REQUEST`-scoped providers were tried by a real NestJS+Knex+Postgres production implementation and abandoned: every dependent service is forced into request scope, so NestJS has to re-instantiate the whole dependency subgraph per request (source: inextenso.dev).
- `nestjs-cls` is actively maintained (~1M downloads/week, latest release 2026-05-25), lists "making the dynamic tenant database connection available everywhere in multi-tenant apps" as one of its stated core use cases, and — confirmed by reading its middleware source directly, not just its docs — **defaults internally to `cls.run()`** (the safe, properly-scoped pattern) and only uses the leak-prone `enterWith()` when a developer explicitly opts in via a `useEnterWith` flag. A hand-rolled implementation has to get that distinction right on its own; this library gets it right by default. It also ships a "Proxy Providers" feature specifically as a replacement for `REQUEST`-scoped providers, directly solving the problem above.

```ts
// app.module.ts
import { ClsModule } from 'nestjs-cls';

@Module({
  imports: [
    ClsModule.forRoot({
      middleware: {
        mount: true,
        setup: (cls, req: AuthenticatedRequest) => {
          // req.user is populated by the Auth Guard from a VERIFIED JWT —
          // never trust req.body/req.headers here.
          const tenantId = req.user?.tenantId;
          if (!tenantId) throw new UnauthorizedException('Missing tenant claim');

          cls.set('tenantId', tenantId);
          cls.set('schema', resolveTenantSchema(tenantId)); // throws if not allowlisted — see §3
        },
      },
    }),
  ],
})
export class AppModule {}
```

```ts
// tenant-context.ts — thin typed wrapper so call sites don't sprinkle string keys everywhere
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

@Injectable()
export class TenantContext {
  constructor(private readonly cls: ClsService) {}

  get schema(): string {
    const schema = this.cls.get<string>('schema');
    if (!schema) throw new Error('No tenant context — this code path must run inside an authenticated request');
    return schema;
  }
}
```

**Pitfalls to test against explicitly** (named production leak vectors — write regression tests for each): [research 2026-08-18, §Architecture patterns]

- A lookup query that filters by `id` alone, forgetting the schema/tenant scope — with schema-per-tenant this fails differently than row-level (wrong-schema query, not wrong-row), but the discipline is the same: never write a repository method that can execute without an explicit schema in scope.
- Cache keys not namespaced by tenant (`cache:settings` instead of `cache:tenant_${id}:settings`).
- Background/queue jobs that lose tenant context — **carry `tenantId` explicitly in every job payload**; `AsyncLocalStorage` does not survive a queue boundary.
- Admin routes that reuse tenant-scoped service methods without re-deriving schema for the target tenant.

---

## 3. Security: schema-name resolution and injection control

This is the single most important code path in the whole implementation. A real, dated vulnerability (**CVE-2026-44680**, published 2026-05-05) is a confirmed SQL-injection bug reachable through exactly this pattern — unsanitized tenant-controlled strings reaching `.withSchema()`-style APIs — in a different ORM's Knex driver. The mechanism (unescaped SQL-identifier quoting) is generic and applies to any hand-rolled `.withSchema(tenantSchema)` call, not just that ORM. [research 2026-08-18, §Integration & interoperability, independently re-verified against the GitHub Security Advisory]

**Rule: `tenantId` never becomes a schema name directly.** Always resolve through a server-side lookup, validated against an allowlist pattern, never string-concatenated from client input:

```ts
// resolve-tenant-schema.ts
const SCHEMA_NAME_PATTERN = /^[A-Za-z_][\w$]*$/; // Postgres identifiers cannot be parameterized — validate, then quote.

export function resolveTenantSchema(tenantId: string): string {
  // tenantId itself should already be a verified, server-issued UUID from the JWT claim —
  // but defense in depth: never trust it blindly, and never derive the schema name by
  // string-concatenating raw client input.
  const schema = `tenant_${tenantId}`;

  if (!SCHEMA_NAME_PATTERN.test(schema)) {
    // This should be unreachable if tenantId is a UUID, but fail loudly if it ever isn't.
    throw new Error(`Refusing unsafe schema name derived from tenantId: ${tenantId}`);
  }

  // Stronger option: look up the schema name from a tenants table keyed by tenantId,
  // rather than deriving it by string interpolation at all — removes the injection
  // surface entirely by construction. Prefer this once the tenants registry exists.
  return schema;
}
```

Apply the allowlist **even though** `tenantId` is expected to already be a server-verified UUID — the CVE was exploitable precisely because a codebase trusted an upstream value that was "supposed to" already be safe. Unit-test `resolveTenantSchema()` directly with adversarial inputs (`"public; DROP TABLE"`, `"a\" OR \"1\"=\"1"`, etc.) as part of the standard test suite, not as an afterthought.

---

## 4. Query routing — the Knex pattern

```ts
// tenant-knex.service.ts
import { Injectable } from '@nestjs/common';
import Knex from 'knex';
import { TenantContext } from './tenant-context';

@Injectable()
export class TenantKnexService {
  constructor(private readonly tenantContext: TenantContext) {}

  // ONE shared pool for the whole app — never one pool per tenant.
  // A real production implementation warns that per-tenant pools exhaust
  // Postgres max_connections as tenant count grows ("too many clients already").
  // [research 2026-08-18, §Integration & interoperability]
  private readonly knex = Knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: { min: 2, max: 50 },
  });

  /** Scoped query builder for the CURRENT request's tenant. Never call this.knex directly outside this class. */
  forCurrentTenant() {
    return this.knex.withSchema(this.tenantContext.schema);
  }
}
```

```ts
// example repository usage
async findOrder(id: string) {
  return this.tenantKnex.forCurrentTenant()
    .table('orders')
    .where({ id })
    .first();
  // Compiles to: select * from "tenant_<id>"."orders" where "id" = ?
  // No SET search_path anywhere in this path.
}
```

**Never** issue `SET search_path = ...` or `SET SESSION ...` anywhere in the codebase. Under PgBouncer's transaction-mode pooling (the standard production pooling mode), a session-level `SET` is not guaranteed to survive to the next statement — the backend connection can be recycled to a *different tenant* between transactions, and a backend that just served tenant A can silently be handed to tenant B still holding tenant A's `search_path`. This is corroborated independently twice, six years apart, by different publishers — it is a structural property of transaction-mode pooling, not a bug that gets fixed. [research 2026-08-18, §Integration & interoperability — verified]

If a raw-SQL escape hatch is ever genuinely unavoidable (e.g. a Postgres extension that must be schema-qualified in DDL), scope it with **transaction-scoped** `set_config('search_path', schema, true)` or `SET LOCAL` inside an explicit `BEGIN...COMMIT`, never a bare session-level `SET`. [research 2026-08-18, §Integration & interoperability]

---

## 5. Tenant provisioning (new-tenant onboarding)

No source found a mature production comparison of template-cloning vs. migration-replay for a Node/Knex stack specifically — this is a judgment call, not a settled best practice. **Default recommendation: migration-replay**, because it keeps migration history authoritative (every tenant's schema is provably the result of the same migration set that's under version control) and avoids template/schema drift. Revisit only if tenant-onboarding latency becomes a measured problem. [research 2026-08-18, §Implementation reality]

```ts
// provision-tenant.ts (sketch — runs as a background job, never inline in a request handler)
async function provisionTenant(tenantId: string, knex: Knex) {
  const schema = resolveTenantSchema(tenantId);

  await knex.raw('CREATE SCHEMA IF NOT EXISTS ??', [schema]); // identifier-bound via `??`, never string-interpolated

  // IMPORTANT: schemaName below only relocates the knex_migrations tracking table —
  // it does NOT scope the migration's own DDL to `schema`. Every migration file must
  // read the target schema from knex.userParams and call .withSchema() itself.
  // See §6 for why, and for the correct migration-file pattern.
  const tenantKnex = knex.withUserParams({ schema });
  await tenantKnex.migrate.latest({
    directory: './migrations',
    schemaName: schema,
    tableName: 'knex_migrations', // created INSIDE the tenant schema, not shared
  });
}
```

If provisioning latency later becomes a real constraint, the PL/pgSQL `clone_schema()` pattern (documented on the official Postgres wiki) is the most-precedented alternative — but confirm current behavior against your Postgres version before adopting it; the primary source describing it is not version-pinned. [research 2026-08-18, §Implementation reality]

---

## 6. Migrations across tenant schemas

**There is no mature tool for this, and there is a correctness trap in the obvious approach.** Knex has no native multi-schema migration-tracking support — the core GitHub issue has been open since 2016 [research 2026-08-18, §Implementation reality]. The trap: `migrate.latest({ schemaName })`'s `schemaName` option looks like it scopes an entire migration run to a tenant's schema — **it does not.** A Knex core maintainer confirmed on the record (and current official Knex docs say the identical thing today) that `schemaName` **only controls where the `knex_migrations`/`knex_migrations_lock` tracking tables are created — it has no effect on which schema the migration's own DDL runs against.** [research 2026-08-18, §Implementation reality — independently verified against the GitHub issue thread and current Knex docs] A naive loop that just passes `schemaName: tenantSchema` to `migrate.latest()` will silently run every `CREATE TABLE`/`ALTER TABLE` against the connection's *default* schema for every single tenant, while appearing to succeed — the tracking table lands in the right place, the actual objects don't.

**The correct pattern:** clone the Knex instance per tenant with `withUserParams({ schema })`, and write every migration file to read that schema back out and call `.withSchema()` on every statement itself:

```ts
// migrations/20260101000000_create_orders.ts — every migration file follows this shape
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const schema = knex.userParams.schema as string; // set via withUserParams() by the caller — see below
  if (!schema) throw new Error('Migration run without a tenant schema in userParams');

  await knex.schema.withSchema(schema).createTable('orders', (table) => {
    table.increments('id').primary();
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  const schema = knex.userParams.schema as string;
  await knex.schema.withSchema(schema).dropTableIfExists('orders');
}
```

```ts
// migrate-all-tenants.ts — run at deploy time (or, at meaningful tenant counts, via the
// async DDL queue per §7 below), NOT from request-handling code
async function migrateAllTenants(baseKnex: Knex, tenantSchemas: string[]) {
  const results: { schema: string; ok: boolean; error?: unknown }[] = [];

  for (const schema of tenantSchemas) {
    try {
      // withUserParams() is what makes knex.userParams.schema available inside the
      // migration files above — schemaName alone (next line) only relocates the
      // tracking table, it does NOT do this.
      const tenantKnex = baseKnex.withUserParams({ schema });
      await tenantKnex.migrate.latest({ directory: './migrations', schemaName: schema, tableName: 'knex_migrations' });
      results.push({ schema, ok: true });
    } catch (error) {
      // Do NOT abort the whole run on one tenant's failure — log and continue,
      // then alert on any failures. One tenant's migration issue must not block every other tenant.
      results.push({ schema, ok: false, error });
    }
  }

  return results;
}
```

**Write a regression test that asserts objects actually land in the tenant schema**, not just that the migration "succeeds" — e.g. after running `migrateAllTenants` against a test schema, query `information_schema.tables WHERE table_schema = $1` and assert the expected tables are present *there*, not in `public`. A migration file that forgets `.withSchema()` on one statement will still report success while silently creating that one object in the wrong place — this class of bug is invisible without an explicit assertion.

**Zero-downtime migration across all tenant schemas is a separate, still-unsolved problem** even in the one real production reference found for this exact stack — don't assume it away. For anything beyond additive, backward-compatible changes (new nullable columns, new tables), plan an explicit expand/contract rollout across the tenant loop, the same discipline already established for Flexi's Runtime DDL guardrails (§7 of the prior research), just replayed per schema. [research 2026-08-17 + 2026-08-18]

**Carry forward the DDL-safety controls from the Runtime DDL research, per-schema:**

- `SET lock_timeout = '2s'` before every `ALTER TABLE`, whether it's a platform migration or a tenant's own Dynamic-Table-Builder DDL — this is per-connection, not per-schema, so it applies unchanged.
- Run DDL through an async queue (Redis/BullMQ), never inline in the request/response cycle — this is where the migration loop above should actually execute from, not a synchronous deploy-time script for tenant counts beyond the low hundreds.
- Additive `ADD COLUMN ... DEFAULT <constant>` is still metadata-only/O(1) in Postgres 11+ — cheap regardless of how many tenant schemas you loop through.

---

## 7. Guardrails — the load-bearing section

Sources disagree by roughly 10–50× on how many tenant schemas Postgres comfortably supports (1,000–2,000 vs. 10,000–50,000). Reconciling the disagreement: **the real constraint is total catalog object count (schemas × tables × indexes × constraints), not schema count alone.** A documented real-world case of ~1,200 schemas × ~200 tables (~240,000 total tables) saw migration runs approach two hours and severe query-planner slowdown, because `pg_catalog` is shared across the whole database, not partitioned per schema. [research 2026-08-18, §Implementation reality — this research's own reconciliation]

**This is why Flexi cannot treat schema-per-tenant as removing the need for per-tenant guardrails already established for the Runtime DDL model** — it relocates the cap from "global" to "per-tenant-schema," it doesn't remove it:

| Guardrail | Scope under schema-per-tenant | Source |
|---|---|---|
| Max dynamic tables per tenant | Enforced per-schema (was: per-tenant-row-partition under the row-level model) | research 2026-08-17 (原 100 cols/table, row/tenant limits) + this research's reconciliation |
| Max columns per table | Unchanged — still a per-table cap | research 2026-08-17 |
| `lock_timeout` on DDL | Unchanged — per-connection, applies to every schema | research 2026-08-17 |
| Async DDL queue | Unchanged — every tenant's DDL (platform migration or Dynamic-Table-Builder user action) goes through the same queue | research 2026-08-17 |
| **New: total catalog object budget** | **Track `schemas × avg tables/schema × avg indexes/table` as a fleet-wide metric; alert well before approaching the range where the documented real case saw 2-hour migrations (~240,000 total tables)** | this research (2026-08-18), reconciled from disputed source ranges — **not independently benchmarked for Flexi's exact combination; treat as a starting cap to validate under load, not a proven-safe number** |

**Concretely, until Flexi has its own measured data:** set an explicit per-tenant cap on Dynamic-Table-Builder tables (reuse the number from the first research pass — 100 columns/table, and add an explicit tables-per-tenant cap that wasn't needed under the row-level model but is now required) and monitor total object count as a first-class operational metric, not an afterthought. Revisit the cap once Flexi has real tenant/table-count data — no external source validates this specific combination (schema-per-tenant + tenant-created dynamic tables), so this guardrail is Flexi's own risk mitigation, not an industry-confirmed number.

---

## 8. Operational checklist

- [ ] **Backups scale with total object count, not schema count** — a single `pg_dump` per tenant schema does not avoid the cost; prefer one `pg_dump --format=custom` (or parallel directory-format dump) for the whole database, then `pg_restore --schema=<name>` per schema when a single tenant needs restoring. [research 2026-08-18, §Implementation reality]
- [ ] **Monitor catalog growth explicitly** (`pg_class`/`pg_attribute` row counts, or a periodic `SELECT schemaname, count(*) FROM pg_tables GROUP BY schemaname` rollup) as a dashboarded metric, not something discovered during an incident.
- [ ] **PgBouncer configuration:** confirm `pool_mode=transaction`, and do not attempt to use `track_extra_parameters` as a substitute for the `.withSchema()` discipline above — it was mentioned as a mitigation but not independently confirmed against PgBouncer's own docs in this research. [open question, research 2026-08-18]
- [ ] **Cache and background-job tenant hygiene:** every cache key namespaced by tenant; every job payload carries `tenantId` explicitly (AsyncLocalStorage does not cross a queue boundary).
- [ ] **`resolveTenantSchema()` has adversarial unit tests** covering injection-style inputs, not just the happy path.
- [ ] **Migration loop runs through the async DDL queue at meaningful tenant counts**, not a synchronous deploy script — every migration file must use the `withUserParams()`/`.withSchema()` pattern from §6, not `schemaName` alone.
- [ ] **`nestjs-cls` is wired via `ClsModule.forRoot()` in `AppModule`**, not a hand-rolled `AsyncLocalStorage` instance — confirm `middleware.mount: true` so it runs before route handlers.

---

## 9. What's explicitly NOT solved by this guide (carry as known risk)

- **Zero-downtime schema migration across all tenant schemas** — no source, including the one real production reference for this exact stack, has a validated solution. Plan for maintenance windows or an expand/contract rollout per §6 until this is solved in-house.
- **The exact safe ceiling for Flexi's specific combination** (schema-per-tenant + uncapped tenant-created dynamic tables) is not validated anywhere in current public engineering writing. §7's caps are a reasoned starting point, not a proven-safe number — revisit with real data.

**Resolved since the first draft of this guide (both verified directly, 2026-08-18):**

- The `migrate.latest({ schemaName })` question — confirmed intended behavior (tracking-table location only, not DDL scoping), not a bug, current in Knex today. §6 reflects the correct `withUserParams()` pattern required to actually scope migration DDL per tenant.
- The `nestjs-cls` evaluation — confirmed actively maintained, purpose-built for this exact multi-tenant use case, and defaults internally to the safe `.run()` pattern (verified by reading its middleware source directly). §2 now recommends it over hand-rolled `AsyncLocalStorage`.

---

## References

- [Technical research: Dynamic Table Builder schema architecture](research/technical-dynamic-table-builder-schema-2026-08-17/research.md) — Runtime DDL safety, indexing, guardrail numbers, Knex vs. Prisma (processed import, 2026-08-17)
- [Technical research: Schema-per-tenant implementation](research/technical-schema-per-tenant-implementation-2026-08-18/research.md) — this guide's primary source, native research run, 18 sources (2026-08-18)
