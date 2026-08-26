# Flexi roadmap

**Verified against source: 2026-08-25.** This roadmap reflects the current
baseline, not the original scaffold plan. The detailed, active list moved into
the Storybook specs under
[apps/frontend/src/docs/specifications/](./apps/frontend/src/docs/specifications/)
-- start from `overview.mdx` and `platform-roadmap.mdx`; the GitHub issue
tracker carries the per-story backlog.

## Completed foundation

- pnpm monorepo; NestJS, React/Vite, Prisma/Postgres, Redis and shared
  TypeScript contracts.
- Response envelope, exception handling, Storybook, lint/format tooling and
  EN/VI shell.
- Tenant and system authentication, RBAC guards, refresh-token rotation/reuse
  detection and rate limiting.
- Super-admin tenant onboarding and tenant schema provisioning.
- Dynamic Tables backend through metadata, DDL jobs, rows and many-to-one
  relations.

## Next priorities

1. Deliver the Dynamic Tables UI and settle/enforce guardrails.
2. Complete first-admin setup (SMTP plus token redemption/password setup).
3. Add frontend tests and CI e2e coverage with local services.
4. Build the remaining product modules in this dependency order:
   Workflows/Pages, Cron jobs, Mail templates, Wiki, Settings, dynamic i18n
   and Logs.

## Product boundaries

- REST only; GraphQL is out of scope.
- Fixed platform metadata remains Prisma/row-scoped. Dynamic Table data uses
  tenant PostgreSQL schemas; migration orchestration across all schemas still
  needs production validation.
