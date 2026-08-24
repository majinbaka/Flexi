# Integration & Interoperability Digest — Schema-per-Tenant on PostgreSQL (NestJS + Knex.js + Connection Pooling)

Round: r1 | Accessed: 2026-08-18

## Q1. Connection pooling vs. per-tenant `search_path` / schema-qualified queries

- **claim**: In PgBouncer's `pool_mode=transaction` (the standard production mode), a session-scoped `SET search_path = tenant_x` executed at the start of a request is lost as soon as the transaction commits, because the backend server connection is returned to the pool at COMMIT/ROLLBACK and can be handed to a *different* client on the very next transaction — so a backend that just served tenant A's query can be handed to tenant B with tenant A's `search_path` still active, or a tenant's own next transaction may land on a "clean" backend with the wrong/no `search_path` set.
  **source**: PgBouncer GitHub issue #1313, "pgbouncer pool_mode=transaction and postgres_fdw causes search_path not reset" (and related pgbouncer-general list thread "alter role set search_path not working?"; PostgreSQL bug report BUG #18928 cross-referencing the same failure mode with postgres_fdw)
  **publisher/URL**: github.com/pgbouncer/pgbouncer/issues/1313; postgresql.org/message-id/7625.1747236612@sss.pgh.pa.us
  **pub_date**: unverified exact date (issue thread references a 2026 postgresql.org message id: 1747236612 epoch); flagged as not independently date-confirmed this session — treat as recent/current, not older than ~1-2 years
  **accessed**: 2026-08-18
  **confidence**: medium (primary-source bug tracker discussion, but I only saw a search-engine synthesis of the thread, not the raw issue text)
  **class**: patterns / versions-compatibility (mechanism is a structural property of transaction-mode pooling, not tied to a specific PgBouncer point release)

- **claim**: Recommended mitigations reported in these threads/write-ups: (a) use `track_extra_parameters` in PgBouncer so it tracks and restores specific session-level parameters (e.g. `search_path`) per client across backend swaps; (b) set the default at the *role* level via `ALTER ROLE <user> SET search_path = <schema>` rather than per-session `SET`; (c) replace every session-scoped `SET` with `SET LOCAL` (or `set_config(..., true)`) issued *inside every transaction*, since `SET LOCAL` is transaction-scoped and therefore safe under transaction-mode pooling — this was described as "the fix" for the search_path-persisting-on-a-recycled-backend root cause.
  **source**: Same PgBouncer issue #1313 thread / synthesis; corroborated conceptually by a separate Go+pgx write-up on the identical problem (see below).
  **publisher/URL**: github.com/pgbouncer/pgbouncer/issues/1313
  **pub_date**: unverified
  **accessed**: 2026-08-18
  **confidence**: medium
  **class**: patterns

- **claim**: A Go/pgx-specific engineering write-up ("Per-tenant transactions in Go with pgx: SET LOCAL search_path, and why every schema name goes through QuoteIdent") independently documents the same pattern for a different stack: use `SET LOCAL search_path` per-transaction (not session-level `SET`) for tenant isolation under pooled connections, and always pass the schema name through Postgres's identifier-quoting function before interpolating it into the `SET LOCAL`/DDL string, because schema names cannot be passed as a bound parameter (Postgres does not allow parameterized identifiers) and must instead be safely quoted.
  **source**: "Per-tenant transactions in Go with pgx: SET LOCAL search_path, and why every schema name goes through QuoteIdent"
  **publisher/URL**: dev.to/yusufihsangorgel/per-tenant-transactions-in-go-with-pgx-set-local-searchpath-and-why-every-schema-name-goes-4138
  **pub_date**: unverified (not fetched directly this session — only surfaced via search snippet; title/URL suggests recency but not confirmed)
  **accessed**: 2026-08-18
  **confidence**: low-medium (not independently fetched/read in full; cross-stack analog, not Node/Knex-specific — directionally useful but not verified in depth)
  **class**: patterns

- **claim**: A NestJS+Knex+PostgreSQL-specific implementation (SAP BTP context) uses Knex's `.withSchema(tenantId)` per-query-builder call to scope each query to the tenant's schema, rather than issuing a session-level `SET search_path`. The tenant ID is captured once per request via an interceptor/AsyncLocalStorage and then applied per-query via `.withSchema()`. The author explicitly did **not** test PgBouncer with this setup, only speculating it "could" help with connection exhaustion — i.e., this write-up does not itself validate the PgBouncer-transaction-mode interaction, but its architecture (schema-qualification via query builder rather than session `SET`) is consistent with what avoids the transaction-mode pooling problem described above.
  **source**: "Multi-Tenancy (Schema separated) with NestJS, Knex and PostgreSQL in SAP BTP" — Nicola Zanon, Inextenso blog
  **publisher/URL**: https://www.inextenso.dev/multi-tenancy-schema-separated-with-nestjs-knex-and-postgresql-in-sap-btp
  **pub_date**: 2022-10-01 (dated — outside the 2-year "architecture pattern" freshness bar as of 2026-08-18; flagged as older than ideal, but the underlying mechanism — Knex `.withSchema()` vs. session `SET` — is a stable Knex/Postgres API property, not something likely to have changed)
  **accessed**: 2026-08-18
  **confidence**: medium (fetched and read directly; author is explicit about what was/wasn't tested)
  **class**: patterns

- **Synthesis (not an independent claim, my own read of the above)**: The consistent recommendation across sources is: avoid session-level `SET search_path` entirely under transaction-mode PgBouncer; either (a) fully schema-qualify every query at the query-builder level (Knex `.withSchema(schemaName)` per call, which Knex compiles into schema-qualified identifiers rather than relying on connection-level session state), or (b) if `SET` is unavoidable, use `SET LOCAL` inside an explicit transaction. Session-mode PgBouncer pooling (1 client : 1 dedicated backend for the connection's lifetime) does not have this problem but gives up the connection-multiplexing benefit that makes PgBouncer worthwhile at scale — sources describe session mode as viable only for specific narrow paths (e.g. long-lived admin/migration connections), not as the default pool mode for the app's hot path.

## Q2. Connection-pool sizing/topology at scale (hundreds–low-thousands of tenants)

- **claim**: Schema-per-tenant ("schema-based sharding" / "bridge model") is generally described as well-suited for roughly 100–10,000 tenants — appropriate for the "hundreds to low-thousands" range in the brief — with the caveat that it's typically recommended for a "medium" tenant count and not pushed much beyond several thousand schemas in a single Postgres instance.
  **source**: search-engine synthesis citing AWS Prescriptive Guidance decision matrix and related SaaS-multitenancy comparison content (Aditya Agrawal blog "Building SaaS with PostgreSQL - Multi-Tenancy Patterns Compared"; AWS docs.aws.amazon.com/prescriptive-guidance saas-multitenant-managed-postgresql "Decision matrix")
  **publisher/URL**: docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/matrix.html; adiagr.com/blog/07-saas-postgres-multitenancy-patterns
  **pub_date**: unverified (AWS Prescriptive Guidance pages are living docs, not dated per-page; not independently confirmed as current)
  **accessed**: 2026-08-18
  **confidence**: low-medium (synthesized from search snippets, not independently fetched/read in full — flagged for follow-up)
  **class**: landscape

- **claim**: The recommended topology at this scale is a **single shared connection pool** (not one pool per tenant), with the tenant's schema selected per-query/per-request rather than via a dedicated pool per tenant. One concrete implementation (NestJS/Knex/SAP BTP write-up) explicitly warns that a pool-per-tenant design will exhaust PostgreSQL's `max_connections`, producing `FATAL: sorry, too many clients already`, once the tenant count grows — and configures a single shared pool (min 2 / max 50 connections) shared across all tenants instead.
  **source**: "Multi-Tenancy (Schema separated) with NestJS, Knex and PostgreSQL in SAP BTP" — Nicola Zanon
  **publisher/URL**: https://www.inextenso.dev/multi-tenancy-schema-separated-with-nestjs-knex-and-postgresql-in-sap-btp
  **pub_date**: 2022-10-01 (dated per note above)
  **accessed**: 2026-08-18
  **confidence**: medium (directly fetched and read; concrete numbers and failure mode given, but from a single implementation, not a broad survey)
  **class**: patterns

- **claim**: At scale, connection overhead is a hard physical constraint independent of the tenancy model: each PostgreSQL connection spawns a full backend process consuming roughly 1–3 MB of memory, so e.g. 10,000 raw connections could consume ~20 GB of memory before any query work is done — this is presented as the core reason pooling (PgBouncer) is treated as mandatory infrastructure at this scale rather than an optional optimization, and per-tenant connection limits enforced at the application layer plus aggressive PgBouncer query timeouts are cited as the practical mitigation.
  **source**: search-engine synthesis referencing "PgBouncer at Scale: 10K+ Connections Multi-Tenant Postgres" (DZone) and Crunchy Data's "Designing Your Postgres Database for Multi-tenancy"
  **publisher/URL**: dzone.com/articles/database-connection-pooling-at-scale-pgbouncer-mul; crunchydata.com/blog/designing-your-postgres-database-for-multi-tenancy
  **pub_date**: unverified (not independently fetched)
  **accessed**: 2026-08-18
  **confidence**: low (search-snippet synthesis only, not read in full — the specific "1-3MB per connection / 20GB for 10K conns" figure should be verified against the Crunchy Data or DZone source directly before being used as a hard number)
  **class**: patterns / landscape

- **Note**: I found and fetched an AWS Prescriptive Guidance page titled "PostgreSQL pool model," expecting it to cover connection-pool sizing for schema-per-tenant — it turned out to describe AWS's "pool model" as a *tenancy* term (single schema + row-level security for all tenants), unrelated to connection-pool topology despite the name collision. Not usable for this question; flagged so it isn't mistakenly cited elsewhere.

## Q3. Propagating "current tenant" through NestJS without cross-request leakage

- **claim**: The pattern reported as causing real cross-request tenant leakage bugs is (a) deriving/trusting tenant ID from client-supplied input (request body) instead of a verified JWT claim, and more architecturally, (b) `AsyncLocalStorage.enterWith()` (which mutates the *current* execution context in place) instead of `AsyncLocalStorage.run()` (which creates a properly scoped child context) — `enterWith` was specifically called out as able to leak context across concurrent async chains, making `run()` the generally preferred method. A related failure mode: if two concurrent async chains fork from the same parent AsyncLocalStorage scope, they share the same underlying store object by reference, so the store must be treated as append-only for the request lifetime — mutating a shared value is a leakage vector even inside "properly" scoped `run()` calls.
  **source**: search-engine synthesis of multiple sources including "Multi-Tenant NestJS: Stop Leaks Before They Start" (Thinking Loop, Medium) and general AsyncLocalStorage guidance pieces
  **publisher/URL**: medium.com/@ThinkingLoop/multi-tenant-nestjs-stop-leaks-before-they-start-15361ca576ab
  **pub_date**: 2026-02-07
  **accessed**: 2026-08-18
  **confidence**: medium (the Medium article itself was directly fetched and read in full; the `enterWith`-vs-`run` distinction came from the broader search synthesis around it, not confirmed as stated inside that specific article)
  **class**: patterns

- **claim**: The reliable/recommended pattern reported: (1) resolve tenant identity in middleware/guard **before** the controller executes, from a cryptographically verified JWT claim — never from request body/query; (2) store `{ tenantId, userId }` in a module-level `AsyncLocalStorage` instance and enter it via `tenantStore.run({ tenantId, userId }, () => next())` in middleware, so tenant context flows implicitly through the whole async call chain without manual parameter threading and without paying NestJS's `REQUEST`-scoped-provider performance penalty; (3) enforce tenant scoping at the data-access layer with a `requireTenant()` helper that throws if context is missing, so a repository method cannot physically execute a query without an explicit `tenantId` in the WHERE clause; (4) extend the same tenant-ID-in-payload discipline to background/queue jobs, which otherwise run "as system" with no context and are a common leakage source; (5) namespace cache keys by tenant (`tenant:${tenantId}:resource`) since caching by resource name alone was reported as a cross-tenant cache-hit vector.
  **source**: "Multi-Tenant NestJS: Stop Leaks Before They Start" — Thinking Loop
  **publisher/URL**: https://medium.com/@ThinkingLoop/multi-tenant-nestjs-stop-leaks-before-they-start-15361ca576ab
  **pub_date**: 2026-02-07
  **accessed**: 2026-08-18
  **confidence**: medium-high (directly fetched, single-author blog rather than official docs — treat prescriptions as one practitioner's opinion, not a documented NestJS-team-endorsed pattern)
  **class**: patterns

- **claim**: A separate, independently-implemented NestJS+Knex example reached a similar design conclusion by a different path: it explicitly tried `REQUEST`-scoped factory providers for tenant context first, found "unfortunate performance implications" from the resulting scope cascade (any provider injecting the request-scoped tenant provider itself becomes request-scoped, and NestJS then has to re-instantiate that whole dependency subgraph per request), and switched to an `AsyncContextInterceptor` built on `AsyncLocalStorage` instead, retrieved downstream via a plain singleton service (`this.asyncContext.get("tenantId")`).
  **source**: "Multi-Tenancy (Schema separated) with NestJS, Knex and PostgreSQL in SAP BTP" — Nicola Zanon
  **publisher/URL**: https://www.inextenso.dev/multi-tenancy-schema-separated-with-nestjs-knex-and-postgresql-in-sap-btp
  **pub_date**: 2022-10-01
  **accessed**: 2026-08-18
  **confidence**: medium (directly fetched; this is the NestJS docs' own documented tradeoff for REQUEST scope re-stated by a practitioner, and matches NestJS's official request-scoped-provider performance caveat, though I did not re-verify against official NestJS docs this session)
  **class**: patterns

- **claim**: `nestjs-cls` exists as a purpose-built continuation-local-storage module for NestJS (built on top of `AsyncLocalStorage`) that explicitly lists multi-tenancy as a target use case, positioning itself as the "safe" packaged version of the roll-your-own `AsyncLocalStorage` pattern described above.
  **source**: NestJS CLS official docs ("Introduction | NestJS CLS")
  **publisher/URL**: https://papooch.github.io/nestjs-cls/
  **pub_date**: unverified (not independently fetched this session — found via search listing only)
  **accessed**: 2026-08-18
  **confidence**: low (title/URL only, not read — flagged as a lead for follow-up, not a verified claim about its API or behavior)
  **class**: ecosystem

## Q4. Auth-to-schema mapping and injection/privilege-escalation risk

- **claim**: Best-practice guidance for tenant identification in JWTs: carry exactly one immutable tenant identifier in a custom top-level claim (e.g. `tenant_id` or `tid`), validated cryptographically at every hop, rather than reusing a standard OIDC field (which carries provider-specific semantics that vary between identity providers and invites parsing drift/collisions) — and never derive the effective tenant/schema from anything the client can independently set (e.g. request body/header) without cross-checking against the verified claim.
  **source**: search-engine synthesis citing "JWT Claims for Tenant Scoping: Best Practices" (Multi-Tenant SaaS Architecture Hub)
  **publisher/URL**: multi-tenant-saas.com/auth-isolation-cross-tenant-access-control/tenant-aware-jwt-token-management/jwt-claims-for-tenant-scoping-best-practices/
  **pub_date**: unverified (not independently fetched; site appears to be a topic-focused reference hub rather than a single named-author engineering blog — treat as lower-authority secondary source, corroborated in spirit by the Thinking Loop Medium post above)
  **accessed**: 2026-08-18
  **confidence**: low-medium
  **class**: patterns

- **claim (concrete, real-world vulnerability)**: A real SQL-injection vulnerability was found and patched in MikroORM's Postgres/Knex driver (`@mikro-orm/knex` ≤ 6.6.13, `@mikro-orm/sql` ≤ 7.0.13) specifically in the multi-tenant schema-name code path: the identifier-quoting helper used by `em.fork({ schema })`, `qb.withSchema(name)`, and `wrap(entity).setSchema(name)` failed to properly escape the dialect's quote character, so an attacker-influenced schema-name string passed to these APIs could break out of the quoted SQL-identifier context and inject arbitrary SQL — i.e., exactly the "JWT/claim resolves to a schema name, schema name reaches a query-builder `withSchema()`-style call unsanitized" pattern is a demonstrated, CVE-tracked real vulnerability class, not a theoretical one. Fixed in `@mikro-orm/knex` 6.6.14+ and `@mikro-orm/sql` 7.0.14+. The advisory's own recommended mitigation is a strict allowlist regex on the schema name — `^[A-Za-z_][\w$]*$` — applied *before* the value is ever passed into the ORM/query-builder, in addition to (not instead of) proper identifier quoting.
  **source**: GitHub Security Advisory GHSA-cfw5-68c4-ffqp / CVE-2026-44680, mikro-orm repository
  **publisher/URL**: https://github.com/mikro-orm/mikro-orm/security/advisories/GHSA-cfw5-68c4-ffqp
  **pub_date**: 2026-05-05
  **accessed**: 2026-08-18
  **confidence**: high (official GitHub Security Advisory, directly fetched, specific CVE ID and version ranges — though MikroORM rather than raw Knex, the mechanism directly transfers to any Knex `.withSchema(tenantSchema)` call fed by unsanitized tenant-resolved input)
  **class**: versions/compatibility (this is a live, dated vulnerability disclosure — directly actionable: confirms the exact attack surface and gives a concrete regex mitigation)

- **claim**: Postgres identifiers (including schema names) cannot be passed as bound/parameterized query parameters — parameterization only covers literal values, not identifiers — so any dynamic schema name used in `SET search_path`, `SET LOCAL search_path`, or a schema-qualified DDL/DML string *must* go through explicit identifier quoting (Postgres's `QUOTE_IDENT`, or the equivalent client-library helper) in addition to allowlist validation; quoting alone is necessary-but-not-sufficient without also validating the underlying tenant-to-schema mapping comes from a trusted source (verified JWT claim → server-side lookup), because quoting prevents syntax breakout but does not prevent a validly-quoted but wrong/unauthorized schema name from being used (privilege-escalation-by-tenant-confusion, distinct from injection).
  **source**: Synthesis of the MikroORM advisory's dual "QuoteIdent AND allowlist" mitigation plus general PostgreSQL identifier-quoting documentation; general point corroborated by "Per-tenant transactions in Go with pgx" article headline claim (schema name "goes through QuoteIdent")
  **publisher/URL**: github.com/mikro-orm/mikro-orm/security/advisories/GHSA-cfw5-68c4-ffqp; postgresql.org/docs/current/sql-syntax-lexical.html (Lexical Structure — general identifier-quoting reference, not independently fetched this session)
  **pub_date**: n/a (reference documentation)
  **accessed**: 2026-08-18
  **confidence**: medium (synthesized from a verified primary source plus general PG documentation not independently re-read this session)
  **class**: patterns

## Leads for follow-up (not yet verified this session)

1. **`nestjs-cls` deep-dive**: fetch https://papooch.github.io/nestjs-cls/ directly to confirm its actual API, whether it documents a specific multi-tenancy recipe, and whether it has any documented gotchas around leakage (only surfaced via search title so far).
2. **Verify the "1-3 MB per connection / 20 GB for 10K connections" figure** against the DZone "PgBouncer at Scale" article and/or Crunchy Data's "Designing Your Postgres Database for Multi-tenancy" post directly — currently only a search-snippet synthesis, not read in full.
3. **AWS Prescriptive Guidance decision matrix** (docs.aws.amazon.com/prescriptive-guidance/.../matrix.html) — fetch directly to get AWS's stated tenant-count thresholds for schema-per-tenant vs. pool (RLS) vs. bridge (DB-per-tenant) verbatim, rather than via search synthesis.
4. **Confirm PgBouncer's official docs position** on `track_extra_parameters` / `server_reset_query` behavior in transaction mode directly from pgbouncer.org/config.html (surfaced in search results, not fetched) — would upgrade Q1's two mitigation claims from medium to high confidence and pin an exact PgBouncer version where `track_extra_parameters` became available.
5. **Knex.js official docs** on `.withSchema()` — not fetched directly this session; would be worth confirming Knex's own documented behavior/caveats for dynamic schema names (the open GitHub issue "Change searchPath per query? #2223" suggests there was historically friction here — worth checking if resolved in current Knex versions).
6. **A second, more recent (2024-2026) NestJS+Knex+Postgres schema-per-tenant implementation write-up** — the most concrete implementation source found (inextenso.dev) is from October 2022, outside the ideal freshness bar for architecture patterns; a follow-up round should look for a fresher confirmation that `.withSchema()` + AsyncLocalStorage + shared pool is still the reported-working pattern in 2025-2026 Knex/NestJS versions.

## What I looked for but could not find

- No source in this round directly confirmed (with a fetched, dated document) whether recent PgBouncer versions (2.x) have changed the transaction-mode `search_path`-loss behavior described in issue #1313 — I could not establish whether this is "current as of latest PgBouncer" or a long-standing, unfixed-by-design property of transaction pooling (my working assumption, consistent with PgBouncer's documented architecture, is the latter — transaction-mode pooling deliberately does not preserve session state across transactions — but I did not verify this against pgbouncer.org/config.html directly this session).
- No source specifically addressed NestJS + Knex + PgBouncer all three together in one integration write-up; the PgBouncer-transaction-mode analysis (Q1) and the NestJS/Knex implementation pattern (Q2/Q3) come from separate sources that I synthesized together, not a single end-to-end account. This is a genuine gap, not just a citation-count limitation — worth flagging to the requester as an assumption-stitch rather than a directly observed integration.
- No source gave a concrete tenant-count number at which per-tenant connection pooling (one pool object per tenant in the Node process, e.g. one Knex instance per tenant) becomes impractical — sources instead reason from raw PostgreSQL `max_connections`/memory limits, not from a stated "impractical above N tenants" threshold specific to the pool-per-tenant *topology* itself (as opposed to schema-per-tenant as a tenancy model in general).
