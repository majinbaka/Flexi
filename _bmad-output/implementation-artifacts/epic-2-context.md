# Epic 2 Context: Tenant Provisioning To Active Workspace

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Flexi can take an accepted onboarding attempt and turn it into a usable tenant workspace through an asynchronous, auditable provisioning workflow. The epic owns the product-visible commit boundary: a tenant starts unavailable in `PROVISIONING`, receives its schema, bootstrap data, First Admin identity, Tenant Admin assignment, setup delivery path, and permanent audit evidence, and becomes `ACTIVE` only after every required step succeeds. Failures and timeouts must remain explicit, safe to inspect, and unable to appear as successful provisioning.

## Stories

- Story 2.1: Provisioning Worker And Tenant Lifecycle Start
- Story 2.2: Tenant Schema Provisioning And Bootstrap Migration
- Story 2.3: Bootstrap Defaults And Tenant RBAC Seed
- Story 2.4: First Admin Identity And Tenant Admin Assignment
- Story 2.5: Setup Link Generation And Backup Email Outcome
- Story 2.6: Activation Boundary, Failure Recording, And Permanent Audit

## Requirements & Constraints

Provisioning must run outside the synchronous web request path. Accepted attempts advance through explicit step outcomes, with success, failure, and timeout states recorded rather than hidden behind a long-running request.

A tenant record is created once and begins with `Tenant.status = PROVISIONING`. Tenant-scoped login and tenant application routes must reject `PROVISIONING`, `FAILED`, and `SUSPENDED`; only `ACTIVE` is usable or handoff-ready.

Tenant schema creation uses the `tenant_<Tenant.id CUID>` naming convention. Required tenant bootstrap migrations and objects must complete before activation, and schema provisioning failures must record the failed step and safe error detail.

Bootstrap data required before activation includes system settings for locale, timezone, base currency, and configuration flags; default workflow statuses `Draft`, `In Review`, `Active`, and `Archived`; roles for Admin/Tenant Admin, Manager, and Member with the default permission matrix; default entity categories `General`, `Operations`, and `Administrative`; and initial notification templates including setup invite, password reset request, and workspace limit warning.

The First Admin must be represented by exactly one login identity and exactly one `TenantUser`, start in `pending_setup`, and must not be backed by a `SystemUser`. The tenant-scoped `TENANT_ADMIN` / `Tenant Administrator` role must exist and be assigned to the First Admin before activation, with tenant-scope permissions only.

Setup link generation happens only after required provisioning steps have succeeded. The link is one-time and short-lived, with a 24-hour expiration unless an existing stricter policy applies. Plaintext setup token values must never be persisted in audit logs, normal logs, or permanent records. Setup link regeneration is exposed through `POST /api/v1/super-admin/tenants/:id/setup-link` and is permission-gated by `system.tenants.onboard` for MVP.

Backup email delivery is not part of the activation boundary once the UI setup link is generated successfully. SMTP failure is warning-only and must be recorded without logging the plaintext token.

Every accepted attempt, successful or failed, must produce permanent `TenantOnboardingAuditLog` evidence. Audit data includes actor identity, request identity, safe payload metadata, step outcomes, compensation status when applicable, final status, and safe resource identifiers. It excludes plaintext passwords, plaintext setup tokens, secrets, stack traces, and raw SQL.

Successful Phase 1 provisioning targets completion under 1 minute. Attempts exceeding 1 minute should transition to timeout/failure rather than spin indefinitely. Migration replay remains the default provisioning strategy until p95 provisioning latency exceeds 30 seconds or tenant schema migration files exceed 50, at which point architecture should evaluate PostgreSQL template schema cloning.

## Technical Decisions

Schema-per-tenant isolation is the binding model. Tenant schema provisioning is owned or coordinated by the onboarding workflow because tenant-scoped and dynamic-table functionality assumes the schema already exists.

Schema names and identifiers must be resolved through server-side tenant data and allowlist validation, not concatenated from client-controlled input. The schema resolver and any shared identifier sanitizer should reject unsafe PostgreSQL identifiers; user-supplied table or column identifiers follow the same allowlist discipline.

Tenant-schema queries should use Knex schema scoping at the call site. Do not use session-level `SET search_path`. If raw SQL is unavoidable for DDL, scope it transaction-locally inside an explicit transaction.

Tenant migration replay must not rely on Knex `schemaName` alone. `schemaName` only relocates migration tracking tables; each migration must receive the target schema through `withUserParams({ schema })` and call `.withSchema(schema)` for its own DDL. Tests should assert created objects land in the tenant schema, not `public`.

Provisioning and migration outcomes must be captured per step so activation can make a single final decision. Known identifiers such as tenant id, schema name, auth account id, TenantUser id, role id, and failed compensation step should be retained where available for engineering escalation.

Dynamic table metadata and dynamic data live inside each tenant schema through Knex-managed tables, not Prisma public-schema models. Tenant schemas used by DynamicTables must support pinned metadata tables for `_meta_tables`, `_meta_fields`, and `_meta_migrations`; onboarding must not create a tenant workspace that violates those substrate expectations.

Guardrail settings for dynamic tables belong on the public-schema `Tenant.dynamicTableGuardrails` field with platform defaults. Because those settings are needed before a tenant creates dynamic tables, they should be available from the tenant public record rather than from tenant-schema metadata.

## UX & Interaction Patterns

Although this epic is backend-heavy, its states drive the operator surfaces. Progress consumers expect ordered steps for permission check, attempt reservation, tenant creation, schema provisioning, bootstrap migrations, Tenant Admin role, First Admin creation, role assignment, setup link creation, activation, and final audit.

The UI may show setup handoff only when `Tenant.status = ACTIVE`. If a token-bearing setup link cannot be safely re-read after reload, surfaces must show safe metadata and a clear regeneration path rather than inventing or exposing the secret.

Failure states must hide customer handoff controls and present the failed step, safe error detail, compensation state, and safe resource identifiers when available. Status must be conveyed with text plus badges/icons, not color alone, and timeline changes should be announced through a polite live region.

## Cross-Story Dependencies

Epic 2 depends on Epic 1 for an accepted, permission-gated, durable, idempotent Onboarding Attempt with safe payload metadata and actor/request identity. Replays of the same attempt must not duplicate tenants, schemas, First Admin identities, roles, or role assignments.

Provisioning order is sequential at the activation boundary: tenant creation precedes schema provisioning; schema provisioning precedes bootstrap seeding; bootstrap state precedes First Admin creation and Tenant Admin assignment; setup link generation follows required provisioning success; activation and audit finalization close the workflow.

Epic 3 depends on Epic 2 step names, statuses, safe identifiers, setup link availability, warning-only email outcome, and audit records to render progress, handoff, failure review, and escalation without adding remediation controls in Phase 1.
