---
title: 'Deferred fixes batch: 429 handling, trust proxy, dependency updates'
type: 'chore'
created: '2026-08-20'
status: 'done'
route: 'one-shot'
---

# Deferred fixes batch: 429 handling, trust proxy, dependency updates

## Intent

**Problem:** Three small, independent items sat in `deferred-work.md`: the frontend gave no dedicated message for rate-limited login/refresh attempts, `main.ts` had no way to trust a reverse proxy's `X-Forwarded-For` for `ThrottlerGuard`, and the pinned ESLint/Prettier/typescript-eslint toolchain had no scheduled update path.

**Approach:** Add a stable `RATE_LIMITED_ERROR_CODE` branch in the frontend API client for 429s on `/auth/login`/`/auth/refresh`, wired to a translated message via a shared `getLoginErrorMessage` helper; add an opt-in `TRUST_PROXY_HOPS` env var read in `main.ts` (disabled by default, no proxy exists in this repo yet); add `.github/dependabot.yml` with a patch-only grouped lint-toolchain update and a grouped github-actions update.

## Suggested Review Order

**Frontend 429 handling**

- Entry point: 429 on a rate-limited path now throws a stable-coded `ApiError` instead of falling through to generic handling.
  [`api-client.ts:244`](../../apps/frontend/src/lib/api-client.ts#L244)

- Deliberately a subset of `NO_REFRESH_PATHS`, not the full set -- `/auth/logout`'s 429s (if any) stay generic.
  [`api-client.ts:55`](../../apps/frontend/src/lib/api-client.ts#L55)

- Shared mapping so both login forms show identical, translated copy instead of raw backend text.
  [`login-error.ts:9`](../../apps/frontend/src/auth/login-error.ts#L9)

- Both forms now delegate to the shared helper instead of duplicating the branch.
  [`LoginPage.tsx:65`](../../apps/frontend/src/pages/LoginPage.tsx#L65)
  [`AdminLoginPage.tsx:55`](../../apps/frontend/src/pages/AdminLoginPage.tsx#L55)

**Trust proxy config**

- Opt-in only: unset by default since no reverse proxy fronts this app yet in any deployment topology in this repo.
  [`main.ts:23`](../../apps/backend/src/main.ts#L23)

- `INestApplication` doesn't expose Express's `.set()` directly -- reached via the underlying HTTP adapter instance.
  [`main.ts:25`](../../apps/backend/src/main.ts#L25)

- Validated as a non-negative integer (hop count), matching this codebase's other env-driven tunables.
  [`env.validation.ts:48`](../../apps/backend/src/config/env.validation.ts#L48)

**Dependency update automation**

- Patch-only grouping keeps trivial lint-toolchain bumps batched without silently squashing a major version bump into the same PR.
  [`dependabot.yml:11`](../../.github/dependabot.yml#L11)
