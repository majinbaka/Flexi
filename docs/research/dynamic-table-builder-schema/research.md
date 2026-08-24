---
title: 'technical research: Dynamic Table Builder schema architecture'
type: 'technical'
topic: 'Dynamic Table Builder — schema architecture and performance for a runtime-DDL, row-level multi-tenant, REST-only Postgres platform'
decision: 'Reference material for Flexi — not yet bound to a specific architecture decision (user declined binding at intake)'
source: 'Processed import: imports/report.md — unnamed AI research tool, no external citations, self-reported production date 2026-08-17'
status: complete
preset: 'standard'
validation: 'normal'
created: '2026-08-17'
updated: '2026-08-17'
---

# Technical research: Dynamic Table Builder schema architecture

**Decision this research serves:** Reference material for Flexi's Dynamic Table Builder module. The user explicitly declined to bind this pass to a specific architecture decision — it is filed for later use, most likely by `bmad-architecture` or a PRD for the module.

## Executive summary

The import argues for **Runtime Physical DDL** (real `CREATE TABLE`/`ALTER TABLE` per user-defined table/field, PostgreSQL native types) as the storage strategy for a row-level multi-tenant, REST-only, Postgres-backed Dynamic Table Builder — the same approach used by Baserow, NocoDB, Directus, and Retool DB — over JSONB-hybrid (Xano-style), EAV, or an in-memory grid engine (Airtable-style). Three findings drive that recommendation, each spot-checked against independent Postgres/Prisma/Knex documentation:

1. Postgres's `ACCESS EXCLUSIVE` lock on `ALTER TABLE` is real and does cascade-block a busy table, which makes an enforced `lock_timeout` and an asynchronous DDL queue a genuine safety requirement, not just caution — **verified**.
2. `ADD COLUMN ... DEFAULT` has been metadata-only (O(1)) since Postgres 11, so additive schema changes are cheap by default — **verified**.
3. Prisma's compile-time schema model is a hard architectural mismatch for user-created runtime tables, which is why the import's call for a separate Knex.js-based dynamic query/DDL layer is sound — **verified**.

**Biggest caveat:** the import itself carries **zero external citations, publisher names, or dates** for any claim — including every numeric guardrail (row limits, rate limits, page sizes) and all four named postmortems. Those read as plausible, internally consistent illustrative figures rather than confirmed facts about real vendors or real incidents, and should not be quoted externally as sourced data. The architectural mechanics (Postgres locking, JSONB/TOAST behavior, Prisma's limits, Knex's capabilities) check out against real documentation; the specific numbers attached to them do not currently have a traceable source.

Two pack dimensions the import does not cover at all: **integration & interoperability** (auth patterns, protocols/formats for exposing dynamic tables — the import stays REST-only by assumption) and **ecosystem health** (release cadence, maintenance vitality, or five-year regret risk for Baserow/NocoDB/Directus/Knex.js as dependencies). Both are open — see Open Questions.

## Landscape & maturity

Four schema strategies recur across low-code/no-code platforms that let end users define data structures at runtime [1]:

| Strategy | Representative platforms | Core storage mechanism | Main advantage | Main disadvantage |
|---|---|---|---|---|
| Runtime Physical DDL | Baserow, NocoDB, Directus, Retool DB | Real physical SQL tables/columns per user table/field | Native SQL query speed, data integrity, easy export | DDL locks on structure changes, system-catalog bloat |
| JSONB / Dynamic Hybrid | Xano | Fixed tables + JSONB column, generated/expression indexes on hot paths | Avoids DDL locks, flexible tenant isolation | Storage overhead, full-document rewrite cost |
| EAV | Legacy CMS, Salesforce Core (per import; unverified as current fact) | Fixed Entities/Attributes/Values tables | No runtime DDL needed | JOIN explosion, severe degradation at scale |
| In-memory grid engine | Airtable | C++ in-RAM spreadsheet engine, async sync to a persistence store | Instant computation response | High RAM cost, strict record-count ceilings |

Baserow's placement in the Runtime-DDL group **checks out independently**: it is a Django + PostgreSQL application where every user-defined table is generated as a real Django model backed by an actual Postgres table via `TableHandler` and Django migrations [2] — confirming the import's characterization is accurate for at least this platform, not merely asserted. NocoDB and Directus's descriptions (UI operations compiled to physical DDL; "database-first" 1:1 collection/field-to-table/column mapping) are consistent with their public positioning but were not independently re-verified in this pass — spot-check budget went to the mechanisms Flexi would actually build against (Postgres, Prisma, Knex), not to re-confirming every named competitor.

**Implication for Flexi:** in a `tenant_id`-partitioned shared Postgres database, Runtime DDL requires every user-created physical table to carry a `tenant_id` column, and pays off specifically because a composite B-Tree on `(tenant_id, …)` gives native-SQL REST read/write performance. Choosing JSONB-hybrid instead trades that performance for eliminating DDL-lock risk outright — a real trade, not a strictly dominant option either way.

## Architecture patterns in practice

### Scale trade-offs

Runtime DDL's scale risk is concrete and independently groundable, even though the import's own account isn't cited: Postgres tracks structure in system catalogs (`pg_class`, `pg_attribute`, `pg_index`) and in per-connection relcache; a very large number of physical tables inflates both, and relcache invalidation messages broadcast to all connections on DDL churn. The import's recommendation — cap dynamic tables per tenant, and above roughly 20,000 dynamic tables system-wide, split the model (Runtime DDL for high-traffic core tables, JSONB for low-query-frequency custom fields) — is a reasonable engineering heuristic but the 20,000 threshold itself is asserted without a source and should be treated as a starting guess to load-test, not a validated ceiling.

JSONB/Hybrid's cost is the mirror image and rests on a real Postgres mechanism: large JSONB values are TOASTed, and updating even one key inside a JSONB document rewrites the whole stored value, which is genuine write amplification — this is standard, well-known Postgres behavior, not a claim specific to this report.

### Indexing for user-defined fields

The import's indexing policy splits cleanly into auto vs. opt-in and **the core mechanism is verified**:

- **Auto-indexed:** primary key + `tenant_id`; foreign keys / relational link fields; a standard `(tenant_id, created_at)` composite for default pagination.
- **Opt-in (user marks a field "Filterable"/"Searchable"):** `(tenant_id, field)` B-Tree for standard filters; `GIN … gin_trgm_ops` for fuzzy/`LIKE '%x%'` text search; `(tenant_id, (data->>'key'))` expression or `jsonb_path_ops` GIN for JSONB paths.
- **Leading-column rule:** every index should carry `tenant_id` as the leading column so a query only walks the current tenant's branch of the index, never a global scan.

`pg_trgm` + GIN for fuzzy `LIKE` search is standard, documented Postgres behavior — confirmed against the extension's own documentation [5]. The leading-`tenant_id` rule is sound relational-database practice (it is how any partition-key-first composite index behaves) though the import states it as a flat mandate rather than showing the trade-off against, e.g., a query that never filters by tenant.

### Runtime DDL safety

This is the import's strongest, most independently-confirmable section:

- `ALTER TABLE` in Postgres takes `ACCESS EXCLUSIVE`, which blocks **all** reads and writes on the table and queues behind (and is queued behind by) other statements — **verified** against Postgres documentation and independent technical write-ups [4]. The import's "lock starvation cascading failure" mechanism — a long SELECT holds the table, the pending ALTER queues, every SELECT arriving after the ALTER queues behind it too — is exactly how Postgres's lock queue is documented to behave.
- `SET lock_timeout = '2s'` before DDL, so a blocked ALTER fails fast instead of starving the connection pool, is a standard mitigation for exactly this failure mode.
- `ADD COLUMN … DEFAULT <constant>` has been metadata-only since Postgres 11 (stored in `pg_attribute.attmissingval`, no table rewrite) — **verified** [3]. The import correctly restricts this to constant/non-volatile defaults; it does not spell out that a volatile default (e.g. a function call) still forces a full rewrite, which is worth adding if this is later formalized into an architecture doc.
- The 4-step online column-type-change pattern (new column → dual write → batch backfill → cutover/drop) is the standard "expand/contract" migration pattern used broadly in the industry; the import doesn't name it as such but describes it correctly.
- Wrapping physical DDL and metadata updates (Flexi's 14 fixed Prisma tables, per the import) in one SQL transaction, and moving DDL execution off the request/response path into a Redis-backed queue (BullMQ named specifically), are both standard, low-risk recommendations for this problem shape.

## Implementation reality

### Operational guardrails

The import proposes concrete ceilings — 100,000 rows/tenant table, 10–20 req/s/tenant, 100 columns/table, default/max REST page size 50/100, batch limit 50 records/request, 2 MB body-parser limit, `statement_timeout = '5s'` — framed as consistent with tiers reported for Airtable, NocoDB, Baserow, and Teable. **None of these numbers, for the named vendors or for the recommendation, carry a source in the import**, and this pass did not independently re-verify vendor pricing/tier pages (out of scope for a normal-validation spot-check, and vendor limits change on their own release cadence regardless). Treat the target-system column as a designer's starting proposal, not a benchmarked figure — reasonable as a first cut, but validate against Flexi's own expected tenant sizes before hard-coding it.

### Query/CRUD layer

Prisma manages a fixed, compile-time schema and cannot represent tables created at runtime without workarounds (dynamic schema-file writes + `prisma migrate`, or raw SQL) — this is a real, well-documented architectural boundary of Prisma, not specific to this report [6]. Knex.js is recommended as the dynamic query/DDL layer specifically because it exposes both a DML query builder and a schema builder (`knex.schema.alterTable(...)`) against Postgres from Node.js — **verified**, this is exactly what Knex ships [7]. Kysely and raw `pg`/Slonik are presented as the alternatives, correctly characterized as harder to use for fully dynamic tables (Kysely) or higher-maintenance for dynamic filter construction (raw SQL) — both are reasonable, if unremarkable, characterizations rather than claims this pass needed to independently re-check.

For N+1 avoidance on linked-record REST responses, the import recommends server-side `json_agg`/`json_build_object` aggregation in a single query, or batching foreign keys into one `WHERE id IN (...)` plus in-memory joining (a DataLoader-style pattern) — both are standard, sound techniques for exactly this problem. Metadata caching (`schema:{tenant_id}:{table_id}` in Redis, invalidated on any DDL) is a reasonable complement, not independently checked here.

## Cross-dimension insights

The report's own synthesis — Runtime DDL for core tables + tenant-id-leading composite indexes + a Knex layer separated from Prisma + async DDL with short `lock_timeout` + strict guardrails — holds together as a coherent architecture *only if* the guardrail numbers are validated against Flexi's real workload, because the whole design's safety story (why DDL is survivable at scale) depends on bounding table count and row count per tenant. The verified mechanics (locking, indexing, Knex/Prisma boundary) explain **why** each guardrail exists; the guardrails themselves are the one part of this synthesis this pass could not confirm as anything more than a plausible starting point.

## Contrary evidence

Red-team pass did not run (`red_team = off`, `validation = normal` — spot-check only, no adversarial pass triggered). Not evaluated in this pass.

## Recommendations

1. **Adopt Runtime Physical DDL as the default storage model** for Flexi's Dynamic Table Builder, with mandatory `tenant_id` on every dynamic table and as the leading column of every dynamic index. Confidence: **medium** — the mechanism is verified; the specific scale thresholds are not. *Feeds:* candidate paradigm for the module's architecture spine.
2. **Enforce `SET lock_timeout` before every runtime DDL statement and move DDL execution to an async queue** (e.g. BullMQ) outside the request/response cycle. Confidence: **high** — the failure mode this defends against (lock-queue cascade) is independently confirmed Postgres behavior. *Feeds:* architecture constraint (operational).
3. **Build the dynamic CRUD/DDL layer on Knex.js, kept separate from Prisma**; use Prisma only for Flexi's own fixed metadata tables. Confidence: **high** — Prisma's compile-time limitation and Knex's dual query/schema-builder capability are both independently verified. *Feeds:* architecture spine, roadmap estimate (a type-coercion layer over Knex's raw results is real extra work to budget).
4. **Before adopting any of the numeric guardrails (row/column/rate/page-size limits) as Flexi's actual limits, re-derive them from Flexi's expected tenant profile** rather than the import's figures, which have no traceable source. Confidence: **low** as stated in the import; treat as a design starting point only. *Feeds:* brief feasibility / non-functional requirements.
5. **Use server-side JSON aggregation (`json_agg`) for linked-record REST responses** to avoid N+1; this is a well-established pattern independent of this specific report. Confidence: **high**. *Feeds:* architecture spine (API layer pattern).

## Open questions

- **Integration & interoperability** (pack dimension not covered by the import): what auth pattern, request/response contract, and webhook/event model does Flexi's Dynamic Table Builder expose beyond "REST-only"? Route: a targeted Run or Draft on this specific gap when the API contract is being designed.
- **Ecosystem health** (pack dimension not covered): release cadence, maintenance risk, and governance for Knex.js and any adopted Runtime-DDL reference platform, as a dependency-risk input to the five-year regret question. Route: a short technical Run scoped to "Knex.js maintenance health" plus whichever competitor platform (if any) Flexi ends up studying as a closer reference than Baserow.
- **Are the numeric guardrails (100k rows/tenant, 10–20 req/s, 100 cols/table, etc.) right for Flexi specifically?** The import supplies no derivation; only load-testing against Flexi's actual tenant shape can answer this. Route: defer to implementation/load-testing, not further research.
- **Is EAV genuinely abandoned by "most modern platforms," or is that an overstatement?** Plausible directionally, unverified as a current landscape fact. Route: skip unless EAV becomes a live candidate — low decision relevance given Runtime DDL is already the recommended path.

## Source appendix

| # | Claim / finding it supports | Publisher | Pub. date | Accessed | Confidence |
|---|---|---|---|---|---|
| [1] | Full landscape taxonomy, all four schema strategies, scale trade-offs, indexing policy, DDL-safety procedure, guardrail numbers, query-layer comparison, four postmortems | [Imported report (imports/report.md) — unnamed AI research tool, author unstated](imports/report.md) | 2026-08-17 (self-reported, unverifiable) | 2026-08-17 | low |
| [2] | Baserow is Django + PostgreSQL; user tables are real physical Postgres tables generated via Django models/migrations | [How Baserow lets users generate Django models on the fly (Baserow blog; see also Baserow Database plugin docs)](https://baserow.io/blog/how-baserow-lets-users-generate-django-models) | undated (vendor docs/blog) | 2026-08-17 | high |
| [3] | Postgres 11+: `ADD COLUMN … DEFAULT <constant>` is metadata-only (O(1)), no table rewrite | [A Missing Link in Postgres 11: Fast Column Creation with Defaults — brandur.org (see also PostgreSQL 11 Docs, 5.5 Modifying Tables)](https://brandur.org/postgres-default) | 2018 (PG11 release) / current docs | 2026-08-17 | high |
| [4] | `ALTER TABLE` takes `ACCESS EXCLUSIVE`, blocks all reads/writes, queues behind/ahead of other statements | [PostgreSQL Docs — 13.3 Explicit Locking (see also: Schema changes and the Postgres lock queue, xata.io)](https://www.postgresql.org/docs/current/explicit-locking.html) | current docs / blog | 2026-08-17 | high |
| [5] | `pg_trgm` + GIN index accelerates fuzzy/`LIKE '%x%'` search, avoiding full table scans | [PostgreSQL Docs — F.35. pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html) | current docs | 2026-08-17 | high |
| [6] | Prisma requires compile-time schema; architecturally incompatible with fully dynamic runtime tables without workarounds | [Prisma reflection during runtime? — GitHub Discussion #12680 (see also Discussion #9534, "Dynamic table name?")](https://github.com/prisma/prisma/discussions/12680) | ongoing discussion thread | 2026-08-17 | medium |
| [7] | Knex.js provides both a query builder and a schema builder (`knex.schema.alterTable`) for Postgres from Node.js | [Schema Builder — Knex.js docs (see also knexjs.org homepage)](https://knexjs.org/guide/schema-builder.html) | current docs | 2026-08-17 | high |

## Staleness map

Computed via `recon_kit.py staleness` against the technical pack's freshness bars (versions/compatibility ≤ 1 mo · ecosystem signals ≤ 6 mo · landscape ≤ 12 mo · patterns ≤ 2 yr), from today (2026-08-17):

| Claim class | Example | Re-check by |
|---|---|---|
| versions/compatibility (Postgres lock behavior, `ADD COLUMN` O(1), Prisma limits, `pg_trgm`) | "Postgres 11+ ADD COLUMN DEFAULT is metadata-only" | **2026-09-17** |
| ecosystem (vendor guardrail tiers: row/rate/page/batch limits) | "Airtable/NocoDB/Baserow/Teable row & rate limits" | 2027-02-17 |
| landscape (vendor schema-strategy classification) | "Baserow/NocoDB/Directus run Runtime DDL" | 2027-08-17 |
| patterns (catalog bloat, TOAST amplification, N+1/json_agg, Knex recommendation, postmortems) | "Catalog bloat degrades query planning at high table counts" | 2028-08-17 |

**Earliest re-check: 2026-09-17** — the versions/compatibility class (Postgres/Prisma mechanics), which is also where this pass placed its highest-confidence, independently-verified claims; a re-check mainly guards against a future Postgres/Prisma release changing this behavior, not against the current claims being wrong today.
