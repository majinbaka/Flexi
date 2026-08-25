---
title: Tenant Onboarding / Tenant Provisioning
status: historical-requirements-reference
created: 2026-08-21
updated: 2026-08-21
---

# PRD: Tenant Onboarding / Tenant Provisioning

> **Historical product contract — verified status: 25/08/2026.** This PRD
> records the intended Phase 1 behaviour. The onboarding backend and core UI
> are now implemented; SMTP, setup-token redemption and detailed
> provisioning-progress UI are still incomplete. Current Product State and
> code/tests take precedence for release status.

## 0. Document Purpose

This PRD defines Flexi's Phase 1 internal tenant provisioning capability for the Super Admin surface and backend/API workflow. It is written for PM, engineering, architecture, QA, Ops, and downstream BMad workflows. Functional requirements are grouped by capability and numbered globally. Technical mechanics that should inform architecture and implementation are preserved in [addendum.md](prd-addendum.md).

Primary source inputs:

- [SPEC.md](../../apps/frontend/src/docs/specs/super-admin-tenant-onboarding.mdx)
- [failure-modes.md](../../apps/frontend/src/docs/specs/super-admin-tenant-onboarding-failure-modes.mdx)
- [schema-per-tenant-implementation-guide.md](../research/schema-per-tenant-implementation-guide.md)
- [ARCHITECTURE-SPINE.md](../../apps/frontend/src/docs/specs/architecture.mdx)

## 1. Vision

Flexi needs a reliable internal control plane for creating a new customer workspace without engineer-run SQL scripts or manual database setup. Phase 1 turns tenant onboarding into a standard, auditable workflow: an authorized internal user submits tenant and first-admin information, Flexi creates a tracked onboarding attempt, provisions the tenant in the background, and activates the tenant only after the required setup steps have completed.

The product goal is not to make onboarding look polished; it is to make onboarding repeatable, visible, and operationally accountable. Operations and Customer Success should be able to start a tenant request at any time, understand its current status, and know exactly what happened if it fails.

The backend workflow is product-critical because Flexi uses schema-per-tenant isolation. A tenant must never become usable while partially provisioned, and a failed attempt must never look successful. The Super Admin UI exists to initiate and observe the workflow; the backend/API workflow is the authority for state, audit, idempotency, and activation.

## 2. Target User

### 2.1 Jobs To Be Done

- As an Ops user, I need to create a new customer workspace from a standard form so I do not depend on an engineer for normal tenant setup.
- As a Customer Success user, I need access to the one-time setup link so I can include it in the customer's onboarding handoff.
- As a System Admin, I need every onboarding attempt to be traceable by actor, input metadata, step status, and final outcome.
- As an engineer on escalation, I need failure details and exact resource identifiers so I can diagnose a failed attempt without reconstructing context from chat or terminal history.

### 2.2 Non-Users (Phase 1)

- Customers and tenant users do not self-register or self-provision tenants in Phase 1.
- Unauthenticated users cannot start this flow.
- Internal users without the tenant onboarding permission cannot start this flow.

### 2.3 Key User Journeys

- **UJ-1. Linh creates a customer workspace after a signed B2B deal.**
  - **Persona + context:** Linh is an Ops specialist creating a tenant for a new business customer.
  - **Entry state:** Linh is signed into the Super Admin Dashboard as a permitted `SystemUser`.
  - **Path:** Linh opens tenant onboarding, enters tenant name, desired subdomain, plan, and first-admin email, then submits the request. Flexi validates the input and starts a background provisioning attempt. Linh watches a step checklist until the tenant becomes active.
  - **Climax:** The UI shows success and displays a one-time setup link that Linh can copy into the customer's onboarding message.
  - **Resolution:** The tenant is `ACTIVE`, the first admin has a setup path, and the attempt is permanently auditable.
  - **Edge case:** If the subdomain is already taken, Linh sees validation feedback before any tenant provisioning state is created.

- **UJ-2. Minh investigates a failed provisioning attempt.**
  - **Persona + context:** Minh is a System Admin responding to an Ops escalation.
  - **Entry state:** Minh opens the tenant onboarding history from the Super Admin Dashboard.
  - **Path:** Minh filters or opens the failed attempt, reviews the failed step, timestamp, actor, safe payload metadata, and basic error details. Minh confirms the tenant is not active and no customer login surface is available.
  - **Climax:** Minh has enough information to file or handle an engineering cleanup ticket without guessing which step failed.
  - **Resolution:** The attempt remains in `FAILED` or `failed-needs-manual-cleanup` state with audit evidence retained.

## 3. Glossary

- **Tenant** — A customer workspace represented by Flexi tenant metadata in the public schema and an associated tenant PostgreSQL schema.
- **Tenant Schema** — The PostgreSQL schema assigned to one Tenant. The expected naming convention is `tenant_<Tenant.id CUID>`.
- **SystemUser** — An internal platform actor. Only permitted SystemUsers may start tenant onboarding.
- **First Admin** — The first customer-side tenant admin created during onboarding. The First Admin is a `TenantUser`, not a `SystemUser`.
- **Tenant Admin Role** — The tenant-scoped `TENANT_ADMIN` / `Tenant Administrator` role assigned to the First Admin before activation.
- **Default RBAC Roles** — Tenant bootstrap roles created before activation: Admin/Tenant Admin, Manager, and Member, each with a default permission matrix.
- **Onboarding Attempt** — A tracked request to create and activate a Tenant. It contains lifecycle state, idempotency identity, step outcomes, and audit details.
- **Setup Link** — A one-time, short-lived link or token-backed URL used by the First Admin to complete initial account setup.
- **Plan** — Phase 1 metadata selected during onboarding. It is stored and displayed but does not enforce entitlements or feature flags in this phase.
- **Provisioning Step** — A named unit of work in the onboarding workflow, such as validation, tenant creation, schema provisioning, bootstrap seeding, First Admin creation, role assignment, setup link creation, activation, or failure recording.
- **Activation** — The final product-visible commit point where `Tenant.status` becomes `ACTIVE`.

## 4. Features

### 4.1 Super Admin Tenant Creation Form

**Description:** A permitted internal user can submit a single tenant onboarding request from the Super Admin Dashboard. The form captures only the information needed for Phase 1 provisioning and tracking: tenant name, desired subdomain, plan, and First Admin email. Realizes UJ-1.

**Functional Requirements:**

#### FR-1: Start Tenant Onboarding From Super Admin

A permitted `SystemUser` can open a tenant onboarding form and submit one request containing Tenant identity data and First Admin identity data. Realizes UJ-1.

**Consequences (testable):**

- The form accepts Tenant name, desired subdomain, Plan, and First Admin email.
- The submit action is unavailable or rejected for actors that are not permitted `SystemUser` actors.
- A successful submit creates or returns a tracked Onboarding Attempt rather than performing long-running provisioning inside the browser request.

#### FR-2: Validate Request Before Provisioning State

Flexi validates onboarding input before creating tenant provisioning state.

**Consequences (testable):**

- Duplicate subdomain is rejected before Tenant activation work begins.
- Invalid email format is rejected before Tenant activation work begins.
- Missing Tenant name, Plan, or First Admin email is rejected with field-level errors.
- Validation errors are shown in the Super Admin UI without creating a usable Tenant.

#### FR-3: Store Plan As Phase 1 Metadata

Flexi stores the selected Plan as Tenant metadata for tracking and display.

**Consequences (testable):**

- The selected Plan is visible in tenant detail and onboarding attempt detail.
- Plan does not activate entitlement enforcement or feature-flag behavior in Phase 1.
- Changing the future entitlement model is not required to complete Phase 1 onboarding.

**Out of Scope:**

- Billing, quota, and feature entitlement enforcement.

### 4.2 Permission-Gated Onboarding API

**Description:** The backend/API workflow is the authority for who may create a tenant and when state is created. Permission checks must fail closed before any tenant provisioning state is created. Realizes UJ-1 and UJ-2.

#### FR-4: Enforce System Onboarding Permission

Only `SystemUser` actors with `system.tenants.onboard` can start onboarding.

**Consequences (testable):**

- Tenant actors and unauthenticated users cannot start onboarding.
- SystemUsers lacking `system.tenants.onboard` fail before tenant state is created.
- There is no `isSuperAdmin` bypass around Role to Permission checks.

#### FR-5: Create A Durable Onboarding Attempt

The backend creates a durable Onboarding Attempt with request identity, safe payload metadata, actor identity, idempotency identity, and initial status.

**Consequences (testable):**

- Each accepted request has a stable attempt identifier.
- Attempt detail includes actor, requested Tenant name, requested subdomain, selected Plan, First Admin email, timestamps, status, and step outcomes.
- Attempt detail never stores plaintext passwords, plaintext setup tokens, or secret values.

#### FR-6: Make Request Retries Idempotent

Repeating the same onboarding request with the same idempotency identity returns or resumes the existing attempt outcome rather than creating duplicate tenant, account, role, or schema records.

**Consequences (testable):**

- A retry after timeout returns the existing attempt if the request identity and payload match.
- A retry cannot create a second Tenant for the same accepted idempotency identity.
- A repeated request with the same idempotency identity and materially different payload is rejected or flagged as a conflict. [ASSUMPTION: conflict behavior returns an explicit API error rather than silently creating a new attempt.]

### 4.3 Background Tenant Provisioning Workflow

**Description:** Provisioning runs asynchronously through a backend worker so long-running schema and bootstrap work does not block the web server. The workflow advances through explicit steps and activates the Tenant only after all required steps succeed. Realizes UJ-1.

#### FR-7: Create Tenant In Non-Active State

Flexi creates the Tenant once with `Tenant.status = PROVISIONING`.

**Consequences (testable):**

- A newly accepted Tenant is not usable for tenant login or tenant-scoped routes while status is `PROVISIONING`.
- The Tenant is not shown as ready until status becomes `ACTIVE`.
- `PROVISIONING`, `FAILED`, and `SUSPENDED` tenants are unavailable to tenant-scoped application surfaces.

#### FR-8: Provision Tenant Schema Before Activation

Flexi provisions the Tenant Schema and required bootstrap objects before activation.

**Consequences (testable):**

- The Tenant Schema name follows the approved `tenant_<Tenant.id CUID>` convention.
- The schema is resolvable through Flexi's tenancy layer.
- Required tenant bootstrap migrations complete before `Tenant.status` can become `ACTIVE`.
- The workflow records success or failure for the schema provisioning step.

#### FR-9: Seed Bootstrap Objects And Baseline Defaults

Flexi seeds the bootstrap objects and baseline defaults required for a newly active Tenant.

**Consequences (testable):**

- Seed completion is represented as a Provisioning Step.
- Activation is blocked if required seed data fails.
- Seed failures are recorded in the Onboarding Attempt.
- Required bootstrap seed objects include:
  - First Admin user record in `pending_setup` state.
  - Default RBAC Roles: Admin/Tenant Admin, Manager, and Member, with their default permission matrices.
  - System Settings: workspace locale, timezone, base currency, and system configuration flags.
  - Core Lookup Data: default status workflows, categories, and initial system notification templates.
- Default RBAC permission matrix:

| Permission Scope             | Admin / Tenant Admin                               | Manager                           | Member                           |
| ---------------------------- | -------------------------------------------------- | --------------------------------- | -------------------------------- |
| User & Role Management       | Full: create, read, update, delete, assign roles   | Read only: directory              | Read only: directory             |
| Workspace Settings & Modules | Full: update system config, features, integrations | Read only                         | None                             |
| Core Business Objects        | Full: CRUD, hard delete, export                    | Create, read, update, soft-delete | Create, read, update own records |
| Audit Logs & Security        | Read and export all logs                           | None                              | None                             |

- Default workflow statuses are `Draft`, `In Review`, `Active`, and `Archived` in a linear lifecycle.
- Default entity categories are `General`, `Operations`, and `Administrative`.
- Initial notification templates are:
  - `WELCOME_SETUP_INVITE`: email payload with the 24-hour setup token, tenant subdomain URL, and primary admin invitation text.
  - `PASSWORD_RESET_REQUEST`: direct reset link token payload.
  - `WORKSPACE_LIMIT_WARNING`: system warning notification when workspace usage approaches quota thresholds.

#### FR-10: Create First Admin Tenant Identity

Flexi creates exactly one login identity and exactly one TenantUser actor for the First Admin.

**Consequences (testable):**

- The First Admin account backs a `TenantUser`, not a `SystemUser`.
- The First Admin starts in `pending_setup` state until the Setup Link is completed.
- The flow does not create an account that backs both actor types.
- First Admin creation completes before Tenant activation.

#### FR-11: Ensure Tenant Admin Role Assignment

Flexi ensures a tenant-scoped Tenant Admin Role and assigns it to the First Admin before activation.

**Consequences (testable):**

- The role code/name are `TENANT_ADMIN` / `Tenant Administrator`.
- `Role.tenantId` equals the new Tenant id.
- The role receives tenant-scope permissions only.
- The First Admin has the Tenant Admin Role before `Tenant.status` becomes `ACTIVE`.

#### FR-12: Activate Only After Successful Completion

Flexi transitions the Tenant to `ACTIVE` only after every required provisioning step succeeds.

**Consequences (testable):**

- Activation is the only product-visible commit point.
- A failed or timed-out step prevents activation.
- The final success audit records safe identifiers for created resources.

### 4.4 Progress Visibility And Status History

**Description:** Ops needs a clear, view-only status surface for tenant onboarding attempts. Phase 1 prioritizes visibility over operator-controlled remediation. Realizes UJ-1 and UJ-2.

#### FR-13: Show Provisioning Progress In Super Admin

The Super Admin UI shows provisioning progress for an accepted attempt.

**Consequences (testable):**

- The UI shows overall status including `PROVISIONING`, `ACTIVE`, and `FAILED`; timed-out attempts resolve to `FAILED` with timeout detail.
- The UI shows a step checklist or equivalent timeline for validation, tenant creation, schema provisioning, bootstrap migrations, seeding, First Admin creation, role assignment, setup link creation, activation, and final audit.
- The UI polls `GET /api/v1/super-admin/tenants/:id/status` for MVP progress updates.

#### FR-14: Show Attempt Detail And Basic Error Information

The Super Admin UI provides attempt detail for success and failure review.

**Consequences (testable):**

- Attempt detail shows actor, timestamps, tenant name, subdomain, Plan, First Admin email, current status, step status, and failed step when applicable.
- Failure detail shows a basic safe error message or error code suitable for Ops escalation.
- Attempt detail never exposes secrets or plaintext setup tokens in logs/history.
- Onboarding history supports MVP filters for status (`PROVISIONING`, `ACTIVE`, `FAILED`), subdomain/keyword search matching tenant name or slug, and `created_at` start/end date range.
- The history table shows actor name, but actor filtering is deferred beyond MVP.

#### FR-15: Keep Phase 1 Failure Controls View-Only

Phase 1 does not include Retry, Cleanup, or manual state-transition buttons in the Super Admin UI.

**Consequences (testable):**

- Failed attempts can be viewed but not retried from the UI.
- Cleanup actions are not exposed to Ops in Phase 1.
- The UI directs Ops to `#ops-escalation-flexi` and the runbook at `https://wiki.internal.flexi/runbooks/tenant-provisioning-failure`.

### 4.5 Setup Link Delivery

**Description:** After successful provisioning, Ops receives a one-time setup path for the First Admin. The UI display is the primary delivery path because B2B onboarding often happens through a high-touch customer handoff. Automated email is a backup path. Realizes UJ-1.

#### FR-16: Generate One-Time Setup Link

Flexi generates a one-time, short-lived Setup Link for the First Admin after successful onboarding.

**Consequences (testable):**

- The Setup Link is generated only after required provisioning steps succeed.
- The plaintext setup token or token-bearing link is returned only through the intended response/display path.
- Plaintext setup token values are not persisted in audit logs.
- Setup Link expiration is 24 hours if no existing stricter setup-token policy applies.
- Ops can regenerate an expired Setup Link from the Super Admin Dashboard via `POST /api/v1/super-admin/tenants/:id/setup-link`.

#### FR-17: Display Setup Link In Super Admin UI

The Super Admin UI displays the Setup Link as the primary handoff mechanism for Ops.

**Consequences (testable):**

- On success, the UI shows the Setup Link and copy affordance.
- The link remains visible only according to safe product rules. [ASSUMPTION: if the full link cannot be safely re-read later, the UI displays it immediately after success and later shows metadata only.]
- The UI makes clear whether automated email was also attempted.

#### FR-18: Support Backup Email Delivery

Flexi can send the Setup Link to the First Admin by automated email as a backup path.

**Consequences (testable):**

- Email delivery failure is warning-only across all customer plans if the UI Setup Link was successfully generated and displayed.
- The UI shows `Email Delivery Failed (Copy Link Manually)` when SMTP delivery fails after link generation succeeds.
- Email delivery outcome is recorded as a step or sub-step without logging the plaintext token.
- Email delivery behavior can be disabled or retried by future work without changing core tenant activation semantics.

### 4.6 Audit And Operational Evidence

**Description:** Every accepted attempt must leave permanent evidence of what happened. Audit exists for security, support, engineering escalation, and accountability. Realizes UJ-2.

#### FR-19: Persist Permanent Audit Record

Flexi persists a permanent `TenantOnboardingAuditLog` record for every accepted onboarding attempt.

**Consequences (testable):**

- Success and failure paths both produce audit evidence.
- Audit detail includes actor, request identity, payload metadata, step outcomes, compensation status where applicable, and final status as JSONB or equivalent structured detail.
- Audit records are not deleted by workflow compensation.

#### FR-20: Record Failure And Manual Escalation State

When provisioning fails or times out, Flexi records the failed step, final failure state, and any resources known to need engineering review.

**Consequences (testable):**

- A failed attempt does not leave `Tenant.status = ACTIVE`.
- `failed-needs-manual-cleanup` is used only when automated compensation cannot safely continue.
- Failure records include exact known identifiers such as Tenant id, schema name, AuthAccount id, TenantUser id, role id, and failed compensation step when available.

## 5. Non-Goals (Explicit)

- Customer self-service signup or unauthenticated tenant creation.
- Tenant-user initiated provisioning.
- Billing, commercial approval, subscription lifecycle, quota enforcement, or entitlement enforcement.
- Full invite lifecycle, password reset, or broader credential management beyond First Admin bootstrap.
- Multi-tenant membership, workspace picker, actor switching, impersonation, or break-glass Root behavior.
- Ops-facing Retry, Cleanup, force activate, force fail, or other remediation controls in Phase 1.
- Dynamic-table provisioning beyond required tenant-schema bootstrap objects needed for a newly active Tenant.
- Solving zero-downtime migration across all tenant schemas as part of this PRD.

## 6. MVP Scope

### 6.1 In Scope

- Web Super Admin Dashboard form for internal tenant onboarding.
- Permission-gated backend onboarding API.
- Durable Onboarding Attempt with idempotency.
- Asynchronous backend provisioning worker.
- Tenant lifecycle states: `PROVISIONING`, `ACTIVE`, `FAILED`, `SUSPENDED`.
- Tenant Schema provisioning and required bootstrap migrations before activation.
- First Admin account and TenantUser creation.
- Tenant Admin Role creation/assignment.
- Plan metadata storage/display.
- Setup Link generation and primary UI display.
- Setup Link regeneration for expired First Admin setup links.
- Backup automated setup email.
- Status checklist/timeline for Ops.
- Onboarding history with status, keyword/subdomain, and date-range filters.
- Attempt detail, failed step, and basic safe error information.
- Permanent audit record with structured step outcomes.
- Timeout behavior for attempts exceeding the Phase 1 SLA target.

### 6.2 Out of Scope for MVP

- Entitlement/feature-flag enforcement from Plan.
- Retry/Cleanup controls in the Super Admin UI.
- Customer-facing signup.
- Billing integration.
- Self-serve domain verification or SSO setup.
- Advanced observability dashboards beyond attempt status/history and basic operational evidence.
- Actor filtering in onboarding history.
- Template-schema cloning until migration replay exceeds the agreed trigger threshold.

## 7. Cross-Cutting NFRs

- **Security:** Only permitted `SystemUser` actors may start onboarding. Tenant actors and unauthenticated actors must fail before tenant state is created.
- **Data isolation:** The Tenant must not become available until Tenant Schema provisioning and required bootstrap work complete. Tenant-scoped routes must reject `PROVISIONING`, `FAILED`, and `SUSPENDED` tenants.
- **Auditability:** Every accepted attempt has permanent audit evidence. Audit must never contain plaintext passwords, plaintext setup tokens, or secret values.
- **Reliability:** Provisioning is asynchronous and has explicit failure and timeout outcomes.
- **Performance:** Successful provisioning target is under 1 minute for Phase 1. Attempts exceeding 1 minute should transition to timeout/failure rather than spin indefinitely.
- **Provisioning strategy threshold:** Migration replay remains the default until p95 provisioning latency exceeds 30 seconds or tenant schema migration files exceed 50, at which point architecture should evaluate PostgreSQL template schema cloning.
- **Idempotency:** Retries must not create duplicate tenants, first-admin accounts, role assignments, or schemas.
- **Operability:** Failed attempts must provide enough safe information for engineering escalation.
- **Accessibility:** Super Admin UI controls and status indicators should meet the same accessibility standard as the existing internal dashboard. [ASSUMPTION: existing standard is WCAG 2.1 AA or equivalent internal baseline.]

## 8. Risk And Mitigations

| Risk                                              | Impact                                       | Mitigation                                                                                      |
| ------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Partial provisioning appears successful           | Customer sees broken or unsafe workspace     | `ACTIVE` is the only commit point; all prior states are unavailable                             |
| Duplicate request creates duplicate resources     | Operational cleanup and customer confusion   | Idempotency identity and conflict handling                                                      |
| Setup token leaks into logs                       | Account takeover risk                        | Never store plaintext setup tokens in audit or logs                                             |
| Worker exceeds expected runtime                   | Ops waits without a clear outcome            | 1-minute target with timeout/failure state                                                      |
| Failed attempt lacks cleanup context              | Engineering escalation is slow               | Attempt detail records failed step and known resource identifiers                               |
| UI exposes remediation controls too early         | Unsafe operational action by non-engineers   | Phase 1 UI is view-only for failed attempts                                                     |
| Schema provisioning is implemented inconsistently | Data isolation or migration correctness risk | Architecture/build must follow schema-per-tenant source constraints in addendum and source docs |

## 9. Operational Requirements

- Provisioning must run outside the synchronous web request path.
- The Super Admin UI must show current attempt status and step progress.
- The UI uses polling for MVP progress updates.
- Attempts that do not complete within 1 minute should surface timeout/failure status.
- Failed attempts require engineering escalation in Phase 1.
- Failed-attempt UI must link to `#ops-escalation-flexi` and `https://wiki.internal.flexi/runbooks/tenant-provisioning-failure`.
- Operators must be able to find recent attempts and inspect their status/history from the Super Admin Dashboard tenant management area.
- Onboarding history filters in MVP are status, subdomain/keyword search, and created-at date range; actor filtering is deferred.

## 10. API / Backend Surface

Phase 1 API routes:

- Trigger provisioning: `POST /api/v1/super-admin/tenants`
- List onboarding history: `GET /api/v1/super-admin/tenants`
- Poll provisioning progress: `GET /api/v1/super-admin/tenants/:id/status`
- Regenerate Setup Link: `POST /api/v1/super-admin/tenants/:id/setup-link`

Standard response envelope:

```json
{
  "success": true,
  "data": {
    "tenantId": "t_123",
    "status": "PROVISIONING"
  },
  "error": null,
  "meta": {
    "timestamp": "2026-08-21T11:00:00Z",
    "requestId": "req_abc123"
  }
}
```

Required backend behaviors:

- Permission check before state creation.
- Idempotency support on accepted requests.
- Structured attempt status and step outcomes.
- Safe error details for UI display.
- Setup Link returned/displayed only through approved path.
- Setup Link regeneration respects the 24-hour expiration policy and never logs plaintext tokens.
- Setup Link regeneration is permission-gated by `system.tenants.onboard` for MVP; a narrower credential-support permission is deferred until a distinct L1/L2 support role exists without provisioning rights.

## 11. Data Governance And Audit

- `TenantOnboardingAuditLog` retention is permanent.
- Audit data stores actor, request identity, safe payload metadata, step outcomes, compensation status, and final state.
- Audit data does not store plaintext passwords, plaintext setup tokens, or secrets.
- Plan is stored as Phase 1 metadata.
- Failed attempts preserve enough resource identifiers for engineering escalation.

## 12. Rollout And Change Management

- Phase 1 is internal-only and limited to permitted SystemUsers.
- Ops and Customer Success need a short operating note covering: how to submit a tenant, how to copy the Setup Link, how to interpret failure, and how to escalate.
- Existing manual engineer-run provisioning should remain available as a controlled fallback until the new workflow has passed acceptance testing.
- A post-launch review should compare successful provisioning latency, failure rate, and escalation quality against the success metrics below.

## 13. Success Metrics

**Primary**

- **SM-1:** Manual engineer intervention for successful standard tenant creation drops to zero. Validates FR-1 through FR-18.
- **SM-2:** 95% of successful Phase 1 provisioning attempts complete in under 1 minute. Validates FR-7 through FR-13.
- **SM-3:** 100% of accepted attempts have permanent audit records with final status and step outcomes. Validates FR-5, FR-19, FR-20.

**Secondary**

- **SM-4:** 100% of successful attempts generate a Setup Link visible to Ops in the UI. Validates FR-16, FR-17.
- **SM-5:** Failed attempts show failed step and safe basic error detail without exposing secrets. Validates FR-14, FR-20.
- **SM-6:** Duplicate retries do not create duplicate Tenant, First Admin, Role, or Tenant Schema records in test and production monitoring. Validates FR-6.
- **SM-7:** 100% of SMTP delivery failures after successful link generation surface as warning-only UI badges, not failed tenant provisioning. Validates FR-18.
- **SM-8:** p95 provisioning latency remains below 30 seconds after launch, preserving buffer under the 1-minute hard timeout. Validates FR-7 through FR-13.

**Counter-metrics**

- **SM-C1:** Do not optimize for lowest possible provisioning time by moving schema work into the synchronous request path. Counterbalances SM-2.
- **SM-C2:** Do not reduce failure visibility to make success rate appear higher; failures must remain explicit and auditable. Counterbalances SM-3 and SM-5.
- **SM-C3:** Do not add UI remediation controls in Phase 1 to reduce escalation count. Counterbalances SM-5.

## 14. Open Questions

None for PRD scope. Remaining implementation details should move to architecture, epics, or build tickets.

## 15. Assumptions Index

- FR-6: Idempotency conflict behavior returns an explicit API error rather than silently creating a new attempt.
- FR-17: If the full Setup Link cannot be safely re-read later, the UI displays it immediately after success and later shows metadata only.
- Cross-Cutting NFRs: Existing internal dashboard accessibility standard is WCAG 2.1 AA or equivalent.
