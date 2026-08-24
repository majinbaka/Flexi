---
name: Flexi Super Admin Tenant Onboarding
status: draft
project: Flexi
title: Super Admin Tenant Onboarding UX
created: 2026-08-21
updated: 2026-08-21
sources:
  - apps/frontend/src/docs/specs/super-admin-tenant-onboarding.mdx
  - apps/frontend/src/docs/specs/super-admin-tenant-onboarding-failure-modes.mdx
  - apps/frontend/src/docs/specs/architecture.mdx
  - docs/research/schema-per-tenant-implementation-guide.md
  - docs/research/schema-per-tenant-implementation/research.md
---

# Flexi Super Admin Tenant Onboarding - Experience Spine

> Paired with `DESIGN.md`. DESIGN.md owns visual identity and token choices; this EXPERIENCE.md owns information architecture, behavior, state, interactions, accessibility, and operator journeys. Spine files win on conflict with mockups, imports, or implementation notes.

## Foundation

Single-surface responsive web inside the existing Flexi authenticated admin shell. Primary surface is desktop/laptop for internal Operations, SysAdmin, and Customer Success users; mobile and tablet support review/status lookup but are not the primary creation surface.

UI system: Flexi internal React + Tailwind component system, using `Layout`, `Sidebar`, `TopNav`, `PageHeader`, `Button`, `Input`, `Select`, `Card`, `Table`, `Badge`, and `Icon`. `DESIGN.md` is the visual identity reference and names token overrides by token path reference.

The core backend invariant that drives UX: `ACTIVE` is the product-visible commit point. `PROVISIONING`, `FAILED`, and `SUSPENDED` tenants must not be presented as usable customer environments.

[ASSUMPTION] Tenant onboarding status is exposed through an onboarding-attempt resource that the frontend can poll. Realtime push is not required for v1.

## Information Architecture

| Surface | Reached from | Purpose |
| --- | --- | --- |
| Tenants list | Sidebar `tenants` module | Review tenant inventory, statuses, recent onboarding attempts, and entry point for new onboarding. |
| Onboard New Tenant | Tenants list primary action | Submit tenant identity, first-admin identity, and plan metadata after preflight validation. |
| Provisioning attempt detail | Submit success, Tenants list row, retry/idempotency lookup | Show step-by-step provisioning progress, safe payload metadata, audit status, and final result. |
| Tenant success result | Provisioning attempt detail when `ACTIVE` | Provide tenant URL, first-admin setup link/token handoff, and copy actions. |
| Failure and cleanup detail | Provisioning attempt detail when `FAILED` or `failed-needs-manual-cleanup` | Explain failed step, compensation state, blocked resources, and operator next action. |
| Audit log detail | Attempt detail drawer/sheet | Inspect permanent audit events and safe identifiers without exposing plaintext secrets. |

Primary navigation remains the existing app shell. The `tenants` module should expose `Onboard New Tenant` as the page-level primary action, not a separate sidebar item.

Surface closure:

| Stated need | Surface that delivers it |
| --- | --- |
| Create a tenant from an internal customer request | Onboard New Tenant |
| Validate slug/subdomain before provisioning | Onboard New Tenant |
| Avoid duplicate tenant/account/schema records on retry | Onboard New Tenant + Provisioning attempt detail |
| Understand long-running backend work | Provisioning attempt detail |
| Copy tenant access details after success | Tenant success result |
| Handle failed provisioning safely | Failure and cleanup detail |
| Preserve auditability | Audit log detail |

These surfaces are spine-only in this fast-path draft. No mockups or wireframes have been generated yet.

## Voice and Tone

Microcopy is operational and exact. Brand voice lives in DESIGN.md.

| Do | Don't |
| --- | --- |
| "Tenant slug is available." | "Looks good!" |
| "Provisioning schema..." | "Setting things up..." |
| "Activation is the final commit point." | "Almost done!" |
| "This retry will return the existing attempt if one exists." | "Try again safely." |
| "Failed at role assignment. Compensation completed." | "Something went wrong." |
| "Copy setup link" | "Share magic link" |

Error copy must name the field or backend step, the consequence, and the next action. Do not expose stack traces, raw SQL, plaintext setup tokens in audit views, or ambiguous "unknown error" messages when the API can provide step status.

## Component Patterns

Behavioral rules for components named in DESIGN.md.Components.

| Component | Use | Behavioral rules |
| --- | --- | --- |
| app-shell | Authenticated Super Admin area | Requires a valid SystemUser session. Users without `system.tenants.onboard` do not see create actions and receive a permission screen or redirect if routed directly. |
| page-header | Every onboarding surface | Title names the task or object. Description states operational context only. Primary action appears right-aligned on desktop and wraps below on small screens. |
| tenant-table | Tenants list | Rows show tenant name, slug, status, plan [ASSUMPTION], created date, latest attempt status, and actions. Row click opens tenant/attempt detail, while explicit action buttons handle onboarding-specific actions. |
| onboarding-form | New tenant submission | One submit surface with grouped sections: Tenant identity, First admin, Plan/options [ASSUMPTION], Preflight. Submit disabled until required fields are valid and slug availability is known. |
| field-validation | Inputs/selects | Required fields validate on blur and before submit. Slug/subdomain runs debounced availability check, then rechecks server-side on submit. Errors persist until corrected. |
| provisioning-progress-timeline | Attempt detail | Shows ordered backend steps with `waiting`, `running`, `succeeded`, `failed`, and `compensated` states. Current step stays visible without page refresh. Failed step expands by default. |
| status-badge | Tenant and attempt state | Tenant lifecycle badges map exactly to `PROVISIONING`, `ACTIVE`, `FAILED`, `SUSPENDED`. Attempt final status can additionally show `failed-needs-manual-cleanup` as warning/manual attention. |
| idempotency-notice | Form and attempt detail | Explains when a retry is safe because the same idempotency key will return or resume the recorded attempt. Shows attempt id when available. |
| result-panel | Successful provisioning | Displays tenant URL, setup link/token handoff, first admin email, tenant id, and schema name where safe. Copy buttons announce copied state and never mutate data. |
| audit-detail-drawer | Audit inspection | Opens from attempt detail. Lists permanent events and safe ids. Secrets are omitted by design. Drawer can be dismissed without losing attempt page state. |
| confirmation-dialog | Risky operations | Required before manual retry after failure, cleanup action, or destructive correction [ASSUMPTION]. Dialog states resources affected and whether tenant is active or unavailable. |
| toast | Cross-surface notifications | Used for save/copy/network/polling notices. Long-running provisioning progress stays in the timeline, not in repeated toasts. |
| empty-state | Tenants list with no tenants or no matching filters | One sentence plus one primary action if user has permission. No motivational copy. |

## State Patterns

| State | Surface | Treatment |
| --- | --- | --- |
| Cold load | Tenants list | Skeleton table rows sized like the final table. |
| Empty tenant inventory | Tenants list | `No tenants yet.` Primary action: `Onboard New Tenant` if permitted. |
| Permission denied | Tenants list, Onboard New Tenant | Hide create controls by default. Direct route shows `You do not have permission to onboard tenants.` |
| Form pristine | Onboard New Tenant | Submit disabled until required fields have values and the slug check completes. |
| Slug checking | Onboard New Tenant | Inline pending state: `Checking slug...`; submit remains disabled. |
| Slug conflict | Onboard New Tenant | Field error: `Slug is already in use.` Offer alternate generated slug [ASSUMPTION]. |
| Submit pending | Onboard New Tenant | Disable all mutating controls. Show `Creating onboarding attempt...` until attempt id is returned. |
| Idempotent retry detected | Onboard New Tenant / Attempt detail | Show idempotency notice and route to the existing attempt outcome. |
| Provisioning running | Attempt detail | Progress timeline polls and updates. Step labels mirror backend step names. |
| Long-running provisioning | Attempt detail | After threshold [ASSUMPTION: 30 seconds], show `Still working. You can leave this page and return to the attempt.` |
| Success | Tenant success result | Tenant status `ACTIVE`; show copyable handoff details and audit summary. |
| Failure compensated | Failure and cleanup detail | Tenant status `FAILED`; failed step and compensation success are visible. No customer handoff shown. |
| Failure manual cleanup | Failure and cleanup detail | Warning treatment. List exact stuck resource ids provided by audit. Customer handoff remains hidden. |
| Offline or polling failed | Attempt detail | Keep latest known step visible. Toast once: `Connection lost. Progress will refresh when you reconnect.` |
| Secret visibility | Tenant success result | Setup token/link shown only once in response-driven success context [ASSUMPTION]. If the page is reloaded and the API cannot return it, show `Setup token is no longer available. Generate a new setup path through the approved credential flow.` |

## Interaction Primitives

- Click/tap to act. No drag interactions.
- Keyboard support follows standard web form behavior: `Tab` moves through fields, `Enter` submits only when focus is not inside a control that captures Enter and the form is valid, `Esc` closes the topmost drawer/dialog.
- Slug availability checks are debounced, cancellable, and always repeated server-side on submit.
- Copy actions use icon + text buttons on handoff values and expose `aria-live` confirmation.
- Attempt detail polling must not reset scroll, collapse expanded failed steps, or clear copied states.
- Back navigation from attempt detail returns to Tenants list with prior filters preserved [ASSUMPTION].
- Banned in v1: celebratory animations, confetti, infinite scroll, hover-only critical actions, hidden background provisioning behind a spinner-only screen, and modal stacks deeper than one.

## Accessibility Floor

Behavioral accessibility. Visual contrast targets live in DESIGN.md.

- WCAG 2.2 AA target for the responsive web surface.
- Every field has a programmatic label. Validation errors are linked with `aria-describedby` and set `aria-invalid`.
- Provisioning timeline exposes each step as text with state, not color alone. Step changes announce through a polite live region.
- Submit-disabled reasons are discoverable by screen reader and visible text near the action.
- Copy buttons announce `Copied [value name]` without moving focus.
- Focus order follows visual reading order across form groups, timeline, result panel, drawers, and dialogs.
- Error recovery does not require color perception, mouse hover, or rapid timing.
- Touch targets meet at least 44px minimum height where controls are interactive.

## Responsive & Platform

| Breakpoint | Behavior |
| --- | --- |
| `md+` | Existing sidebar remains visible. Onboard form may use two columns: main form plus preflight/summary. Attempt detail may place audit/result metadata beside the timeline if space allows. |
| `< md` | Sidebar becomes drawer. Form sections stack. Timeline remains a vertical list. Audit drawer becomes a full-screen sheet. Tables scroll horizontally inside their own container. |

Primary creation is optimized for desktop/laptop operations. Mobile must support reading status, copying handoff values, and seeing failures clearly, but it does not need dense multi-column creation ergonomics.

## Operational Safety Patterns

| Concern | UX rule |
| --- | --- |
| Permission boundary | Only SystemUsers with `system.tenants.onboard` can access creation. UI never implies an `isSuperAdmin` bypass. |
| Activation boundary | Handoff details appear only after `Tenant.status = ACTIVE`. |
| Idempotency | Every submission carries or receives an idempotency key [ASSUMPTION]. Retrying routes to the existing attempt result. |
| Audit retention | Audit detail is always available for success and failure. It never exposes plaintext setup tokens or secret values. |
| Compensation | Failed attempts show whether compensation completed, partially completed, or requires manual cleanup. |
| Tenant availability | `PROVISIONING`, `FAILED`, and `SUSPENDED` tenants are not shown as login-ready. |

## Provisioning Step Vocabulary

Use these operator-facing step names. They intentionally mirror source workflow names without exposing implementation internals beyond what an operator needs.

| Backend step | Operator-facing label | Completion signal |
| --- | --- | --- |
| Authorize SystemUser | Checking permission | Caller may onboard tenants. |
| Reserve onboarding attempt | Reserving onboarding attempt | Attempt id and idempotency record exist. |
| Create Tenant | Creating tenant record | Tenant exists as `PROVISIONING`. |
| Provision tenant schema | Provisioning tenant schema | Schema and bootstrap migrations complete. |
| Ensure Tenant Admin role | Preparing Tenant Admin role | Tenant-scoped role and permissions exist. |
| Create first admin actor | Creating first admin account | First admin identity and setup token are created. |
| Assign role | Assigning Tenant Admin role | First admin has tenant admin role. |
| Activate Tenant | Activating tenant | Tenant status becomes `ACTIVE`. |
| Finalize audit | Finalizing audit | Permanent success/failure audit is written. |

## Key Flows

### Flow 1 - New tenant onboarding (Minh, Customer Success Ops, after a signed contract arrives)

1. Minh opens the Flexi Super Admin dashboard on a laptop.
2. He navigates to `Tenants` and clicks `Onboard New Tenant`.
3. He enters tenant name, slug/subdomain, first admin email, and plan [ASSUMPTION].
4. The slug field checks availability. The form blocks submit until the slug is available.
5. Minh clicks `Provision Tenant`.
6. The UI creates/reserves the onboarding attempt, then routes to the attempt detail.
7. The progress timeline advances through schema provisioning, role bootstrap, first admin creation, activation, and audit finalization.
8. **Climax:** The tenant reaches `ACTIVE`; Minh sees the tenant URL and first-admin setup handoff in the result panel with copy actions.

Failure path: slug becomes taken between preflight and submit. The server rejects before tenant state is created; the form returns to edit mode with `Slug is already in use.`

### Flow 2 - Safe retry after timeout (An, SysAdmin, network drops during provisioning)

1. An submits a valid onboarding form.
2. The attempt detail opens and shows `Provisioning tenant schema`.
3. The browser loses connection before completion.
4. An returns to the Tenants list later and finds the latest onboarding attempt by tenant slug.
5. The attempt detail shows the current/final backend outcome from the idempotent attempt.
6. If An resubmits the same request, the UI shows the idempotency notice and routes to the existing attempt rather than creating a second tenant.
7. **Climax:** An can tell whether the tenant is active, still provisioning, or failed without creating duplicate tenant, account, role, or schema records.

Failure path: the existing attempt is `FAILED`; An sees the failed step and compensation result before choosing any retry/manual action.

### Flow 3 - Provisioning failure with manual cleanup (Lan, Internal Operations lead, schema provisioning partially fails)

1. Lan opens a failed onboarding attempt from the Tenants list.
2. The failure panel names the failed step: `Provisioning tenant schema`.
3. The timeline expands the failed step and shows compensation outcome.
4. The audit drawer lists safe resource ids, including tenant id and schema name if known.
5. Customer handoff controls remain hidden because the tenant is not `ACTIVE`.
6. Lan confirms the manual cleanup path or escalates with the audit details [ASSUMPTION: manual cleanup action exists in v1 or v1.1].
7. **Climax:** Lan has an exact, auditable cleanup target and no UI path accidentally presents the tenant as usable.

Failure path: compensation status is missing or ambiguous. The UI blocks retry/destructive cleanup and shows `Manual review required. Audit detail is incomplete.`
