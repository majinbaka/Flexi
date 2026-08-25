# Flexi Roadmap

This scaffold (see the "Flexi Core Scaffold" spec,
`apps/frontend/src/docs/specs/flexi-core-scaffold.mdx`, view via
Storybook's Docs sidebar under "Specs/Platform & Tooling")
establishes the monorepo, core metadata schema, and one stub module per
feature area, with no business logic. Everything below is deferred work --
each item corresponds 1:1 to an entry in
[`docs/process/deferred-work.md`](./docs/process/deferred-work.md).

Phases are ordered by dependency: later modules build on earlier ones (e.g.
Workflows/Pages assume Auth + RBAC exist; Cron assumes Workflows exist).
Within a phase, order is not strict.

## Phase 0 -- Scaffold (this repo, done)

- pnpm monorepo: `apps/backend` (NestJS), `apps/frontend` (React+Vite),
  `packages/shared-types`
- Core metadata schema (14 Prisma models), row-level `tenantId` multi-tenancy
- Stub module + one placeholder route per feature area, registered in
  `AppModule`
- Response envelope + global exception filter
- Frontend router shell, sidebar nav, i18next (en/vi)
- Docker Compose (Postgres 16 + Redis 7)
- Shared frontend design tokens in `apps/frontend/src/styles/tokens.css`

## Phase 1 -- Foundation: Auth & Multi-Tenancy

Nothing else can be real without these two.

- **Authentication & Authorization** (`apps/backend/src/modules/auth`):
  login/logout, refresh tokens, forgot password, RBAC role/permission
  management (the `Role`/`Permission`/`RolePermission` tables already exist),
  tenant-aware auth guards/middleware.
- **Multi-tenant isolation** (`apps/backend/src/modules/tenants` +
  cross-cutting): enforce `tenantId` scoping on every query (the
  `TenantContext` decorator currently only parses the header, it enforces
  nothing), subdomain/tenant-code resolution, optionally harden with
  Postgres RLS policies later.

## Phase 2 -- Core Low-Code Primitives

- **Dynamic Database / Table Builder** (`apps/backend/src/modules/dynamic-tables`):
  table/field creation UI + API, field validation, relations, and the
  runtime DDL/migration engine (raw SQL or a query builder like Knex --
  Prisma cannot model these at runtime, see Design Notes in the scaffold
  spec).
- **Settings** (`apps/backend/src/modules/settings`): system-wide
  theme/logo/org config UI + API, per-tenant settings.

## Phase 3 -- Builders on top of dynamic data

- **Page Builder & Page Routing** (`apps/backend/src/modules/pages`):
  drag-drop component builder, data binding to dynamic tables, dynamic
  routing with role-based access.
- **Workflow Builder** (`apps/backend/src/modules/workflows`): drag-drop
  node-graph editor, triggers, conditions, actions.

## Phase 4 -- Automation & Communication

- **Cron Jobs** (`apps/backend/src/modules/cron-jobs`): cron expression UI,
  binding to workflows/scripts/actions, run history log. Depends on
  Workflows existing to have something to schedule.
- **Mail & Templates** (`apps/backend/src/modules/mail-templates`): SMTP
  config, template editor with variable binding, template list management.

## Phase 5 -- Content & Observability

- **Wiki / internal documentation** (`apps/backend/src/modules/wiki`):
  article CRUD, folder hierarchy (the `WikiPage.parentId` self-relation
  already exists), search, markdown editor.
- **Realtime Logging** (`apps/backend/src/modules/logs`): WebSocket live
  log viewer, filter by module/level/tenant, queryable log storage (the
  `LogEntry` table already exists as a write target).
- **Dynamic-content i18n** (`apps/backend/src/modules/i18n`): translation of
  user-created content (field labels, page names, wiki content) -- beyond
  the base system-UI i18n scaffolding already in place
  (`apps/frontend/src/i18n`, `Translation` table).

## Out of scope (per spec constraints, not just deferred)

- GraphQL (REST only, by design)
- Schema-per-tenant (row-level `tenantId` only, by design)
