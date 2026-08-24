---
name: Flexi Super Admin Tenant Onboarding
description: Utility-first internal operations surface for safely provisioning schema-per-tenant customers in Flexi.
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
colors:
  surface: '#FAF8FF'
  surface-container-lowest: '#FFFFFF'
  surface-container-low: '#F3F3FE'
  surface-container: '#EDEDF9'
  surface-container-high: '#E7E7F3'
  on-surface: '#191B23'
  on-surface-variant: '#434655'
  outline: '#737686'
  outline-variant: '#C3C6D7'
  primary: '#004AC6'
  on-primary: '#FFFFFF'
  primary-fixed: '#DBE1FF'
  on-primary-fixed: '#00174B'
  secondary-fixed-dim: '#B7C8E1'
  on-secondary-fixed: '#0B1C30'
  tertiary-fixed: '#FFDBCD'
  on-tertiary-fixed: '#360F00'
  error: '#BA1A1A'
  on-error: '#FFFFFF'
  error-container: '#FFDAD6'
  on-error-container: '#93000A'
typography:
  page-title:
    fontFamily: 'Inter, system-ui, sans-serif'
    fontSize: 28px
    fontWeight: '700'
    lineHeight: '34px'
    letterSpacing: '0'
  section-title:
    fontFamily: 'Inter, system-ui, sans-serif'
    fontSize: 24px
    fontWeight: '700'
    lineHeight: '32px'
    letterSpacing: '0'
  body:
    fontFamily: 'Inter, system-ui, sans-serif'
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '24px'
    letterSpacing: '0'
  body-sm:
    fontFamily: 'Inter, system-ui, sans-serif'
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '20px'
    letterSpacing: '0'
  label:
    fontFamily: 'Inter, system-ui, sans-serif'
    fontSize: 12px
    fontWeight: '600'
    lineHeight: '16px'
    letterSpacing: '0.08em'
  code-sm:
    fontFamily: 'JetBrains Mono, ui-monospace, monospace'
    fontSize: 13px
    fontWeight: '400'
    lineHeight: '20px'
    letterSpacing: '0'
rounded:
  sm: 0.25rem
  md: 0.5rem
  lg: 0.75rem
  xl: 1rem
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  gutter: 16px
  page-desktop: 24px
components:
  app-shell:
    background: '{colors.surface}'
    foreground: '{colors.on-surface}'
  page-header:
    title: '{typography.page-title}'
    description: '{typography.body}'
  tenant-table:
    background: '{colors.surface}'
    border: '{colors.outline-variant}'
    header-background: '{colors.surface-container-low}'
    radius: '{rounded.lg}'
  onboarding-form:
    background: '{colors.surface-container-lowest}'
    border: '{colors.outline-variant}'
    radius: '{rounded.lg}'
  field-validation:
    error: '{colors.error}'
    focus: '{colors.primary}'
  provisioning-progress-timeline:
    background: '{colors.surface-container-lowest}'
    current: '{colors.primary}'
    complete: '{colors.secondary-fixed-dim}'
    warning: '{colors.tertiary-fixed}'
    failed: '{colors.error-container}'
  status-badge:
    neutral: '{colors.surface-container-high}'
    active: '{colors.secondary-fixed-dim}'
    provisioning: '{colors.primary-fixed}'
    failed: '{colors.error-container}'
    suspended: '{colors.tertiary-fixed}'
    radius: '{rounded.full}'
  idempotency-notice:
    background: '{colors.primary-fixed}'
    foreground: '{colors.on-primary-fixed}'
    radius: '{rounded.md}'
  result-panel:
    background: '{colors.surface-container-lowest}'
    border: '{colors.outline-variant}'
    radius: '{rounded.lg}'
  audit-detail-drawer:
    background: '{colors.surface-container-lowest}'
    border: '{colors.outline-variant}'
  confirmation-dialog:
    background: '{colors.surface-container-lowest}'
    danger: '{colors.error}'
    radius: '{rounded.lg}'
  toast:
    background: '{colors.surface-container-lowest}'
    border: '{colors.outline-variant}'
    radius: '{rounded.md}'
  empty-state:
    background: '{colors.surface}'
    foreground: '{colors.on-surface-variant}'
---

# Flexi Super Admin Tenant Onboarding - Design Spine

## Brand & Style

This surface is an internal operations tool, not a marketing or consumer product. It inherits Flexi's existing React/Tailwind component system and the Stitch-synced token vocabulary already present in `apps/frontend/src/styles/tokens.css`.

The posture is utility-first: dense enough for trained operators, calm enough for high-stakes provisioning, and visually explicit whenever infrastructure work is running. Visual emphasis belongs on permission boundaries, irreversible commit points, progress, validation, auditability, and copyable handoff outputs.

[ASSUMPTION] The Super Admin area can reuse the existing authenticated app shell while adding route-level permission gating for `system.tenants.onboard`.

## Colors

The palette uses existing Flexi tokens with no new decorative palette. This keeps the onboarding surface visually aligned with the current admin dashboard.

| Token | Role | Rule |
| --- | --- | --- |
| `{colors.surface}` | Page canvas | Used for the authenticated shell background. |
| `{colors.surface-container-lowest}` | Form, result, drawer surfaces | Used where the operator must inspect or copy data. |
| `{colors.primary}` | Primary action and current provisioning step | Reserved for the next intentional action or the currently running step. |
| `{colors.primary-fixed}` | Informational/idempotency notice | Used for retry-safe and non-error system messages. |
| `{colors.secondary-fixed-dim}` | Successful/complete state | Used for `ACTIVE` and completed step markers. |
| `{colors.tertiary-fixed}` | Warning/manual-attention state | Used for `SUSPENDED`, long-running attempts, and manual cleanup warnings. |
| `{colors.error-container}` / `{colors.error}` | Failed/destructive state | Used for `FAILED`, destructive confirmations, and validation errors. |

Avoid color-only state communication. Every status badge, step marker, and failure panel must include text and, where useful, a Material Symbols icon.

Contrast target: text on `{colors.surface}`, `{colors.surface-container-lowest}`, `{colors.primary}`, `{colors.error}`, and badge surfaces must meet WCAG 2.2 AA for normal text.

## Typography

Use Inter for all product text. Use JetBrains Mono only for machine identifiers such as tenant id, schema name, setup token snippets, idempotency keys, and audit resource ids.

| Role | Token | Use |
| --- | --- | --- |
| Page title | `{typography.page-title}` | Top-level surface titles such as `Tenants` or `Onboard New Tenant`. |
| Section title | `{typography.section-title}` | Major form/result sections, not table headers. |
| Body | `{typography.body}` | Explanatory copy and primary readable content. |
| Body small | `{typography.body-sm}` | Field help, table cells, secondary metadata. |
| Label | `{typography.label}` | Existing uppercase labels for inputs and table headers. |
| Code small | `{typography.code-sm}` | Slugs, schema names, ids, setup tokens, URLs. |

Use short, scannable labels. Do not use display-scale typography inside form panels, tables, sidebars, or status timelines.

## Layout & Spacing

The experience lives inside the existing Flexi shell: fixed sidebar on `md+`, mobile drawer below `md`, top nav, and a content canvas with `p-lg md:p-xl` spacing.

Primary desktop layout:

| Surface | Layout rule |
| --- | --- |
| Tenants list | PageHeader, compact filters, table. Secondary panels open as drawer/dialog. |
| Onboarding form | Single-page form with grouped sections. Summary and preflight status stay adjacent on desktop, stacked on narrow viewports. |
| Provisioning attempt detail | Progress timeline first, then safe payload metadata, audit detail, and handoff/result panel. |
| Success result | Tenant URL and first-admin setup handoff are visually isolated in `{components.result-panel}`. |

Spacing uses the existing 4px-derived scale. Dense internal tables may use `{spacing.md}` cell padding; provisioning/result surfaces may use `{spacing.lg}` for breathing room around high-risk actions.

## Elevation & Depth

Use borders and tonal surfaces before shadow. Existing `shadow-sm` is acceptable on tables, cards, result panels, dialogs, drawers, and toasts. Do not stack cards inside cards.

Progress and audit surfaces should feel attached to the page, not like decorative floating panels. Elevation only indicates a modal layer, drawer layer, or toast layer.

## Shapes

Operational controls use crisp corners:

| Token | Use |
| --- | --- |
| `{rounded.sm}` | Small inline controls where existing components require it. |
| `{rounded.md}` | Notices, toasts, small panels. |
| `{rounded.lg}` | Forms, tables, dialogs, drawers, result panels. |
| `{rounded.full}` | Status badges only. |

Avoid oversized rounded panels and pill-shaped buttons. The only full-radius component is `status-badge`.

## Components

Visual specs for implementation consumers. Behavioral rules live in `EXPERIENCE.md`.

| Component | Visual spec |
| --- | --- |
| app-shell | Existing Flexi `Layout`, `Sidebar`, and `TopNav`; `{components.app-shell.background}` page canvas and `{components.app-shell.foreground}` text. |
| page-header | Existing `PageHeader`; title uses `{components.page-header.title}` and description uses `{components.page-header.description}`. |
| tenant-table | Existing `Table`; `{components.tenant-table.background}` panel, `{components.tenant-table.header-background}` header, `{components.tenant-table.border}` hairline, `{components.tenant-table.radius}` corners. |
| onboarding-form | Existing `Card` or equivalent un-nested panel; `{components.onboarding-form.background}`, `{components.onboarding-form.border}`, `{components.onboarding-form.radius}`. |
| field-validation | Existing `Input` and `Select` styling; invalid border/focus use `{components.field-validation.error}`, valid focus uses `{components.field-validation.focus}`. |
| provisioning-progress-timeline | Custom vertical timeline or stepper using existing Icon/Badge vocabulary. Current step uses `{components.provisioning-progress-timeline.current}`, completed uses `{components.provisioning-progress-timeline.complete}`, failed uses `{components.provisioning-progress-timeline.failed}`. |
| status-badge | Existing `Badge`; map `PROVISIONING` to `{components.status-badge.provisioning}`, `ACTIVE` to `{components.status-badge.active}`, `FAILED` to `{components.status-badge.failed}`, `SUSPENDED` to `{components.status-badge.suspended}`. |
| idempotency-notice | Inline notice above progress/result areas; `{components.idempotency-notice.background}` and `{components.idempotency-notice.foreground}`. |
| result-panel | Isolated handoff panel for tenant URL and first-admin setup token; code values use `{typography.code-sm}` and copy buttons use existing `Button` with icons. |
| audit-detail-drawer | Right-side drawer on desktop, full-screen sheet on small screens; surface uses `{components.audit-detail-drawer.background}` and border uses `{components.audit-detail-drawer.border}`. |
| confirmation-dialog | Existing modal/dialog pattern [ASSUMPTION]; use `{components.confirmation-dialog.danger}` only for destructive or irreversible retries/cleanup actions. |
| toast | Existing toast pattern [ASSUMPTION]; compact, one sentence, optional action. |
| empty-state | Existing empty-state styling [ASSUMPTION]; muted foreground, single primary action. |

## Do's and Don'ts

| Do | Don't |
| --- | --- |
| Reuse Flexi tokens and internal components. | Introduce a parallel visual system or consumer-style hero layout. |
| Make provisioning status and auditability visually prominent. | Hide background work behind an indefinite spinner. |
| Use monospace for machine identifiers and handoff secrets. | Render setup tokens in ordinary prose where they are easy to mis-copy. |
| Use badges plus labels for tenant lifecycle state. | Communicate status through color alone. |
| Keep the form in one operational flow with strong validation. | Split onboarding across ornamental wizard pages unless backend genuinely needs phased submission. |
| Reserve destructive colors for failed states and destructive actions. | Use red for normal warnings or impatience prompts. |
