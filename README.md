# Flexi

Flexi is a pnpm monorepo for a low-code platform: NestJS REST API, React/Vite
SPA, PostgreSQL/Redis and shared TypeScript contracts.

As of 25/08/2026, authentication/RBAC, super-admin tenant onboarding and the
Dynamic Tables backend are implemented. The Dynamic Tables builder UI and
several product modules remain unfinished. See
[Current Product State](./apps/frontend/src/docs/current-product-state.mdx)
and the [live backlog](./docs/process/deferred-work.md) before planning work.

## Prerequisites

- Node.js >= 20
- [pnpm](https://pnpm.io/) >= 9
- Docker + Docker Compose

## Local setup

    pnpm install
    cp .env.example .env
    cp apps/backend/.env.example apps/backend/.env
    docker compose up -d
    pnpm build:shared-types
    pnpm --filter @flexi/backend prisma:deploy
    pnpm --filter @flexi/backend prisma:seed

Start the apps in separate terminals:

    pnpm dev:backend
    pnpm dev:frontend

The API runs at http://localhost:3000/api; Vite runs at
http://localhost:5173. Use the backend prisma:migrate script only when
creating a new local migration.

## Current capabilities

- Auth: tenant/system login, refresh-token rotation and reuse detection,
  logout, /auth/me, JWT and permission guards, login/refresh rate limits.
- Tenant onboarding: slug preflight, idempotent requests, queued provisioning,
  tenant schema/bootstrap/seed, first-admin setup token, audit, tenant list.
  SMTP delivery and setup-token redemption are not implemented.
- Dynamic Tables backend: tenant-schema metadata, queued DDL, table/field
  updates, job status, row CRUD and many-to-one relations. The frontend
  /dynamic-tables route is still a placeholder.
- Frontend: app shell, EN/VI UI i18n, auth screens, onboarding and tenant
  list. Workflows, Pages, Cron jobs, Mail templates, Wiki, dynamic i18n,
  Settings and Logs remain placeholders.

## Default local super admin

The seed creates a development-only account:

| Field    | Value                                    |
| -------- | ---------------------------------------- |
| Email    | super@flexi.local                        |
| Password | Super123!                                |
| Login    | POST /api/auth/login without x-tenant-id |

Never use that account or password outside local development.

## Common commands

| Command                                       | Purpose                                  |
| --------------------------------------------- | ---------------------------------------- |
| pnpm build                                    | Build shared types, backend and frontend |
| pnpm lint                                     | Run ESLint                               |
| pnpm format:check                             | Check Prettier formatting                |
| pnpm test                                     | Run workspace test scripts               |
| pnpm --filter backend test:e2e                | Run backend e2e tests                    |
| pnpm dev:storybook                            | Run Storybook                            |
| pnpm --filter @flexi/frontend build-storybook | Build Storybook docs                     |

## Documentation

Storybook contains UI docs and the current-state page:

    pnpm dev:storybook

The [documentation index](./docs/README.md) links the current backlog.
Code, tests and the Storybook current-state page are the documentation source
for current behavior.
