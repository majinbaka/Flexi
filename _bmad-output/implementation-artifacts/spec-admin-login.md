---
title: 'System Admin Login (/admin/login)'
type: 'feature'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 0
context: []
route: 'one-shot'
---

# System Admin Login (/admin/login)

## Intent

**Problem:** The login screen only supported Tenant Users (`/login`, requires a Tenant ID) — System Admins had no way to sign in, since `/admin/login` was explicitly deferred from `spec-core-authentication-fe.md`.

**Approach:** Add `AdminLoginPage` at `/admin/login`, reusing the existing `AuthContext`/api-client/`ProtectedRoute` infrastructure. It calls the same `POST /auth/login` but omits `x-tenant-id`, which the backend already uses to resolve system vs. tenant login. `AuthContext.login()`'s `tenantId` param was made optional to support this.

## Suggested Review Order

**Auth session plumbing**

- `tenantId` becomes optional; header is only sent when present, letting the same `login()` serve both actor types.
  [`AuthContext.tsx:116`](../../apps/frontend/src/auth/AuthContext.tsx#L116)

**New admin login screen**

- `AdminLoginPage`: same shell as `LoginPage` minus the Tenant ID field; calls `login(email, password)` with no third argument.
  [`AdminLoginPage.tsx:13`](../../apps/frontend/src/pages/AdminLoginPage.tsx#L13)

- Route table: `/admin/login` added as a second public sibling next to `/login`.
  [`router.tsx:22`](../../apps/frontend/src/router.tsx#L22)

**Peripherals**

- `auth` i18n namespace: `adminLoginTitle`/`adminLoginSubtitle` (EN/VI).
  [`en.json:51`](../../apps/frontend/src/i18n/locales/en.json#L51)

- Storybook coverage for the new page, mirroring `LoginPage.stories.tsx`.
  [`AdminLoginPage.stories.tsx:1`](../../apps/frontend/src/pages/AdminLoginPage.stories.tsx#L1)

- Stale comment on `LoginPage` updated to point at the new page instead of "deferred".
  [`LoginPage.tsx:9`](../../apps/frontend/src/pages/LoginPage.tsx#L9)
