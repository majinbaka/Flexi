# Remaining work

**Verified against source: 2026-08-25.** This is the live, concise backlog.
Completed and historical planning records are intentionally not retained here.
Use [Current Product State](../../apps/frontend/src/docs/current-product-state.mdx)
for the verified code inventory.

## Product capabilities

- Build the Dynamic Tables frontend builder and connect it to the existing
  table, field, job-status and row APIs.
- Decide, implement and validate Dynamic Tables guardrails: tenant table and
  column limits, request/page-size limits, and operational catalog metrics.
- Implement setup-token redemption/password setup and real SMTP delivery for
  tenant first-admin invitations.
- Add reset-password flows plus role, permission and account administration;
  enforce permission-ceiling and role-scope rules when those mutation APIs
  exist.
- Replace the remaining placeholder modules: Workflows, Pages, Cron jobs,
  Mail templates, Wiki, dynamic-content i18n, Settings and Logs.

## Reliability and verification

- Add a frontend test runner and cover auth refresh, login variants,
  onboarding permissions and tenant-list states.
- Run backend e2e tests with Postgres/Redis in CI, including tenant
  provisioning, Dynamic Tables permissions and DDL failure paths.
- Add provisioning progress/history UI and observability for setup-link
  regeneration, refresh-token reuse, and terminal queue failures.
- Validate database pool sizing, migration orchestration across tenant schemas
  and production DDL timeout/retry behaviour with realistic traffic.

## Deferred by product choice

- No GraphQL: Flexi remains REST-only.
- Dynamic Tables has backend support but no builder UI yet; do not treat the
  frontend placeholder route as proof that its backend API is unavailable.
