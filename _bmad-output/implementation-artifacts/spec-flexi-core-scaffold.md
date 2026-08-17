---
title: 'Flexi Core Platform Scaffold'
type: 'feature'
created: '2026-08-17'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'd6bd004f8ea2d3aadc8f4a7d6008d0a11fd56418'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Flexi is a greenfield low-code platform (11 planned feature modules: auth, dynamic tables, workflows, pages, cron, mail, wiki, multi-tenant, i18n, settings, logging) with no repository skeleton yet, so no module work can start.

**Approach:** Scaffold a pnpm monorepo (NestJS backend + React/Vite frontend) with a Prisma-modeled core metadata schema, one thin stub NestJS module per planned feature area (no business logic), a routed React shell with i18next wired, Docker Compose for Postgres+Redis, and README/ROADMAP docs. Deep implementation of each module is deferred (see `deferred-work.md`).

## Boundaries & Constraints

**Always:**
- Monorepo via pnpm workspaces: `apps/backend` (NestJS), `apps/frontend` (React+TS+Vite), `packages/shared-types`.
- Core metadata modeled in `apps/backend/prisma/schema.prisma` with exactly these entities: Tenant, User, Role, Permission, RolePermission, DynamicTable, DynamicField, Workflow, Page, CronJob, MailTemplate, WikiPage, LogEntry, Translation.
- Multi-tenancy = row-level `tenantId` column on tenant-scoped tables (not schema-per-tenant) — rationale documented in Design Notes.
- REST API with a standard response envelope `{ success, data, error }` and a global exception filter producing `{ success:false, error:{ code, message } }`.
- One NestJS module per feature area — `auth`, `tenants`, `dynamic-tables`, `workflows`, `pages`, `cron-jobs`, `mail-templates`, `wiki`, `i18n`, `settings`, `logs` — each with `module.ts` + `controller.ts` + `service.ts` and exactly one placeholder route (`GET /{area}` → `{ success:true, data:{ status:'not-implemented' } }`), registered in `AppModule`.
- Frontend: `react-router` shell with one placeholder page per module, sidebar nav, i18next configured with `en`/`vi` resource stubs.
- `docker-compose.yml` provisioning Postgres 16 + Redis 7 for local dev.
- `README.md` (setup/run) and `ROADMAP.md` (phased MVP→extended plan referencing `deferred-work.md` goals).

**Ask First:** None — tech-stack choices are pre-approved by the user; proceed on reasonable assumptions per user instruction.

**Never:**
- No real business logic in any module (no auth guards enforcing RBAC, no dynamic DDL/migration engine, no workflow execution, no drag-drop builder UI, no cron scheduling execution, no SMTP sending, no wiki markdown render/search, no realtime WS log streaming) — all deferred.
- No GraphQL — REST only.
- No schema-per-tenant.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh boot | `docker compose up -d` then `pnpm --filter backend prisma migrate dev` then `pnpm --filter backend start:dev` | Backend connects to Postgres, applies migration creating all 14 metadata tables, listens on configured port | Startup fails loudly if `DATABASE_URL` unset |
| Stub route call | `GET /api/workflows` (any stub module) | `200` with `{ success:true, data:{ status:'not-implemented' } }` | N/A |

</frozen-after-approval>

## Code Map

- Repo is greenfield — only `.git`, `.claude`, `_bmad`, `_bmad-output`, `.agents` exist. No prior app code to reuse.
- `apps/backend/prisma/schema.prisma` -- new: core metadata models (single source of truth for DB shape)
- `apps/backend/src/app.module.ts` -- new: root module wiring all 11 feature-area modules + Prisma/Config
- `apps/backend/src/common/` -- new: response envelope interceptor, global exception filter, tenant-context decorator (parses `x-tenant-id` header only — no enforcement logic)
- `apps/backend/src/modules/<area>/` × 11 -- new: stub module/controller/service per feature area listed above
- `apps/frontend/src/router.tsx` -- new: route table, one path per module
- `apps/frontend/src/i18n/` -- new: i18next init + `en.json`/`vi.json` stubs
- `docker-compose.yml`, `README.md`, `ROADMAP.md`, `pnpm-workspace.yaml` -- new: repo root infra/docs

## Tasks & Acceptance

**Execution:**
- [x] `pnpm-workspace.yaml`, root `package.json`, `.gitignore`, `.env.example` -- create workspace root -- establishes monorepo tooling
- [x] `docker-compose.yml` -- add Postgres 16 + Redis 7 services -- local dev infra
- [x] `apps/backend/` -- scaffold NestJS app (Nest CLI structure, `main.ts`, `app.module.ts`, config module with env validation) -- backend entrypoint
- [x] `apps/backend/prisma/schema.prisma` -- model the 14 core entities with `tenantId` FKs where tenant-scoped -- core metadata engine
- [x] `apps/backend/src/common/response.interceptor.ts`, `http-exception.filter.ts` -- implement response/error envelope -- API convention baseline
- [x] `apps/backend/src/modules/{auth,tenants,dynamic-tables,workflows,pages,cron-jobs,mail-templates,wiki,i18n,settings,logs}/` -- stub module+controller+service per area, one placeholder route each -- module skeleton for future stories
- [x] `apps/frontend/` -- scaffold Vite React+TS app with router shell, sidebar nav, placeholder page per module -- frontend entrypoint
- [x] `apps/frontend/src/i18n/` -- wire i18next with `en`/`vi` stub resources -- i18n scaffold
- [x] `packages/shared-types/` -- shared DTO/enum types (e.g. field data types enum) importable by both apps -- avoid FE/BE drift
- [x] `README.md` -- local dev setup/run instructions -- onboarding
- [x] `ROADMAP.md` -- phased rollout referencing each deferred module goal -- planning artifact

**Acceptance Criteria:**
- Given a clean checkout, when running `docker compose up -d && pnpm install && pnpm --filter backend prisma migrate dev`, then all 14 metadata tables are created in Postgres with no errors.
- Given the backend running, when calling `GET /api/<area>` for any of the 11 stub modules, then the response is `200` with the standard envelope and `status:'not-implemented'`.
- Given the frontend running, when navigating to any module's sidebar link, then its placeholder route renders without a router error.
- Given `README.md`, when a new developer follows it top-to-bottom on a clean machine, then they reach a running backend+frontend with no undocumented steps.

## Spec Change Log

## Design Notes

**Monorepo (pnpm workspaces, no Turborepo yet):** keeps FE/BE/shared-types in one versioned unit with shared TS types for metadata entities (Table/Field/Workflow defs) — critical since the frontend builders will consume the same shape the backend emits. Turborepo/Nx can be added later once build-caching pain justifies it; not needed for a scaffold.

**NestJS over raw Express:** DI + Guards/Interceptors map directly onto cross-cutting concerns this platform needs everywhere (tenant resolution, RBAC, response envelope) — building those as Nest primitives now means later modules (deferred) plug in without re-plumbing.

**Prisma for core metadata, NOT for user-created dynamic tables:** Prisma's schema is compile-time/static, so it's a good fit for the ~14 fixed metadata tables here. The dynamic Table/Field Builder (deferred module #3) will need runtime DDL (raw SQL / query-builder like Knex) since Prisma cannot generate models at runtime — flagging this now so the metadata schema's `DynamicTable`/`DynamicField` models describe *definitions*, not the actual dynamic tables themselves.

**Row-level `tenantId` over schema-per-tenant:** schema-per-tenant gives strong isolation but multiplies migration/ops complexity linearly with tenant count and complicates cross-tenant admin/reporting queries. Row-level `tenantId` (optionally hardened later with Postgres RLS policies) scales better for a SaaS-style low-code platform expecting many small-to-medium tenants. This is a foundational choice — changing it later is expensive, so it's called out explicitly rather than left implicit.

**REST over GraphQL:** the platform's defining trait is runtime-defined data shapes (user-created tables/fields). A GraphQL schema is normally static and code-generated; making it dynamic per-tenant/per-table adds real complexity (schema stitching or a custom resolver-per-field-type layer) for no clear win at this stage. REST with a generic `{success,data,error}` envelope is simpler to auto-generate CRUD routes for dynamic tables later and easier to secure/rate-limit per route.

## Verification

**Commands:**
- `pnpm install` -- expected: installs without errors across all workspace packages
- `docker compose up -d` -- expected: `postgres` and `redis` containers healthy
- `pnpm --filter backend prisma migrate dev --name init` -- expected: migration applies, 14 tables created
- `pnpm --filter backend start:dev` -- expected: Nest app boots, logs all 11 module routes mapped
- `pnpm --filter backend test` -- expected: env-validation regression tests pass
- `pnpm --filter backend test:e2e` -- expected: all 11 stub routes + `/api/health` return the expected envelope
- `pnpm --filter frontend dev` -- expected: Vite dev server serves the shell with working sidebar routing

## Suggested Review Order

**Module registration & response envelope wiring (entry point)**

- Interceptor/filter registered as DI providers, not imperative `main.ts` calls, so Nest's test harness picks them up too.
  [`app.module.ts:45`](../../apps/backend/src/app.module.ts#L45)

- Bootstrap now fails loudly and exits on rejection; CORS and input validation made explicit.
  [`main.ts:33`](../../apps/backend/src/main.ts#L33)

**Multi-tenancy & schema design**

- Row-level `tenantId` chosen over schema-per-tenant; `DynamicTable`/`DynamicField` are metadata only, not runtime DDL.
  [`schema.prisma:1`](../../apps/backend/prisma/schema.prisma#L1)

**API response envelope convention**

- Every success response wrapped in `{ success, data, error }` -- the shape every module stub returns.
  [`response.interceptor.ts:18`](../../apps/backend/src/common/response.interceptor.ts#L18)

- Error payload resolution, now null-safe against non-object `HttpException` bodies.
  [`http-exception.filter.ts:69`](../../apps/backend/src/common/http-exception.filter.ts#L69)

**Module stub pattern (repeated 11x)**

- Canonical shape every feature-area module follows: one route, envelope applied globally.
  [`auth.controller.ts:14`](../../apps/backend/src/modules/auth/auth.controller.ts#L14)

- Tenant header parsed but deliberately unenforced -- real RBAC/tenant checks are deferred.
  [`tenant-context.decorator.ts:13`](../../apps/backend/src/common/tenant-context.decorator.ts#L13)

**Frontend routing/shell**

- Single source of truth: route table and sidebar both derive from the same shared-types module list.
  [`modules.ts:16`](../../apps/frontend/src/modules.ts#L16)

- Catch-all route added so unmatched paths render `NotFoundPage` instead of blank.
  [`router.tsx:22`](../../apps/frontend/src/router.tsx#L22)

**i18n**

- i18next wired with en/vi stub resources for the base system UI only.
  [`i18n/index.ts:16`](../../apps/frontend/src/i18n/index.ts#L16)

**Tests (peripherals)**

- e2e smoke test iterates `FEATURE_MODULES` so route/module-list drift fails CI, not just review.
  [`app.e2e-spec.ts:21`](../../apps/backend/test/app.e2e-spec.ts#L21)

- Regression test locking in the "fails loudly without `DATABASE_URL`" acceptance criterion.
  [`env.validation.spec.ts:21`](../../apps/backend/src/config/env.validation.spec.ts#L21)
