# Flexi

Flexi is a greenfield low-code platform. This repository is currently a
**scaffold**: a pnpm monorepo (NestJS backend + React/Vite frontend) with a
Prisma-modeled core metadata schema and one thin stub module per planned
feature area. No feature has real business logic yet -- see
[`_bmad-output/implementation-artifacts/deferred-work.md`](./_bmad-output/implementation-artifacts/deferred-work.md)
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
docs/                Process/workflow docs (e.g. Figma design sync)
docker-compose.yml   Postgres 16 + Redis 7 for local dev
```

## Design workflow

The intended process is to sync frontend UI from Figma incrementally,
one feature at a time, into a shared CSS token file rather than
hardcoding values per component. As of this writing no screens have
been synced yet -- `tokens.css` is empty and the sync ledger has zero
rows; this section documents the convention future feature work is
expected to follow. See
[`docs/figma-design-sync.md`](./docs/figma-design-sync.md) for the file
key, MCP server, and step-by-step process, and
[`_bmad-output/implementation-artifacts/figma-sync-ledger.md`](./_bmad-output/implementation-artifacts/figma-sync-ledger.md)
for which frames have been synced so far.

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

## Everyday scripts (from repo root)

| Command                | What it does                                                     |
| ---------------------- | ---------------------------------------------------------------- |
| `pnpm dev:backend`     | `nest start --watch`                                             |
| `pnpm dev:frontend`    | `vite` dev server                                                |
| `pnpm build`           | Builds `shared-types`, then `backend`, then `frontend`, in order |
| `pnpm lint`            | Lint all workspaces with ESLint                                  |
| `pnpm format`          | Format all files with Prettier                                   |
| `pnpm format:check`    | Check Prettier formatting without writing                        |
| `pnpm test`            | Run each workspace's test script, if it has one                  |
| `pnpm prisma:generate` | Regenerate Prisma Client from `schema.prisma`                    |
| `pnpm prisma:migrate`  | Create/apply a new Prisma migration                              |

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
schema-per-tenant -- see the Design Notes in
[`_bmad-output/implementation-artifacts/spec-flexi-core-scaffold.md`](./_bmad-output/implementation-artifacts/spec-flexi-core-scaffold.md)
for the rationale. `apps/backend/src/common/tenant-context.decorator.ts`
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
