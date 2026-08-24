# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Flexi is a low-code platform: pnpm monorepo, NestJS backend (`apps/backend`) +
React/Vite frontend (`apps/frontend`), sharing types via `packages/shared-types`.
The root `README.md` frames this as an early scaffold with only stub modules,
but that's stale — Auth, Tenants (provisioning), and Dynamic Tables now have
real, non-trivial implementations (JWT auth + RBAC, async tenant
provisioning with compensation/audit, a DDL engine with a job queue). The
other 8 feature-area modules (`workflows`, `pages`, `cron-jobs`,
`mail-templates`, `wiki`, `i18n`, `settings`, `logs`) are still one-route
stubs returning `{ status: 'not-implemented' }`. Check `ROADMAP.md` and
`docs/process/deferred-work.md` for what's planned
vs. done, but verify against the actual module before trusting either doc —
see the multi-tenancy note below for an example of docs lagging code.

## Commands

Run from the repo root unless noted.

```bash
pnpm install                                    # also builds nothing — see below
pnpm run build:shared-types                     # MUST run before starting backend/frontend or after editing packages/shared-types/src
pnpm --filter backend prisma migrate dev --name <name>   # apply/create a migration + regenerate Prisma Client
pnpm dev:backend                                # nest start --watch, port 3000, routes under /api
pnpm dev:frontend                               # vite dev server, port 5173
pnpm dev:storybook                              # Storybook for apps/frontend, port 6006
pnpm build                                      # shared-types -> backend -> frontend, in order
pnpm lint                                       # eslint . (flat config, one root eslint.config.js for both apps)
pnpm format / pnpm format:check                 # prettier
pnpm editorconfig:check
pnpm test                                       # runs each workspace's test script if present
```

Backend tests (Jest, run from `apps/backend` or via `--filter`):

```bash
pnpm --filter backend test                      # unit tests (*.spec.ts, colocated with source)
pnpm --filter backend test:watch
pnpm --filter backend test:e2e                  # apps/backend/test, separate jest-e2e.json config
pnpm --filter backend test -- path/to/file.spec.ts       # single file
pnpm --filter backend test -- -t "test name"             # by name
```

There is no frontend test runner configured (`@flexi/frontend` has no
`test` script) — Storybook stories are the current substitute for
component-level verification.

Local infra: `docker compose up -d` (Postgres 16 + Redis 7). Both apps read
env from `.env` files that must be copied from `.env.example` first (root
`.env` for Docker/Vite, `apps/backend/.env` for NestJS + Prisma CLI — see
README "First-time setup" for the full sequence). CI (`.github/workflows/ci.yml`)
runs: editorconfig check → `prisma generate` → `pnpm build` → `pnpm lint` →
`pnpm format:check` → `pnpm test`, against a dummy `DATABASE_URL` (no live DB
in CI).

## Architecture

### Two coexisting data-access layers — know which one a module uses

This is the single most important thing to get right before touching
backend code, and it's easy to get wrong from the Prisma schema's comments
or `ROADMAP.md` alone (both describe the *original* decision, not the
current one — see the "Schema-Per-Tenant Core" spec under
`apps/frontend/src/docs/specs/schema-per-tenant-core.mdx` (view via
Storybook's Docs sidebar, "Specs/Auth & Tenancy Core") for the pivot
rationale):

- **Core platform metadata** (`Tenant`, `AuthAccount`, `SystemUser`,
  `TenantUser`, `Role`/`Permission`/`RolePermission`, `RefreshToken`,
  `SetupToken`, `TenantOnboardingAttempt`, and the still-stub modules'
  tables like `Workflow`/`Page`/`CronJob`/etc.) lives in Prisma, row-scoped
  by a `tenantId` column, in the `public` schema. Accessed via
  `PrismaService` (`apps/backend/src/prisma/`).
- **Dynamic Table Builder data** (user-created tables/fields/rows) lives in
  a **separate Postgres schema per tenant** (`tenant_<tenantId>`), accessed
  only through Knex via `TenantKnexService`
  (`apps/backend/src/tenancy/tenant-knex.service.ts`). Prisma cannot model
  these at runtime since their shape is created dynamically.

Never resolve a tenant schema name by string-concatenating
`tenant_${tenantId}` — always go through
`apps/backend/src/tenancy/resolve-tenant-schema.ts`, the sole choke point
that validates and length-checks it (Postgres silently truncates
identifiers over 63 bytes, which could otherwise collide two tenants onto
the same schema). Same rule for any other Postgres identifier
(table/column names) built from user input: route it through
`apps/backend/src/tenancy/sanitize-identifier.ts`.

Tenant identity for schema routing comes from exactly one place:
`JwtAuthGuard.canActivate()` (`apps/backend/src/modules/auth/guards/jwt-auth.guard.ts`),
which verifies the access token, confirms the tenant is still `ACTIVE`, and
sets `tenantId`/`schema` on a CLS (continuation-local storage, via
`nestjs-cls`) store. `TenantContext`
(`apps/backend/src/tenancy/tenant-context.ts`) is the typed read-only
accessor for that store elsewhere in request handling — both its getters
throw if called outside a verified tenant-scoped request, deliberately, so
a code path outside tenant context fails loudly instead of silently
defaulting to `public`. This happens in the guard rather than
`ClsModule`'s middleware hook because Nest middleware runs before guards,
so `request.user` isn't populated yet at that point.

### DDL is asynchronous, never on the request path

Dynamic table/field creation is validated synchronously in
`DynamicTablesService`, then enqueued as a BullMQ job
(`apps/backend/src/modules/dynamic-tables/ddl-worker.ts`) and executed by a
worker. A destructive field-type change (`modify` with a `dataType` change)
becomes a 3-step expand/contract sequence (add shadow column → backfill →
cutover), never a single in-place `ALTER ... TYPE`. `GET
/api/tables/jobs/:jobId` polls status. Row DML (`rows.controller.ts`) is
synchronous — only table/field DDL is queued.

### Response envelope & errors

Every HTTP response is wrapped by a global interceptor/filter pair wired as
`APP_INTERCEPTOR`/`APP_FILTER` providers in `app.module.ts` (not
`main.ts`, so they're also active under Nest's `Test.createTestingModule`):

```jsonc
{ "success": true, "data": { /* ... */ }, "error": null }
{ "success": false, "data": null, "error": { "code": "...", "message": "..." } }
```

`apps/backend/src/common/response.interceptor.ts` and
`apps/backend/src/common/http-exception.filter.ts`. A validation failure
uses `BadRequestException({ error: 'VALIDATION_ERROR', message: [...] })` —
follow that shape for new validation errors so they render consistently.

### Auth

Login issues a short-lived JWT access token + rotating refresh token
(hashed, never stored in plaintext — `RefreshToken.tokenHash`). An
`AuthAccount` is the login identity (email + passwordHash); it backs
*either* a `SystemUser` (platform-level, e.g. the super admin, no
`tenantId`) *or* a `TenantUser` (scoped to one tenant) — never both, and
that's enforced at the service layer, not the DB. Both actor types are
authorized through the same `Role` → `Permission` → `PermissionsGuard`
mechanism (`@RequirePermissions()` decorator); there is no `isSuperAdmin`
bypass. `x-tenant-id` header routes a login attempt to a `TenantUser`;
omitting it routes to a `SystemUser`.

### Tenant provisioning

Creating a tenant is an async, multi-step, compensating workflow
(`apps/backend/src/modules/tenants/provisioning.service.ts` +
`provisioning.worker.ts`, BullMQ-backed): create `Tenant` row → provision
its Postgres schema + bootstrap dynamic-tables meta tables → seed default
RBAC → create the first admin `TenantUser` → generate a one-time setup
link → send email. Each `TenantOnboardingAttempt` is idempotent on a
caller-supplied idempotency key, and every attempt's step outcomes plus
final activation result are permanently recorded (`TenantOnboardingAttempt`
+ the append-only `TenantOnboardingAuditLog`) even on failure. A tenant
lands in `PROVISIONING` → `ACTIVE` or `FAILED`; `FAILED` can mean
`failed-needs-manual-cleanup` if compensation itself couldn't complete.

### Shared types package

`packages/shared-types` is a real workspace package resolved through
`node_modules`, **not** live-linked TypeScript — it must be built
(`pnpm run build:shared-types`) before either app can import
`@flexi/shared-types`, and after every change under
`packages/shared-types/src`. Several Prisma columns that are conceptually
enums (`DynamicField.dataType`, `Permission.scope`) are stored as plain
strings and validated at the service layer against enums exported from
this package instead — the intent is one source of truth for the allowed
values, shared by both apps, rather than a Prisma-native enum on one side
and a duplicated TS union on the other.

### Frontend

React Router SPA (`apps/frontend/src/router.tsx`), i18next for en/vi
(`apps/frontend/src/i18n`), Tailwind for styling. `apps/frontend/src/lib/api-client.ts`
is the sole HTTP client. Storybook stories live alongside components
(`*.stories.tsx`) and MDX docs pages live under `apps/frontend/src/docs/`,
rendered in Storybook's Docs view — this includes the Figma design-sync
workflow doc (`figma-design-sync.mdx`); read that (in Storybook, not raw)
before touching `apps/frontend/src/styles/tokens.css` or syncing new
screens, and update
`docs/process/figma-sync-ledger.md` when you do.

## Conventions worth knowing before editing

- One root `eslint.config.js` (flat config) covers both apps; `eslint-config-prettier`
  is deliberately last in the config array so ESLint only flags logic
  issues and Prettier stays the sole formatting authority.
- Backend `*.spec.ts` files are colocated with the source they test (not in
  a parallel `__tests__` tree); e2e tests live separately under
  `apps/backend/test`.
- Design specs (Design Notes, Boundaries, "Never" lists) behind
  non-trivial modules, plus the architecture spine, live as MDX pages
  under `apps/frontend/src/docs/specs/` — view them via Storybook's Docs
  sidebar ("Specs/…", `pnpm --filter @flexi/frontend storybook`) rather
  than reading the raw `.mdx` — when working in `dynamic-tables`,
  `tenants`, or `auth`, check for a matching spec there before assuming
  intent from code alone; several of the code comments in this repo (e.g.
  in `dynamic-tables.service.ts`, `ddl-worker.ts`) directly reference spec
  section names like "AD-2", "AD-10", "CAP-4". `apps/frontend/src/docs/specs-index.mdx`
  is the index.
- This repo is developed partly through the BMad method (`_bmad/`,
  `_bmad-output/`, and the `bmad-*` skills). Curated planning output
  (PRD, epics, UX design, research, process docs) has been consolidated
  out of `_bmad-output/` into the top-level `docs/` folder (see
  `docs/README.md`) and Storybook (specs/architecture, above) — treat
  those as canonical, not the BMad source paths they were migrated from.
  `_bmad-output/` itself still holds BMad's live working state:
  `_bmad-output/implementation-artifacts/sprint-status.yaml` tracks story
  status, and per-topic `.memlog.md`/digest/import files are BMad session
  scratch, not documentation.
