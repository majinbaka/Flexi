# Flexi

Flexi is a greenfield low-code platform. This repository is currently a
**scaffold**: a pnpm monorepo (NestJS backend + React/Vite frontend) with a
Prisma-modeled core metadata schema and one thin stub module per planned
feature area. No feature has real business logic yet -- see
[`docs/process/deferred-work.md`](./docs/process/deferred-work.md)
and [`ROADMAP.md`](./ROADMAP.md) for what's deferred and why.

## Prerequisites

- Node.js >= 20
- [pnpm](https://pnpm.io/) >= 9 (`corepack enable` or `npm i -g pnpm`)
- Docker + Docker Compose (for local Postgres/Redis)

## Repository layout

```
apps/
  backend/           NestJS API (REST, port 3000 by default)
  frontend/          React + Vite SPA (port 5173 by default)
packages/
  shared-types/      Types/enums/DTOs shared by both apps (built to dist/, see below)
docker-compose.yml   Postgres 16 + Redis 7 for local dev
```

Design specifications and the architecture spine live as MDX pages under
`apps/frontend/src/docs/`,
rendered by Storybook's Docs view -- see "Component workshop (Storybook)"
below. Everything else (PRD, epics, UX design, research, process docs)
lives under [`docs/`](./docs) -- see [`docs/README.md`](./docs/README.md).

## Component workshop (Storybook)

`apps/frontend` has a Storybook instance for developing/viewing
components in isolation and reading process docs as rendered MDX pages,
instead of only inside the running app.

```bash
pnpm --filter @flexi/frontend storybook
```

Starts the Storybook dev server (default `http://localhost:6006`). The
sidebar lists component stories (`Layout`, `Sidebar`) under "Components",
docs ("Introduction", "Design Tokens", and "Current Product State") under "Docs",
and every design spec plus the architecture spine under "Specs" (grouped
by Architecture, Tenant Onboarding, Dynamic Table Builder, Auth & Tenancy
Core, and Platform & Tooling -- see
[`apps/frontend/src/docs/specs-index.mdx`](./apps/frontend/src/docs/specs-index.mdx)).
`pnpm --filter @flexi/frontend build-storybook` produces a
static build in `apps/frontend/storybook-static/`.

## First-time setup (clean checkout -> running app)

Run these from the repository root, in order.

### 1. Install dependencies

```bash
pnpm install
```

pnpm will ask to run a few packages' install scripts (Prisma engines,
`esbuild`, `@nestjs/core`). This repo already whitelists them via the
`pnpm.onlyBuiltDependencies` field in the root `package.json`, so a plain
`pnpm install` is enough -- no extra `pnpm approve-builds` step needed.

### 2. Configure environment variables

```bash
cp .env.example .env
cp apps/backend/.env.example apps/backend/.env
```

- Root `.env` is read by `docker-compose.yml` (Postgres/Redis credentials and
  ports) and contains the `VITE_*` variables for the frontend.
- `apps/backend/.env` is read by both the NestJS `ConfigModule` and the
  Prisma CLI (both resolve `.env` relative to `apps/backend`, which is the
  working directory pnpm uses for `pnpm --filter backend ...`
  commands). It must contain `DATABASE_URL` at minimum -- the backend fails
  to boot loudly if it's unset.

The defaults in both `.env.example` files already match each other and
`docker-compose.yml`, so for local dev you can copy them as-is.

### 3. Start Postgres + Redis

```bash
docker compose up -d
```

Wait for both containers to report healthy:

```bash
docker compose ps
```

### 4. Build the shared types package

The backend and frontend both import `@flexi/shared-types` as a regular
workspace package (resolved through `node_modules`), so it must be compiled
**before** starting either app -- there is no on-the-fly TS resolution across
workspace package boundaries here.

```bash
pnpm run build:shared-types
```

Re-run this whenever you change files under `packages/shared-types/src`
(or run `pnpm --filter shared-types dev` to watch).

### 5. Apply the database schema

```bash
pnpm --filter backend prisma migrate dev --name init
```

This creates all 14 core metadata tables (`tenants`, `users`, `roles`,
`permissions`, `role_permissions`, `dynamic_tables`, `dynamic_fields`,
`workflows`, `pages`, `cron_jobs`, `mail_templates`, `wiki_pages`,
`log_entries`, `translations`) in the `flexi` Postgres database and
generates the Prisma Client.

### 6. Run the backend

```bash
pnpm --filter backend start:dev
```

Nest boots on `http://localhost:3000`, with every route prefixed `/api`. You
should see all 11 stub module routes mapped in the startup log. Verify with:

```bash
curl http://localhost:3000/api/workflows
# {"success":true,"data":{"status":"not-implemented"},"error":null}
```

### 7. Run the frontend (separate terminal)

```bash
pnpm --filter frontend dev
```

Vite serves the SPA on `http://localhost:5173` (or the next free port if
that one's taken). Open it in a browser -- the sidebar lists all 11 modules;
each links to a placeholder page rendered client-side via `react-router`.
Use the EN/VI buttons in the sidebar to switch locales (i18next).

## Default super admin (local dev)

`prisma migrate dev` runs `apps/backend/prisma/seed.ts` automatically (via
the `prisma.seed` config in `apps/backend/package.json`), which creates a
platform-level **SystemUser** with the `PlatformAdmin` role -- the
system-wide "super admin", as opposed to a per-tenant `Admin`
(`TenantUser`). It is authorized through the same Role -> Permission /
`PermissionsGuard` mechanism as everyone else; there is no `isSuperAdmin`
bypass.

|          |                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Email    | `super@flexi.local`                                                                                                                   |
| Password | `Super123!`                                                                                                                           |
| Login    | `POST /api/auth/login` with **no** `x-tenant-id` header (that header is what routes a login to a tenant `Admin`/`TenantUser` instead) |

**This is a local-dev-only seed, not a production bootstrap.** The seed
script hardcodes this password and refuses to run when
`NODE_ENV=production` (see the guard at the top of `seed.ts`). Before
deploying anywhere real, create a proper system admin with a generated
password (e.g. a one-off script or `psql`/Prisma Studio insert into
`auth_accounts` + `system_users` + `roles`/`role_permissions`) and rotate
or remove the seeded `super@flexi.local` account.

## Everyday scripts (from repo root)

| Command                   | What it does                                                                      |
| ------------------------- | --------------------------------------------------------------------------------- |
| `pnpm dev:backend`        | `nest start --watch`                                                              |
| `pnpm dev:frontend`       | `vite` dev server                                                                 |
| `pnpm dev:storybook`      | Storybook dev server for `apps/frontend`                                          |
| `pnpm build`              | Builds `shared-types`, then `backend`, then `frontend`, in order                  |
| `pnpm lint`               | Lint all workspaces with ESLint                                                   |
| `pnpm format`             | Format all files with Prettier                                                    |
| `pnpm format:check`       | Check Prettier formatting without writing                                         |
| `pnpm editorconfig:check` | Check tracked files against `.editorconfig` (indent, EOL, final newline, charset) |
| `pnpm test`               | Run each workspace's test script, if it has one                                   |
| `pnpm prisma:generate`    | Regenerate Prisma Client from `schema.prisma`                                     |
| `pnpm prisma:migrate`     | Create/apply a new Prisma migration                                               |

## API conventions

Every response is wrapped in a standard envelope:

```jsonc
// success
{ "success": true, "data": { /* ... */ }, "error": null }

// failure (any thrown HttpException, or an unhandled error)
{ "success": false, "data": null, "error": { "code": "...", "message": "..." } }
```

implemented via `apps/backend/src/common/response.interceptor.ts` (global
interceptor) and `apps/backend/src/common/http-exception.filter.ts` (global
exception filter), both wired in `apps/backend/src/main.ts`.

## Multi-tenancy (current state)

Tenant scoping is row-level (`tenantId` column) rather than
schema-per-tenant -- see the Design Notes in the "Flexi Core Scaffold"
spec (`apps/frontend/src/docs/specs/flexi-core-scaffold.mdx`, view via
Storybook's Docs sidebar under "Specs/Platform & Tooling") for the
rationale. `apps/backend/src/common/tenant-context.decorator.ts`
only parses the `x-tenant-id` request header -- it does **not** validate or
enforce anything yet; real enforcement is deferred.

## What's stubbed vs. real

Every one of the 11 feature-area modules (`auth`, `tenants`,
`dynamic-tables`, `workflows`, `pages`, `cron-jobs`, `mail-templates`,
`wiki`, `i18n`, `settings`, `logs`) currently exposes exactly one route --
`GET /api/<area>` returning `{ status: 'not-implemented' }` -- and no
business logic. See `ROADMAP.md` for the planned rollout order.

## Troubleshooting

- **Backend fails to start with a Prisma/`DATABASE_URL` error**: make sure
  `apps/backend/.env` exists and `docker compose ps` shows `postgres` as
  healthy.
- **`Cannot find module '@flexi/shared-types'`**: run
  `pnpm run build:shared-types` (step 4 above) -- this package is not
  auto-built by `pnpm install`.
- **Frontend port already in use**: Vite automatically tries the next free
  port and prints the actual URL it bound to.
