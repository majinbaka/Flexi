---
title: 'Story 1.1: Permission-Gated Onboarding Entry And Form Shell'
type: 'feature'
created: '2026-08-21'
status: 'done'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
baseline_commit: '1b0d2b44513480e123f5eb20b712c53b23f334db'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Tenants area is still a generic placeholder, so an Ops/System user has no approved Super Admin entry point for tenant onboarding, and the app has no route-level/control-level check for `system.tenants.onboard`.

**Approach:** Replace the Tenants placeholder with a real authenticated Tenants surface whose primary action is permission-gated, add a protected onboarding route that renders a grouped form shell, and keep all submit/preflight/API state creation out of this story.

## Boundaries & Constraints

**Always:** Require `actorType === system` and `permissions.includes('system.tenants.onboard')` before showing `Onboard New Tenant` or rendering the onboarding form. Use the existing authenticated `Layout`, route tree, i18n, and UI primitives. Keep Tenants as the sidebar destination; onboarding is reached from the Tenants page primary action, not a new sidebar item. The form shell must have accessible labels for Tenant identity, First Admin, Plan/options, and Preflight groups.

**Ask First:** Adding a real onboarding submit endpoint, adding persistence models beyond demo seed permission catalog data, changing the core auth token shape, or introducing a frontend test framework.

**Never:** Do not fake a successful tenant creation, call a non-existent onboarding API, create Tenant/Onboarding Attempt records, implement slug availability validation, or expose onboarding controls to tenant actors or SystemUsers without the permission.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Permitted entry | Signed-in SystemUser has `system.tenants.onboard` and opens `/tenants` | Tenants page renders in the app shell with `Onboard New Tenant` as the page action | N/A |
| Permitted route | Same user activates the action or opens `/tenants/onboard` | Onboarding page renders grouped Tenant identity, First Admin, Plan/options, and Preflight form shell with accessible labels | N/A |
| Missing permission | Signed-in SystemUser lacks `system.tenants.onboard` and opens `/tenants` | Create action is hidden; no form state is initialized | N/A |
| Direct denied route | Tenant actor or unpermitted SystemUser opens `/tenants/onboard` | Permission-denied surface renders inside the app shell; no form state is initialized | No network mutation; no onboarding state created |

</frozen-after-approval>

## Code Map

- `apps/frontend/src/router.tsx:25` -- protected route tree wraps `Layout`; module routes are generated from `MODULE_NAV_ITEMS` and currently send `/tenants` to `PlaceholderPage`.
- `apps/frontend/src/auth/AuthContext.tsx:20` -- `currentUser` is available to frontend components; use it for permission gating.
- `packages/shared-types/src/entities.ts:193` and `packages/shared-types/src/enums.ts:42` -- `AuthenticatedUserDto.permissions` and `ActorType.SYSTEM` define the local permission predicate.
- `apps/frontend/src/modules.ts:18` and `apps/frontend/src/components/Sidebar.tsx:59` -- Tenants already exists as one sidebar module; keep that nav item and avoid adding an onboarding nav item.
- `apps/frontend/src/components/TopNav.tsx:23` -- breadcrumb only matches exact module paths, so nested `/tenants/onboard` needs prefix-aware or explicit crumb handling.
- `apps/frontend/src/pages/PlaceholderPage.tsx:15` -- current generic module page; replace only the Tenants route with real pages, leave other modules on the placeholder.
- `apps/frontend/src/components/ui/PageHeader.tsx:15`, `Button.tsx:41`, `Input.tsx:19`, `Select.tsx:15`, `Card.tsx:19`, `Table.tsx:75`, `Badge.tsx:178` -- existing UI primitives to reuse for the Tenants page and form shell.
- `apps/frontend/src/stories/decorators.tsx:18` -- Storybook mock user is tenant-scoped; add SystemUser mocks with and without `system.tenants.onboard`.
- `apps/frontend/src/i18n/locales/en.json:13` and `vi.json:13` -- add Tenants/onboarding/permission-denied copy in both locales.
- `apps/backend/prisma/seed.ts:22` -- demo SystemUser currently only receives `system.me.read`; grant `system.tenants.onboard` to the demo PlatformAdmin role so the seeded system login can exercise the allowed path.
- `apps/backend/src/modules/auth/decorators/require-permissions.decorator.ts:14` and `guards/permissions.guard.ts:28` -- backend permission convention for later API stories; do not wire a fake API in this story.

## Tasks & Acceptance

**Execution:**
- [x] `apps/frontend/src/auth/permissions.ts` -- add a small predicate such as `canOnboardTenants(user)` that requires System actor type plus `system.tenants.onboard`.
- [x] `apps/frontend/src/pages/TenantsPage.tsx` -- create the real Tenants surface with `PageHeader`, an empty/list shell, and permission-gated `Onboard New Tenant` action linking to `/tenants/onboard`.
- [x] `apps/frontend/src/pages/TenantOnboardingPage.tsx` -- create the grouped form shell with labelled Tenant identity, First Admin, Plan/options, and Preflight sections; controls may be disabled/non-mutating where later stories own validation and submit.
- [x] `apps/frontend/src/pages/PermissionDeniedPage.tsx` or equivalent local component -- render a clear no-access state for direct denied route access.
- [x] `apps/frontend/src/router.tsx` -- route `/tenants` to `TenantsPage`, route `/tenants/onboard` to the gated onboarding page, and leave other module routes generated from `MODULE_NAV_ITEMS`.
- [x] `apps/frontend/src/components/TopNav.tsx` -- keep breadcrumb useful on nested `/tenants/onboard` paths.
- [x] `apps/frontend/src/i18n/locales/en.json` and `apps/frontend/src/i18n/locales/vi.json` -- add all visible strings.
- [x] `apps/frontend/src/stories/decorators.tsx` and new/update page stories -- add permitted SystemUser, unpermitted SystemUser, and tenant-user variants for Tenants and onboarding pages.
- [x] `packages/shared-types/src/permissions.ts` -- expose `system.tenants.onboard` as the shared permission code used by frontend gating, Storybook mocks, and backend seed.
- [x] `apps/backend/prisma/seed.ts` -- seed `system.tenants.onboard` as a SYSTEM permission and assign it to the demo PlatformAdmin role.

**Acceptance Criteria:**
- Given a signed-in SystemUser with `system.tenants.onboard`, when they open `/tenants`, then the existing app shell renders a Tenants page with `Onboard New Tenant` as the primary page action.
- Given that permitted SystemUser, when they choose `Onboard New Tenant`, then `/tenants/onboard` renders one form shell grouped into Tenant identity, First Admin, Plan/options, and Preflight with accessible labels.
- Given a signed-in SystemUser without `system.tenants.onboard`, when they open `/tenants`, then the create action is absent.
- Given a tenant actor or unpermitted SystemUser, when they open `/tenants/onboard` directly, then a permission-denied surface renders and no onboarding form state or network mutation is created.

## Spec Change Log

## Design Notes

Frontend permission gating is not a security boundary for the future submit API; it is the user-facing entry/control boundary for this story. Later backend API stories must still enforce `@RequirePermissions('system.tenants.onboard')` before state creation.

The form shell should be honest about its current capability: it collects/display fields and disabled submit affordance only. Story 1.2 owns blur validation, slug availability, submit-disabled business rules, and preflight state transitions.

## Verification

**Commands:**
- `pnpm --filter @flexi/shared-types build` -- expected: shared permission export builds for app consumers.
- `pnpm --filter @flexi/frontend build` -- expected: TypeScript and Vite build pass.
- `pnpm --filter @flexi/frontend build-storybook` -- expected: Storybook builds with permitted, denied, and mobile stories.
- `pnpm --filter @flexi/backend build` -- expected: seed permission changes compile.
- `pnpm lint` -- expected: repository lint passes.

## Suggested Review Order

**Entry And Permission Boundary**

- Route split isolates Tenants from other generated module placeholders.
  [`router.tsx:30`](../../apps/frontend/src/router.tsx#L30)

- Shared predicate is the single frontend gate for onboarding access.
  [`permissions.ts:9`](../../apps/frontend/src/auth/permissions.ts#L9)

- Page action is visible only when the current actor can onboard tenants.
  [`TenantsPage.tsx:53`](../../apps/frontend/src/pages/TenantsPage.tsx#L53)

**Onboarding Shell**

- Direct denied access exits before form state is created.
  [`TenantOnboardingPage.tsx:56`](../../apps/frontend/src/pages/TenantOnboardingPage.tsx#L56)

- Grouped form shell covers the approved intake sections without submit behavior.
  [`TenantOnboardingPage.tsx:86`](../../apps/frontend/src/pages/TenantOnboardingPage.tsx#L86)

- Preflight is semantic and live-region ready for later state updates.
  [`TenantOnboardingPage.tsx:142`](../../apps/frontend/src/pages/TenantOnboardingPage.tsx#L142)

- Disabled submit now exposes the reason programmatically and visually.
  [`TenantOnboardingPage.tsx:166`](../../apps/frontend/src/pages/TenantOnboardingPage.tsx#L166)

**Shell And Support**

- Nested module paths keep the Tenants breadcrumb instead of falling to Home.
  [`TopNav.tsx:23`](../../apps/frontend/src/components/TopNav.tsx#L23)

- Permission code is shared across app code, stories, and seed data.
  [`permissions.ts:1`](../../packages/shared-types/src/permissions.ts#L1)

- Demo PlatformAdmin receives the onboarding permission for local validation.
  [`seed.ts:59`](../../apps/backend/prisma/seed.ts#L59)

**Review Harness**

- Story variants cover permitted, unpermitted, tenant, and mobile surfaces.
  [`TenantsPage.stories.tsx:29`](../../apps/frontend/src/pages/TenantsPage.stories.tsx#L29)

- Story variants cover allowed and denied direct onboarding routes.
  [`TenantOnboardingPage.stories.tsx:88`](../../apps/frontend/src/pages/TenantOnboardingPage.stories.tsx#L88)
