---
title: 'Tenant Schema Context & Knex Routing (Dynamic Tables)'
type: 'feature' # feature | bugfix | refactor | chore
created: '2026-08-18'
status: 'done' # draft | ready-for-dev | in-progress | in-review | done
review_loop_iteration: 0 # incremented by step-04 before each review loopback
context: []
baseline_commit: '0fea9f0430163288443faf8ef7bff2dddc5c22e9'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The (deferred) Dynamic Table Builder will create tenant-owned tables at runtime; Prisma can't do dynamic per-tenant DDL, so those tables need their own Postgres schema per tenant — but there is currently no safe way to resolve a tenant's schema name or scope a query builder to it.

**Approach:** Add a Knex-based tenant-schema-routing layer (CLS-propagated tenant context + allowlist-validated `resolveTenantSchema()` + a shared-pool `TenantKnexService`) that sits alongside Prisma, scoped only to the future dynamic-tables data path. Flexi's own metadata stays row-level `tenantId` in Prisma, unchanged.

## Boundaries & Constraints

**Always:**
- Tenant identity comes only from the already-verified JWT claim (`request.user.tenantId`, set by `JwtAuthGuard`) — never re-derived from body/query/header.
- Schema names are resolved only through `resolveTenantSchema()`, allowlist-validated against `/^[A-Za-z_][\w$]*$/`; never string-concatenated elsewhere.
- Every dynamic-table query is scoped via `.withSchema()` at the call site; no code path issues a session-level `SET search_path`.
- One shared Knex `pg` pool for the whole app, reusing the existing `DATABASE_URL`.

**Ask First:** None.

**Never:**
- No tenant schema provisioning/creation (deferred — no schema exists in Postgres yet for any tenant).
- No cross-tenant migration runner (deferred).
- No actual Dynamic-Table-Builder routes/DDL (separate, deferred module).
- No change to Prisma's row-level-`tenantId` model for existing tables — that decision stays frozen per `spec-flexi-core-scaffold.md`.
- No per-tenant Knex pools.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid tenant JWT | Request carries a verified `tenantId` claim | CLS store holds `tenantId` + `schema`; `TenantContext.schema` returns `tenant_<id>` with no DB round trip | N/A |
| System (non-tenant) JWT | `actorType` is System, no `tenantId` claim | `TenantContext.schema` access throws | Error: no tenant context |
| Adversarial tenantId | e.g. `"public; DROP TABLE"`, `a" OR "1"="1` | `resolveTenantSchema()` throws before any string reaches Knex | Error: refuses unsafe schema name |
| Scoped query compile | `TenantKnexService.forCurrentTenant()` inside a tenant request | Compiles to `select ... from "tenant_<id>"."<table>"` | N/A |
| Accessed outside a request | No CLS store present (e.g. app bootstrap code) | Throws immediately, never returns `undefined`/`public` | Error: no tenant context |

</frozen-after-approval>

## Code Map

- `apps/backend/src/modules/auth/guards/jwt-auth.guard.ts:22` -- existing guard verifying the JWT and setting `request.user`. CLS tenant context must be set **from inside this guard** after verification, not from `ClsModule`'s middleware `setup` hook — Nest middleware runs *before* guards, so `request.user` doesn't exist yet at that point.
- `apps/backend/src/modules/auth/auth.types.ts:15` -- `AccessTokenPayload` (`tenantId?: string`) — source-of-truth shape for the verified claim.
- `apps/backend/prisma/schema.prisma:199` -- `Tenant.id` uses `@default(cuid())`, not a UUID. `resolveTenantSchema()`'s allowlist regex must be exercised against real cuid shape (lowercase alnum, no hyphens) in tests, not the UUID example in the source guide (a hyphenated UUID would actually fail that same regex).
- `apps/backend/src/prisma/prisma.service.ts` -- existing `OnModuleInit`/`OnModuleDestroy` lifecycle pattern to mirror for the new Knex service.
- `apps/backend/src/config/env.validation.ts:9` -- `DATABASE_URL` already required/validated; reuse it for Knex's pool, don't add a new env var.
- `apps/backend/src/app.module.ts` -- register the new tenancy module here.
- `apps/backend/package.json` -- add `knex`, `pg`, `nestjs-cls` (none currently installed; backend uses Prisma only today).
- `packages/shared-types/src/entities.ts:193` -- `AuthenticatedUserDto` — confirms System actors carry no `tenantId`.
- `_bmad-output/implementation-artifacts/spec-flexi-core-scaffold.md:89` -- frozen Design Note: row-level `tenantId` is the platform's core-metadata strategy. This spec's schema-per-tenant layer is scoped only to future Dynamic-Table-Builder tables — not a reversal.
- `_bmad-output/planning-artifacts/schema-per-tenant-implementation-guide.md` §1–4 -- source guide these patterns are narrowed/adapted from (it assumes Knex-only and schema-per-tenant for *everything*; neither holds here).

## Tasks & Acceptance

**Execution:**
- [x] `apps/backend/package.json` -- add `knex`, `pg`, `nestjs-cls` deps -- required, not yet installed
- [x] `apps/backend/src/tenancy/resolve-tenant-schema.ts` -- new: `resolveTenantSchema(tenantId): string`, allowlist-validated, throws on mismatch -- single choke point preventing schema-name injection (pattern behind CVE-2026-44680)
- [x] `apps/backend/src/tenancy/resolve-tenant-schema.spec.ts` -- unit tests covering the I/O matrix's adversarial + valid-cuid cases
- [x] `apps/backend/src/tenancy/tenant-context.ts` -- new: typed CLS wrapper; `schema` getter throws when unset
- [x] `apps/backend/src/tenancy/tenant-knex.service.ts` -- new: one shared `pg` pool (reads `DATABASE_URL`), lifecycle-hooked like `PrismaService`; `forCurrentTenant()` returns `knex.withSchema(tenantContext.schema)`
- [x] `apps/backend/src/tenancy/tenancy.module.ts` -- new: `ClsModule.forRoot({ middleware: { mount: true } })` (no `setup` callback), provides `TenantContext` + `TenantKnexService`
- [x] `apps/backend/src/modules/auth/guards/jwt-auth.guard.ts` -- edit: after verifying the token, when `payload.tenantId` is present, `cls.set('tenantId', ...)` and `cls.set('schema', resolveTenantSchema(...))`
- [x] `apps/backend/src/app.module.ts` -- edit: import `TenancyModule`

**Also touched (not listed above, required by the edits that were):**
- `apps/backend/src/tenancy/tenant-context.spec.ts` (new) -- unit tests for `TenantContext`'s throw-on-unset contract (system actor, no-CLS-store).
- `apps/backend/src/tenancy/tenant-knex.service.spec.ts` (new) -- unit test for `forCurrentTenant()`'s schema-qualified SQL compilation and the "no `SET search_path`" acceptance criterion.
- `apps/backend/src/modules/auth/auth.service.spec.ts` -- `JwtAuthGuard`'s constructor gained a `ClsService` param; updated its test instantiation and added CLS-population coverage for the "Valid tenant JWT" / "System (non-tenant) JWT" I/O matrix rows.

**Acceptance Criteria:**
- Given a valid tenant-scoped access token, when a provider injects `TenantContext` downstream, then `.schema` returns `tenant_<tenantId>` with no DB round trip.
- Given a valid system (non-tenant) access token, when `TenantContext.schema` is accessed, then it throws rather than returning `undefined` or `public`.
- Given `TenantKnexService.forCurrentTenant()`, when compiled, then the resulting SQL is schema-qualified and no code path in this change issues `SET search_path`.

## Spec Change Log

## Design Notes

**Narrower than the source guide, deliberately:** only the future Dynamic-Table-Builder data path adopts schema-per-tenant. Flexi's own metadata (`Tenant`/`AuthAccount`/`TenantUser`/`Role`/etc.) stays row-level in Prisma per the frozen decision in `spec-flexi-core-scaffold.md`. Nothing here touches `schema.prisma` or existing Prisma-based services.

**CLS population point deviates from the source guide's example:** the guide sets tenant context inside `ClsModule`'s middleware `setup` callback by reading `req.user` — but in this codebase JWT verification happens in `JwtAuthGuard`, which runs *after* middleware, so `req.user` isn't populated yet at that point. `ClsModule.forRoot()` still mounts middleware to open the CLS store early; tenant values are set explicitly inside `JwtAuthGuard.canActivate()` once the payload is verified.

**No live tenant schema exists yet** (provisioning is deferred, see `deferred-work.md`). Tests exercise `resolveTenantSchema()` and Knex SQL compilation only — they must not depend on a real `tenant_<id>` schema being present in Postgres.

## Verification

**Commands:**
- `pnpm --filter @flexi/backend test -- tenancy` -- expected: new unit tests pass, including adversarial `resolveTenantSchema` inputs
- `pnpm --filter @flexi/backend build` -- expected: compiles clean with the new deps
- `pnpm --filter @flexi/backend start:dev` -- expected: boots with no new required env vars, no behavior change on existing routes

## Suggested Review Order

**Design intent -- why CLS is wired the way it is**

- Entry point: explains why tenant context is set inside the guard, not `ClsModule`'s `setup` hook, and why the module is `@Global()`.
  [`tenancy.module.ts:7`](../../apps/backend/src/tenancy/tenancy.module.ts#L7)

**Tenant identity entry point**

- The only place a verified `tenantId` claim becomes CLS-resolved tenant context; System-actor tokens leave it unset on purpose.
  [`jwt-auth.guard.ts:77`](../../apps/backend/src/modules/auth/guards/jwt-auth.guard.ts#L77)

**Schema-name safety (the security-critical path)**

- Single choke point turning a tenantId into a schema name; rejects empty input, adversarial input, and over-length input before anything reaches Knex.
  [`resolve-tenant-schema.ts:22`](../../apps/backend/src/tenancy/resolve-tenant-schema.ts#L22)

**Tenant context access contract**

- Typed CLS wrapper; both getters throw rather than silently falling back to an ambient/`public` schema.
  [`tenant-context.ts:28`](../../apps/backend/src/tenancy/tenant-context.ts#L28)

**Query routing**

- Shared Knex pool + `withSchema()` scoping; the class doc explains why the pool is intentionally lazy and never issues `SET search_path`.
  [`tenant-knex.service.ts:26`](../../apps/backend/src/tenancy/tenant-knex.service.ts#L26)
- `forCurrentTenant()` -- the one method every future dynamic-table query must be built from.
  [`tenant-knex.service.ts:62`](../../apps/backend/src/tenancy/tenant-knex.service.ts#L62)

**Wiring into the app**

- `TenancyModule` registered alongside `PrismaModule` so `ClsService`/`TenantContext`/`TenantKnexService` are available app-wide.
  [`app.module.ts:30`](../../apps/backend/src/app.module.ts#L30)

**Peripherals -- tests**

- Adversarial + boundary coverage for schema-name resolution (empty, injection strings, 63-byte edge).
  [`resolve-tenant-schema.spec.ts:1`](../../apps/backend/src/tenancy/resolve-tenant-schema.spec.ts#L1)
- Throw-on-unset coverage for a System actor's request and for code with no CLS store at all.
  [`tenant-context.spec.ts:1`](../../apps/backend/src/tenancy/tenant-context.spec.ts#L1)
- Schema-qualified SQL compilation, with no live Postgres required.
  [`tenant-knex.service.spec.ts:1`](../../apps/backend/src/tenancy/tenant-knex.service.spec.ts#L1)
- Guard-level CLS population for both the "Valid tenant JWT" and "System (non-tenant) JWT" I/O matrix rows.
  [`auth.service.spec.ts:565`](../../apps/backend/src/modules/auth/auth.service.spec.ts#L565)
