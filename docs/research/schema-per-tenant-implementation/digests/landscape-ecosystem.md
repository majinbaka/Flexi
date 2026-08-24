# Digest: Landscape & Maturity — Node.js Schema-per-Tenant Tooling Ecosystem

**Topic:** Schema-per-tenant multi-tenancy on PostgreSQL for NestJS + Knex.js
**Dimension:** Landscape & maturity (tooling ecosystem)
**Accessed:** 2026-08-18

---

## Q1. Node.js ecosystem libraries for Postgres schema-per-tenant

| Package | Wraps | Latest version | Publish date | Adoption signal | Automates | Leaves to dev |
|---|---|---|---|---|---|---|
| `knex-postgres-multi-tenancy` (wgrisa) | Knex | 1.1.0 | 2020-04-08 | 4 GitHub stars, 1 open issue | Query prefixing via `$_` convention; runs migrations per tenant before returning a scoped knex instance | Everything else; connect/Express middleware only |
| `@nestjs-multitenant/typeorm` | TypeORM (not Knex) | 1.0.1 | 2025-06-18 | ~7 npm downloads/month (near-zero) | Per-tenant `DataSource` management, request-scoped tenant resolution, `@InjectTenantRepository()` DI, connection pooling per tenant | Actual migration orchestration across schemas; tenant provisioning logic |

**{claim: "knex-postgres-multi-tenancy does NOT implement Postgres schema-per-tenant — it implements table-prefix multi-tenancy within a single schema (e.g. `tenant_123_users`), despite the package name", source: "knex-postgres-multi-tenancy GitHub README", publisher: github.com/wgrisa/knex-postgres-multi-tenancy, pub_date: 2020-04-08 (last release), accessed: 2026-08-18, confidence: high, class: ecosystem}**

**{claim: "knex-postgres-multi-tenancy has had no release since April 2020 (v1.1.0) and has only 4 GitHub stars — effectively unmaintained/negligible adoption", source: "npm registry + GitHub repo", publisher: registry.npmjs.org / github.com/wgrisa/knex-postgres-multi-tenancy, pub_date: 2020-04-08, accessed: 2026-08-18, confidence: high, class: ecosystem}**

**{claim: "@nestjs-multitenant/typeorm (the closest NestJS-specific schema-per-tenant helper) last published 1.0.1 on 2025-06-18 (~14 months before this research date) and has approximately 7 downloads/month on npm — essentially unused in production", source: "npm registry API (downloads/point) + registry.npmjs.org package metadata", publisher: api.npmjs.org, pub_date: 2025-06-18, accessed: 2026-08-18, confidence: high, class: ecosystem}**

**No dedicated, actively-adopted Knex-specific schema-per-tenant library was found.** Search for "schema per tenant node.js library 2025/2026" surfaced only hand-rolled implementation blog posts (see below), not packages — a landscape signal in itself: the Node ecosystem lacks a de facto standard tool comparable to Rails' Apartment or Django's django-tenants.

**{claim: "For NestJS + Knex + Postgres specifically, the pattern in practice is hand-rolled: a custom database module, a Postgres client/pool wrapper, tenant-ID extraction middleware, AsyncLocalStorage for context propagation, and manual `.withSchema(tenantId)` calls per query — no library abstracts this", source: "Multi-tenancy (Schema separated) with NestJS, Knex and PostgreSQL in SAP BTP", publisher: Nicola Zanon, inextenso.dev, pub_date: 2022-10-01, accessed: 2026-08-18, confidence: high, class: patterns}**

**{claim: "Even the hand-rolled reference implementation explicitly leaves zero-downtime migrations, tenant-specific background jobs, security hardening, and testing as unsolved/out-of-scope problems", source: "same as above (Zanon, inextenso.dev)", publisher: inextenso.dev, pub_date: 2022-10-01, accessed: 2026-08-18, confidence: high, class: patterns}**

A parallel TypeORM-focused write-up (Luca Scalzotto, "Schema-based multitenancy in NestJS with TypeORM," scalzotto.nl) surfaced in search results describing the same pattern for TypeORM instead of Knex — title/topic only, not deep-fetched; listed as a lead below since it corroborates the "roll your own" landscape finding but its full content and freshness are unverified this session.

---

## Q2. Prior art from other ecosystems: failure modes and mature solutions

### Ruby — Apartment gem (Rails)

**{claim: "The Apartment gem's latest release is v2.2.1, released 2019-06-19 — over 7 years stale as of this research date — despite 5.2 million cumulative downloads, meaning it is widely historically adopted but not currently maintained upstream", source: "RubyGems package page", publisher: rubygems.org/gems/apartment, pub_date: 2019-06-19, accessed: 2026-08-18, confidence: high, class: ecosystem}**

**{claim: "The influitive/apartment GitHub repo shows 116 open issues and 20 open PRs with no explicit archived/deprecated banner, i.e. it is in a stalled-but-not-formally-abandoned state", source: "GitHub repo page", publisher: github.com/influitive/apartment, pub_date: unspecified (snapshot 2026-08-18), accessed: 2026-08-18, confidence: medium, class: ecosystem}**

**{claim: "A widely-cited retrospective from Arkency (Tomasz Wróbel) documents three compounding failure modes discovered running Postgres schema-multitenancy in production: (1) Postgres extensions like pgcrypto/hstore must live in a dedicated schema kept in search_path rather than public, causing authorization friction especially with managed DB providers; (2) PgBouncer in transaction/statement pooling mode cannot safely support `search_path`-based tenant switching — doing so risks mixing tenant data, forcing a fallback to session-mode pooling with its own overhead; (3) background job frameworks (Delayed Job) create an architectural ambiguity about whether job tables live per-tenant or shared — the team chose a shared/prefixed table approach", source: "\"What surprised us in Postgres-schema multitenancy\"", publisher: Tomasz Wróbel, blog.arkency.com, pub_date: 2020-10-01, accessed: 2026-08-18, confidence: medium (single source, and the article is ~6 years old — outside the 2-year architecture-pattern freshness bar, though the underlying PgBouncer/search_path mechanical constraint is a Postgres/PgBouncer behavior, not a library version claim, so it is likely still mechanically valid; flagged as aged), class: patterns}**

### Python — django-tenants / django-tenant-schemas

**{claim: "django-tenants (the maintained successor to the archived django-tenant-schemas) is actively released as of this research: v3.14.0 on 2026-08-05, v3.13.0 on 2026-08-04, v3.12.0 on 2026-08-03 — i.e. releases within the last 2 weeks, under a single listed maintainer (Thomas Turner), PyPI status 'Production/Stable', supporting Django 5.2/6.0/6.1 and Python 3.10+", source: "PyPI project page", publisher: pypi.org/project/django-tenants, pub_date: 2026-08-05, accessed: 2026-08-18, confidence: high, class: ecosystem}**

This is a useful contrast: Python's schema-per-tenant tooling (django-tenants) is currently far more actively maintained than anything found in the Node.js or even current Ruby ecosystem — supporting the brief's premise that Node tooling is comparatively immature and that prior art should be drawn from Python/Ruby.

**{claim: "django-tenants' own documentation frames schema-per-tenant as 'an ideal compromise between simplicity and performance' requiring minimal code changes versus shared-schema, but production write-ups flag catalog/schema-count growth and cross-schema reporting complexity as the recurring operational costs as tenant count scales", source: "django-tenants GitHub/docs + secondary production write-ups (Medium/TestDriven.io, aggregated via search, not individually deep-fetched)", publisher: github.com/django-tenants/django-tenants; django-tenants.readthedocs.io, pub_date: undated/rolling docs, accessed: 2026-08-18, confidence: low (aggregated from search snippets, not a single fetched primary source), class: patterns}**

---

## Q3. Is schema-per-tenant "declining" or "still current" (2025–2026 discussion)?

**{claim: "A 2026 guide covering Rails 8 multi-tenancy explicitly states: 'Schema-per-tenant made sense in 2018 when row-level tooling was immature. In 2026, the operational overhead rarely justifies the isolation benefits unless you are in healthcare, finance, or government,' and further notes schema-per-tenant is Postgres-only/incompatible with Rails 8's SQLite defaults, and that cross-tenant reporting/analytics becomes complex multi-schema joins", source: "Multi-Tenancy in Rails 8: Row-Level, Schema-Based, or Database-Per-Tenant for Your SaaS in 2026", publisher: Omaship, omaship.com/guides/multi-tenant-rails-saas-2026, pub_date: 2026 (exact day not confirmed), accessed: 2026-08-18, confidence: medium (guide-style content, not a first-person team retrospective; treat as secondhand synthesis rather than a named team's account), class: landscape}**

**{claim: "PlanetScale's April 2026 technical post states schema-per-tenant on Postgres 'likely won't scale beyond a few hundred tenants' because every table/index/constraint/sequence across all schemas lives in the shared system catalog; with hundreds of schemas the catalog grows into millions of rows, degrading query-planner performance (catalog lookups on every query) and slowing migrations. It also states connection-level catalog loading becomes noticeably slower around 50,000 tenants, and that PgBouncer transaction-mode pooling cannot safely support per-request `search_path` switching (a session-level setting) — corroborating the independent 2020 Arkency finding. The article concludes shared-schema + RLS is 'the most common and is our recommended approach,' i.e. it frames the industry trajectory as moving away from schema-per-tenant, not toward it. It found no counter-examples of teams adopting schema-per-tenant in the piece", source: "Approaches to tenancy in Postgres", publisher: Simeon Griggs, planetscale.com/blog, pub_date: 2026-04-21, accessed: 2026-08-18, confidence: medium (PlanetScale is a Postgres-hosting vendor with a product angle favoring simpler/shared architectures they can host at scale — treat catalog-bloat mechanism as credible/independently corroborated by Arkency, but treat the "recommended approach" framing as vendor-flavored rather than neutral consensus), class: patterns}**

**{claim: "Independent PgBouncer/search_path incompatibility in transaction-pooling mode is corroborated by two independent sources six years apart (Arkency 2020, PlanetScale 2026), making it the most durable, well-evidenced known failure mode of schema-per-tenant on Postgres", source: "cross-referenced from both sources above", publisher: n/a (synthesis), pub_date: n/a, accessed: 2026-08-18, confidence: high, class: patterns}**

**No named-team, first-person "we migrated away from schema-per-tenant, here's what broke" retrospective (in the vein of a specific company engineering blog, e.g. a Basecamp/Shopify/GitLab-style postmortem) was found this session.** What was found instead is secondary guide/vendor content asserting the migration trend and its underlying mechanism (catalog bloat, PgBouncer). This is a genuine evidence gap — see Leads/Gaps below.

---

## Q4. Schema-per-tenant + tenant-created (dynamic/user-defined) tables

**No direct discussion combining "Postgres schema-per-tenant" with "tenants creating their own arbitrary tables inside their schema" (e.g., an Airtable/Retool-style user-defined-table feature) was found this session**, despite multiple query attempts (`"user-defined tables" multi-tenant postgres schema per tenant airtable-like risk`, `tenants create their own tables postgres schema catalog risk saas`, `no-code platform architecture postgres CREATE TABLE per user tenant schema`). Results consistently redirected to two adjacent-but-distinct topics instead:

1. **Tenant-customizable *fields* (not full tables)** via JSONB columns, EAV/metadata-config tables, or a single generic "custom data" column — the common pattern for letting tenants add custom fields without DDL changes. This is explicitly a workaround that *avoids* per-tenant DDL/dynamic table creation, per multiple aggregated sources (Medium/dev.to-level content, not individually deep-verified — confidence low).
2. **General schema-per-tenant catalog bloat** (Q3 sources above) — which is directly relevant by extension/inference but was not written about in the specific context of *user-triggered* table creation.

**{claim: "No source found this session explicitly analyzes the compounding risk of combining schema-per-tenant isolation with tenant-initiated dynamic DDL (tenants running their own CREATE TABLE inside their schema). This appears to be an under-discussed combination in current public technical writing", source: "absence across 3 distinct search queries this session", publisher: n/a, pub_date: n/a, accessed: 2026-08-18, confidence: n/a (negative finding), class: landscape}**

**Reasoned inference (not sourced — flagged explicitly as inference, not a retrieved claim):** Given that Q3 sources establish system-catalog growth (tables/indexes/constraints/sequences across schemas) as the primary scaling ceiling for schema-per-tenant, and that ceiling is a function of *total object count in the catalog regardless of who created the objects*, a feature where tenants can freely create their own tables would remove the operator's ability to bound or predict catalog growth — the "few hundred tenants" ceiling PlanetScale cites assumes a fixed, developer-controlled number of tables per tenant schema. This inference is architecturally straightforward from the sourced catalog-bloat mechanism but was not itself stated by any source found this session, and should be treated as a derived risk, not an externally validated one.

---

## Leads (not independently verified this session — worth following up)

- Luca Scalzotto, "Schema-based multitenancy in NestJS with TypeORM," scalzotto.nl/posts/nestjs-typeorm-schema-multitenancy/ — title/topic surfaced in search only; would corroborate/extend the "hand-rolled, no library" finding for the TypeORM side.
- Thomas Vanderstraeten, "Schema-based multitenancy with NestJS, TypeORM and PostgresSQL," thomasvds.com — same category, not fetched.
- `postgres-schema-bundle` (MacPaw), github.com/MacPaw/postgres-schema-bundle — surfaced in search, maintenance status and scope not verified.
- `pg_multitenant_schemas` Ruby gem (rubygems.org) — a newer/smaller alternative to Apartment surfaced in search snippets; version/maintenance not checked.
- TypeORM GitHub issue #4786 ("Multi-tenant architecture using schema") and nestjs/typeorm issue #58 — community discussion threads that likely contain practitioner pain points; not deep-read this session.
- Citus Data docs on "transitioning" (github.com/citusdata/citus_docs) — surfaced under the migration-retrospective query; not fetched, may contain schema-per-tenant-to-distributed-table migration guidance relevant to Q3.
- "Scaling Postgres" podcast episode 374, "Migrating Millions Of Databases" — surfaced but not fetched; title suggests database-per-tenant rather than schema-per-tenant, relevance uncertain.

## What was searched for but not found

- A first-person, named-team production retrospective explicitly titled/framed as "why we moved away from schema-per-tenant" (or the reverse direction).
- Any actively-maintained (release within 6 months) Node.js/Knex-specific schema-per-tenant library. None exists per this session's searches.
- Any source directly discussing schema-per-tenant combined with tenant-initiated dynamic table creation (Q4) as a named, analyzed combination.
