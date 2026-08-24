---
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
  - step-04-final-validation
extractionStatus: confirmed
inputDocuments:
  - docs/product/prd.md
  - apps/frontend/src/docs/specs/architecture.mdx
  - docs/design/ux-design.md
  - docs/design/ux-experience.md
---

# Flexi - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Flexi, decomposing the requirements from the PRD, UX Design if it exists, and Architecture requirements into implementable stories.

## Requirements Inventory

### Functional Requirements

FR1: A permitted SystemUser can open a tenant onboarding form and submit one request containing tenant identity data and First Admin identity data.

FR2: Flexi validates onboarding input before creating tenant provisioning state.

FR3: Flexi stores the selected Plan as Tenant metadata for tracking and display, without activating entitlement enforcement or feature-flag behavior in Phase 1.

FR4: Only SystemUser actors with `system.tenants.onboard` can start onboarding; tenant actors, unauthenticated users, and SystemUsers without the permission fail before state creation.

FR5: The backend creates a durable Onboarding Attempt with request identity, safe payload metadata, actor identity, idempotency identity, timestamps, status, and step outcomes, without storing plaintext passwords, plaintext setup tokens, or secrets.

FR6: Repeating the same onboarding request with the same idempotency identity returns or resumes the existing attempt outcome rather than creating duplicate tenant, account, role, or schema records.

FR7: Flexi creates the Tenant once with `Tenant.status = PROVISIONING`, and `PROVISIONING`, `FAILED`, and `SUSPENDED` tenants are unavailable to tenant-scoped application surfaces.

FR8: Flexi provisions the tenant schema and required bootstrap objects before activation, using the approved `tenant_<Tenant.id CUID>` schema naming convention and recording step success or failure.

FR9: Flexi seeds the bootstrap objects and baseline defaults required for a newly active tenant before activation, including First Admin pending setup, default RBAC roles and permissions, system settings, core lookup data, default workflow statuses, default entity categories, and initial notification templates.

FR10: Flexi creates exactly one login identity and exactly one TenantUser actor for the First Admin, in `pending_setup` state, before tenant activation.

FR11: Flexi ensures a tenant-scoped `TENANT_ADMIN` / `Tenant Administrator` role and assigns it to the First Admin before activation.

FR12: Flexi transitions the Tenant to `ACTIVE` only after every required provisioning step succeeds, and records final success audit evidence with safe identifiers.

FR13: The Super Admin UI shows provisioning progress for an accepted attempt, including status, a step checklist or timeline, and MVP polling via `GET /api/v1/super-admin/tenants/:id/status`.

FR14: The Super Admin UI provides attempt detail for success and failure review, including actor, timestamps, tenant name, subdomain, Plan, First Admin email, current status, step status, failed step when applicable, safe error detail, history filters, and actor display without exposing secrets.

FR15: Phase 1 failed attempts are view-only in the Super Admin UI; Retry, Cleanup, and manual state-transition controls are not exposed, and Ops is directed to the escalation channel and runbook.

FR16: Flexi generates a one-time, short-lived Setup Link for the First Admin after successful onboarding, never persists plaintext setup token values in audit logs, and supports expired-link regeneration via `POST /api/v1/super-admin/tenants/:id/setup-link`.

FR17: The Super Admin UI displays the Setup Link as the primary handoff mechanism for Ops, with copy affordance and clear automated-email outcome.

FR18: Flexi can send the Setup Link to the First Admin by automated email as a backup path; SMTP failure after successful link generation is warning-only and is recorded without logging the plaintext token.

FR19: Flexi persists a permanent `TenantOnboardingAuditLog` record for every accepted onboarding attempt, including actor, request identity, safe payload metadata, step outcomes, compensation status where applicable, and final status.

FR20: When provisioning fails or times out, Flexi records the failed step, final failure state, and known resource identifiers that need engineering review, without leaving the tenant `ACTIVE`.

### NonFunctional Requirements

NFR1: Security - only permitted SystemUser actors may start onboarding; tenant actors and unauthenticated actors must fail before tenant state is created.

NFR2: Data isolation - tenants must not become available until tenant schema provisioning and required bootstrap work complete, and tenant-scoped routes must reject `PROVISIONING`, `FAILED`, and `SUSPENDED` tenants.

NFR3: Auditability - every accepted attempt must have permanent audit evidence, and audit must never contain plaintext passwords, plaintext setup tokens, or secret values.

NFR4: Reliability - provisioning must run asynchronously and produce explicit success, failure, and timeout outcomes.

NFR5: Performance - successful Phase 1 provisioning target is under 1 minute, and attempts exceeding 1 minute should transition to timeout/failure rather than spin indefinitely.

NFR6: Provisioning strategy threshold - migration replay remains the default until p95 provisioning latency exceeds 30 seconds or tenant schema migration files exceed 50, at which point architecture should evaluate PostgreSQL template schema cloning.

NFR7: Idempotency - retries must not create duplicate tenants, first-admin accounts, role assignments, or schemas.

NFR8: Operability - failed attempts must provide enough safe information for engineering escalation.

NFR9: Accessibility - Super Admin UI controls and status indicators should meet WCAG 2.1 AA or the equivalent existing internal dashboard baseline.

### Additional Requirements

- No starter or greenfield template is specified in the Architecture input.
- The discovered Architecture Spine is scoped to Dynamic Database / Table Builder, not directly to Tenant Onboarding; its requirements affect tenant-schema and dynamic-table substrate decisions that onboarding must not violate.
- Dynamic table metadata and dynamic data must live inside each tenant schema through Knex-managed tables, not Prisma public-schema models.
- DynamicTables must be the sole owner of DDL and DML for dynamic tables; future modules must consume `DynamicTablesService` rather than call tenant-schema database access directly.
- Inside DynamicTables, every metadata, data, DDL, and DML statement must be built from `TenantKnexService.forCurrentTenant()`.
- User-supplied table and column identifiers must be validated by one shared `sanitizeIdentifier()` function with the same allowlist discipline as tenant schema resolution.
- Dynamic table DDL must not execute on the HTTP request/response path; the API validates and enqueues a BullMQ job, returns `202 Accepted`, and exposes job status through a controller endpoint.
- Dynamic table DDL workers must run in-process on BullMQ's PostgreSQL backend and use config-backed lock timeout, retry/backoff, and migration-record outcome capture.
- Dynamic table validation schemas must be generated and cached per table, and field edits must synchronously invalidate or rebuild that table's cache entry.
- Dynamic table DML routes must use generic metadata-resolved REST routing: `/api/tables/:tableId/rows` plus `/:rowId`.
- Relation fields in dynamic tables are many-to-one only and must use literal same-schema foreign-key columns.
- Per-tenant dynamic-table guardrail settings belong in the Prisma public-schema `Tenant.dynamicTableGuardrails` field with platform defaults.
- Tenant schemas used by DynamicTables must include pinned Knex-managed metadata table shapes for `_meta_tables`, `_meta_fields`, and `_meta_migrations`.
- Existing `apps/backend/src/modules/dynamic-tables/` stubs are superseded in place when implementing DynamicTables functionality.
- Tenant schema provisioning itself is explicitly deferred in the DynamicTables architecture; the Tenant Onboarding workflow must therefore own or coordinate initial tenant PostgreSQL schema creation before tenant-scoped/dynamic-table functionality can be used.

### UX Design Requirements

UX-DR1: Reuse the existing authenticated Flexi app shell with `Layout`, `Sidebar`, `TopNav`, `PageHeader`, `Button`, `Input`, `Select`, `Card`, `Table`, `Badge`, and `Icon` components.

UX-DR2: Apply the DESIGN.md token system for colors, typography, spacing, radius, and component surfaces, including status-specific mappings for `PROVISIONING`, `ACTIVE`, `FAILED`, and `SUSPENDED`.

UX-DR3: Implement route-level and control-level permission gating so only SystemUsers with `system.tenants.onboard` see create actions or can access the Onboard New Tenant route.

UX-DR4: Provide a Tenants list surface with tenant name, slug, lifecycle status, plan, created date, latest attempt status, and explicit onboarding-specific actions.

UX-DR5: Expose `Onboard New Tenant` as the Tenants page primary action, not as a separate sidebar item.

UX-DR6: Build the onboarding form as one grouped operational flow with Tenant identity, First Admin, Plan/options, and Preflight sections.

UX-DR7: Disable submit until required fields are valid and slug availability is known.

UX-DR8: Validate required fields on blur and before submit, keep errors visible until corrected, and link errors to fields with accessible semantics.

UX-DR9: Implement debounced, cancellable slug/subdomain availability checking and repeat availability validation server-side on submit.

UX-DR10: Show slug states explicitly, including `Checking slug...`, `Slug is already in use.`, and a successful availability state.

UX-DR11: During submit, disable all mutating controls and show `Creating onboarding attempt...` until an attempt id is returned.

UX-DR12: Route successful submissions to the provisioning attempt detail surface.

UX-DR13: Implement a provisioning progress timeline that shows ordered backend steps with `waiting`, `running`, `succeeded`, `failed`, and `compensated` states.

UX-DR14: The timeline must poll without resetting scroll, collapsing expanded failed steps, or clearing copied states.

UX-DR15: Failed steps must expand by default and show failed step, safe error detail, and compensation state.

UX-DR16: After a long-running threshold, show an operator message that provisioning is still working and the operator can leave and return to the attempt.

UX-DR17: Show idempotency notices on form and attempt detail surfaces, including the existing attempt id when available.

UX-DR18: Implement success result content only when `Tenant.status = ACTIVE`, showing tenant URL, setup link/token handoff, First Admin email, tenant id, and schema name where safe.

UX-DR19: Provide copy actions for handoff values using icon + text buttons, with `aria-live` copied confirmation and no data mutation.

UX-DR20: If the setup token/link cannot be safely re-read after reload, show metadata and a clear regeneration/approved-flow message rather than pretending the secret remains available.

UX-DR21: Implement failure and cleanup detail that hides customer handoff controls whenever the tenant is not `ACTIVE`.

UX-DR22: Implement an audit detail drawer on desktop and full-screen sheet on small screens, preserving attempt page state when dismissed.

UX-DR23: Audit detail must list permanent events and safe identifiers while omitting stack traces, raw SQL, plaintext setup tokens, and other secrets.

UX-DR24: Implement Tenants list states for cold load skeleton rows, empty tenant inventory, no matching filters, and permission denied.

UX-DR25: Preserve Tenants list filters when navigating back from attempt detail.

UX-DR26: Support responsive behavior: `md+` uses visible sidebar and may use multi-column form/detail layouts; below `md`, sidebar becomes a drawer, form sections stack, timeline remains vertical, audit becomes full-screen sheet, and tables scroll horizontally inside their container.

UX-DR27: Meet WCAG 2.2 AA target for the responsive web surface, including programmatic labels, `aria-describedby`, `aria-invalid`, readable submit-disabled reasons, and 44px minimum touch targets.

UX-DR28: Provisioning timeline updates must be exposed as text and announced through a polite live region, not communicated by color alone.

UX-DR29: Use exact operational microcopy that names fields or backend steps, consequences, and next actions; avoid vague success/failure copy and celebratory animations.

UX-DR30: Use monospace typography for machine identifiers such as tenant id, schema name, setup token snippets, idempotency keys, URLs, and audit resource ids.

UX-DR31: Use borders and tonal surfaces before shadow, avoid nested cards, reserve full-radius styling for status badges only, and avoid a marketing or consumer-style layout.

UX-DR32: Implement safe offline or polling-failed behavior by keeping the latest known step visible and showing a single reconnection notice.

### FR Coverage Map

FR1: Epic 1 - Safe Tenant Onboarding Intake enables a permitted SystemUser to submit tenant and First Admin identity data.

FR2: Epic 1 - Safe Tenant Onboarding Intake validates onboarding input before tenant provisioning state is created.

FR3: Epic 1 - Safe Tenant Onboarding Intake stores Plan as Phase 1 metadata without entitlement enforcement.

FR4: Epic 1 - Safe Tenant Onboarding Intake enforces `system.tenants.onboard` before state creation.

FR5: Epic 1 - Safe Tenant Onboarding Intake creates a durable Onboarding Attempt with safe metadata, actor identity, idempotency identity, status, and step outcomes.

FR6: Epic 1 - Safe Tenant Onboarding Intake makes duplicate submissions idempotent and conflict-aware.

FR7: Epic 2 - Tenant Provisioning To Active Workspace creates tenants in `PROVISIONING` and blocks unavailable tenant states from tenant-scoped surfaces.

FR8: Epic 2 - Tenant Provisioning To Active Workspace provisions the tenant schema and required bootstrap objects before activation.

FR9: Epic 2 - Tenant Provisioning To Active Workspace seeds required bootstrap objects and baseline defaults before activation.

FR10: Epic 2 - Tenant Provisioning To Active Workspace creates exactly one First Admin login identity and one TenantUser actor.

FR11: Epic 2 - Tenant Provisioning To Active Workspace creates or ensures the tenant-scoped Tenant Admin Role and assigns it to the First Admin.

FR12: Epic 2 - Tenant Provisioning To Active Workspace activates only after all required provisioning steps succeed.

FR13: Epic 3 - Operator Visibility, Handoff, And Failure Review shows provisioning progress and MVP polling in Super Admin.

FR14: Epic 3 - Operator Visibility, Handoff, And Failure Review provides attempt detail, safe error information, and onboarding history filters.

FR15: Epic 3 - Operator Visibility, Handoff, And Failure Review keeps Phase 1 failure controls view-only and directs Ops to escalation.

FR16: Epic 2 - Tenant Provisioning To Active Workspace generates and regenerates one-time setup links through the approved backend path.

FR17: Epic 3 - Operator Visibility, Handoff, And Failure Review displays the setup link and copy handoff in the Super Admin UI.

FR18: Epic 2 - Tenant Provisioning To Active Workspace supports backup email delivery as warning-only after link generation succeeds.

FR19: Epic 2 - Tenant Provisioning To Active Workspace persists permanent audit records for every accepted attempt.

FR20: Epic 2 - Tenant Provisioning To Active Workspace records failed steps, final failure state, and known engineering-review resource identifiers.

## Epic List

### Epic 1: Safe Tenant Onboarding Intake
Ops can submit a validated, permission-gated tenant onboarding request and get a durable, idempotent attempt instead of relying on manual engineer setup.
**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6

### Epic 2: Tenant Provisioning To Active Workspace
Flexi can asynchronously provision a tenant schema, seed required bootstrap data, create the First Admin, assign admin role, generate setup delivery, activate only on success, and record permanent audit/failure evidence.
**FRs covered:** FR7, FR8, FR9, FR10, FR11, FR12, FR16, FR18, FR19, FR20

### Epic 3: Operator Visibility, Handoff, And Failure Review
Ops and SysAdmins can monitor onboarding progress, inspect history/detail, copy successful handoff data, and safely escalate failures without exposing remediation controls in Phase 1.
**FRs covered:** FR13, FR14, FR15, FR17

## Epic 1: Safe Tenant Onboarding Intake

Ops can submit a validated, permission-gated tenant onboarding request and get a durable, idempotent attempt instead of relying on manual engineer setup.

### Story 1.1: Permission-Gated Onboarding Entry And Form Shell

**Requirement refs:** FR1, FR4, NFR1, UX-DR1, UX-DR3, UX-DR5, UX-DR6, UX-DR27

As an Ops user,
I want to open a tenant onboarding form only when I have the required permission,
So that tenant creation starts from the approved Super Admin surface.

**Acceptance Criteria:**

**Given** a signed-in SystemUser with `system.tenants.onboard`
**When** they open the Tenants area and choose `Onboard New Tenant`
**Then** the onboarding route renders a grouped form for Tenant identity, First Admin, Plan/options, and Preflight
**And** the form uses the existing authenticated Flexi shell and accessible labels.

**Given** a signed-in user without `system.tenants.onboard`
**When** they view the Tenants area or open the onboarding route directly
**Then** create controls are hidden or blocked
**And** no onboarding state is created.

### Story 1.2: Field Validation And Slug Preflight

**Requirement refs:** FR2, FR3, UX-DR7, UX-DR8, UX-DR9, UX-DR10, UX-DR11, UX-DR27, UX-DR29

As an Ops user,
I want tenant inputs validated before submit,
So that invalid or duplicate tenant requests are stopped before provisioning state exists.

**Acceptance Criteria:**

**Given** the onboarding form is open
**When** required fields are empty, email is invalid, or Plan is missing
**Then** submit remains unavailable and field-level errors identify the problem.

**Given** an operator enters a slug/subdomain
**When** the slug availability check runs
**Then** the UI shows checking, available, or conflict states
**And** server-side submit repeats the availability validation before creating state.

### Story 1.3: Durable Permission-Gated Attempt API

**Requirement refs:** FR4, FR5, NFR1, NFR3

As a System Admin,
I want accepted onboarding requests recorded as durable attempts,
So that every accepted request is traceable from creation.

**Acceptance Criteria:**

**Given** an authorized SystemUser submits valid onboarding data
**When** `POST /api/v1/super-admin/tenants` is called
**Then** the backend checks `system.tenants.onboard` before state creation
**And** creates an Onboarding Attempt with actor identity, safe payload metadata, request identity, idempotency identity, timestamps, status, and step outcomes.

**Given** any actor is unauthenticated, tenant-scoped, or lacks permission
**When** they call the endpoint
**Then** the request fails before tenant or attempt state is created.

### Story 1.4: Idempotent Submission Handling

**Requirement refs:** FR6, NFR7, UX-DR17

As an Ops user,
I want safe retries to return the existing attempt,
So that network retries do not create duplicate tenants, schemas, accounts, or roles.

**Acceptance Criteria:**

**Given** an onboarding request was accepted with an idempotency identity
**When** the same request is submitted again with the same identity and matching payload
**Then** the existing attempt is returned or resumed
**And** no duplicate tenant, account, role, or schema records are created.

**Given** the same idempotency identity is reused with materially different payload
**When** the request is submitted
**Then** the backend returns an explicit conflict error
**And** the UI shows an idempotency notice with the existing attempt id when available.

## Epic 2: Tenant Provisioning To Active Workspace

Flexi can asynchronously provision a tenant schema, seed required bootstrap data, create the First Admin, assign admin role, generate setup delivery, activate only on success, and record permanent audit/failure evidence.

### Story 2.1: Provisioning Worker And Tenant Lifecycle Start

**Requirement refs:** FR7, NFR2, NFR4, NFR5

As a System Admin,
I want accepted attempts processed asynchronously,
So that tenant provisioning does not block the web request and starts in a safe non-active state.

**Acceptance Criteria:**

**Given** an accepted Onboarding Attempt exists
**When** provisioning starts
**Then** processing runs outside the synchronous web request path
**And** the attempt records the running provisioning step.

**Given** tenant creation succeeds
**When** the tenant record is created
**Then** `Tenant.status` is `PROVISIONING`
**And** tenant-scoped login/routes do not treat the tenant as usable.

### Story 2.2: Tenant Schema Provisioning And Bootstrap Migration

**Requirement refs:** FR8, NFR2, NFR4, NFR6, NFR8, Additional Requirements

As an engineer on escalation,
I want each tenant schema provisioned with recorded step outcomes,
So that schema setup is isolated, traceable, and blocks activation on failure.

**Acceptance Criteria:**

**Given** a tenant in `PROVISIONING`
**When** schema provisioning runs
**Then** Flexi creates or verifies the schema using `tenant_<Tenant.id CUID>` naming
**And** the schema is resolvable through the tenancy layer.

**Given** required bootstrap migrations run
**When** any schema provisioning or migration step fails
**Then** the attempt records the failed step and safe error detail
**And** activation is blocked.

### Story 2.3: Bootstrap Defaults And Tenant RBAC Seed

**Requirement refs:** FR9, NFR2

As a Tenant Admin,
I want a new workspace to include required default roles, permissions, settings, lookup data, statuses, and notifications,
So that the tenant is usable immediately after activation.

**Acceptance Criteria:**

**Given** the tenant schema is provisioned
**When** bootstrap seeding runs
**Then** Flexi creates required system settings for locale, timezone, base currency, and configuration flags
**And** creates default workflow statuses `Draft`, `In Review`, `Active`, and `Archived`.

**Given** bootstrap seeding runs
**When** RBAC and lookup seed data is created
**Then** Admin/Tenant Admin, Manager, and Member roles exist with their default permission matrix
**And** categories `General`, `Operations`, and `Administrative` exist
**And** notification templates `WELCOME_SETUP_INVITE`, `PASSWORD_RESET_REQUEST`, and `WORKSPACE_LIMIT_WARNING` exist.

**Given** any required seed fails
**When** the worker records the outcome
**Then** the seed step is failed
**And** activation is blocked.

### Story 2.4: First Admin Identity And Tenant Admin Assignment

**Requirement refs:** FR10, FR11, NFR2

As a Customer Success user,
I want the first customer admin created and assigned tenant admin permissions before activation,
So that the customer has a valid setup path into the new workspace.

**Acceptance Criteria:**

**Given** required tenant bootstrap state exists
**When** First Admin creation runs
**Then** Flexi creates exactly one login identity and exactly one `TenantUser` actor
**And** the First Admin starts in `pending_setup` state
**And** no account backs both `SystemUser` and `TenantUser`.

**Given** the First Admin exists
**When** role assignment runs
**Then** Flexi ensures tenant-scoped `TENANT_ADMIN` / `Tenant Administrator` exists
**And** assigns it to the First Admin before activation
**And** the role has tenant-scope permissions only.

### Story 2.5: Setup Link Generation And Backup Email Outcome

**Requirement refs:** FR16, FR18, NFR3

As an Ops user,
I want Flexi to generate a one-time setup link and optionally email it,
So that I can hand off access while email failure remains warning-only.

**Acceptance Criteria:**

**Given** required provisioning steps have succeeded
**When** setup link generation runs
**Then** Flexi generates a one-time setup link for the First Admin
**And** the expiration is 24 hours unless a stricter existing policy applies
**And** plaintext setup token values are not persisted in audit logs.

**Given** setup link generation succeeds
**When** backup email delivery fails
**Then** tenant activation semantics are not changed
**And** the email outcome is recorded as warning-only without logging the plaintext token.

**Given** a permitted SystemUser requests setup link regeneration
**When** `POST /api/v1/super-admin/tenants/:id/setup-link` is called
**Then** the request is permission-gated by `system.tenants.onboard` for MVP
**And** a new approved setup path is generated according to expiration policy.

### Story 2.6: Activation Boundary, Failure Recording, And Permanent Audit

**Requirement refs:** FR12, FR19, FR20, NFR2, NFR3, NFR4, NFR8

As a System Admin,
I want provisioning to activate only after all required steps succeed and permanently record failures,
So that partial provisioning never appears successful and escalation has safe identifiers.

**Acceptance Criteria:**

**Given** every required provisioning step succeeds
**When** activation runs
**Then** Flexi transitions the tenant to `ACTIVE`
**And** records final success audit evidence with safe resource identifiers.

**Given** any required step fails or times out
**When** the attempt reaches a final failure outcome
**Then** the tenant is not `ACTIVE`
**And** the attempt records failed step, final failure state, compensation status where applicable, and known identifiers such as tenant id, schema name, account id, TenantUser id, role id, and failed compensation step when available.

**Given** an accepted attempt succeeds or fails
**When** audit finalization runs
**Then** a permanent `TenantOnboardingAuditLog` record is persisted
**And** audit data excludes plaintext passwords, plaintext setup tokens, and secrets.

## Epic 3: Operator Visibility, Handoff, And Failure Review

Ops and SysAdmins can monitor onboarding progress, inspect history/detail, copy successful handoff data, and safely escalate failures without exposing remediation controls in Phase 1.

### Story 3.1: Tenants List And Onboarding History

**Requirement refs:** FR13, FR14, UX-DR1, UX-DR2, UX-DR4, UX-DR5, UX-DR24, UX-DR25, UX-DR26

As an Ops user,
I want to find tenants and recent onboarding attempts from the Tenants area,
So that I can track onboarding work without leaving the Super Admin dashboard.

**Acceptance Criteria:**

**Given** a permitted SystemUser opens the Tenants list
**When** tenant and attempt data loads
**Then** rows show tenant name, slug, lifecycle status, plan, created date, latest attempt status, actor name, and onboarding-specific actions
**And** `Onboard New Tenant` is exposed as the page primary action rather than a separate sidebar item.

**Given** the Tenants list is loading or empty
**When** the UI renders
**Then** loading uses skeleton table rows sized like the final table
**And** empty or no-match states use concise operational copy with a primary action only when the user has permission.

**Given** an operator filters onboarding history
**When** they choose status, keyword/subdomain, or created-at date range filters
**Then** the history list updates using those MVP filters
**And** actor filtering is not exposed in MVP.

### Story 3.2: Provisioning Attempt Detail And Timeline

**Requirement refs:** FR13, FR14, UX-DR12, UX-DR13, UX-DR14, UX-DR15, UX-DR16, UX-DR28, UX-DR32

As an Ops user,
I want a live attempt detail timeline,
So that I can understand long-running tenant provisioning without refreshing or guessing.

**Acceptance Criteria:**

**Given** an accepted attempt exists
**When** the operator opens attempt detail
**Then** the UI shows overall status and ordered steps for permission check, attempt reservation, tenant creation, schema provisioning, Tenant Admin role, First Admin creation, role assignment, activation, and audit finalization.

**Given** provisioning is running
**When** `GET /api/v1/super-admin/tenants/:id/status` returns updates
**Then** the timeline shows `waiting`, `running`, `succeeded`, `failed`, or `compensated` states as text with status badges
**And** updates do not reset scroll, collapse expanded failed steps, or clear copied states.

**Given** provisioning exceeds the long-running threshold
**When** the attempt is still not final
**Then** the UI tells the operator they can leave the page and return to the attempt
**And** polling failures keep the latest known step visible with a single reconnection notice.

### Story 3.3: Success Handoff Result

**Requirement refs:** FR17, UX-DR18, UX-DR19, UX-DR20, UX-DR30, UX-DR31

As a Customer Success user,
I want successful onboarding to show copyable tenant handoff details,
So that I can send the customer the right setup information.

**Acceptance Criteria:**

**Given** an attempt reaches `ACTIVE`
**When** the result panel renders
**Then** it shows tenant URL, First Admin email, setup link/token handoff, tenant id, and schema name where safe
**And** machine identifiers and URLs use monospace styling.

**Given** the operator clicks a copy action
**When** the value is copied
**Then** the UI announces `Copied [value name]` through an accessible live confirmation
**And** the copy action does not mutate server data.

**Given** the setup token or token-bearing link cannot be safely re-read after reload
**When** the success page is revisited
**Then** the UI shows safe metadata and a clear approved-flow regeneration message instead of exposing or inventing the secret.

### Story 3.4: Failure Detail And View-Only Escalation

**Requirement refs:** FR14, FR15, UX-DR15, UX-DR21, UX-DR23, UX-DR29

As a System Admin,
I want failed attempts to show safe failure and escalation details without unsafe controls,
So that Ops can escalate accurately while Phase 1 remediation stays controlled.

**Acceptance Criteria:**

**Given** an attempt is `FAILED` or `failed-needs-manual-cleanup`
**When** the operator opens attempt detail
**Then** the failed step expands by default
**And** safe error detail, compensation status, and known resource identifiers are visible when available.

**Given** the tenant is not `ACTIVE`
**When** the failure detail renders
**Then** customer handoff controls are hidden
**And** the tenant is not presented as login-ready or usable.

**Given** Phase 1 failure controls are view-only
**When** an operator reviews a failed attempt
**Then** Retry, Cleanup, force activate, force fail, and manual state-transition controls are not exposed
**And** the UI directs Ops to `#ops-escalation-flexi` and `https://wiki.internal.flexi/runbooks/tenant-provisioning-failure`.

### Story 3.5: Audit Detail Drawer

**Requirement refs:** FR14, FR19, FR20, NFR3, NFR8, UX-DR22, UX-DR23, UX-DR26

As an engineer on escalation,
I want a safe audit detail view for an onboarding attempt,
So that I can inspect permanent evidence without exposing secrets.

**Acceptance Criteria:**

**Given** an attempt has audit events
**When** the operator opens audit detail
**Then** a right-side drawer on desktop or full-screen sheet on small screens lists permanent events, step outcomes, safe payload metadata, and safe identifiers
**And** dismissing the drawer preserves the attempt page state.

**Given** audit detail is shown
**When** the event data includes sensitive fields
**Then** plaintext passwords, plaintext setup tokens, secrets, stack traces, and raw SQL are omitted
**And** safe identifiers remain visible for escalation.

### Story 3.6: Responsive, Accessible Operational UX

**Requirement refs:** NFR9, UX-DR2, UX-DR26, UX-DR27, UX-DR28, UX-DR29, UX-DR31, UX-DR32

As an internal operator,
I want onboarding screens to be usable across supported devices and assistive technologies,
So that provisioning work remains reliable under normal operational conditions.

**Acceptance Criteria:**

**Given** the operator uses a desktop viewport
**When** they view the Tenants list, onboarding form, or attempt detail
**Then** the existing sidebar remains visible
**And** form/detail layouts may use two columns where space allows.

**Given** the operator uses a viewport below `md`
**When** they view onboarding surfaces
**Then** sidebar navigation becomes a drawer, form sections stack, the timeline remains vertical, audit detail becomes a full-screen sheet, and tables scroll horizontally within their own container.

**Given** an operator uses keyboard or screen reader navigation
**When** they interact with forms, timeline, result panel, drawers, dialogs, and copy actions
**Then** focus order follows visual reading order, every field has a programmatic label, validation uses `aria-describedby` and `aria-invalid`, status changes are announced through a polite live region, and touch targets are at least 44px high.

**Given** status, error, warning, or success states render
**When** the operator reviews the UI
**Then** state is communicated with text plus badges/icons, not color alone
**And** operational microcopy names the field or backend step, consequence, and next action.
